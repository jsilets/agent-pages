#!/usr/bin/env node
// A fake sandbox runner for work on the viewer. It takes the job that the host sends for an @claude or @chatgpt
// comment, and it plays one run with no assistant and no sign-in: it sends the progress events with the timing of a
// real run, and it calls the real MCP connector of the job (list_comments, get_page, edit_page, reply_to_comment).
// So the page gets a real new version and the thread gets a real reply. It has no dependencies.
//
//   node host/dev/simulate-run.mjs [--port 8812] [--speed 1] [--no-progress]
//   cd host && SANDBOX_RUNNER_URL=http://localhost:8812/run bunx vite --port 8787
//
// What it edits: the quote of the comment, or the first paragraph of the page when the comment has no quote.
// The new text is the text after the first colon of the comment ("@claude reword this: The new text."), or a
// shorter form of the old text.
// A comment with [fail] ends as failed. A comment with [signin] ends as not_signed_in. A comment with [slow] waits longer
// before the edit. POST /warm answers 202 and logs the user. --no-progress sends no progress events, so the viewer has only the events that the host makes itself.
// With SANDBOX_RUNNER_SECRET set, the runner refuses a job without that value in the x-runner-secret header.
import { createServer } from 'node:http';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1]; };
const PORT = +arg('port', 8812);
const SPEED = +arg('speed', 1) || 1;
const PROGRESS = !process.argv.includes('--no-progress');
const SECRET = process.env.SANDBOX_RUNNER_SECRET || '';
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
    if (/\[signin\]/.test(comment.body)) return await finish('not_signed_in', 'the simulated assistant has no sign-in');
    await sleep(500);
    await progress('tool', { tool: 'get_page' });
    const html = (await mcp('get_page', { slug: job.slug })).content[1].text;
    await sleep(/\[slow\]/.test(comment.body) ? 6000 : 2200);
    if (/\[fail\]/.test(comment.body)) return await finish('failed', 'a simulated failure');

    const oldText = findOld(html, comment.quote);
    if (!oldText) throw new Error('no text to edit: the quote is not in the page HTML');
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
    const stored = (await mcp('edit_page', { slug: job.slug, edits: [{ old_text: oldText, new_text: newText }], comment_id: job.comment_id })).structuredContent;
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

createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const answer = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST') return answer(405, { error: 'POST a job' });
    if (SECRET && req.headers['x-runner-secret'] !== SECRET) { log('refused: wrong or missing x-runner-secret'); return answer(401, { error: 'wrong x-runner-secret' }); }
    // The host asks for a warm-up when a person opens a comment box. This runner has nothing to warm, so it only logs the call.
    if (req.url === '/warm') { let user = ''; try { user = JSON.parse(raw).user || ''; } catch {} log('warm', user); return answer(202, { warm: true }); }
    let job;
    try { job = JSON.parse(raw); } catch { return answer(400, { error: 'the body is not JSON' }); }
    if (!job.mcp_url || !job.callback_url || !job.comment_id || !job.slug) return answer(400, { error: 'the job needs mcp_url, callback_url, comment_id and slug' });
    log('job', job.agent_label, job.slug, job.comment_id, SECRET ? '(secret ok)' : '');
    answer(202, { accepted: true });
    run(job);
  });
}).listen(PORT, () => log(`simulated runner on http://localhost:${PORT}/run  speed ${SPEED}${PROGRESS ? '' : '  no progress events'}${SECRET ? '  secret required' : ''}`));
