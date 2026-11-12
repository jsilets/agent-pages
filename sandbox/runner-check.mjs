#!/usr/bin/env node
// Load checks of a runner in docker mode, with real runs: two users at once, and a queue of comments from one user.
// It has no dependencies.
//
//   SANDBOX_RUNNER_SECRET=… node sandbox/runner-check.mjs <host URL> <runner URL> [two-users|queue]
//
// two-users  Three jobs at the same moment: user A (Claude in docker mode, with a sign-in volume), user B (Codex in
//            host mode, the sign-in of this machine) and user C (Claude in docker mode, a volume with no sign-in).
//            Then user A alone, for the time with no other load.
// queue      Three jobs of user A at the same moment, on one page. They must run one after the other, and each one
//            must see the edit of the job before it.
// The script posts each job straight to the runner with no callback_url, so the runner answers with the result.
// It makes one connector token for each label on the host and deletes them at the end.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [host, runner = 'http://localhost:8811', which = 'two-users'] = process.argv.slice(2);
if (!host) { console.error('usage: runner-check.mjs <host URL> <runner URL> [two-users|queue]'); process.exit(2); }
const SECRET = process.env.SANDBOX_RUNNER_SECRET || '';
const api = async (path, init) => { const r = await fetch(host + path, init); if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.status === 204 ? null : r.headers.get('content-type')?.includes('json') ? r.json() : r.text(); };
const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>How heat pumps work</title></head><body><h1>How heat pmups work</h1><p>A heat pump moves heat from one place to another. It does not burn fuel to make heat.</p><p>In summer, the same machine runs teh other way and cools the house.</p></body></html>';
const tokens = [];
const tokenFor = async (label) => { const t = await api('/api/connector-tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }) }); tokens.push(t); return t; };
const page = async (name) => { const slug = `sandbox-check/${name}-${Date.now().toString(36)}`; await api(`/api/pages/${slug}`, { method: 'PUT', headers: { 'content-type': 'text/html; charset=utf-8' }, body: PAGE }); return slug; };
const comment = (slug, body) => api(`/api/pages/${slug}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
const run = async (job) => {
  const t0 = Date.now();
  const r = await fetch(`${runner}/run`, { method: 'POST', headers: { 'content-type': 'application/json', ...(SECRET ? { 'x-runner-secret': SECRET } : {}) }, body: JSON.stringify(job) });
  const o = await r.json();
  return { user: job.user, engine: job.engine ?? 'claude', mode: job.mode ?? 'docker', http: r.status, status: o.status, ms_wall: Date.now() - t0, ms_queue: o.ms_queue, ms_container: o.ms_container, cold_container: o.cold_container, warm: o.warm, ms_first_tool: o.ms_first_tool, ms_reply: o.ms_reply, ms_engine: o.ms_engine, error: o.error?.slice(0, 120) };
};
const show = (title, rows) => { console.log(`\n${title}`); for (const r of rows) console.log(JSON.stringify(r)); };
const volume = (user) => `agent-pages-claude-${createHash('sha256').update(user).digest('hex').slice(0, 16)}`;

try {
  const claude = await tokenFor('claude'), chatgpt = await tokenFor('chatgpt');
  if (which === 'two-users') {
    // User C has a volume with no sign-in: its container starts, and Claude Code ends with "Not logged in".
    spawnSync('docker', ['volume', 'create', volume('runner-check-c')]);
    const [sa, sb, sc] = await Promise.all([page('a'), page('b'), page('c')]);
    const [ca, cb, cc] = await Promise.all([comment(sa, 'fix the typo in the heading'), comment(sb, 'fix the typo in the heading'), comment(sc, 'fix the typo in the heading')]);
    const together = await Promise.all([
      run({ mcp_url: claude.mcp_url, comment_id: ca.id, slug: sa, agent_label: 'claude', engine: 'claude', user: 'local' }),
      run({ mcp_url: chatgpt.mcp_url, comment_id: cb.id, slug: sb, agent_label: 'chatgpt', engine: 'codex', user: 'runner-check-b', mode: 'host' }),
      run({ mcp_url: claude.mcp_url, comment_id: cc.id, slug: sc, agent_label: 'claude', engine: 'claude', user: 'runner-check-c' }),
    ]);
    show('Three users at the same moment', together);
    const sd = await page('d');
    const cd = await comment(sd, 'fix the typo in the heading');
    show('User A alone, next', [await run({ mcp_url: claude.mcp_url, comment_id: cd.id, slug: sd, agent_label: 'claude', engine: 'claude', user: 'local' })]);
    spawnSync('docker', ['volume', 'rm', volume('runner-check-c')]);
  } else {
    const slug = await page('q');
    const asks = ['fix the typo in the heading', 'fix the typo in the last paragraph', 'add the sentence "It works best in a house that keeps heat in." at the end of the first paragraph'];
    const cs = [];
    for (const a of asks) cs.push(await comment(slug, a));
    const rows = await Promise.all(cs.map((c) => run({ mcp_url: claude.mcp_url, comment_id: c.id, slug, agent_label: 'claude', engine: 'claude', user: 'local' })));
    show('Three comments of one user at the same moment', rows);
    const p = await api(`/api/pages/${slug}`);
    const html = await api(`/raw/${slug}/${p.latest}`);
    const threads = await api(`/api/pages/${slug}/comments`);
    console.log(JSON.stringify({ versions: p.latest, heading_fixed: html.includes('heat pumps work'), last_fixed: html.includes('runs the other way'), sentence_added: html.includes('keeps heat in.'), resolved: threads.filter((t) => t.status === 'resolved').length }));
  }
} finally {
  for (const t of tokens) await api(`/api/connector-tokens/${t.id}`, { method: 'DELETE' }).catch(() => {});
}
