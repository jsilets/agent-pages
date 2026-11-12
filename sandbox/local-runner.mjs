#!/usr/bin/env node
// A small HTTP server for local tests of the sandbox. It has no dependencies. Do not expose it to a network.
//
//   node sandbox/local-runner.mjs [--mode host|docker] [--port 8811]
//
// POST /run takes the job JSON of run-comment.mjs, plus an optional `mode` and `user`.
//   host    runs run-comment.mjs with the `claude` or the `codex` that is installed and signed in on this machine.
//   docker  runs the same script in the image, with one named volume for each user as CLAUDE_CONFIG_DIR.
// With `callback_url` in the job, the server answers 202 at once, and run-comment.mjs reports to that URL.
// With no `callback_url`, the server waits and answers with the JSON of the run.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const PORT = +arg('port', process.env.RUNNER_PORT || 8811);
const MODE = arg('mode', process.env.RUNNER_MODE || 'host');
const IMAGE = process.env.SANDBOX_IMAGE || 'agent-pages-sandbox';
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'run-comment.mjs');
const MAX_BODY = 64 * 1024;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** The volume that holds the Claude sign-in of one user. The name has a hash, so it shows no email address. */
export const volumeOf = (user) => `agent-pages-claude-${createHash('sha256').update(String(user || 'local')).digest('hex').slice(0, 16)}`;

/** A container reaches the dev server of this machine as host.docker.internal, not as localhost. */
export const forDocker = (url) => (typeof url === 'string' ? url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/, '$1host.docker.internal') : url);

/** The named variables of an environment that have a value. A child gets these and no other variable of this process. */
const pick = (env, keys) => Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, env[k]]));

/** The environment of run-comment.mjs in host mode. Null with no HOME or no USER: Claude Code needs both to find its sign-in. */
export function hostEnv(env = process.env) {
  return env.HOME && env.USER ? pick(env, ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'CLAUDE_BIN', 'CODEX_BIN', 'CODEX_HOME', 'RUN_TIMEOUT_MS']) : null;
}

/** Starts one run. Resolves with the JSON that run-comment.mjs printed, plus the timings that this server measured. */
function start(job, mode) {
  const t0 = Date.now();
  let cmd, args, env;
  if (mode === 'docker') {
    job = { ...job, mcp_url: forDocker(job.mcp_url), callback_url: forDocker(job.callback_url) };
    cmd = 'docker';
    args = ['run', '--rm', '-i', '--add-host', 'host.docker.internal:host-gateway', '-v', `${volumeOf(job.user)}:/claude-config`, IMAGE];
    // The docker program gets what it needs to find the Docker daemon. The container gets none of these variables.
    env = pick(process.env, ['PATH', 'HOME', 'USER', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT']);
  } else {
    // Node starts each binary from PATH with no shell, so no alias applies. Claude Code and Codex read their own sign-in.
    // run-comment.mjs passes on only the variables in its childEnv, and it adds CLAUDE_CONFIG_DIR=$HOME/.claude.
    cmd = process.execPath;
    args = [SCRIPT];
    env = hostEnv();
    if (!env) return Promise.resolve({ ok: false, status: 'failed', error: 'host mode needs HOME and USER in the environment', mode, ms_runner: 0 });
  }
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => resolve({ ok: false, status: 'failed', error: `cannot start ${cmd}: ${e.message}`, mode, ms_runner: Date.now() - t0 }));
    child.on('close', (code) => {
      let out;
      try {
        out = JSON.parse(stdout.trim().split('\n').pop());
      } catch {
        out = { ok: false, status: 'failed', error: `${cmd} ended with exit code ${code} and no JSON`, stderr_tail: stderr.slice(-2000) };
      }
      // ms_start is the time before run-comment.mjs runs its first line: the start of Node in host mode, the start of the container in docker mode.
      resolve({ ...out, mode, ms_runner: Date.now() - t0, ms_start: out.t_start ? Date.parse(out.t_start) - t0 : null });
    });
    child.stdin.end(JSON.stringify(job));
  });
}

/** Runs for one user go one after the other, because they share one CLAUDE_CONFIG_DIR. */
const queues = new Map();
function enqueue(job, mode) {
  const key = `${mode}:${job.user || 'local'}`;
  const next = (queues.get(key) ?? Promise.resolve()).then(() => start(job, mode));
  queues.set(key, next.catch(() => {}));
  return next;
}

/** When run-comment.mjs could not report, this server reports the failure, so the host does not wait for the time limit. */
async function reportIfSilent(job, out) {
  if (!job.callback_url || (out.callback_status >= 200 && out.callback_status < 300)) return;
  try {
    await fetch(job.callback_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: out.status === 'done' ? 'done' : out.status || 'failed', detail: out.detail || out.error }), signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    log('callback failed', e.message);
  }
}

const summary = (o) => ({ status: o.status, mode: o.mode, t_start: o.t_start, t_first_tool: o.t_first_tool, ms_runner: o.ms_runner, ms_start: o.ms_start, ms_auth: o.ms_auth, engine: o.engine, model: o.model, ms_engine: o.ms_engine, ms_first_tool: o.ms_first_tool, num_turns: o.num_turns, total_cost_usd: o.total_cost_usd, tools: o.tool_calls?.map((t) => `${t.name}@${t.ms}`).join(' '), callback_status: o.callback_status, error: o.error });

const handle = (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, mode: MODE });
  if (req.method !== 'POST' || req.url !== '/run') return send(404, { error: 'POST /run' });
  let body = '';
  req.setEncoding('utf8').on('data', (d) => { if (body.length <= MAX_BODY) body += d; });
  req.on('end', async () => {
    let job;
    try {
      job = JSON.parse(body);
    } catch {}
    if (!job || typeof job !== 'object' || body.length > MAX_BODY) return send(400, { error: 'send the job as JSON of at most 64 KB' });
    const { mode = MODE, ...rest } = job;
    if (mode !== 'host' && mode !== 'docker') return send(400, { error: 'mode must be host or docker' });
    log('run', mode, rest.slug, rest.comment_id);
    const done = enqueue(rest, mode).then(async (out) => {
      await reportIfSilent(rest, out);
      log('end', rest.comment_id, JSON.stringify(summary(out)));
      return out;
    });
    if (rest.callback_url) return send(202, { accepted: true, mode });
    send(200, await done);
  });
};

// The server listens on the loopback addresses only. `localhost` is ::1 for some clients and 127.0.0.1 for others.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (MODE === 'host' && !hostEnv()) { console.error('host mode needs HOME and USER in the environment. Claude Code finds its sign-in with them.'); process.exit(1); }
  for (const host of ['127.0.0.1', '::1']) createServer(handle).on('error', (e) => log(`no listener on ${host}: ${e.message}`)).listen(PORT, host);
  log(`local runner on http://localhost:${PORT}/run, mode ${MODE}`);
}
