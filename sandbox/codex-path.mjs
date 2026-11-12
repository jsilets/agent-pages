#!/usr/bin/env node
// Runs the whole docker path of a @chatgpt comment with a stand-in model: the Codex image, the controls of a run, the
// egress proxy with the connector route, the real connector of a host, run-comment.mjs, and the result. Only the model
// is a stand-in, so the test needs no ChatGPT sign-in. It has no dependencies.
//
//   node sandbox/codex-path.mjs http://localhost:8804
//
// What it does:
//   1. Signs the test user in with `codex login --with-api-key` and a key that is not real, so `codex login status`
//      passes in the same way as for a person. Codex writes its own file. This script reads no credential.
//   2. Publishes a page with a typo, writes a comment, and makes a connector token on the host.
//   3. Starts the stand-in model in a container on the internal network of the runner. It answers like the OpenAI
//      Responses API: list_comments, get_page, edit_page with a reply, then one last message.
//   4. Runs the job with runJob, in the Codex container of the user, as startDocker of local-runner.mjs does. The program
//      gets the connector at the proxy. The model provider points at the stand-in (the one change: `-c model_provider`).
//   5. Checks the page, the thread, the proxy log, and that the token is not in the container. Then it removes all.
// It uses the port number 8897 for the names of its Docker objects, so it does not touch a runner on another port.
import { spawn, spawnSync } from 'node:child_process';

process.env.RUNNER_PORT = process.env.CODEX_PATH_PORT || '8897';
process.env.RUNNER_MODE = 'docker';
const R = await import('./local-runner.mjs');
const { runJob } = await import('./run-comment.mjs');

