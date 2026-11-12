#!/usr/bin/env node
// A fake sandbox runner for work on the viewer. It takes the job that the host sends for an @claude or @chatgpt
// comment, and it plays one run with no assistant and no sign-in: it sends the progress events with the timing of a
// real run, and it calls the real MCP connector of the job (list_comments, get_page, edit_page, reply_to_comment).
// So the page gets a real new version and the thread gets a real reply. It has no dependencies.
//
//   node host/dev/simulate-run.mjs [--port 8812] [--speed 1] [--no-progress] [--connected claude,codex] [--auto-approve]
//   cd host && SANDBOX_RUNNER_URL=http://localhost:8812/run bunx vite --port 8787
//
// What it edits: the quote of the comment, or the first paragraph of the page when the comment has no quote.
// The new text is the text after the first colon of the comment ("@claude reword this: The new text."), or a
// shorter form of the old text.
// A comment with [fail] ends as failed. A comment with [signin] ends as not_signed_in. A comment with [slow] waits longer
// before the edit. POST /warm answers 202 and logs the user. --no-progress sends no progress events, so the viewer has only the events that the host makes itself.
// A comment with [multi] makes one edit_page call with two edits: the quote, and the next paragraph after it.
// With SANDBOX_RUNNER_SECRET set, the runner refuses a request without that value in the x-runner-secret header.
//
// It also fakes the sign-in endpoints of the runner, so the Assistants dialog of the viewer works with no real sign-in:
//   POST /status {user}, /connect {user, engine}, /connect/status {id}, /connect/code {id, code}, /disconnect {user, engine}.
// --connected is the comma list of the engines that each person starts with (default: claude,codex; '' for none).
// Claude: the sign-in page at /fake/claude/<id> shows a code after "Approve", and the viewer sends that code.
// ChatGPT: the page at /fake/device takes the short code that the viewer shows. --auto-approve connects it after 3 seconds.
// A job for an engine that the person did not connect ends as not_signed_in.
import { createServer } from 'node:http';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1]; };
const PORT = +arg('port', 8812);
const SPEED = +arg('speed', 1) || 1;
const PROGRESS = !process.argv.includes('--no-progress');
const SECRET = process.env.SANDBOX_RUNNER_SECRET || '';
const START = (arg('connected', 'claude,codex') || '').split(',').map((e) => e.trim()).filter(Boolean);
const AUTO = process.argv.includes('--auto-approve');
const MODELS = {
  claude: { models: [{ id: 'sim-claude-fast', label: 'Faster', note: 'Good for most comments.' }, { id: 'sim-claude-careful', label: 'More careful', note: 'Slower. For long or hard edits.' }], default_model: 'sim-claude-fast' },
  codex: { models: [{ id: 'sim-codex-fast', label: 'Faster', note: 'Good for most comments.' }, { id: 'sim-codex-careful', label: 'More careful', note: 'Slower. For long or hard edits.' }], default_model: 'sim-codex-fast' },
};
/** The engines that each person connected, and each sign-in that is not finished. */
const connected = new Map(), flows = new Map();
const engines = (user) => { if (!connected.has(user)) connected.set(user, new Set(START)); return connected.get(user); };
const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

