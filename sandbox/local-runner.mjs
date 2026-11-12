#!/usr/bin/env node
// The runner: an HTTP server that takes the jobs of the host and runs each one in a sandbox. It has no dependencies.
// It listens on the loopback addresses only.
//
//   node sandbox/local-runner.mjs [--mode host|docker] [--port 8811]
//
// Each route takes POST with a JSON body. With SANDBOX_RUNNER_SECRET set, each route but GET /health needs that value in
// the header x-runner-secret. README.md has the contract of each route.
//   /run             the job JSON of run-comment.mjs, plus an optional `mode`
//   /warm            { user, engine?, model?, effort? }. docker mode: starts the container of the user before a job exists.
//   /status          { user } -> { assistants: { claude: { connected, models, default_model }, chatgpt: { … } } }
//   /connect         { user, engine } -> { id, url, user_code?, needs_code, expires_at }. docker mode only.
//   /connect/code    { id, code } -> { status }. The code goes to the waiting program one time.
//   /connect/status  { id } -> { status, detail? }
//   /connect/cancel  { id } -> { status }
//   /disconnect      { user, engine } -> { connected: false }
//   GET /health
//   host    runs Claude Code or Codex as installed and signed in on this machine.
//   docker  runs them in one container for each user, with the controls that README.md lists.
// With `callback_url` in the job, /run answers 202 at once, and the run reports to that URL.
// With no `callback_url`, the server waits and answers with the JSON of the run.
//
// Environment (all optional):
//   SANDBOX_RUNNER_SECRET     the shared secret of the host and the runner
//   SANDBOX_IDLE_MS           how long the container of a user stays after a run. Default 90000. 0: one container for each run.
//   SANDBOX_WARM_MS           how long a container that POST /warm started stays with no job. Default 60000. 0: /warm does nothing.
//   SANDBOX_PREWARM           0: do not start Claude Code before the next job arrives. Default 1.
//   SANDBOX_DISCOVER_ORIGIN   the origin of the host. With SANDBOX_RUNNER_SECRET, the runner gets the connector answers that
//                             are the same for each token from <origin>/s/_mcp/discover, so a program can wait before the first job.
//                             Default: the first entry of SANDBOX_CONNECTOR_ORIGINS, then the origin of the last job.
//   SANDBOX_MAX_QUEUE         how many jobs of one user can wait. Default 5.
//   SANDBOX_MEMORY, SANDBOX_CPUS, SANDBOX_PIDS   the limits of a container. Default 1g, 2, 256.
//   SANDBOX_EGRESS_ALLOW      a comma list of hosts for each container, in place of the lists of egress-proxy.mjs
//   SANDBOX_CONNECTOR_ORIGINS a comma list of origins. A job with another origin in mcp_url or callback_url gets 400.
//   SANDBOX_CLAUDE_MODEL, SANDBOX_CLAUDE_EFFORT, SANDBOX_CODEX_MODEL, SANDBOX_CODEX_EFFORT   for a job that names none
//   SANDBOX_CLAUDE_MIN_AGE_MS the youngest age at which the runner may end a Claude process, outside the time limit. Default 30000.
//   SANDBOX_CONNECT_TIMEOUT_MS how long a sign-in waits for the person. Default 600000.
//   SANDBOX_HOST_EGRESS       1: host mode sends each run through its own egress-proxy.mjs on 127.0.0.1, with the hosts of a run
//                             of that engine. The program then gets the URL of the proxy, not the connector token.
//   SANDBOX_CLAUDE_IMAGE, SANDBOX_CODEX_IMAGE, SANDBOX_EGRESS_IMAGE, RUN_TIMEOUT_MS, RUNNER_PORT, RUNNER_MODE
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, defaults, ENGINE_ENV, jobError, MODELS, runJob, waitBeforeStop, warmClaude, mcpConfig } from './run-comment.mjs';
import { RUN_ALLOW, SIGNIN_ALLOW, startProxy } from './egress-proxy.mjs';
import { codeError, failureDetail, parseClaudeLogin, parseClaudeStatus, parseCodexLogin, parseCodexStatus, scrub, SIGNIN, SIGNIN_TIMEOUT_MS } from './signin.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const E = process.env;
const PORT = +arg('port', E.RUNNER_PORT || 8811);
const MODE = arg('mode', E.RUNNER_MODE || 'host');
/** One image for each engine, from the targets of the Dockerfile. A Claude run never pulls or starts the Codex image. */
export const IMAGES = { claude: E.SANDBOX_CLAUDE_IMAGE || 'agent-pages-sandbox-claude', codex: E.SANDBOX_CODEX_IMAGE || 'agent-pages-sandbox-codex' };
export const EGRESS_IMAGE = E.SANDBOX_EGRESS_IMAGE || 'agent-pages-egress';
const SECRET = E.SANDBOX_RUNNER_SECRET || '';
/** The warm policy. PERF.md and COST.md have the numbers behind the defaults. */
const IDLE_MS = E.SANDBOX_IDLE_MS === undefined ? 90_000 : +E.SANDBOX_IDLE_MS;
const WARM_MS = E.SANDBOX_WARM_MS === undefined ? 60_000 : +E.SANDBOX_WARM_MS;
const PREWARM = E.SANDBOX_PREWARM !== '0' && (IDLE_MS > 0 || WARM_MS > 0);
const MAX_QUEUE = E.SANDBOX_MAX_QUEUE === undefined ? 5 : +E.SANDBOX_MAX_QUEUE;
const LIMITS = { memory: E.SANDBOX_MEMORY || '1g', cpus: E.SANDBOX_CPUS || '2', pids: E.SANDBOX_PIDS || '256' };
const TIMEOUT_MS = +E.RUN_TIMEOUT_MS || 180_000;
const CONNECT_TIMEOUT_MS = +E.SANDBOX_CONNECT_TIMEOUT_MS || SIGNIN_TIMEOUT_MS;
const ORIGINS = (E.SANDBOX_CONNECTOR_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
let discoverOrigin = E.SANDBOX_DISCOVER_ORIGIN || ORIGINS[0] || null;
const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 64 * 1024;
/** The names of the Docker objects of this runner. Two runners on two ports do not share one. */
const NET = `agent-pages-sandbox-${PORT}`;
const PROXY = `agent-pages-egress-${PORT}`;
const LABEL = `agent-pages-runner=${PORT}`;
/** /status keeps an answer this long. A run and a sign-in change it at once. */
const STATUS_TTL_MS = 30_000;

/** One JSON line for each event. No line has a token, a URL of the connector, a run id, a sign-in URL or a pasted code. */
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

export const hashOf = (user) => createHash('sha256').update(String(user || 'local')).digest('hex').slice(0, 16);
/** The volume that holds the Claude sign-in of one user. The name has a hash, so it shows no email address. */
export const volumeOf = (user) => `agent-pages-claude-${hashOf(user)}`;
/** The volume that holds the ChatGPT sign-in of one user, as CODEX_HOME. */
export const codexVolumeOf = (user) => `agent-pages-codex-${hashOf(user)}`;
/** The sign-in volume and its mount point for each engine. */
export const signInOf = (engine, user) => (engine === 'codex' ? { volume: codexVolumeOf(user), mount: '/codex-home' } : { volume: volumeOf(user), mount: '/claude-config' });
const NAMES = { claude: 'Claude Code', codex: 'Codex' };
/** The assistant of each engine, as the host names it in a mention. */
export const ASSISTANT = { claude: 'claude', codex: 'chatgpt' };

/** A container reaches the dev server of this machine as host.docker.internal, not as localhost. */
export const forDocker = (url) => (typeof url === 'string' ? url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/, '$1host.docker.internal') : url);

