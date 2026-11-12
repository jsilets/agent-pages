#!/usr/bin/env node
// A stand-in for ChatGPT, for the local test of MCP Events. It needs Node 18 or later and no packages.
//
//   node tools/fake-chatgpt.mjs <mcp_url> [--port 8802] [--slug <group>/<name>] [--mention chatgpt] [--events <n>]
//
// It subscribes to comment.created on the MCP connector with a callback URL on this machine. Its listener
// answers the verification challenge and checks the Standard Webhooks signature of each delivery. For each
// event it prints the delay, then does what an assistant does: get_page, one edit_page that puts the quoted
// text in upper case, and reply_to_comment with resolve. Ctrl-C, or --events <n> events, unsubscribes and exits.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const [mcpUrl, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : fallback);
if (!mcpUrl) {
  console.error('usage: node tools/fake-chatgpt.mjs <mcp_url> [--port 8802] [--slug <group>/<name>] [--mention chatgpt] [--events <n>]');
  process.exit(2);
}
const port = Number(opt('port', 8802));
const maxEvents = Number(opt('events', 0));
const args = { ...(opt('slug') ? { slug: opt('slug') } : {}), mention: opt('mention', 'chatgpt') };
const callback = `http://127.0.0.1:${port}/mcp-events/callback_${randomBytes(6).toString('hex')}`;
const secret = `whsec_${randomBytes(32).toString('base64')}`;
const subscription = { name: 'comment.created', arguments: args, delivery: { mode: 'webhook', url: callback } };

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const out = await res.json();
  if (out.error) throw Object.assign(new Error(`${method}: ${out.error.code} ${out.error.message} ${JSON.stringify(out.error.data ?? '')}`), { rpc: out.error });
  return out.result;
}
async function tool(name, toolArgs) {
  const out = await rpc('tools/call', { name, arguments: toolArgs });
  if (out.isError) throw new Error(`${name}: ${out.content[0].text}`);
  return out;
}

/** The Standard Webhooks check: a timestamp within 5 minutes, and one v1 signature over `<id>.<timestamp>.<raw body>` that matches. */
function signatureValid(headers, raw) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  if (!id || !timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const want = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.`).update(raw).digest();
  return String(headers['webhook-signature'] ?? '')
    .split(' ')
    .some((s) => {
      const got = Buffer.from(s.startsWith('v1,') ? s.slice(3) : '', 'base64');
      return got.length === want.length && timingSafeEqual(got, want);
    });
}

let subscriptionId = null;
let handled = 0;
const seen = new Set();
const delays = [];

/** What an assistant does with the event: read the page, change it, and answer the comment. */
async function act(event) {
  const { comment_id, slug, quote } = event.data;
  const page = await tool('get_page', { slug });
  const meta = JSON.parse(page.content[0].text);
  const html = page.content[1].text;
  let body = 'I made no change: the comment has no quote that occurs exactly once in the page.';
  if (quote && html.split(quote).length === 2 && quote !== quote.toUpperCase()) {
    const edit = await tool('edit_page', { slug, edits: [{ old_text: quote, new_text: quote.toUpperCase() }], comment_id });
    log(`  edit_page: ${slug} version ${meta.version} -> ${edit.structuredContent.version}`);
    body = `Done. I put the quoted text in upper case in version ${edit.structuredContent.version}.`;
  }
  const reply = await tool('reply_to_comment', { comment_id, body, resolve: true });
  log(`  reply_to_comment: reply ${reply.structuredContent.id}, resolved ${reply.structuredContent.resolved}`);
}

const server = createServer((req, res) => {
  const received = Date.now();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const answer = (status, body) => res.writeHead(status, body ? { 'content-type': 'application/json' } : {}).end(body ? JSON.stringify(body) : undefined);
    if (req.method !== 'POST' || req.url !== new URL(callback).pathname) return answer(404);
    if (!signatureValid(req.headers, raw)) {
      log('REFUSED a request with an invalid signature');
      return answer(401);
    }
    const sub = req.headers['x-mcp-subscription-id'];
    if (!sub || (subscriptionId && sub !== subscriptionId)) {
      log(`REFUSED a request for the subscription ${sub}`);
      return answer(410);
    }
    const body = JSON.parse(raw.toString('utf8'));
    if (body.type === 'verification') {
      log(`challenge received (webhook-id ${req.headers['webhook-id']}, subscription ${sub}), signature valid, echoed`);
      return answer(200, { challenge: body.challenge });
    }
    if (body.type) return answer(204); // Another control notification. This stand-in ignores it.
    // A 2xx answer acknowledges receipt. The work runs after the answer, as ChatGPT does it.
    answer(204);
    if (body.eventId !== req.headers['webhook-id']) log(`NOTE: webhook-id ${req.headers['webhook-id']} is not the eventId ${body.eventId}`);
    if (seen.has(body.eventId)) return log(`duplicate of ${body.eventId} ignored`);
    seen.add(body.eventId);
    const delay = received - Date.parse(body.timestamp);
    delays.push(delay);
    log(`event ${body.eventId} ${body.name}: signature valid, delay ${delay} ms from the comment timestamp to receipt`);
    log(`  data: ${JSON.stringify(body.data)}`);
    act(body)
      .catch((e) => log(`  FAILED: ${e.message}`))
      .finally(() => ++handled === maxEvents && stop());
  });
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    if (subscriptionId) log('events/unsubscribe ->', JSON.stringify(await rpc('events/unsubscribe', subscription)));
  } catch (e) {
    log(`events/unsubscribe failed: ${e.message}`);
  }
  if (delays.length) log(`delays in ms: ${delays.join(', ')}`);
  server.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

server.listen(port, '127.0.0.1', async () => {
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-chatgpt', version: '0.0.0' } });
    log(`initialize -> protocol ${init.protocolVersion}, capabilities ${JSON.stringify(init.capabilities)}`);
    if (!init.capabilities?.events) throw new Error('the server does not declare the events capability');
    const { events } = await rpc('events/list');
    log(`events/list -> ${events.map((e) => `${e.name} [${e.delivery}] arguments: ${Object.keys(e.inputSchema.properties)}`).join('; ')}`);
    const sub = await rpc('events/subscribe', { ...subscription, delivery: { ...subscription.delivery, secret }, cursor: null, ...(opt('ttl') ? { ttlMs: Number(opt('ttl')) } : {}) });
    subscriptionId = sub.id;
    log(`events/subscribe ${JSON.stringify(args)} -> ${JSON.stringify(sub)}`);
    const again = await rpc('events/subscribe', { ...subscription, delivery: { ...subscription.delivery, secret }, cursor: null });
    log(`events/subscribe again -> same id: ${again.id === sub.id} (the server sends no second challenge)`);
    log(`listening on ${callback}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
});
