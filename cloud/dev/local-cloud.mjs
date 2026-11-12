#!/usr/bin/env node
// The cloud runner on one machine, with Docker in place of Cloudflare Containers. It has no dependencies.
//
//   RUNNER_SECRET=<the SANDBOX_RUNNER_SECRET of the host> node cloud/dev/local-cloud.mjs [--port 8815]
//
// What is real: the HTTP front and the Durable Object logic (src/core.mjs, unchanged), the image that Cloudflare runs
// (cloud/agentd/claude.Dockerfile with agentd), the firewall and the proxy of agentd, the archive of the sign-in folder,
// and the host on localhost. What stands in for the platform:
//   ctx.container.start / destroy     docker run / docker rm, with the CPU and memory of standard-1 (1/2 vCPU, 4 GiB)
//   ctx.container.getTcpPort(8080)    a port on 127.0.0.1 that Docker publishes
//   interceptOutboundHttp(runner.internal)   --add-host runner.internal:host-gateway and a server on port+1 of this
//                                     process. It finds the Durable Object by the agentd token of the request.
//   Durable Object storage and alarms a Map and setTimeout, in memory
//   R2                                files in .cloudflare/state-cloud/r2 (the bytes are the sealed archives)
// A sign-in for the test: CLOUD_VOLUME=<docker volume> CLOUD_VOLUME_USER=<identity> mounts an existing sign-in volume
// as the folder of that user (agentd: AGENTD_DIR_PERSISTENT=1). The runs then renew the sign-in in the volume itself, as
// local-runner.mjs does, and no copy of it exists that could renew apart from it. dev/archive-roundtrip.mjs proves the
// archive path (seal, store, restore, still signed in) with no network.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, RunnerCore, userKey } from '../src/core.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const PORT = +arg('port', process.env.RUNNER_PORT || 8815);
const UP_PORT = PORT + 1;
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, '..', '.cloudflare', 'state-cloud', 'r2');
const LABEL = `agent-pages-cloud=${PORT}`;
const IMAGES = { claude: process.env.CLOUD_CLAUDE_IMAGE || 'agent-pages-agentd-claude', codex: process.env.CLOUD_CODEX_IMAGE || 'agent-pages-agentd-codex' };
const LIMITS = { claude: { cpus: '0.5', memory: '4g' }, codex: { cpus: '0.5', memory: '4g' } };
const env = { ...process.env, HOST_ORIGINS: process.env.HOST_ORIGINS || '', DISCOVER_ORIGIN: process.env.DISCOVER_ORIGIN || '' };
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const dockerEnv = () => Object.fromEntries(['PATH', 'HOME', 'USER', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const docker = (args, opts = {}) => spawnSync('docker', args, { env: dockerEnv(), encoding: 'utf8', timeout: 60_000, ...opts });

function storage(key) {
  const m = new Map();
  let timer = null, at = null;
  return {
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async (k) => m.delete(k),
    getAlarm: async () => at,
    setAlarm: async (t) => { at = t; clearTimeout(timer); timer = setTimeout(() => { at = null; cores.get(key)?.alarm().catch((e) => log({ ev: 'alarm_error', error: String(e.message) })); }, Math.max(0, t - Date.now())); timer.unref?.(); },
  };
}

const r2 = {
  path: (k) => join(STATE, ...k.split('/')),
  get: async (k) => { const p = r2.path(k); return existsSync(p) ? new Uint8Array(readFileSync(p)) : null; },
  put: async (k, b) => { const p = r2.path(k); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, b, { mode: 0o600 }); },
  delete: async (k) => rmSync(r2.path(k), { force: true }),
};

const VOLUME = process.env.CLOUD_VOLUME || null;
let volumeKey = null;
function container(key) {
  const name = `agent-pages-cloud-${PORT}-${key.slice(0, 12)}`;
  const c = {
    port: null, isRunning: false,
    get running() { return c.isRunning; },
    async start({ image, env: e }) {
      docker(['rm', '-f', name]);
      const lim = LIMITS[image];
      const dir = image === 'codex' ? '/codex-home' : '/claude-config';
      const args = ['run', '-d', '--name', name, '--label', LABEL, '--init',
        // The controls of the Cloudflare instance that agentd cannot set itself: CPU and memory of standard-1, no inbound port but 8080.
        '--cpus', lim.cpus, '--memory', lim.memory, '--pids-limit', '256',
        // Cloudflare gives agentd root capabilities. Here it gets only the ones it uses: the firewall, and the start of each program as uid 10001.
        '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'KILL', '--security-opt', 'no-new-privileges',
        '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700', ...(VOLUME && key === volumeKey ? ['-v', `${VOLUME}:${dir}`, '-e', 'AGENTD_DIR_PERSISTENT=1'] : ['--tmpfs', `${dir}:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=0700`]),
        '--add-host', 'runner.internal:host-gateway', '-p', '127.0.0.1::8080',
        '-e', `AGENTD_UPSTREAM=http://runner.internal:${UP_PORT}`, ...Object.entries(e).flatMap(([k, v]) => ['-e', `${k}=${v}`]), IMAGES[image]];
      const r = docker(args);
      if (r.status !== 0) throw new Error(`docker run: ${r.stderr.trim().split('\n').pop()}`);
      c.port = docker(['port', name, '8080']).stdout.trim().split('\n')[0].split(':').pop();
      c.isRunning = true;
      spawn('docker', ['wait', name], { env: dockerEnv(), stdio: 'ignore' }).on('close', () => { c.isRunning = false; }).unref();
      spawn('docker', ['logs', '-f', name], { env: dockerEnv(), stdio: ['ignore', 'inherit', 'inherit'] }).unref();
    },
    async destroy() { docker(['rm', '-f', name]); c.isRunning = false; },
    async setInactivityTimeout() {},
    async intercept() {},
    async agentd(path, body, { token, ms = 15_000 } = {}) {
      const res = await fetch(`http://127.0.0.1:${c.port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-agentd-token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(ms) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
  };
  return c;
}

const cores = new Map();
const host = { fetch: (url, init) => fetch(url, init) };
const coreOf = (key) => {
  if (!cores.has(key)) cores.set(key, new RunnerCore({ key, storage: storage(key), container: container(key), r2, host, env }));
  return cores.get(key);
};

/** The intercept of runner.internal: the Durable Object whose box has this agentd token. */
const upstream = createServer(async (req, res) => {
  const token = req.headers['x-agentd-token'];
  let core = null;
  for (const c of cores.values()) if ((await c.storage.get('box'))?.token === token) core = c;
  const chunks = [];
  for await (const d of req) chunks.push(d);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = core ? await core.fromContainer(new Request(`http://runner.internal${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : body })) : new Response('no', { status: 401 });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});

export function cleanup() {
  const ids = docker(['ps', '-aq', '--filter', `label=${LABEL}`]).stdout?.trim();
  if (ids) docker(['rm', '-f', ...ids.split(/\s+/)]);
}

upstream.listen(UP_PORT, '127.0.0.1');
createServer(async (req, res) => {
  const chunks = [];
  for await (const d of req) chunks.push(d);
  const r = await handle(new Request(`http://runner${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) }), env, coreOf).catch((e) => new Response(JSON.stringify({ error: String(e.message) }), { status: 500 }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, '127.0.0.1');
log({ ev: 'start', url: `http://localhost:${PORT}/run`, upstream: UP_PORT, images: IMAGES, secret: !!env.RUNNER_SECRET });
if (VOLUME) {
  volumeKey = await userKey(process.env.CLOUD_VOLUME_USER || 'local');
  await coreOf(volumeKey).setConn('claude', { connected: true, gen: 0 });
  log({ ev: 'volume', user: volumeKey.slice(0, 12), volume: VOLUME });
}
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { for (const c of cores.values()) await c.stopBox('runner end').catch(() => {}); cleanup(); process.exit(0); });