/** The named variables of an environment that have a value. A child gets these and no other variable of this process. */
const pick = (env, keys) => Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, env[k]]));

/** The environment that run-comment.mjs needs in host mode. Null with no HOME or no USER: Claude Code needs both to find its sign-in. */
export function hostEnv(env = process.env) {
  return env.HOME && env.USER ? pick(env, ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'CLAUDE_BIN', 'CODEX_BIN', 'CODEX_HOME', 'RUN_TIMEOUT_MS']) : null;
}

/** Compares two secrets in a time that does not depend on where they differ. An empty secret matches nothing. */
export function sameSecret(a, b) {
  const x = createHash('sha256').update(String(a ?? '')).digest(), y = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(x, y) && String(a ?? '').length > 0;
}

/** True when the URL has an origin of the list, or the list is empty. */
export const originAllowed = (url, origins) => { if (!origins.length) return true; try { return origins.includes(new URL(url).origin); } catch { return false; } };

/** The controls that each container of a user gets: a run, a sign-in, a status check. */
const controls = (limits) => [
  // tini is process 1. It removes each program that ends, and it stops at once when the runner removes the container.
  '--init',
  // The root file system is read-only. /tmp is memory, and no program can run from it.
  '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700',
  // No Linux capability, and no program can get more rights than its parent.
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--pids-limit', String(limits.pids), '--memory', String(limits.memory), '--memory-swap', String(limits.memory), '--cpus', String(limits.cpus),
  // The image sets USER runner (uid 10001), HOME=/tmp, and CLAUDE_CONFIG_DIR or CODEX_HOME.
  '--user', '10001:10001',
];

/**
 * The `docker run` arguments of the container of one user. Each control is one line.
 * tests/sandbox.test.mjs checks the list, and verify-controls.mjs tries each forbidden thing in a real container.
 * A sign-in container has the same arguments: the proxy gives it the sign-in hosts while the sign-in waits.
 */
export function sandboxArgs({ name, user, engine = 'claude', network, proxy, image = IMAGES[engine], limits = LIMITS, label = LABEL }) {
  const { volume, mount } = signInOf(engine, user);
  return [
    'run', '-d', '--name', name, '--label', label,
    ...controls(limits),
    // The network has no route to the outside. The egress proxy is the only other machine on it. No port is published.
    '--network', network,
    // The sign-in folder of this user for this engine is the only folder that keeps data.
    '-v', `${volume}:${mount}`,
    '-e', `HTTPS_PROXY=http://${proxy}:3128`, '-e', `HTTP_PROXY=http://${proxy}:3128`, '-e', `NO_PROXY=${proxy}`,
    ...(engine === 'codex' ? [] : Object.entries(ENGINE_ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`])),
    image,
  ];
}

/**
 * The `docker run` arguments of a status check: no network, and the sign-in volume read-only. The program cannot renew,
 * change or remove a sign-in there, so the check is safe while another program of the user runs.
 */
export const statusArgs = ({ user, engine, image = IMAGES[engine], limits = LIMITS }) => {
  const { volume, mount } = signInOf(engine, user);
  return ['run', '--rm', ...controls(limits), '--network', 'none', '-v', `${volume}:${mount}:ro`, image, ...SIGNIN[engine].status];
};

// ---------------------------------------------------------------------------------------------------------------------
// Docker

/** The docker program gets what it needs to find the Docker daemon. No container gets these variables. */
const dockerEnv = () => pick(process.env, ['PATH', 'HOME', 'USER', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT']);

function docker(args, { env = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { env: { ...dockerEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    // This ends the docker program, not a program in a container.
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: String(e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}
const must = async (args, opts) => { const r = await docker(args, opts); if (r.code !== 0) throw new Error(`docker ${args[0]} ${args[1] ?? ''}: ${r.stderr.split('\n').pop() || `exit code ${r.code}`}`); return r.stdout; };

/** The files that each target of the Dockerfile copies. A change of one of them changes the image. */
const BUILD_INPUTS = { claude: ['Dockerfile'], codex: ['Dockerfile'], egress: ['Dockerfile', 'egress-proxy.mjs'] };
/** The hash of the build inputs of a target. Each image has it in the label agent-pages.inputs. */
export const inputsHash = (target, read = (f) => readFileSync(join(HERE, f))) => {
  const h = createHash('sha256').update(`target ${target}\n`);
  for (const f of BUILD_INPUTS[target]) h.update(`${f}\n`).update(read(f)).update('\n');
  return h.digest('hex').slice(0, 16);
};
const INPUTS_LABEL = 'agent-pages.inputs';

/** Builds an image from its target of the Dockerfile when it is missing or its build inputs changed. One build for each image at a time. */
const builds = new Map();
export function ensureImage(image, target) {
  if (!builds.has(image)) builds.set(image, (async () => {
    const want = inputsHash(target);
    const r = await docker(['image', 'inspect', '-f', `{{index .Config.Labels "${INPUTS_LABEL}"}}`, image]);
    if (r.code === 0 && r.stdout === want) return;
    const t0 = Date.now();
    log({ ev: 'build', image, why: r.code === 0 ? 'inputs changed' : 'missing', inputs: want, was: r.code === 0 ? r.stdout || null : null });
    await must(['build', '--target', target, '--label', `${INPUTS_LABEL}=${want}`, '-t', image, HERE], { timeoutMs: 900_000 });
    log({ ev: 'built', image, inputs: want, ms: Date.now() - t0 });
  })().catch((e) => { builds.delete(image); throw e; }));
  return builds.get(image);
}

/**
 * True when the user has a sign-in volume for the engine. A sign-in makes the volume, a sign-out removes it, and the
 * runner never makes one for a run, so a missing volume means "not connected". The check is one `docker volume inspect`.
 */
export async function hasVolume(engine, user) {
  return (await docker(['volume', 'inspect', '-f', '{{.Name}}', signInOf(engine, user).volume], { timeoutMs: 10_000 })).code === 0;
}
/** The old name of hasVolume. */
export const hasSignIn = hasVolume;

let infra = null;
/** IP address of a container to { user, engine, kind }, for the egress lines of the proxy log. */
const ipOwners = new Map();
/** The network and the egress proxy. One time for the life of the runner. */
export function ensureInfra() {
  return (infra ??= (async () => {
    const t0 = Date.now();
    const secret = randomBytes(32).toString('base64url');
    await ensureImage(EGRESS_IMAGE, 'egress');
    // What a runner on this port left behind.
    const old = await must(['ps', '-aq', '--filter', `label=${LABEL}`]);
    if (old) await docker(['rm', '-f', ...old.split(/\s+/)]);
    await docker(['network', 'rm', NET]);
    await must(['network', 'create', '--internal', '--label', LABEL, NET]);
    const allow = E.SANDBOX_EGRESS_ALLOW ? ['-e', `EGRESS_ALLOW=${E.SANDBOX_EGRESS_ALLOW}`] : [];
    // `-e CONTROL_SECRET` with no value takes the value from the environment of the docker program, so it is not an argument.
    await must(['run', '-d', '--name', PROXY, '--label', LABEL, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '128m',
      '--add-host', 'host.docker.internal:host-gateway', '-p', '127.0.0.1::3129', '-e', 'CONTROL_SECRET', ...allow, EGRESS_IMAGE], { env: { CONTROL_SECRET: secret } });
    await must(['network', 'connect', NET, PROXY]);
    const port = (await must(['port', PROXY, '3129'])).split('\n')[0].split(':').pop();
    // Each request has its own connection. A connection that waits can be closed on the far side of the Docker port.
    const control = (method, path, body) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : '';
      const req = httpRequest({ host: '127.0.0.1', port, path, method, agent: false, timeout: 5000, headers: { 'x-control-secret': secret, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), connection: 'close' } }, (res) => {
        let text = '';
        res.setEncoding('utf8').on('data', (d) => { text += d; }).on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`egress proxy: ${method} ${path.split('/')[1]} answered ${res.statusCode}`));
          try { resolve(JSON.parse(text)); } catch { reject(new Error('egress proxy: the answer is not JSON')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('egress proxy: no answer in 5 s'))).on('error', reject).end(data);
    });
    for (let i = 0; ; i++) {
      try {
        await control('GET', '/health');
        break;
      } catch (e) {
        if (i > 50) throw new Error(`the egress proxy did not start: ${e.message}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    followProxyLog();
    log({ ev: 'infra', network: NET, proxy: PROXY, ms: Date.now() - t0 });
    const net = { control, mcpUrl: `http://${PROXY}:3128/mcp` };
    discover(net).catch(() => {});
    return net;
  })().catch((e) => { infra = null; throw e; }));
}

