#!/usr/bin/env node
// agentd: the supervisor inside the sandbox container of one user on Cloudflare. It has no dependencies.
//
// The Durable Object of the user (UserRunner in cloud/src/worker.mjs, logic in cloud/src/core.mjs) reaches agentd on port 8080 only, through ctx.container.getTcpPort().
// agentd does on Cloudflare what sandbox/local-runner.mjs does with `docker exec` on one machine:
//   - It runs one job with runJob() of sandbox/run-comment.mjs: the same arguments, the same stream parsers, the same
//     progress events. The image copies run-comment.mjs as it is, and agentd imports it. Nothing is copied by hand.
//   - It keeps one Claude Code process that waits for the next job (warmClaude() of run-comment.mjs).
//   - It runs the sign-in commands of sandbox/signin.mjs and passes the pasted code to the program on stdin, one time.
//   - It is the egress proxy of the programs, on 127.0.0.1:3128: CONNECT to the hosts of the allow list only, and
//     POST /mcp to the connector. The connector request goes to http://runner.internal/mcp, which the Durable Object
//     intercepts and sends to the connector URL of the run. So the connector token never enters the container.
//   - It saves the sign-in folder as one encrypted archive after each run and each sign-in, when no program runs.
//     It never reads a file of the folder: `tar` packs the folder as bytes, and agentd encrypts the bytes.
//
// Routes on port 8080 (each one needs the header x-agentd-token, except the first POST /init that sets the token):
//   GET  /health                   the state, with no secret
//   POST /init                     { token, key, aad, archive?, prewarm?, model?, effort? }   restores the sign-in folder
//   POST /run                      { job, nonce }    202. The run reports through http://runner.internal/cb/<nonce>.
//   POST /kill                     ends the run at once (the hard time limit)
//   POST /login                    {}                 starts the sign-in of the engine of this container
//   POST /login/code               { id, code }       the code that the person pasted
//   POST /login/status             { id }             { status: pending | connected | failed | expired, detail? }
//   POST /logout                   {}                 signs out and empties the folder
//   POST /drain                    {}                 ends each program gently, saves the folder, and answers
import { spawn, spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import * as RC from '../../sandbox/run-comment.mjs';
import * as EP from '../../sandbox/egress-proxy.mjs';
import * as SI from '../../sandbox/signin.mjs';

const E = process.env;
export const ENGINE = E.AGENTD_ENGINE === 'codex' ? 'codex' : 'claude';
const PORT = +E.AGENTD_PORT || 8080;
const PROXY_PORT = +E.AGENTD_PROXY_PORT || 3128;
/** The intercepted host name. Only the Durable Object answers it, and only for this container. */
const UPSTREAM = (E.AGENTD_UPSTREAM || 'http://runner.internal').replace(/\/+$/, '');
const TIMEOUT_MS = +E.RUN_TIMEOUT_MS || 180_000;
/** The user of the programs. agentd runs as root only to set the firewall rules and to start the programs as this user. */
const UID = 10001, GID = 10001;
const DIR = ENGINE === 'codex' ? E.CODEX_HOME || '/codex-home' : E.CLAUDE_CONFIG_DIR || '/claude-config';
const BIN = { claude: E.CLAUDE_BIN || 'claude', codex: E.CODEX_BIN || 'codex' };
const MAX_BODY = 32 * 1024 * 1024;
const MCP_URL = `http://127.0.0.1:${PROXY_PORT}/mcp`;
/**
 * Development only (cloud/dev/local-cloud.mjs): the sign-in folder is a Docker volume that keeps itself, as in
 * sandbox/local-runner.mjs. agentd then takes it as signed in and saves no archive, so no second copy of the sign-in
 * exists that could renew it apart from the volume. Cloudflare has no such volume, and the Durable Object never sets this.
 */
const PERSISTENT = E.AGENTD_DIR_PERSISTENT === '1';
// The folder where the programs run. A test on a machine with no /work sets another folder.
const WORK = E.AGENTD_WORK || '/work';

/** The allow lists. sandbox/egress-proxy.mjs has them; the fallback is the list of commit 23cbb93. test/agentd.test.mjs checks both. */
export const ALLOW = {
  run: EP.RUN_ALLOW?.[ENGINE] ?? (ENGINE === 'codex' ? ['chatgpt.com', 'auth.openai.com', 'api.openai.com'] : ['api.anthropic.com', 'platform.claude.com']),
  signin: EP.SIGNIN_ALLOW?.[ENGINE] ?? (ENGINE === 'codex' ? ['chatgpt.com', 'auth.openai.com', 'api.openai.com'] : ['api.anthropic.com', 'platform.claude.com', 'claude.ai', 'claude.com']),
};

/** One JSON line for each event. No line has a token, a key, a code, a URL of a sign-in, or a byte of the archive. */
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), src: 'agentd', engine: ENGINE, ...o }));