/** One run: the progress events, the MCP calls, and the final result. */
async function run(job) {
  let seq = 0, rpcId = 0;
  const progress = async (kind, more = {}) => {
    if (!PROGRESS) return;
    const body = { seq: ++seq, at: new Date().toISOString(), kind, ...more };
    const status = await fetch(job.callback_url + '/progress', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) }).then((r) => r.status, (e) => `error: ${e.message}`);
    log('progress', status, kind, more.tool || (more.text != null ? `${more.text.length} chars` : ''));
  };
  const mcp = async (name, args) => {
    const res = await fetch(job.mcp_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
    const out = await res.json();
    if (out.error || out.result?.isError) throw new Error(`${name}: ${out.error?.message || out.result.content[0].text}`);
    return out.result;
  };
  const finish = async (status, detail) => {
    const code = await fetch(job.callback_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status, detail }) }).then((r) => r.status, (e) => `error: ${e.message}`);
    log('result', code, status, detail);
  };
  try {
    await progress('started');
    await sleep(1400);
    await progress('tool', { tool: 'list_comments' });
    const threads = (await mcp('list_comments', { slug: job.slug, status: 'all' })).structuredContent.threads;
    const comment = threads.flatMap((t) => [t, ...t.replies.map((r) => ({ ...r, quote: t.quote }))]).find((c) => c.id === job.comment_id);
    if (!comment) throw new Error('the comment is not on the page');
    if (/\[signin\]/.test(comment.body) || !engines(job.user).has(job.engine)) return await finish('not_signed_in', 'the simulated assistant has no sign-in');
    await sleep(500);
    await progress('tool', { tool: 'get_page' });
    const html = (await mcp('get_page', { slug: job.slug })).content[1].text;
    await sleep(/\[slow\]/.test(comment.body) ? 6000 : 2200);
    if (/\[fail\]/.test(comment.body)) return await finish('failed', 'a simulated failure');

    const oldText = findOld(html, comment.quote);
    if (!oldText) throw new Error('no text to edit: the quote is not in the page HTML');
    const other = /\[multi\]/.test(comment.body) ? nextOld(html, oldText) : null;
    const colon = comment.body.indexOf(':');
    const plain = oldText.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const newText = colon >= 0 && comment.body.slice(colon + 1).trim() ? comment.body.slice(colon + 1).trim() : plain.split(/(?<=[.!?])\s/)[0].replace(/,? and .*$/, '.').replace(/\.\.$/, '.');
    await progress('tool', { tool: 'edit_page' });
    await sleep(250);
    await progress('focus', { quote: oldText.slice(0, 500) });
    await sleep(900);
    // An assistant writes about 12 characters each 100 ms. The runner groups them into one event each 300 ms.
    for (let n = 36; n < newText.length; n += 36) { await progress('typing', { quote: oldText.slice(0, 500), text: newText.slice(0, n) }); await sleep(300); }
    await progress('typing', { quote: oldText.slice(0, 500), text: newText.slice(0, 2000) });
    await sleep(500);
    const edits = [{ old_text: oldText, new_text: newText }];
    if (other) edits.push({ old_text: other, new_text: other.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] + ' (The assistant changed this paragraph too.)' });
    const stored = (await mcp('edit_page', { slug: job.slug, edits, comment_id: job.comment_id })).structuredContent;
    log('edit_page', `v${stored.version}`);
    await sleep(1800);
    await progress('tool', { tool: 'reply_to_comment' });
    await sleep(700);
    await mcp('reply_to_comment', { comment_id: job.comment_id, body: `Done. I changed that text in version ${stored.version}.` });
    await sleep(300);
    await finish('done', `engine=${job.engine} model=simulated tools=list_comments,get_page,edit_page,reply_to_comment`);
  } catch (e) {
    log('run failed', e.message);
    await finish('failed', String(e.message).slice(0, 300));
  }
}

/** The inner HTML of the first paragraph after the old text, for a second edit. */
function nextOld(html, oldText) {
  const after = html.slice(html.indexOf(oldText) + oldText.length);
  for (const m of after.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)) if (m[2].trim().length > 20 && html.split(m[2]).length === 2 && !m[2].includes(oldText)) return m[2];
  return null;
}

/** The HTML of the quote in the page, with the inline tags that split it, or the inner HTML of the first paragraph. */
function findOld(html, quote) {
  const body = html.slice(Math.max(0, html.search(/<body\b/i)));
  if (quote) {
    const words = quote.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/&/g, '(?:&|&amp;)'));
    const m = body.match(new RegExp(words.join('(?:\\s|<[^>]+>|&nbsp;)+')));
    if (m && html.split(m[0]).length === 2) return m[0];
  }
  for (const m of body.matchAll(/<(p|li|h2)\b[^>]*>([\s\S]*?)<\/\1>/g)) if (m[2].trim().length > 20 && html.split(m[2]).length === 2) return m[2];
  return null;
}