/**
 * Copies the egress lines of the proxy log into this log, with the user and the engine of the container: each tunnel
 * and each refusal, with the host name only. So one log has what a cloud operator needs.
 */
function followProxyLog() {
  const child = spawn('docker', ['logs', '-f', PROXY], { env: dockerEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  child.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
      let o;
      try { o = JSON.parse(buf.slice(0, i)); } catch { continue; }
      if (o.ev !== 'tunnel' && o.ev !== 'deny') continue;
      const who = ipOwners.get(o.from) ?? {};
      log({ ev: o.ev === 'tunnel' ? 'egress_opened' : 'egress_refused', user: who.user ?? null, engine: who.engine ?? null, kind: who.kind ?? null, profile: o.profile ?? null, host: o.host ?? null, port: o.port ?? null, ...(o.method ? { method: o.method } : {}) });
    }
  });
  child.on('error', () => {}).unref();
}

/** Gives the proxy the hosts that a container may reach: the hosts of a run, or of a sign-in. */
async function allowFor(net, ip, { user, engine, kind }) {
  ipOwners.set(ip, { user: hashOf(user), engine, kind });
  await net.control('PUT', `/allow/${ip}`, { hosts: (kind === 'signin' ? SIGNIN_ALLOW : RUN_ALLOW)[engine], profile: `${engine}-${kind}` });
}
async function forget(net, ip) {
  ipOwners.delete(ip);
  await net.control('DELETE', `/allow/${ip}`).catch(() => {});
}

/** The cgroup numbers of a container: the CPU time that its processes used, and the most memory, since its start. */
async function usage(name) {
  const r = await docker(['exec', name, 'cat', '/sys/fs/cgroup/cpu.stat', '/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/memory.current'], { timeoutMs: 5000 });
  if (r.code !== 0) return {};
  const usec = /^usage_usec (\d+)$/m.exec(r.stdout);
  const thr = /^nr_throttled (\d+)$/m.exec(r.stdout);
  const [peak, current] = r.stdout.trim().split('\n').slice(-2).map(Number);
  return { cpu_s: usec ? +usec[1] / 1e6 : null, throttled: thr ? +thr[1] : null, peak_memory_mb: Math.round(peak / 1048576), memory_mb: Math.round(current / 1048576) };
}

/** `<engine>:<user hash>` to { key, engine, name, ip, warm, idle, t_start, ms_start, runs, started_by, procs, model }. */
export const boxes = new Map();
/** `<engine>:<user hash>` to the promise of a removal that has not ended. A new container of that key waits for it. */
const removing = new Map();
const keyOf = (engine, user) => `${engine}:${hashOf(user)}`;

/**
 * Ends the programs of a container before the container goes. A Claude program can renew the sign-in at its start, and
 * a program that ends in that time can destroy the sign-in (see CLAUDE_MIN_AGE_MS in run-comment.mjs). So the runner
 * waits until the youngest program is old enough, closes the input of each program, then sends SIGINT in the container,
 * and waits each time. `hard` (the time limit of a run) skips the wait.
 */
export async function quiesce(box, { hard = false, graceMs = 10_000 } = {}) {
  const procs = [...box.procs];
  if (!procs.length || hard) return 'none';
  const allClosed = (ms) => Promise.race([Promise.all(procs.map((p) => p.closed)).then(() => true), new Promise((r) => setTimeout(() => r(false), ms).unref())]);
  const wait = waitBeforeStop({ engine: box.engine, ageMs: Date.now() - Math.max(...procs.map((p) => p.t_spawn)) });
  if (wait > 0 && (await allClosed(wait))) return 'ended';
  for (const p of procs) { try { p.child.stdin?.end(); } catch {} }
  if (await allClosed(graceMs)) return 'eof';
  await docker(['exec', box.name, 'pkill', '-INT', '-x', box.engine === 'codex' ? 'codex' : 'claude'], { timeoutMs: 5000 });
  return (await allClosed(graceMs)) ? 'sigint' : 'left';
}

/**
 * Removes a container, and logs what a cloud host bills for its life: the seconds from the start to the stop, the CPU
 * seconds of its processes, the peak memory, and the runs it served. COST.md computes the price from these lines.
 * `why` is idle, warm unused, timeout, not signed in, run end, exited, sign-in, sign-out or shutdown.
 */
