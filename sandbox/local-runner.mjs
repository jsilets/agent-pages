#!/usr/bin/env node
// The runner: an HTTP server that takes the jobs of the host and runs each one in a sandbox. It has no dependencies.
// It listens on the loopback addresses only.
//
//   node sandbox/local-runner.mjs [--mode host|docker] [--port 8811]
//
// POST /run    takes the job JSON of run-comment.mjs, plus an optional `mode`. With SANDBOX_RUNNER_SECRET set, the
//              request needs that value in the header x-runner-secret.
// POST /warm   body { "user": "…" }. docker mode: starts the container of the user before a job exists.
// GET  /health
//   host    runs Claude Code or Codex as installed and signed in on this machine.
//   docker  runs them in one container for each user, with the controls that README.md lists.
// With `callback_url` in the job, the server answers 202 at once, and the run reports to that URL.
// With no `callback_url`, the server waits and answers with the JSON of the run.
//
// Environment (all optional):
//   SANDBOX_RUNNER_SECRET     the shared secret of the host and the runner
//   SANDBOX_IDLE_MS           how long the container of a user stays after a run. Default 600000. 0: one container for each run.
//   SANDBOX_PREWARM           0: do not start Claude Code before the next job arrives. Default 1.
//   SANDBOX_MAX_QUEUE         how many jobs of one user can wait. Default 5.
//   SANDBOX_MEMORY, SANDBOX_CPUS, SANDBOX_PIDS   the limits of a container. Default 1g, 2, 256.
//   SANDBOX_EGRESS_ALLOW      a comma list of hosts for the egress proxy, in place of its default list
//   SANDBOX_CONNECTOR_ORIGINS a comma list of origins. A job with another origin in mcp_url or callback_url gets 400.
//   SANDBOX_CLAUDE_MODEL, SANDBOX_CLAUDE_EFFORT, SANDBOX_CODEX_MODEL, SANDBOX_CODEX_EFFORT   for a job that names none
//   SANDBOX_IMAGE, SANDBOX_EGRESS_IMAGE, RUN_TIMEOUT_MS, RUNNER_PORT, RUNNER_MODE
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, ENGINE_ENV, jobError, runJob, warmClaude, mcpConfig } from './run-comment.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const E = process.env;
const PORT = +arg('port', E.RUNNER_PORT || 8811);
const MODE = arg('mode', E.RUNNER_MODE || 'host');
export const IMAGE = E.SANDBOX_IMAGE || 'agent-pages-sandbox';
export const EGRESS_IMAGE = E.SANDBOX_EGRESS_IMAGE || 'agent-pages-egress';
const SECRET = E.SANDBOX_RUNNER_SECRET || '';
const IDLE_MS = E.SANDBOX_IDLE_MS === undefined ? 600_000 : +E.SANDBOX_IDLE_MS;
const PREWARM = E.SANDBOX_PREWARM !== '0' && IDLE_MS > 0;
const MAX_QUEUE = E.SANDBOX_MAX_QUEUE === undefined ? 5 : +E.SANDBOX_MAX_QUEUE;
const LIMITS = { memory: E.SANDBOX_MEMORY || '1g', cpus: E.SANDBOX_CPUS || '2', pids: E.SANDBOX_PIDS || '256' };
const TIMEOUT_MS = +E.RUN_TIMEOUT_MS || 180_000;
const ORIGINS = (E.SANDBOX_CONNECTOR_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 64 * 1024;
/** The names of the Docker objects of this runner. Two runners on two ports do not share one. */
const NET = `agent-pages-sandbox-${PORT}`;
const PROXY = `agent-pages-egress-${PORT}`;
const LABEL = `agent-pages-runner=${PORT}`;

/** One JSON line for each event. No line has a token, a URL of the connector, or a run id. */
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

export const hashOf = (user) => createHash('sha256').update(String(user || 'local')).digest('hex').slice(0, 16);
/** The volume that holds the Claude sign-in of one user. The name has a hash, so it shows no email address. */
export const volumeOf = (user) => `agent-pages-claude-${hashOf(user)}`;
/** The volume that holds the ChatGPT sign-in of one user, as CODEX_HOME. */
export const codexVolumeOf = (user) => `agent-pages-codex-${hashOf(user)}`;

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

/**
 * The `docker run` arguments of the container of one user. Each control is one line.
 * tests/sandbox.test.mjs checks the list, and verify-controls.mjs tries each forbidden thing in a real container.
 */
export function sandboxArgs({ name, user, network, proxy, image = IMAGE, limits = LIMITS, label = LABEL }) {
  return [
    'run', '-d', '--name', name, '--label', label,
    // tini is process 1. It removes each program that ends, and it stops at once when the runner removes the container.
    '--init',
    // The root file system is read-only. /tmp is memory, and no program can run from it.
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700',
    // No Linux capability, and no program can get more rights than its parent.
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', String(limits.pids), '--memory', String(limits.memory), '--memory-swap', String(limits.memory), '--cpus', String(limits.cpus),
    // The network has no route to the outside. The egress proxy is the only other machine on it. No port is published.
    '--network', network,
    // The two sign-in folders of this user are the only folders that keep data.
    '-v', `${volumeOf(user)}:/claude-config`, '-v', `${codexVolumeOf(user)}:/codex-home`,
    // The image sets USER runner (uid 10001), HOME=/tmp, CLAUDE_CONFIG_DIR and CODEX_HOME.
    '--user', '10001:10001',
    '-e', `HTTPS_PROXY=http://${proxy}:3128`, '-e', `HTTP_PROXY=http://${proxy}:3128`, '-e', `NO_PROXY=${proxy}`,
    ...Object.entries(ENGINE_ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    image,
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Docker

/** The docker program gets what it needs to find the Docker daemon. No container gets these variables. */
const dockerEnv = () => pick(process.env, ['PATH', 'HOME', 'USER', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT']);

function docker(args, { env = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { env: { ...dockerEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: String(e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}
const must = async (args, opts) => { const r = await docker(args, opts); if (r.code !== 0) throw new Error(`docker ${args[0]} ${args[1] ?? ''}: ${r.stderr.split('\n').pop() || `exit code ${r.code}`}`); return r.stdout; };

let infra = null;
/** The network and the egress proxy. One time for the life of the runner. */
export function ensureInfra() {
  return (infra ??= (async () => {
    const t0 = Date.now();
    const secret = randomBytes(32).toString('base64url');
    for (const [image, target] of [[IMAGE, []], [EGRESS_IMAGE, ['--target', 'egress']]]) {
      if ((await docker(['image', 'inspect', '-f', '{{.Id}}', image])).code === 0) continue;
      log({ ev: 'build', image });
      await must(['build', ...target, '-t', image, HERE], { timeoutMs: 900_000 });
    }
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
    log({ ev: 'infra', network: NET, proxy: PROXY, ms: Date.now() - t0 });
    return { control, mcpUrl: `http://${PROXY}:3128/mcp` };
  })().catch((e) => { infra = null; throw e; }));
}

/** user key to { name, ip, warm, idle }. */
export const boxes = new Map();

export async function removeBox(key, why) {
  const box = boxes.get(key);
  if (!box) return;
  boxes.delete(key);
  clearTimeout(box.idle);
  box.warm?.discard();
  await docker(['rm', '-f', box.name]);
  log({ ev: 'container_removed', user: key, why });
}

/** The running container of a user. Starts one when the user has none. */
export async function ensureBox(user) {
  const key = hashOf(user);
  let box = boxes.get(key);
  if (box) { clearTimeout(box.idle); return { box, cold: false }; }
  const name = `agent-pages-sbx-${PORT}-${key}`;
  const args = sandboxArgs({ name, user, network: NET, proxy: PROXY });
  // A container with this name can stay after a failure. Remove it and try one more time.
  if ((await docker(args)).code !== 0) { await docker(['rm', '-f', name]); await must(args); }
  const ip = await must(['inspect', '-f', `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`, name]);
  box = { key, name, ip, warm: null, idle: null };
  boxes.set(key, box);
  // A program in the container can stop the container. `docker wait` ends at that moment, so the next job gets a new container.
  const live = box;
  spawn('docker', ['wait', name], { env: dockerEnv(), stdio: 'ignore' }).on('close', () => { if (boxes.get(key) === live) removeBox(key, 'exited'); }).on('error', () => {}).unref();
  return { box, cold: true };
}

export const execIn = (box) => (engine, args) => spawn('docker', ['exec', '-i', box.name, engine === 'codex' ? 'codex' : 'claude', ...args], { env: dockerEnv(), stdio: ['pipe', 'pipe', 'pipe'] });

/** Starts Claude Code in the container before the next job arrives, when the proxy can answer its first connector requests. */
async function prewarm(box, { control, mcpUrl }) {
  if (!PREWARM || !boxes.has(box.key) || (box.warm && !box.warm.dead)) return;
  try {
    const { cached } = await control('GET', '/health');
    if (!cached.includes('tools/list')) return;
    const d = defaults().claude;
    box.warm = warmClaude({ exec: execIn(box), mcp: mcpConfig(mcpUrl), model: d.model, effort: d.effort });
  } catch {}
}

const idleLater = (box) => {
  clearTimeout(box.idle);
  if (IDLE_MS > 0) box.idle = setTimeout(() => removeBox(box.key, 'idle'), IDLE_MS).unref();
};

export async function startDocker(job) {
  const t0 = Date.now();
  const net = await ensureInfra();
  const { box, cold } = await ensureBox(job.user);
  const ms_container = Date.now() - t0;
  await net.control('PUT', `/route/${box.ip}`, { mcp_url: forDocker(job.mcp_url) });
  const warm = box.warm;
  box.warm = null;
  let out;
  try {
    out = await runJob(job, { exec: execIn(box), mcpUrl: net.mcpUrl, warm, cwd: '/work', timeoutMs: TIMEOUT_MS, kill: () => removeBox(box.key, 'timeout'), stop: () => docker(['exec', box.name, 'pkill', '-KILL', '-x', 'codex']) });
  } finally {
    await net.control('DELETE', `/route/${box.ip}`).catch(() => {});
  }
  if (boxes.has(box.key)) {
    // The most memory that the container used since its start, from the cgroup of the container.
    const peak = await docker(['exec', box.name, 'cat', '/sys/fs/cgroup/memory.peak'], { timeoutMs: 5000 });
    if (peak.code === 0) out.peak_memory_mb = Math.round(+peak.stdout / 1048576);
    if (IDLE_MS > 0) { idleLater(box); prewarm(box, net); } else await removeBox(box.key, 'run end');
  }
  return { ...out, cold_container: cold, ms_container };
}

export function cleanup() {
  const env = dockerEnv();
  const ids = spawnSync('docker', ['ps', '-aq', '--filter', `label=${LABEL}`], { env, encoding: 'utf8' }).stdout?.trim();
  if (ids) spawnSync('docker', ['rm', '-f', ...ids.split(/\s+/)], { env });
  spawnSync('docker', ['network', 'rm', NET], { env });
}

// ---------------------------------------------------------------------------------------------------------------------
// The queue and the HTTP server

/** Starts one run. Resolves with the result of runJob, plus the timings that this server measured. */
async function start(job, mode, t_received) {
  const ms_queue = Date.now() - t_received;
  let out;
  try {
    out = mode === 'docker' ? await startDocker(job) : await runJob(job, { timeoutMs: TIMEOUT_MS });
  } catch (e) {
    // The run did not start. The host must not wait for the time limit.
    out = { ok: false, status: 'failed', engine: job.engine, error: String(e.message || e).slice(0, 300) };
    if (job.callback_url) out.callback_status = await fetch(job.callback_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'failed', detail: `runner: ${out.error}` }), signal: AbortSignal.timeout(15_000) }).then((r) => r.status, () => null);
  }
  return { ...out, mode, ms_queue, ms_runner: Date.now() - t_received };
}

/**
 * A queue for each key. The jobs of one key run one after the other, so one user has one run at a time.
 * add(key, fn) returns the promise of fn(), or null when `max` jobs of the key wait already.
 */
export function userQueue(max) {
  /** key to { tail, pending }. `pending` counts the job that runs and the jobs that wait. */
  const queues = new Map();
  return (key, fn) => {
    const q = queues.get(key) ?? { tail: Promise.resolve(), pending: 0 };
    if (q.pending > max) return null;
    queues.set(key, q);
    q.pending++;
    const next = q.tail.then(fn);
    q.tail = next.catch(() => {}).then(() => { if (--q.pending === 0) queues.delete(key); });
    return next;
  };
}
const queue = userQueue(MAX_QUEUE);
const enqueue = (job, mode, t_received) => queue(`${mode}:${hashOf(job.user)}`, () => start(job, mode, t_received));

/** What the log keeps of a run. `detail` and `error` come from run-comment.mjs, which removes the connector URL. */
const summary = (job, o) => ({
  ev: 'run', comment_id: job.comment_id, slug: job.slug, user: hashOf(job.user), engine: o.engine, model: o.model, status: o.status, mode: o.mode, warm: o.warm, cold_container: o.cold_container,
  ms_queue: o.ms_queue, ms_container: o.ms_container, ms_init: o.ms_init, ms_first_token: o.ms_first_token, ms_first_tool: o.ms_first_tool, ms_reply: o.ms_reply, ms_callback: o.ms_callback, ms_engine: o.ms_engine, ms_runner: o.ms_runner,
  num_turns: o.num_turns, total_cost_usd: o.total_cost_usd, peak_memory_mb: o.peak_memory_mb, tools: o.tool_calls?.map((t) => `${t.name}@${t.ms}`).join(' '), timeline: o.timeline?.map(([ms, l]) => `${l}@${ms}`).join(' '),
  callback_status: o.callback_status, progress_sent: o.progress_sent, progress_accepted: o.progress_accepted, error: o.error && String(o.error).replaceAll(job.callback_url ?? '\0', '<callback_url>').replaceAll(job.mcp_url ?? '\0', '<mcp_url>').slice(0, 300),
});

const handle = (req, res) => {
  const t_received = Date.now();
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, mode: MODE });
  if (req.method !== 'POST' || (req.url !== '/run' && req.url !== '/warm')) return send(404, { error: 'POST /run' });
  if (SECRET && !sameSecret(req.headers['x-runner-secret'], SECRET)) { log({ ev: 'refused', cause: 'secret' }); return send(401, { error: 'the header x-runner-secret is missing or wrong' }); }
  let body = '';
  req.setEncoding('utf8').on('data', (d) => { if (body.length <= MAX_BODY) body += d; });
  req.on('end', async () => {
    let job;
    try {
      job = JSON.parse(body);
    } catch {}
    if (!job || typeof job !== 'object' || body.length > MAX_BODY) return send(400, { error: 'send the job as JSON of at most 64 KB' });
    if (req.url === '/warm') {
      // With no idle time, nothing would remove a container that gets no job.
      if (MODE !== 'docker' || IDLE_MS <= 0) return send(200, { ok: true, warm: false });
      send(202, { accepted: true });
      return void ensureInfra().then(async (net) => { const { box } = await ensureBox(job.user); idleLater(box); await prewarm(box, net); }).catch((e) => log({ ev: 'warm_failed', error: String(e.message || e).slice(0, 200) }));
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

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (MODE === 'host' && !hostEnv()) { console.error('host mode needs HOME and USER in the environment. Claude Code finds its sign-in with them.'); process.exit(1); }
  // The server listens on the loopback addresses only. `localhost` is ::1 for some clients and 127.0.0.1 for others.
  for (const host of ['127.0.0.1', '::1']) createServer(handle).on('error', (e) => log({ ev: 'no_listener', host, error: e.message })).listen(PORT, host);
  log({ ev: 'start', url: `http://localhost:${PORT}/run`, mode: MODE, secret: !!SECRET, idle_ms: IDLE_MS, prewarm: PREWARM, max_queue: MAX_QUEUE, limits: LIMITS });
  if (MODE === 'docker') {
    ensureInfra().catch((e) => log({ ev: 'infra_failed', error: String(e.message || e).slice(0, 300) }));
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { cleanup(); process.exit(0); });
  }
}