/** The two pages of the fake providers. They are plain HTML with a little script, for a person in a browser tab. */
const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<style>body{font:15px/1.5 system-ui;max-width:420px;margin:60px auto;padding:0 20px;color:#1a1a1a}button{font:600 15px system-ui;padding:10px 18px;border-radius:10px;border:0;background:#1a1a1a;color:#fff;cursor:pointer}
code{display:block;margin:12px 0;padding:12px;border-radius:10px;background:#f1efe8;font:600 15px ui-monospace,monospace;word-break:break-all}input{font:600 20px ui-monospace,monospace;padding:8px 10px;width:12ch;letter-spacing:.08em;border:1px solid #999;border-radius:8px}</style>
<p style="color:#777;font-size:13px">Simulated sign-in. No real account is used.</p>${body}`;
function signInPage(url, res) {
  const html = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
  const claude = url.pathname.match(/^\/fake\/claude\/([\w-]+)$/);
  if (claude) {
    const f = flows.get(claude[1]);
    if (!f) return html(404, PAGE('Not found', '<h1>This sign-in has ended</h1>'));
    return html(200, PAGE('Sign in to Claude', `<h1>Allow Pages to use Claude?</h1><p>Pages runs Claude for your comments, with your own plan.</p>
<button id="ok">Approve</button><div id="out" hidden><p>Copy this code and paste it into Pages:</p><code id="code">${f.code}</code></div>
<script>ok.onclick=()=>{ok.hidden=true;out.hidden=false;getSelection().selectAllChildren(code)}</script>`));
  }
  if (url.pathname === '/fake/device') return html(200, PAGE('ChatGPT device sign-in', `<h1>Enter the code</h1><p>Type the code that Pages shows.</p>
<form id="f"><input id="c" name="code" autocomplete="off" placeholder="XXXX-XXXX" autofocus> <button>Continue</button></form><p id="msg"></p>
<script>f.onsubmit=async(e)=>{e.preventDefault();const r=await fetch('/fake/device',{method:'POST',body:c.value});msg.textContent=r.ok?'You are signed in. Go back to Pages.':'That code is not right.';if(r.ok)f.hidden=true}</script>`));
  return null;
}

createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const answer = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, 'http://localhost');
    // The fake provider pages: a person opens them in a tab. They take no secret.
    if (req.method === 'GET' && signInPage(url, res) !== null) return;
    if (req.method === 'POST' && url.pathname === '/fake/device') {
      const f = [...flows.values()].find((x) => x.engine === 'codex' && x.user_code === raw.trim().toUpperCase() && x.status === 'pending');
      if (!f) return answer(400, { error: 'no such code' });
      f.status = 'connected'; engines(f.user).add('codex'); log('connect codex', f.user, 'approved on the device page');
      return answer(200, { ok: true });
    }
    if (req.method !== 'POST') return answer(405, { error: 'POST a job' });
    if (SECRET && req.headers['x-runner-secret'] !== SECRET) { log('refused: wrong or missing x-runner-secret'); return answer(401, { error: 'wrong x-runner-secret' }); }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return answer(400, { error: 'the body is not JSON' }); }
    // The host asks for a warm-up when a person opens a comment box. This runner has nothing to warm, so it only logs the call.
    if (url.pathname === '/warm') { log('warm', body.user || ''); return answer(202, { warm: true }); }
    if (url.pathname === '/status') {
      const on = engines(String(body.user || ''));
      return answer(200, { assistants: { claude: { connected: on.has('claude'), ...MODELS.claude }, chatgpt: { connected: on.has('codex'), ...MODELS.codex } } });
    }
    if (url.pathname === '/connect') {
      const engine = body.engine === 'codex' ? 'codex' : 'claude', id = 'sim-' + rand(16), port = req.socket.localPort;
      const f = { id, user: String(body.user || ''), engine, status: 'pending', expires: Date.now() + 10 * 60 * 1000, code: engine === 'claude' ? 'sim' + rand(20) + '#' + rand(12) : '', user_code: engine === 'codex' ? rand(4) + '-' + rand(4) : '' };
      flows.set(id, f);
      if (AUTO && engine === 'codex') setTimeout(() => { if (f.status === 'pending') { f.status = 'connected'; engines(f.user).add('codex'); log('connect codex', f.user, 'auto-approved'); } }, 3000 / SPEED);
      log('connect start', engine, f.user);
      return answer(200, engine === 'claude'
        ? { id, url: `http://localhost:${port}/fake/claude/${id}`, needs_code: true, expires_at: new Date(f.expires).toISOString() }
        : { id, url: `http://localhost:${port}/fake/device`, user_code: f.user_code, needs_code: false, expires_at: new Date(f.expires).toISOString() });
    }
    if (url.pathname === '/connect/status' || url.pathname === '/connect/code') {
      const f = flows.get(String(body.id || ''));
      if (!f) return answer(200, { status: 'expired' });
      if (f.status === 'pending' && Date.now() > f.expires) f.status = 'expired';
      if (url.pathname === '/connect/code' && f.status === 'pending') {
        // The code is never logged.
        if (f.engine === 'claude' && body.code === f.code) { f.status = 'connected'; engines(f.user).add('claude'); log('connect claude', f.user, 'code accepted'); }
        else { log('connect', f.engine, f.user, 'code refused'); return answer(200, { status: 'failed', detail: 'the code did not match' }); }
      }
      return answer(200, { status: f.status });
    }
    if (url.pathname === '/disconnect') { engines(String(body.user || '')).delete(body.engine === 'codex' ? 'codex' : 'claude'); log('disconnect', body.engine, body.user); return answer(200, { ok: true }); }
    const job = body;
    if (!job.mcp_url || !job.callback_url || !job.comment_id || !job.slug) return answer(400, { error: 'the job needs mcp_url, callback_url, comment_id and slug' });
    log('job', job.agent_label, job.slug, job.comment_id, 'model=' + (job.model || 'default'), SECRET ? '(secret ok)' : '');
    answer(202, { accepted: true });
    run(job);
  });
}).listen(PORT, () => log(`simulated runner on http://localhost:${PORT}/run  speed ${SPEED}${PROGRESS ? '' : '  no progress events'}${SECRET ? '  secret required' : ''}  connected: ${START.join(',') || 'none'}${AUTO ? '  auto-approve' : ''}`));