export function removeBox(key, why) {
  const box = boxes.get(key);
  if (!box) return removing.get(key) ?? Promise.resolve();
  boxes.delete(key);
  clearTimeout(box.idle);
  const p = (async () => {
    const hard = why === 'timeout' || why === 'exited';
    const stopped = await quiesce(box, { hard });
    const u = why === 'exited' ? {} : await usage(box.name);
    await docker(['rm', '-f', box.name]);
    if (infra) forget(await infra, box.ip);
    log({ ev: 'container_stopped', user: key.split(':')[1], engine: box.engine, why, started_by: box.started_by, runs: box.runs, ms_start: box.ms_start, s_billable: (Date.now() - box.t_start) / 1000, cpu_s: u.cpu_s ?? null, cpu_throttled: u.throttled ?? null, peak_memory_mb: u.peak_memory_mb ?? null, programs_stopped: stopped });
  })().finally(() => { if (removing.get(key) === p) removing.delete(key); });
  removing.set(key, p);
  return p;
}

/** The running container of a user for an engine. Starts one when there is none. `by` is 'run' or 'warm', for the log. */
export async function ensureBox(user, engine = 'claude', by = 'run') {
  const key = keyOf(engine, user);
  let box = boxes.get(key);
  if (box) { clearTimeout(box.idle); return { box, cold: false }; }
  // A container of this key that is still stopping has a program of this user, and the same name.
  await removing.get(key);
  box = boxes.get(key);
  if (box) { clearTimeout(box.idle); return { box, cold: false }; }
  const [net] = await Promise.all([ensureInfra(), ensureImage(IMAGES[engine], engine)]);
  const name = `agent-pages-sbx-${PORT}-${engine}-${hashOf(user)}`;
  const args = sandboxArgs({ name, user, engine, network: NET, proxy: PROXY });
  const t_start = Date.now();
  // A container with this name can stay after a failure. Remove it and try one more time.
  if ((await docker(args)).code !== 0) { await docker(['rm', '-f', name]); await must(args); }
  const ip = await must(['inspect', '-f', `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`, name]);
  await allowFor(net, ip, { user, engine, kind: 'run' });
  box = { key, engine, name, ip, warm: null, idle: null, t_start, ms_start: Date.now() - t_start, runs: 0, started_by: by, procs: new Set(), model: undefined, effort: undefined };
  boxes.set(key, box);
  log({ ev: 'container_started', user: hashOf(user), engine, by, ms_start: box.ms_start });
  // A program in the container can stop the container. `docker wait` ends at that moment, so the next job gets a new container.
  const live = box;
  spawn('docker', ['wait', name], { env: dockerEnv(), stdio: 'ignore' }).on('close', () => { if (boxes.get(key) === live) removeBox(key, 'exited'); }).on('error', () => {}).unref();
  return { box, cold: true };
}

/** Starts a program in the container of a box. The box knows each program and its age, so a removal can wait for it. */
export const execIn = (box) => (engine, args) => {
  const child = spawn('docker', ['exec', '-i', box.name, engine === 'codex' ? 'codex' : 'claude', ...args], { env: dockerEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  const proc = { child, t_spawn: Date.now() };
  proc.closed = new Promise((r) => { child.on('close', r); child.on('error', r); });
  box.procs.add(proc);
  proc.closed.then(() => box.procs.delete(proc));
  return child;
};

/**
 * The connector answers that are the same for each token, from <origin>/s/_mcp/discover. The requests are the ones that
 * Claude Code 2.1.311 sends at its start: server/discover (MCP 2026-07-28), then initialize (2025-11-25) when the first
 * one fails, and tools/list. The runner puts the answers in the proxy, so a program can start before the first job.
 * The secret of the runner stays in the runner: the proxy gets the answers, not the secret.
 */
const MODERN = '2026-07-28';
const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} };
export const DISCOVER_REQUESTS = [
  ['server/discover', { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } }, true],
  ['tools/list', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } }, true],
  ['initialize', { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'agent-pages-runner', version: '1' } } }, false],
  ['notifications/initialized', { jsonrpc: '2.0', method: 'notifications/initialized' }, false],
];
let discovering = null;
export function discover(net, origin = discoverOrigin, secret = SECRET, fetchFn = fetch) {
  if (!origin || !secret) return Promise.resolve(false);
  return (discovering ??= (async () => {
    const t0 = Date.now();
    const answers = {};
    for (const [method, body, modern] of DISCOVER_REQUESTS) {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-runner-secret': secret, ...(modern ? { 'mcp-protocol-version': MODERN, 'mcp-method': method } : {}) };
      const r = await fetchFn(new URL('/s/_mcp/discover', origin).href, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const text = await r.text();
      if (r.status < 200 || r.status >= 300) throw new Error(`discover ${method}: ${r.status}`);
      answers[method] = { status: r.status, body: text };
    }
    await net.control('PUT', '/cache', { answers });
    log({ ev: 'discovered', methods: Object.keys(answers), ms: Date.now() - t0 });
    return true;
  })().catch((e) => { log({ ev: 'discover_failed', error: String(e.message || e).slice(0, 200) }); return false; }).finally(() => { discovering = null; }));
}

/**
 * Starts Claude Code in the container before the next job arrives, when the proxy can answer its first connector requests.
 * The program gets the model of the last job or the last /warm of this user, so the next job of the same model can use it.
 */
async function prewarm(box, net) {
  // A container that runs a job starts no second program: the end of the job starts the next one.
  if (!PREWARM || box.engine !== 'claude' || box.busy || !boxes.has(box.key) || (box.warm && !box.warm.dead)) return;
  try {
    let { cached } = await net.control('GET', '/health');
    if (!cached.includes('tools/list') && (await discover(net))) ({ cached } = await net.control('GET', '/health'));
    if (!cached.includes('tools/list') || !boxes.has(box.key) || box.busy || (box.warm && !box.warm.dead)) return;
    const d = defaults().claude;
    box.warm = warmClaude({ exec: execIn(box), mcp: mcpConfig(net.mcpUrl), model: box.model ?? d.model, effort: box.effort ?? d.effort });
  } catch {}
}

/** Removes the container after `ms` with no job. A later call can only make the time longer, so /warm never cuts the linger of a run. */
const removeAfter = (box, ms, why) => {
  const at = Date.now() + ms;
  if (box.idle && box.idleAt >= at) return;
  clearTimeout(box.idle);
  box.idleAt = at;
  box.idle = setTimeout(() => removeBox(box.key, why), ms).unref();
};

/** POST /warm: the person opened a comment box. Starts the container and the program, and keeps them SANDBOX_WARM_MS. */
export async function warmUp(user, engine = 'claude', { model, effort } = {}) {
  if (WARM_MS <= 0) return { warm: false, cause: 'SANDBOX_WARM_MS is 0' };
  if (signingIn(engine, user)) return { warm: false, cause: 'a sign-in is in progress' };
  if (!(await hasVolume(engine, user))) return { warm: false, cause: 'not_signed_in' };
  const net = await ensureInfra();
  const { box, cold } = await ensureBox(user, engine, 'warm');
  if (model !== undefined || effort !== undefined) {
    const d = defaults()[engine];
    box.model = model ?? d.model;
    box.effort = effort ?? d.effort;
  }
  removeAfter(box, WARM_MS, 'warm unused');
  await prewarm(box, net);
  return { warm: true, cold };
}

/** The result of a job that no program ran, for a user with no sign-in for the engine. The host shows "not connected". */
async function notSignedIn(job, engine, t0, why = `${NAMES[engine]} has no sign-in for this user`) {
  const out = { ok: false, status: 'not_signed_in', engine, error: why, ms_signin_check: Date.now() - t0, container: false };
  if (job.callback_url) out.callback_status = await fetch(job.callback_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: out.status, detail: out.error }), signal: AbortSignal.timeout(15_000) }).then((r) => r.status, () => null);
  return out;
}