const host = process.argv[2] || 'http://localhost:8804';
const USER = 'codex-path-test';
const PORT = process.env.RUNNER_PORT;
const NET = `agent-pages-sandbox-${PORT}`, MODEL = `agent-pages-standin-${PORT}`;
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const docker = (args, input) => { const r = spawnSync('docker', args, { env, encoding: 'utf8', input, timeout: 120_000 }); return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }; };
const api = async (path, init) => { const r = await fetch(host + path, init); if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.status === 204 ? null : r.headers.get('content-type')?.includes('json') ? r.json() : r.text(); };
let failed = 0;
const check = (name, ok, proof) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${String(proof).replace(/\s*\n\s*/g, ' | ').slice(0, 400)}`); };

/** The stand-in model: the Responses API with SSE. It reads the slug and the comment id from the prompt. */
const MODEL_JS = `
const http = require('http');
const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 };
http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)).on('end', () => {
  let j = {}; try { j = JSON.parse(b); } catch {}
  if (!req.url.endsWith('/responses')) { res.writeHead(404); return res.end('{}'); }
  const text = JSON.stringify(j.input ?? []);
  const slug = /slug \\\\"([^\\\\]+)\\\\"/.exec(text)?.[1], id = /comment has the id \\\\"([0-9a-f]{24})\\\\"/.exec(text)?.[1];
  const tools = [...(j.tools ?? []), ...(j.input ?? []).flatMap((i) => (i.type === 'additional_tools' ? i.tools : []))];
  const find = (n) => { for (const t of tools) for (const x of t.tools ?? [t]) if (x.name === n || (x.name ?? '').endsWith(n)) return { name: x.name, ...(t.tools ? { namespace: t.name } : {}) }; return null; };
  const done = (text.match(/function_call_output/g) ?? []).length;
  const steps = [['list_comments', { slug, status: 'all' }], ['get_page', { slug }], ['edit_page', { slug, comment_id: id, edits: [{ old_text: 'pmups', new_text: 'pumps' }], reply: { body: 'Fixed the typo in the heading.', resolve: true } }]];
  const step = steps[done], call = step && find(step[0]);
  console.log(JSON.stringify({ ev: 'model', turn: done, slug: !!slug, id: !!id, call: call?.name ?? null }));
  const item = call ? { type: 'function_call', id: 'fc_' + done, call_id: 'call_' + done, ...call, arguments: JSON.stringify(step[1]) } : { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'I fixed the typo and replied.', annotations: [] }] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of [{ type: 'response.created', response: { id: 'r' } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'r', usage } }]) res.write('event: ' + e.type + '\\ndata: ' + JSON.stringify(e) + '\\n\\n');
  res.end();
}); }).listen(8080);`;

const slug = `sandbox-codex/path-${Date.now().toString(36)}`;
let token = null, box = null;
try {
  // 1. The sign-in of the test user, by Codex itself.
  const vol = R.codexVolumeOf(USER);
  let r = docker(['run', '-i', '--rm', '--read-only', '--tmpfs', '/tmp:rw,uid=10001,gid=10001', '--user', '10001:10001', '--network', 'none', '-v', `${vol}:/codex-home`, R.IMAGES.codex, 'codex', 'login', '--with-api-key'], 'sk-standin-not-a-real-key\n');
  check('codex login --with-api-key signs the test user in, in its volume', r.code === 0, r.out.split('\n').pop());

  // 2. A page, a comment and a connector token on the host.
  await api(`/api/pages/${slug}`, { method: 'PUT', headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><html><head><meta charset="utf-8"><title>How heat pumps work</title></head><body><h1>How heat pmups work</h1><p>A heat pump moves heat.</p></body></html>' });
  const comment = await api(`/api/pages/${slug}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'fix the typo in the heading' }) });
  token = await api('/api/connector-tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'chatgpt' }) });

  // 3. The network, the proxy, the container of the user, and the stand-in model on the same internal network.
  const net = await R.ensureInfra();
  ({ box } = await R.ensureBox(USER, 'codex'));
  docker(['rm', '-f', MODEL]);
  r = docker(['run', '-d', '--name', MODEL, '--label', `agent-pages-runner=${PORT}`, '--network', NET, '--read-only', '--cap-drop', 'ALL', '--entrypoint', 'node', R.EGRESS_IMAGE, '-e', MODEL_JS]);
  check('the stand-in model starts on the internal network', r.code === 0, r.out.slice(0, 80));
  await new Promise((ok) => setTimeout(ok, 800));

  // 4. The job, as startDocker runs it: the connector route in the proxy, then runJob in the container.
  // The callback goes to this script, so the test sees the progress events and the result that the host would get.
  const job = { mcp_url: token.mcp_url, comment_id: comment.id, slug, agent_label: 'chatgpt', engine: 'codex', user: USER, callback_url: 'http://callback.test/s/_run/x' };
  const results = [];
  await net.control('PUT', `/route/${box.ip}`, { mcp_url: R.forDocker(job.mcp_url) });
  const provider = ['-c', `model_providers.standin={ name = "standin", base_url = "http://${MODEL}:8080/v1", wire_api = "responses" }`, '-c', 'model_provider="standin"'];
  const exec = (engine, args) => spawn('docker', ['exec', '-i', '-e', `NO_PROXY=${MODEL},agent-pages-egress-${PORT}`, box.name, 'codex', ...args, ...(args[0] === 'exec' ? provider : [])], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const progress = [];
  const out = await runJob(job, { exec, mcpUrl: net.mcpUrl, cwd: '/work', timeoutMs: 60_000, post: async (_u, body) => { results.push(body.status); return 200; }, postProgress: (_u, b) => progress.push(b.kind === 'tool' ? `tool:${b.tool}` : b.kind) });
  const inside = docker(['exec', box.name, 'sh', '-c', 'cat /proc/*/cmdline 2>/dev/null | tr "\\0" " "; env']).out + docker(['inspect', box.name]).out;
  await net.control('DELETE', `/route/${box.ip}`);
  check('the run is done, with the three connector calls of a real run', out.status === 'done' && out.tool_calls.map((t) => t.name).join(',') === 'list_comments,get_page,edit_page', `status ${out.status}, tools ${out.tool_calls.map((t) => t.name)}, exit ${out.exit_code}, ${out.ms_engine} ms, ${out.error ?? ''}`);

  // 5. What the person sees, and what the logs have.
  const page = await api(`/api/pages/${slug}`);
  const html = await api(`/raw/${slug}/${page.latest}`);
  const thread = (await api(`/api/pages/${slug}/comments`)).find((t) => t.id === comment.id);
  check('the connector stored the edit and the reply: version 2 has "pumps", and the thread is resolved', page.latest === 2 && html.includes('How heat pumps work') && thread.status === 'resolved' && thread.replies[0]?.author === 'chatgpt', `version ${page.latest}, thread ${thread.status}, reply by ${thread.replies[0]?.author}: ${thread.replies[0]?.body}`);
  const proxyLog = docker(['logs', `agent-pages-egress-${PORT}`]).out;
  const tools = [...proxyLog.matchAll(/"tool":"(\w+)"/g)].map((m) => m[1]);
  check('each connector call went through the proxy, which logged the tool and not the URL', tools.join(',') === 'list_comments,get_page,edit_page' && !proxyLog.includes(token.token) && !proxyLog.includes('/s/_mcp/'), `proxy log: ${tools.join(', ')}`);
  check('the token is not in a command line, in the environment, or in `docker inspect` of the container', !inside.includes(token.token) && !inside.includes('/s/_mcp/'), `${inside.length} characters searched`);
  check('the progress events of an edit came out, as for the viewer', ['started', 'tool:list_comments', 'tool:get_page', 'tool:edit_page', 'focus', 'typing'].every((k) => progress.includes(k)), progress.join(' '));
  check('the result went to the callback one time, as done', results.join(',') === 'done', results.join(','));
  check('codex exec ran no tool but the connector', !out.other_items, `other items: ${out.other_items ?? 'none'}`);
} catch (e) {
  check('the script ran to its end', false, e.stack || e);
} finally {
  if (token) await api(`/api/connector-tokens/${token.id}`, { method: 'DELETE' }).catch(() => {});
  if (box) await R.removeBox(box.key, 'test end');
  docker(['rm', '-f', MODEL]);
  R.cleanup();
  docker(['volume', 'rm', R.codexVolumeOf(USER)]);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