// ---------------------------------------------------------------------------------------------------------------------
// Hardening: what the platform does not do for us. Each step is best effort, and GET /health reports the result.

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });

/**
 * The firewall of the container. The programs run as uid 10001, and that user reaches only the loopback address: the
 * proxy of agentd. A connection to any other address fails at once with a reset, so nothing waits for a DNS answer or a
 * connect time limit. agentd itself (root) reaches the hosts of the allow list for the CONNECT tunnels, and runner.internal.
 */
export const FIREWALL = [
  ['-A', 'OUTPUT', '-o', 'lo', '-j', 'ACCEPT'],
  ['-A', 'OUTPUT', '-m', 'owner', '--uid-owner', String(UID), '-p', 'tcp', '-j', 'REJECT', '--reject-with', 'tcp-reset'],
  ['-A', 'OUTPUT', '-m', 'owner', '--uid-owner', String(UID), '-j', 'REJECT'],
];
/** The source and the type of the mount on "/", from the last such line of /proc/mounts. */
export function rootMount(text = (() => { try { return readFileSync('/proc/mounts', 'utf8'); } catch { return ''; } })()) {
  const line = text.split('\n').filter((l) => l.split(' ')[1] === '/').pop();
  return line ? { source: line.split(' ')[0], type: line.split(' ')[2] } : null;
}
function harden() {
  const out = { root: isRoot(), egress: 'proxy-only', rootfs_ro: false, tmp: false };
  try { out.rootfs_ro = /^\S+ \/ \S+ ro[ ,]/m.test(readFileSync('/proc/mounts', 'utf8')); } catch {}
  if (!out.root || E.AGENTD_HARDEN === '0') return out;
  let ok = true;
  for (const bin of ['iptables', 'ip6tables']) for (const rule of FIREWALL) { const r = sh(bin, ['-w', ...rule]); if (r.status !== 0) { ok = false; log({ ev: 'firewall_failed', bin, error: (r.stderr || r.error?.message || '').trim().slice(0, 200) }); } }
  if (ok) out.egress = 'enforced';
  // The platform has no read-only root file system. With root capabilities agentd can make one: memory for /tmp and the
  // sign-in folder, then the root read-only. A container that is read-only already (docker --read-only) skips this.
  if (!out.rootfs_ro) {
    const m1 = sh('mount', ['-t', 'tmpfs', '-o', `rw,noexec,nosuid,nodev,size=64m,uid=${UID},gid=${GID},mode=0700`, 'tmpfs', '/tmp']);
    const m2 = sh('mount', ['-t', 'tmpfs', '-o', `rw,noexec,nosuid,nodev,size=32m,uid=${UID},gid=${GID},mode=0700`, 'tmpfs', DIR]);
    // busybox mount needs the type and the source of the root mount to remount it (the Cloudflare simulator: overlay).
    const root = rootMount();
    const m3 = m1.status === 0 && m2.status === 0 && root ? sh('mount', ['-o', 'remount,ro', '-t', root.type, root.source, '/']) : { status: 1, stderr: root ? '' : 'no root mount in /proc/mounts' };
    out.tmp = m1.status === 0;
    out.rootfs_ro = m3.status === 0;
    if (!out.rootfs_ro) log({ ev: 'rootfs_rw', error: [m1, m2, m3].map((r) => (r.stderr || '').trim()).filter(Boolean).join(' | ').slice(0, 200) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The programs

/** The environment of a program: run-comment.mjs childEnv(), plus the proxy of agentd. No variable holds a secret. */
export function programEnv(engine = ENGINE) {
  const base = { HOME: '/tmp', USER: 'runner', PATH: E.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: E.LANG, USE_BUILTIN_RIPGREP: E.USE_BUILTIN_RIPGREP, ...(engine === 'codex' ? { CODEX_HOME: DIR } : { CLAUDE_CONFIG_DIR: DIR }) };
  const proxy = `http://127.0.0.1:${PROXY_PORT}`;
  return { ...RC.childEnv(engine, base), HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
}

/** Each program runs as uid 10001 in its own process group, so a kill reaches its children too. */
const asUser = () => (isRoot() ? { uid: UID, gid: GID } : {});
export const exec = (engine, args, { cwd } = {}) => {
  const child = spawn(BIN[engine === 'codex' ? 'codex' : 'claude'], args, { cwd: cwd || WORK, env: programEnv(engine), stdio: ['pipe', 'pipe', 'pipe'], detached: true, ...asUser() });
  procs.add(child);
  child.on('close', () => procs.delete(child));
  return child;
};
/** Every program that runs now. A save waits until this set is empty. */
const procs = new Set();
const killGroup = (child, sig = 'SIGKILL') => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };

// ---------------------------------------------------------------------------------------------------------------------
// The archive of the sign-in folder

const MAGIC = Buffer.from('APC1');
/** AES-256-GCM. The format: "APC1", the 12-byte IV, the 16-byte tag, the ciphertext. `aad` binds the archive to one user and one engine. */
export function seal(plain, key, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
export function open(sealed, key, aad) {
  if (sealed.length < 32 || !sealed.subarray(0, 4).equals(MAGIC)) throw new Error('not an archive of agentd');
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(4, 16));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(sealed.subarray(16, 32));
  return Buffer.concat([d.update(sealed.subarray(32)), d.final()]);
}

/** Runs `tar` as the user of the programs. agentd gives or takes the bytes and never looks inside them. */
function tar(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['pipe', 'pipe', 'pipe'], ...asUser() });
    const out = []; let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.setEncoding('utf8').on('data', (d) => { err = (err + d).slice(-500); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`tar ended with ${code}: ${err.trim().split('\n').pop()}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? null);
  });
}
export const pack = (dir = DIR) => tar(['-C', dir, '-czf', '-', '.']);
export const unpack = (bytes, dir = DIR) => tar(['-C', dir, '-xzf', '-'], bytes);
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------------------------------------------------
// State

const S = {
  token: null, key: null, aad: null,
  /** True when the folder holds a sign-in that a run or a sign-in made, so a save has something to keep. */
  signedIn: false,
  lastDigest: null,
  run: null, warm: null, login: null,
  model: undefined, effort: undefined, prewarm: true,
  hardening: null, t_start: Date.now(),
};

/** Sends a request to the Durable Object through the intercepted host. The token proves that agentd sent it. */
async function up(path, { method = 'POST', body, type = 'application/json', ms = 15_000 } = {}) {
  const res = await fetch(UPSTREAM + path, { method, headers: { 'content-type': type, 'x-agentd-token': S.token ?? '' }, body: type === 'application/json' && body !== undefined ? JSON.stringify(body) : body, signal: AbortSignal.timeout(ms) });
  await res.body?.cancel();
  return res.status;
}

/** Saves the folder when no program runs and the bytes changed. Returns { saved, unchanged?, bytes?, ms }. */
let saving = null;
export async function save(why) {
  if (PERSISTENT) return { saved: false, cause: 'the folder is a volume' };
  if (!S.key || !S.signedIn) return { saved: false, cause: 'no sign-in' };
  if (procs.size) return { saved: false, cause: 'a program runs' };
  return (saving ??= (async () => {
    const t0 = Date.now();
    const plain = await pack();
    const digest = sha(plain);
    if (digest === S.lastDigest) return { saved: false, unchanged: true, ms: Date.now() - t0 };
    const sealed = seal(plain, S.key, S.aad);
    const status = await up(`/archive/${ENGINE}`, { method: 'PUT', body: sealed, type: 'application/octet-stream', ms: 30_000 });
    if (status !== 200) throw new Error(`the archive store answered ${status}`);
    S.lastDigest = digest;
    const out = { saved: true, bytes: sealed.length, ms: Date.now() - t0 };
    log({ ev: 'saved', why, ...out });
    return out;
  })().finally(() => { saving = null; }));
}

/** Starts the Claude process that waits for the next job, when the folder has a sign-in and nothing else runs. */
function prewarm() {
  if (ENGINE !== 'claude' || !S.prewarm || !S.signedIn || S.run || S.login?.status === 'pending' || (S.warm && !S.warm.dead)) return;
  S.warm = RC.warmClaude({ exec, mcp: RC.mcpConfig(MCP_URL), model: S.model, effort: S.effort });
  log({ ev: 'prewarm', model: S.model ?? 'default' });
}

/** Ends the waiting process gently (CLAUDE_MIN_AGE_MS protects a sign-in refresh). */
async function stopWarm() {
  const w = S.warm;
  S.warm = null;
  if (!w || w.dead) return 'none';
  const r = w.discard ? await w.discard() : 'none';
  return typeof r === 'string' ? r : 'ended';
}

// ---------------------------------------------------------------------------------------------------------------------
// Routes

async function init(b) {
  if (S.token) return [409, { error: 'agentd has a token already' }];
  if (typeof b.token !== 'string' || b.token.length < 32) return [400, { error: 'token must have 32 characters or more' }];
  const key = Buffer.from(String(b.key ?? ''), 'base64');
  if (key.length !== 32 || typeof b.aad !== 'string') return [400, { error: 'key must be 32 bytes in base64, and aad a string' }];
  Object.assign(S, { token: b.token, key, aad: b.aad, model: b.model ?? RC.defaults()[ENGINE].model, effort: b.effort ?? RC.defaults()[ENGINE].effort, prewarm: b.prewarm !== false });
  const t0 = Date.now();
  let restored = false;
  if (b.archive) {
    try {
      const plain = open(Buffer.from(b.archive, 'base64'), key, b.aad);
      await unpack(plain);
      S.lastDigest = sha(plain);
      S.signedIn = restored = true;
    } catch (e) {
      // A broken or foreign archive: the person must connect again. The cause has no byte of the archive.
      log({ ev: 'restore_failed', error: String(e.message).slice(0, 120) });
      return [422, { error: 'the archive did not open', restored: false }];
    }
  }
  if (PERSISTENT) S.signedIn = true;
  const ms_restore = Date.now() - t0;
  log({ ev: 'init', restored, ms_restore });
  prewarm();
  return [200, { ok: true, restored, ms_restore }];
}

function startRun(b) {
  if (S.run) return [409, { error: 'a run is running' }];
  // Only a sign-in that still waits blocks a run. A sign-in that ended stays in S.login for its status.
  if (S.login?.status === 'pending') return [409, { error: 'a sign-in is running' }];
  const nonce = String(b.nonce ?? '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return [400, { error: 'nonce must be 16 to 64 URL characters' }];
  const job = { ...b.job, engine: ENGINE, mcp_url: MCP_URL, callback_url: `${UPSTREAM}/cb/${nonce}` };
  for (const k of ['model', 'effort']) if (job[k] == null) delete job[k];
  const bad = RC.jobError(job);
  if (bad) return [400, { error: bad }];
  const post = (url, body, ms = 15_000) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentd-token': S.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) }).then((r) => { r.body?.cancel(); return r.status; });
  const warm = S.warm;
  S.warm = null;
  const t0 = Date.now();
  const run = { nonce, child: null, killed: false };
  S.run = run;
  run.done = (async () => {
    let out;
    try {
      out = await RC.runJob(job, { exec: (e, a, o) => (run.child = exec(e, a, o)), mcpUrl: MCP_URL, warm, cwd: WORK, timeoutMs: TIMEOUT_MS, post, postProgress: (url, body) => post(url, body, 2000), kill: () => { run.killed = true; if (run.child) killGroup(run.child); } });
    } catch (e) {
      out = { ok: false, status: 'failed', error: String(e.message || e).slice(0, 300) };
      await post(job.callback_url, { status: 'failed', detail: `agentd: ${out.error}` }).catch(() => null);
    }
    // Wait for every program of the run to end before the save: a refresh writes the folder.
    for (let i = 0; procs.size && i < 50; i++) await new Promise((r) => setTimeout(r, 100));
    let saved = null;
    if (out.status !== 'not_signed_in') saved = await save('run').catch((e) => ({ saved: false, error: String(e.message).slice(0, 120) }));
    if (out.status === 'not_signed_in') S.signedIn = false;
    const summary = { status: out.status, engine: ENGINE, model: out.model, warm: out.warm, ms_total: Date.now() - t0, ms_init: out.ms_init, ms_first_token: out.ms_first_token, ms_first_tool: out.ms_first_tool, ms_reply: out.ms_reply, ms_engine: out.ms_engine, ms_callback: out.ms_callback, num_turns: out.num_turns, total_cost_usd: out.total_cost_usd, callback_status: out.callback_status, progress_sent: out.progress_sent, progress_accepted: out.progress_accepted, tools: out.tool_calls?.map((t) => `${t.name}@${t.ms}`).join(' '), saved: saved?.saved ?? false, save_ms: saved?.ms, error: out.status === 'done' ? undefined : String(out.error ?? '').slice(0, 300) };
    log({ ev: 'run', ...summary });
    // The next waiting program uses the model of this job: the choice of the person.
    S.model = job.model ?? RC.defaults()[ENGINE].model;
    S.effort = job.effort ?? RC.defaults()[ENGINE].effort;
    S.run = null;
    await up(`/done/${nonce}`, { body: summary }).catch(() => null);
    prewarm();
  })();
  return [202, { accepted: true }];
}

async function startLogin() {
  if (S.run) return [409, { error: 'a run is running' }];
  if (S.login && S.login.status === 'pending') return [409, { error: 'a sign-in is running' }];
  await stopWarm();
  const cmd = SI.SIGNIN[ENGINE];
  const id = randomBytes(18).toString('base64url');
  const child = exec(ENGINE, cmd.login.slice(1));
  const L = { id, child, text: '', status: 'pending', detail: null, code: false, expires_at: new Date(Date.now() + SI.SIGNIN_TIMEOUT_MS).toISOString() };
  S.login = L;
  const add = (d) => { L.text = (L.text + d).slice(-16_000); };
  child.stdout.setEncoding('utf8').on('data', add);
  child.stderr.setEncoding('utf8').on('data', add);
  child.stdin.on('error', () => {});
  L.timer = setTimeout(() => { if (L.status === 'pending') { L.status = 'expired'; killGroup(child); } }, SI.SIGNIN_TIMEOUT_MS);
  child.on('close', async (code) => {
    clearTimeout(L.timer);
    if (L.status !== 'pending') return;
    const st = spawnSync(BIN[ENGINE], cmd.status.slice(1), { env: programEnv(), encoding: 'utf8', timeout: 15_000, ...asUser() });
    const ok = code === 0 && (ENGINE === 'claude' ? SI.parseClaudeStatus(st.stdout) : SI.parseCodexStatus(`${st.stdout}${st.stderr}`));
    if (!ok) { L.status = 'failed'; L.detail = SI.failureDetail(ENGINE, L.text, { exitCode: code }); log({ ev: 'signin', status: 'failed', exit_code: code }); return; }
    S.signedIn = true;
    S.lastDigest = null;
    try {
      await save('signin');
      L.status = 'connected';
    } catch (e) {
      L.status = 'failed';
      L.detail = 'The sign-in worked, but the runner could not keep it. Connect again.';
      log({ ev: 'signin_save_failed', error: String(e.message).slice(0, 120) });
    }
    log({ ev: 'signin', status: L.status });
    prewarm();
  });
  // Wait for the URL (and the code of Codex). The program prints them in about a second.
  const parse = () => (ENGINE === 'claude' ? SI.parseClaudeLogin(L.text) : SI.parseCodexLogin(L.text));
  for (let i = 0; i < 200; i++) {
    const p = parse();
    if (p.url && (ENGINE === 'claude' || p.user_code) && L.status === 'pending') {
      log({ ev: 'signin', status: 'started' });
      return [200, { id, url: p.url, ...(p.user_code ? { user_code: p.user_code } : {}), needs_code: cmd.needs_code, expires_at: L.expires_at }];
    }
    if (L.status !== 'pending' || child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (L.status === 'pending') { L.status = 'failed'; killGroup(child); }
  return [502, { error: SI.failureDetail(ENGINE, L.text) }];
}

function loginCode(b) {
  const L = S.login;
  if (!L || L.id !== b.id) return [404, { error: 'no such sign-in' }];
  if (L.status !== 'pending') return [409, { error: `the sign-in is ${L.status}` }];
  if (ENGINE !== 'claude') return [400, { error: 'this sign-in takes no code' }];
  const bad = SI.codeError(b.code);
  if (bad) return [400, { error: bad }];
  if (L.code) return [409, { error: 'the sign-in has its code already' }];
  // The code goes to the program one time, and to nothing else: no log line, no answer.
  L.code = true;
  L.child.stdin.write(`${b.code}\n`);
  return [200, { ok: true }];
}

function loginStatus(b) {
  const L = S.login;
  if (!L || L.id !== b.id) return [404, { error: 'no such sign-in' }];
  return [200, { status: L.status, ...(L.detail ? { detail: L.detail } : {}) }];
}

async function logout() {
  if (S.run) return [409, { error: 'a run is running' }];
  await stopWarm();
  if (S.login?.status === 'pending') { S.login.status = 'failed'; killGroup(S.login.child); }
  const r = spawnSync(BIN[ENGINE], SI.SIGNIN[ENGINE].logout.slice(1), { env: programEnv(), encoding: 'utf8', timeout: 20_000, ...asUser() });
  spawnSync('sh', ['-c', 'rm -rf -- "$0"/* "$0"/.[!.]* "$0"/..?*', DIR], { timeout: 10_000, ...asUser() });
  S.signedIn = false; S.lastDigest = null;
  log({ ev: 'logout', exit_code: r.status });
  return [200, { ok: true }];
}

async function drain() {
  const t0 = Date.now();
  if (S.run) { S.run.killed = true; if (S.run.child) killGroup(S.run.child); await S.run.done?.catch(() => {}); }
  const warm = await stopWarm();
  if (S.login?.status === 'pending') { S.login.status = 'expired'; killGroup(S.login.child); }
  for (let i = 0; procs.size && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
  const saved = await save('drain').catch((e) => ({ saved: false, error: String(e.message).slice(0, 120) }));
  const out = { ok: true, warm, left: procs.size, ...saved, ms: Date.now() - t0 };
  log({ ev: 'drain', ...out });
  return [200, out];
}

function health() {
  return [200, { ok: true, engine: ENGINE, has_token: !!S.token, signed_in: S.signedIn, busy: !!S.run, login: S.login?.status ?? null, warm: !!(S.warm && !S.warm.dead), procs: procs.size, hardening: S.hardening, uptime_ms: Date.now() - S.t_start }];
}

const same = (a, b) => { const x = createHash('sha256').update(String(a ?? '')).digest(), y = createHash('sha256').update(String(b ?? '')).digest(); return timingSafeEqual(x, y) && !!a; };

const ROUTES = {
  'POST /init': init, 'POST /run': startRun, 'POST /kill': async () => { if (S.run?.child) { S.run.killed = true; killGroup(S.run.child); } return [200, { ok: true }]; },
  'POST /login': startLogin, 'POST /login/code': loginCode, 'POST /login/status': loginStatus, 'POST /logout': logout, 'POST /drain': drain,
};

export function control() {
  return createServer((req, res) => {
    const send = ([status, body]) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/health') return send(health());
    const fn = ROUTES[`${req.method} ${path}`];
    if (!fn) return send([404, { error: 'no such route' }]);
    if (!(path === '/init' && !S.token) && !same(req.headers['x-agentd-token'], S.token)) return send([401, { error: 'x-agentd-token' }]);
    const chunks = []; let n = 0;
    req.on('data', (d) => { n += d.length; if (n <= MAX_BODY) chunks.push(d); });
    req.on('end', async () => {
      let b = {};
      try { b = n ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send([400, { error: 'send JSON' }]); }
      if (n > MAX_BODY || !b || typeof b !== 'object') return send([400, { error: 'send JSON of at most 32 MB' }]);
      try { send(await fn(b)); } catch (e) { log({ ev: 'error', route: path, error: String(e.message || e).slice(0, 200) }); send([500, { error: 'agentd failed' }]); }
    });
  });
}

/**
 * The proxy of the programs, on the loopback address only.
 *   CONNECT <host>:443   a tunnel to a host of the allow list. A sign-in widens the list while it waits for the person.
 *   POST /mcp            the connector, through the Durable Object. The program never sees the token of the run.
 *   anything else        403 at once.
 */
export function egress() {
  const proxy = createServer((req, res) => {
    let path = req.url;
    if (/^http:\/\//i.test(path)) { try { const u = new URL(path); if (/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(u.host)) path = u.pathname; } catch {} }
    if (path !== '/mcp') { log({ ev: 'deny', method: req.method, host: (() => { try { return new URL(req.url).host.slice(0, 80); } catch { return '(a path)'; } })() }); res.writeHead(403); return res.end(); }
    const headers = { 'content-type': req.headers['content-type'] || 'application/json', accept: req.headers.accept || 'application/json, text/event-stream', 'x-agentd-token': S.token ?? '' };
    for (const h of ['mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id', 'content-length']) if (req.headers[h]) headers[h] = req.headers[h];
    const u = new URL(UPSTREAM + '/mcp');
    const t0 = Date.now();
    const upReq = httpRequest(u, { method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] || 'application/json', ...(r.headers['mcp-session-id'] ? { 'mcp-session-id': r.headers['mcp-session-id'] } : {}) });
      r.pipe(res);
      r.on('end', () => log({ ev: 'mcp', status: r.statusCode, ms: Date.now() - t0 }));
    });
    upReq.on('error', (e) => { log({ ev: 'mcp', status: 502, cause: e.code || 'error' }); if (!res.headersSent) res.writeHead(502); res.end(); });
    upReq.setTimeout(120_000, () => upReq.destroy(new Error('timeout')));
    req.pipe(upReq);
  });
  proxy.on('connect', (req, socket, head) => {
    const t = EP.connectTarget(req.url);
    const list = S.login?.status === 'pending' ? ALLOW.signin : ALLOW.run;
    if (!t || t.port !== 443 || !EP.hostAllowed(t.host, list)) {
      log({ ev: 'deny', host: t ? t.host.slice(0, 80) : '(not a host name)', port: t?.port ?? null });
      return socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    }
    const upSock = connect(t.port, t.host, () => {
      log({ ev: 'tunnel', host: t.host });
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upSock.write(head);
      upSock.pipe(socket); socket.pipe(upSock);
    });
    upSock.setNoDelay(true); socket.setNoDelay(true);
    upSock.on('error', () => socket.destroy());
    socket.on('error', () => upSock.destroy());
  });
  proxy.on('clientError', (_e, s) => s.destroy());
  return proxy;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  S.hardening = harden();
  if (E.AGENTD_REQUIRE_EGRESS === '1' && S.hardening.egress !== 'enforced') { log({ ev: 'refuse_start', hardening: S.hardening }); process.exit(3); }
  egress().listen(PROXY_PORT, '127.0.0.1');
  control().listen(PORT, '0.0.0.0');
  log({ ev: 'start', port: PORT, proxy_port: PROXY_PORT, upstream: UPSTREAM, hardening: S.hardening, node: process.version, dir_exists: existsSync(DIR) });
  // The platform sends SIGTERM before it stops a container (a rollout, a host restart). Save first, then end.
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, async () => { await drain().catch(() => {}); process.exit(0); });
}