export async function startDocker(job) {
  const t0 = Date.now();
  const engine = job.engine === 'codex' ? 'codex' : 'claude';
  try { discoverOrigin ??= new URL(job.mcp_url).origin; } catch {}
  if (signingIn(engine, job.user)) return notSignedIn(job, engine, t0, `a sign-in of ${SIGNIN[engine].name} is in progress for this user`);
  const [net, signedIn] = await Promise.all([ensureInfra(), boxes.has(keyOf(engine, job.user)) || hasVolume(engine, job.user)]);
  if (!signedIn) { remember(engine, job.user, false); return notSignedIn(job, engine, t0); }
  const { box, cold } = await ensureBox(job.user, engine, 'run');
  const ms_container = Date.now() - t0;
  box.runs++;
  box.busy = true;
  const d = defaults()[engine];
  // The next program that waits gets the model of this job.
  box.model = job.model ?? d.model;
  box.effort = job.effort ?? d.effort;
  await net.control('PUT', `/route/${box.ip}`, { mcp_url: forDocker(job.mcp_url) });
  const warm = box.warm;
  box.warm = null;
  let out;
  try {
    out = await runJob(job, { exec: execIn(box), mcpUrl: net.mcpUrl, warm, cwd: '/work', timeoutMs: TIMEOUT_MS, kill: () => removeBox(box.key, 'timeout'), stop: () => docker(['exec', box.name, 'pkill', '-KILL', '-x', 'codex']) });
  } finally {
    box.busy = false;
    await net.control('DELETE', `/route/${box.ip}`).catch(() => {});
  }
  if (out.status === 'done') remember(engine, job.user, true);
  if (out.status === 'not_signed_in') remember(engine, job.user, false);
  if (boxes.has(box.key)) {
    const u = await usage(box.name);
    Object.assign(out, { peak_memory_mb: u.peak_memory_mb, container_cpu_s: u.cpu_s, container_throttled: u.throttled });
    // A container with no usable sign-in has nothing to wait for.
    if (out.status === 'not_signed_in') await removeBox(box.key, 'not signed in');
    else if (IDLE_MS > 0) { removeAfter(box, IDLE_MS, 'idle'); prewarm(box, net); } else await removeBox(box.key, 'run end');
  }
  return { ...out, cold_container: cold, ms_container };
}

// ---------------------------------------------------------------------------------------------------------------------
// Sign-in, status and sign-out

/** `<engine>:<user hash>` to { connected, at }: what the runner knows of a sign-in, from a check, a run or a sign-in. */
const known = new Map();
const remember = (engine, user, connected) => known.set(keyOf(engine, user), { connected, at: Date.now() });

/** Sign-in id to the session. One session for each user and engine at a time. */
export const sessions = new Map();
const signingIn = (engine, user) => [...sessions.values()].some((s) => s.key === keyOf(engine, user) && s.status === 'pending');

/**
 * Whether one user has a usable sign-in for one engine. No volume: false, with no container. Else the answer of the
 * program itself (`claude auth status --json`, `codex login status`), in a container with no network and a read-only
 * volume, so the check cannot renew or change the sign-in. A run, a sign-in and a sign-out change the answer at once.
 */
export async function checkSignIn(engine, user, { now = Date.now(), fresh = false } = {}) {
  const key = keyOf(engine, user);
  if (!fresh && signingIn(engine, user)) return { connected: false, signing_in: true };
  const k = known.get(key);
  if (!fresh && k && now - k.at < STATUS_TTL_MS) return { connected: k.connected };
  if (MODE !== 'docker') {
    // Host mode uses the sign-ins of this machine. A short program that starts a renewal and ends can destroy a sign-in,
    // so the runner starts no program to check it. A run that finds no sign-in makes this false.
    return { connected: k ? k.connected : true, mode: 'host' };
  }
  if (!(await hasVolume(engine, user))) { remember(engine, user, false); return { connected: false }; }
  await ensureImage(IMAGES[engine], engine);
  const r = await docker(statusArgs({ user, engine }), { timeoutMs: 30_000 });
  const connected = engine === 'codex' ? parseCodexStatus(`${r.stdout}\n${r.stderr}`) : parseClaudeStatus(r.stdout);
  remember(engine, user, connected);
  return { connected };
}

/** POST /status: the assistants of one user, with the models a person can choose. */
export async function assistantStatus(user) {
  const [claude, codex] = await Promise.all(['claude', 'codex'].map((e) => checkSignIn(e, user).catch((err) => ({ connected: false, error: String(err.message || err).slice(0, 200) }))));
  const d = defaults();
  const entry = (engine, s) => ({ ...s, models: MODELS[engine].models, default_model: d[engine].model ?? MODELS[engine].default_model });
  return { assistants: { [ASSISTANT.claude]: entry('claude', claude), [ASSISTANT.codex]: entry('codex', codex) } };
}

/**
 * POST /connect: starts the sign-in of the unmodified program in a container of the user, on the internal network.
 * While the sign-in waits, the proxy lets that container reach the sign-in hosts (SIGNIN_ALLOW of egress-proxy.mjs).
 * Resolves when the program printed what the person needs: the URL (Claude) or the link and the one-time code (Codex).
 */
