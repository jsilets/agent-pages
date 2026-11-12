#!/usr/bin/env node
// Proves that the Codex image runs `codex exec` with the arguments of docker mode, with no sign-in and no model request.
// A stand-in model (the OpenAI Responses API with SSE) and a stand-in connector run in this process. The stand-in model
// asks for one get_page call and then answers "done". It has no dependencies.
//
//   node sandbox/codex-standin.mjs [image] [model name]
//
// Default image: agent-pages-sandbox-codex. Default model name: gpt-6.1-sol, so Codex gives the model the tools of a real
// run, with code mode. It prints the tools that Codex offered, the connector calls, the exit code, and the peak memory
// and the CPU time of the container. It exits with 1 when the run did not make the connector call or did not end with 0.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { codexArgs } from './run-comment.mjs';

const image = process.argv[2] || 'agent-pages-sandbox-codex';
const model = process.argv[3] || 'gpt-6.1-sol';
const TOOLS = ['list_comments', 'get_page', 'edit_page', 'reply_to_comment', 'list_pages'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: { slug: { type: 'string' } } } }));
const seen = { mcp: [], offered: null };
const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 };

const server = createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d)).on('end', () => {
    let j = {};
    try { j = JSON.parse(b); } catch {}
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/mcp') {
      seen.mcp.push(j.method === 'tools/call' ? `tools/call ${j.params?.name}` : j.method);
      if (j.id === undefined) { res.writeHead(202); return res.end(); }
      if (j.method === 'initialize') return json({ jsonrpc: '2.0', id: j.id, result: { protocolVersion: j.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'standin', version: '1' } } });
      if (j.method === 'tools/list') return json({ jsonrpc: '2.0', id: j.id, result: { tools: TOOLS } });
      if (j.method === 'tools/call') return json({ jsonrpc: '2.0', id: j.id, result: { content: [{ type: 'text', text: '{"slug":"g/n","html":"<h1>Hi</h1>"}' }] } });
      return json({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'no such method' } });
    }
    if (!req.url.endsWith('/responses')) { res.writeHead(404); return res.end('{}'); }
    // Codex sends the tools in `tools`, or in an `additional_tools` item of the input.
    const tools = [...(j.tools ?? []), ...(j.input ?? []).flatMap((i) => (i.type === 'additional_tools' ? i.tools : []))];
    seen.offered ??= tools.map((t) => (t.tools ? `${t.name}[${t.tools.map((x) => x.name).join(',')}]` : t.name ?? t.type));
    let call = null;
    for (const t of tools) for (const x of t.tools ?? [t]) if (x.name === 'get_page' || x.name?.endsWith('get_page')) call = { name: x.name, ...(t.tools ? { namespace: t.name } : {}) };
    const first = !JSON.stringify(j.input ?? []).includes('function_call_output');
    const item = first && call
      ? { type: 'function_call', id: 'fc_1', call_id: 'call_1', ...call, arguments: '{"slug":"g/n"}' }
      : { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of [{ type: 'response.created', response: { id: 'r' } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'r', usage } }]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
});
await new Promise((ok) => server.listen(0, '0.0.0.0', ok));
const base = `http://host.docker.internal:${server.address().port}`;
const job = { mcp_url: `${base}/mcp`, comment_id: 'ab12'.repeat(6), slug: 'g/n', agent_label: 'chatgpt', engine: 'codex' };
const args = [...codexArgs(job, '/work', `${base}/mcp`), '-c', `model_providers.standin={ name = "standin", base_url = "${base}/v1", wire_api = "responses" }`, '-c', 'model_provider="standin"', '-m', model];
// The controls of a run, but with a tmpfs for CODEX_HOME in place of a volume, and with a route to this machine.
const docker = ['run', '--rm', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700', '--tmpfs', '/codex-home:rw,uid=10001,gid=10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001', '--memory', '1g', '--add-host', 'host.docker.internal:host-gateway',
  image, 'sh', '-c', 'codex "$@" < /dev/null; echo "exit=$?"; cat /sys/fs/cgroup/memory.peak; grep usage_usec /sys/fs/cgroup/cpu.stat', 'sh', ...args];
const t0 = Date.now();
const out = await new Promise((ok) => { let o = ''; const c = spawn('docker', docker, { stdio: ['ignore', 'pipe', 'pipe'] }); c.stdout.on('data', (d) => (o += d)); c.on('close', () => ok(o)); });
server.close();
const lines = out.trim().split('\n');
const events = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const call = events.find((e) => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call');
const exit = /exit=(\d+)/.exec(out)?.[1];
const peak = +lines.at(-2), cpu = +/usage_usec (\d+)/.exec(out)?.[1] / 1e6;
console.log(JSON.stringify({ image, model, ms: Date.now() - t0, exit: exit === undefined ? null : +exit, tools_offered: seen.offered, connector: seen.mcp, tool_call: call ? `${call.item.tool} ${call.item.status}` : null, errors: events.filter((e) => e.item?.type === 'error').map((e) => e.item.message.slice(0, 160)), peak_memory_mb: Math.round(peak / 1048576), cpu_s: cpu }, null, 2));
process.exit(exit === '0' && call?.item.status === 'completed' ? 0 : 1);