export async function startSignIn(user, engine) {
  if (MODE !== 'docker') throw Object.assign(new Error('a sign-in from the web app needs docker mode'), { status: 400 });
  const key = keyOf(engine, user);
  for (const s of sessions.values()) if (s.key === key && s.status === 'pending') cancelSignIn(s.id, 'replaced');
  const spec = SIGNIN[engine];
  const id = randomBytes(16).toString('hex');
  const t0 = Date.now();
  const s = { id, key, user: hashOf(user), engine, status: 'pending', detail: null, needs_code: spec.needs_code, t0, expires_at: new Date(t0 + CONNECT_TIMEOUT_MS).toISOString(), output: '', codeSent: false, volume: signInOf(engine, user).volume, hadVolume: await hasVolume(engine, user) };
  sessions.set(id, s);
  known.delete(key);
  log({ ev: 'signin_start', user: s.user, engine });
  try {
    // A run of the user must not share the sign-in folder with the sign-in.
    await removeBox(key, 'sign-in');
    const [net] = await Promise.all([ensureInfra(), ensureImage(IMAGES[engine], engine)]);
    s.name = `agent-pages-signin-${PORT}-${engine}-${hashOf(user)}`;
    const args = sandboxArgs({ name: s.name, user, engine, network: NET, proxy: PROXY });
    if ((await docker(args)).code !== 0) { await docker(['rm', '-f', s.name]); await must(args); }
    s.ip = await must(['inspect', '-f', `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`, s.name]);
    await allowFor(net, s.ip, { user, engine, kind: 'signin' });
    const child = spawn('docker', ['exec', '-i', s.name, ...spec.login], { env: dockerEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    s.child = child;
    s.t_spawn = Date.now();
    child.stdin.on('error', () => {});
    s.closed = new Promise((resolve) => { child.on('close', (code) => resolve(code)); child.on('error', () => resolve(null)); });
    const ready = new Promise((resolve) => {
      const read = (d) => {
        s.output = (s.output + d).slice(-16_000);
        if (engine === 'claude') { const p = parseClaudeLogin(s.output); if (p.url && p.waiting) resolve({ url: p.url }); }
        else { const p = parseCodexLogin(s.output); if (p.url && p.user_code) resolve({ url: p.url, user_code: p.user_code, expires_min: p.expires_min }); }
      };
      child.stdout.setEncoding('utf8').on('data', read);
      child.stderr.setEncoding('utf8').on('data', read);
      s.closed.then(() => resolve(null));
    });
    s.timer = setTimeout(() => endSignIn(s, 'expired', 'The sign-in waited 10 minutes for the person. Start it again.'), CONNECT_TIMEOUT_MS).unref();
    s.closed.then((code) => onLoginExit(s, code, user));
    const got = await Promise.race([ready, new Promise((r) => setTimeout(() => r('slow'), 30_000))]);
    if (!got || got === 'slow') {
      await endSignIn(s, 'failed', got === 'slow' ? `${spec.name} printed no sign-in link in 30 s.` : failureDetail(engine, s.output, { exitCode: await s.closed }));
      throw Object.assign(new Error(s.detail), { status: 502 });
    }
    Object.assign(s, got);
    log({ ev: 'signin_ready', user: s.user, engine, ms: Date.now() - t0 });
    return { id, url: got.url, ...(got.user_code ? { user_code: got.user_code } : {}), needs_code: spec.needs_code, expires_at: s.expires_at };
  } catch (e) {
    if (s.status === 'pending') await endSignIn(s, 'failed', scrub(e.message || e));
    throw e;
  }
}

/** The program of a sign-in ended. It wrote its own credential file, so the status check gives the result. */
async function onLoginExit(s, code, user) {
  if (s.status !== 'pending') return;
  const ok = code === 0 && (await checkSignIn(s.engine, user, { fresh: true })).connected;
  await endSignIn(s, ok ? 'connected' : 'failed', ok ? null : failureDetail(s.engine, s.output, { code: s.code, exitCode: code }));
}

/** Ends a session one time: stops the program and removes the container, and removes a volume that this sign-in made and did not fill. */
async function endSignIn(s, status, detail) {
  if (s.status !== 'pending') return;
  s.status = status;
  s.detail = detail ? scrub(detail, [s.code], 400) : null;
  s.code = null;
  clearTimeout(s.timer);
  // The person has the result for 10 minutes, then the session is gone.
  setTimeout(() => sessions.delete(s.id), 10 * 60 * 1000).unref();
  if (s.child && s.child.exitCode === null) {
    try { s.child.stdin.end(); } catch {}
    const ended = await Promise.race([s.closed.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
    if (!ended && s.name) { await docker(['exec', s.name, 'pkill', '-INT', '-f', SIGNIN[s.engine].login[0]], { timeoutMs: 5000 }); await Promise.race([s.closed, new Promise((r) => setTimeout(r, 5000))]); }
  }
  if (s.name) await docker(['rm', '-f', s.name]);
  if (s.ip && infra) await forget(await infra, s.ip);
  const [engine] = s.key.split(':');
  if (status === 'connected') known.set(s.key, { connected: true, at: Date.now() });
  else {
    known.delete(s.key);
    // A sign-in that did not finish leaves no volume behind, so the runner does not take the person as connected.
    if (!s.hadVolume) await docker(['volume', 'rm', s.volume]);
  }
  log({ ev: 'signin_end', user: s.user, engine, status, ms: Date.now() - s.t0, code_sent: s.codeSent, ...(s.detail ? { detail: s.detail } : {}) });
}

/** POST /connect/code: writes the pasted code to the waiting program one time. The code is in no log and no answer. */
export function sendCode(id, code) {
  const s = sessions.get(id);
  if (!s) return { status: 404, body: { error: 'no such sign-in' } };
  if (!s.needs_code) return { status: 400, body: { error: 'this sign-in takes no code' } };
  if (s.status !== 'pending') return { status: 409, body: { status: s.status } };
  if (s.codeSent) return { status: 409, body: { error: 'the code was sent already', status: s.status } };
  const bad = codeError(code);
  if (bad) return { status: 400, body: { error: bad } };
  const buf = Buffer.from(`${code}\n`, 'utf8');
  s.codeSent = true;
  // Kept only to cut it from the output of the program, and wiped when the session ends.
  s.code = code;
  try { s.child.stdin.write(buf); } finally { buf.fill(0); }
  log({ ev: 'signin_code_sent', user: s.user, engine: s.engine });
  return { status: 200, body: { status: s.status } };
}

/** POST /connect/status. */
export function signInStatus(id) {
  const s = sessions.get(id);
  if (!s) return { status: 404, body: { error: 'no such sign-in' } };
  return { status: 200, body: { status: s.status, ...(s.detail ? { detail: s.detail } : {}) } };
}

/** POST /connect/cancel: the person closed the sign-in. */
export async function cancelSignIn(id, why = 'canceled') {
  const s = sessions.get(id);
  if (!s) return { status: 404, body: { error: 'no such sign-in' } };
  await endSignIn(s, 'failed', why === 'replaced' ? 'A newer sign-in replaced this one.' : 'The sign-in was canceled.');
  return { status: 200, body: { status: s.status } };
}

/** POST /disconnect: the sign-out of the program itself, then the volume goes. The person is not connected after it. */
export async function disconnect(user, engine) {
  const key = keyOf(engine, user);
  for (const s of sessions.values()) if (s.key === key && s.status === 'pending') await cancelSignIn(s.id);
  await removeBox(key, 'sign-out');
  const t0 = Date.now();
  let logout = null;
  if (MODE === 'docker' && (await hasVolume(engine, user))) {
    const [net] = await Promise.all([ensureInfra(), ensureImage(IMAGES[engine], engine)]);
    const name = `agent-pages-signout-${PORT}-${engine}-${hashOf(user)}`;
    await docker(['rm', '-f', name]);
    await must(sandboxArgs({ name, user, engine, network: NET, proxy: PROXY }));
    const ip = await must(['inspect', '-f', `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`, name]);
    // The sign-out can revoke the token at the host of the engine, so the container gets the hosts of a run.
    await allowFor(net, ip, { user, engine, kind: 'run' });
    const r = await docker(['exec', name, ...SIGNIN[engine].logout], { timeoutMs: 60_000 });
    logout = r.code;
    await docker(['rm', '-f', name]);
    await forget(net, ip);
    await docker(['volume', 'rm', signInOf(engine, user).volume]);
  }
  remember(engine, user, false);
  log({ ev: 'signout', user: hashOf(user), engine, logout_exit: logout, ms: Date.now() - t0 });
  return { connected: false };
}

export function cleanup() {
  const env = dockerEnv();
  const ids = spawnSync('docker', ['ps', '-aq', '--filter', `label=${LABEL}`], { env, encoding: 'utf8' }).stdout?.trim();
  if (ids) spawnSync('docker', ['rm', '-f', ...ids.split(/\s+/)], { env });
  spawnSync('docker', ['network', 'rm', NET], { env });
}

/** Ends each program in the way that keeps its sign-in, then removes each Docker object of this runner. */
export async function shutdown() {
  await Promise.race([
    Promise.all([...[...sessions.values()].filter((s) => s.status === 'pending').map((s) => endSignIn(s, 'failed', 'The runner stopped.')), ...[...boxes.keys()].map((k) => removeBox(k, 'shutdown'))]),
    new Promise((r) => setTimeout(r, 60_000)),
  ]);
  cleanup();
}

// ---------------------------------------------------------------------------------------------------------------------
// Host mode through the egress proxy

/**
 * One host-mode run through its own egress proxy on 127.0.0.1 (SANDBOX_HOST_EGRESS=1). The program gets HTTPS_PROXY and
 * the connector at the proxy, so its command line has no token, and the log shows each host that it reached.
 * The proxy has the hosts of a run of that engine only. It still runs as the person of this machine, with no container.
 */
export async function runHostEgress(job, { timeoutMs = TIMEOUT_MS } = {}) {
  const engine = job.engine === 'codex' ? 'codex' : 'claude';
  const env = childEnv(engine);
  if (!env) return runJob(job, { timeoutMs });
  const p = startProxy({ secret: randomBytes(24).toString('hex'), port: 0, controlPort: 0, host: '127.0.0.1', log: (o) => {
    if (o.ev === 'tunnel' || o.ev === 'deny') log({ ev: o.ev === 'tunnel' ? 'egress_opened' : 'egress_refused', user: hashOf(job.user), engine, kind: 'host-run', profile: o.profile, host: o.host, port: o.port });
    else if (o.ev === 'mcp') log({ ev: 'egress_mcp', user: hashOf(job.user), engine, method: o.method, tool: o.tool, status: o.status });
  } });
  await new Promise((r) => (p.proxy.listening ? r() : p.proxy.once('listening', r)));
  const port = p.proxy.address().port;
  p.allowed.set('127.0.0.1', { hosts: RUN_ALLOW[engine], profile: `${engine}-host-run` });
  p.routes.set('127.0.0.1', job.mcp_url);
  const dir = mkdtempSync(join(tmpdir(), 'run-comment-'));
  const proxyEnv = { HTTPS_PROXY: `http://127.0.0.1:${port}`, HTTP_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: '127.0.0.1,localhost' };
  const bin = engine === 'codex' ? E.CODEX_BIN || 'codex' : E.CLAUDE_BIN || 'claude';
  try {
    return await runJob(job, { timeoutMs, cwd: dir, mcpUrl: `http://127.0.0.1:${port}/mcp`, exec: (_e, args) => spawn(bin, args, { cwd: dir, env: { ...env, ...proxyEnv }, stdio: ['pipe', 'pipe', 'pipe'] }) });
  } finally {
    p.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The queue and the HTTP server

/** Starts one run. Resolves with the result of runJob, plus the timings that this server measured. */
async function start(job, mode, t_received) {
  const ms_queue = Date.now() - t_received;
  log({ ev: 'run_start', comment_id: job.comment_id, user: hashOf(job.user), engine: job.engine ?? 'claude', mode, ms_queue });
  let out;
  try {
    out = mode === 'docker' ? await startDocker(job) : E.SANDBOX_HOST_EGRESS === '1' ? await runHostEgress(job) : await runJob(job, { timeoutMs: TIMEOUT_MS });
    if (mode !== 'docker' && (out.status === 'done' || out.status === 'not_signed_in')) remember(job.engine === 'codex' ? 'codex' : 'claude', job.user, out.status === 'done');
  } catch (e) {
    // The run did not start. The host must not wait for the time limit.
    out = { ok: false, status: 'failed', engine: job.engine, error: String(e.message || e).slice(0, 300) };
    if (job.callback_url) out.callback_status = await fetch(job.callback_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'failed', detail: `runner: ${out.error}` }), signal: AbortSignal.timeout(15_000) }).then((r) => r.status, () => null);
  }
  return { ...out, mode, ms_queue, ms_runner: Date.now() - t_received };
}

/**
 * A queue for each key. The jobs of one key run one after the other, so one user has one run at a time.
 * add(key, fn) returns the promise of fn(), or null when `max` jobs of the key wait already. add.pending(key) counts the
 * job that runs and the jobs that wait.
 */
export function userQueue(max) {
  /** key to { tail, pending }. `pending` counts the job that runs and the jobs that wait. */
  const queues = new Map();
  const add = (key, fn) => {
    const q = queues.get(key) ?? { tail: Promise.resolve(), pending: 0 };
    if (q.pending > max) return null;
    queues.set(key, q);
    q.pending++;
    const next = q.tail.then(fn);
    q.tail = next.catch(() => {}).then(() => { if (--q.pending === 0) queues.delete(key); });
    return next;
  };
  add.pending = (key) => queues.get(key)?.pending ?? 0;
  return add;
}
const queue = userQueue(MAX_QUEUE);
const enqueue = (job, mode, t_received) => {
  const key = `${mode}:${hashOf(job.user)}`;
  const ahead = queue.pending(key);
  const run = queue(key, () => start(job, mode, t_received));
  if (run && ahead) log({ ev: 'queued', comment_id: job.comment_id, user: hashOf(job.user), engine: job.engine ?? 'claude', ahead });
  return run;
};

/** What the log keeps of a run. `detail` and `error` come from run-comment.mjs, which removes the connector URL. */
const summary = (job, o) => ({
  ev: 'run', comment_id: job.comment_id, slug: job.slug, user: hashOf(job.user), engine: o.engine, model: o.model, status: o.status, mode: o.mode, warm: o.warm, cold_container: o.cold_container,
  ms_queue: o.ms_queue, ms_container: o.ms_container, ms_discard: o.ms_discard, ms_init: o.ms_init, ms_first_token: o.ms_first_token, ms_first_tool: o.ms_first_tool, ms_reply: o.ms_reply, ms_callback: o.ms_callback, ms_engine: o.ms_engine, ms_runner: o.ms_runner,
  num_turns: o.num_turns, total_cost_usd: o.total_cost_usd, peak_memory_mb: o.peak_memory_mb, container_cpu_s: o.container_cpu_s, container_throttled: o.container_throttled, container: o.container, tools: o.tool_calls?.map((t) => `${t.name}@${t.ms}`).join(' '), timeline: o.timeline?.map(([ms, l]) => `${l}@${ms}`).join(' '),
  callback_status: o.callback_status, progress_sent: o.progress_sent, progress_accepted: o.progress_accepted, error: o.error && String(o.error).replaceAll(job.callback_url ?? '\0', '<callback_url>').replaceAll(job.mcp_url ?? '\0', '<mcp_url>').slice(0, 300),
});

const ENGINE_OF = { claude: 'claude', codex: 'codex', chatgpt: 'codex' };
const ROUTES = new Set(['/run', '/warm', '/status', '/connect', '/connect/code', '/connect/status', '/connect/cancel', '/disconnect']);

const handle = (req, res) => {
  const t_received = Date.now();
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, mode: MODE });
  if (req.method !== 'POST' || !ROUTES.has(req.url)) return send(404, { error: `POST ${[...ROUTES].join(', ')}` });
  if (SECRET && !sameSecret(req.headers['x-runner-secret'], SECRET)) { log({ ev: 'refused', cause: 'secret', route: req.url }); return send(401, { error: 'the header x-runner-secret is missing or wrong' }); }
  const chunks = [];
  let size = 0;
  req.on('data', (d) => { size += d.length; if (size <= MAX_BODY) chunks.push(d); });
  req.on('end', async () => {
    let job;
    const raw = Buffer.concat(chunks);
    try {
      job = JSON.parse(raw.toString('utf8'));
    } catch {}
    // The body of /connect/code has the code. The buffer is wiped once it is parsed.
    raw.fill(0);
    if (!job || typeof job !== 'object' || size > MAX_BODY) return send(400, { error: 'send JSON of at most 64 KB' });
    const engineOf = (v, dflt) => (v === undefined ? dflt : ENGINE_OF[v]);
    try {
      if (req.url === '/warm') {
        const engine = engineOf(job.engine, 'claude');
        if (!engine) return send(400, { error: 'engine must be claude or codex' });
        const bad = job.model !== undefined || job.effort !== undefined ? jobError({ mcp_url: 'http://x/', comment_id: '0'.repeat(24), slug: 'a/b', agent_label: 'a', model: job.model, effort: job.effort }) : null;
        if (bad) return send(400, { error: bad });
        if (MODE !== 'docker' || WARM_MS <= 0) return send(200, { ok: true, warm: false });
        send(202, { accepted: true });
        const t0 = Date.now();
        return void warmUp(job.user, engine, { model: job.model, effort: job.effort }).then((r) => log({ ev: 'warm', user: hashOf(job.user), engine, ...r, ms: Date.now() - t0 }), (e) => log({ ev: 'warm_failed', error: String(e.message || e).slice(0, 200) }));
      }
      if (req.url === '/status') return send(200, await assistantStatus(job.user));
      if (req.url === '/connect' || req.url === '/disconnect') {
        const engine = engineOf(job.engine, null);
        if (!engine) return send(400, { error: 'engine must be claude or codex' });
        return send(200, req.url === '/connect' ? await startSignIn(job.user, engine) : await disconnect(job.user, engine));
      }
      if (req.url.startsWith('/connect/')) {
        if (typeof job.id !== 'string') return send(400, { error: 'id must be the id that /connect returned' });
        const r = req.url === '/connect/code' ? sendCode(job.id, job.code) : req.url === '/connect/status' ? signInStatus(job.id) : await cancelSignIn(job.id);
        job.code = null;
        return send(r.status, r.body);
      }
    } catch (e) {
      return send(e.status ?? 500, { error: scrub(e.message || e) });
    }
    const { mode = MODE, ...rest } = job;
    if (mode !== 'host' && mode !== 'docker') return send(400, { error: 'mode must be host or docker' });
    const bad = jobError(rest) ?? (originAllowed(rest.mcp_url, ORIGINS) && (rest.callback_url === undefined || originAllowed(rest.callback_url, ORIGINS)) ? null : 'mcp_url and callback_url must have an origin of SANDBOX_CONNECTOR_ORIGINS');
    if (bad) return send(400, { error: bad });
    const run = enqueue(rest, mode, t_received);
    if (!run) { log({ ev: 'refused', cause: 'queue', user: hashOf(rest.user) }); return send(429, { error: `${MAX_QUEUE} jobs of this user wait already` }); }
    const done = run.then((out) => { log(summary(rest, out)); return out; });
    if (rest.callback_url) return send(202, { accepted: true, mode });
    send(200, await done);
  });
};

/** Starts the HTTP server on the loopback addresses. `localhost` is ::1 for some clients and 127.0.0.1 for others. */
export function serve(port = PORT) {
  return ['127.0.0.1', '::1'].map((host) => createServer(handle).on('error', (e) => log({ ev: 'no_listener', host, error: e.message })).listen(port, host));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (MODE === 'host' && !hostEnv()) { console.error('host mode needs HOME and USER in the environment. Claude Code finds its sign-in with them.'); process.exit(1); }
  serve();
  log({ ev: 'start', url: `http://localhost:${PORT}/run`, mode: MODE, secret: !!SECRET, idle_ms: IDLE_MS, warm_ms: WARM_MS, discover: !!(discoverOrigin && SECRET), prewarm: PREWARM, max_queue: MAX_QUEUE, limits: LIMITS });
  if (MODE === 'docker') {
    ensureInfra().catch((e) => log({ ev: 'infra_failed', error: String(e.message || e).slice(0, 300) }));
    // A changed image builds now, not at the first job of the engine.
    for (const e of ['claude', 'codex']) ensureImage(IMAGES[e], e).catch((err) => log({ ev: 'build_failed', image: IMAGES[e], error: String(err.message || err).slice(0, 300) }));
    let stopping = false;
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { if (stopping) { cleanup(); process.exit(1); } stopping = true; log({ ev: 'stopping', containers: boxes.size }); shutdown().finally(() => process.exit(0)); });
  }
}
