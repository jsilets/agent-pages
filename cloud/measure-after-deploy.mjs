#!/usr/bin/env node
// The measurements that only a deploy can give. Run it one time after DEPLOY.md step 9, against the deployed host.
// It has no dependencies. It makes 5 real Claude runs with the Claude account that you sign in to in step 2.
//
//   AGENT_PAGES_URL=https://pages.example.com AGENT_PAGES_CLIENT_ID=… AGENT_PAGES_CLIENT_SECRET=… node cloud/measure-after-deploy.mjs
//
// The Access service token is the identity of the runs, so the script signs that identity in to Claude (step 2). It never
// prints, stores or logs the code that you paste: the code goes to the host in one request. Steps, in order:
//   1. The runner answers through the service binding (GET /api/assistants).
//   2. Sign-in: the time to the sign-in URL is a cold container start plus `claude auth login`. You open the URL and paste the code.
//   3. A test page.
//   4. A cold run: the script waits LINGER + 40 s, so the container stops and the next run must start one and restore the archive.
//   5. A next run in the linger (container and program wait).
//   6. Warm on intent: wait for the stop, POST /api/assistants/warm, 8 s of "typing", then the comment.
//   7. Two comments at once: the second waits for the first (one run at a time for each user).
//   8. The page is deleted. The sign-in stays; disconnect it in the viewer if you want.
// It prints one table, and the commands that give the numbers of the runner log (container start, billable seconds).
import { createInterface } from 'node:readline/promises';

const base = (process.env.AGENT_PAGES_URL || '').replace(/\/+$/, '');
const id = process.env.AGENT_PAGES_CLIENT_ID, secret = process.env.AGENT_PAGES_CLIENT_SECRET;
const LINGER_S = +process.env.LINGER_S || 90;
if (!base || !id || !secret) { console.error('Set AGENT_PAGES_URL, AGENT_PAGES_CLIENT_ID and AGENT_PAGES_CLIENT_SECRET (an Access service token).'); process.exit(2); }
const headers = { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, init = {}) {
  const r = await fetch(base + path, { ...init, headers: { ...headers, ...(init.body ? { 'content-type': init.type ?? 'application/json' } : {}), ...(init.headers ?? {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${r.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const kv = (detail) => Object.fromEntries(String(detail ?? '').split(' ').map((p) => p.split('=')).filter((p) => p.length === 2));

/** One comment, timed from its POST: the run record, the reply, the end. The detail has the numbers of the runner. */
async function comment(slug, body) {
  const t0 = Date.now();
  const c = await api(`/api/pages/${slug}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  for (;;) {
    await sleep(200);
    const t = (await api(`/api/pages/${slug}/comments`)).find((x) => x.id === c.id);
    const reply = t?.replies?.[0];
    if (t?.run && t.run.status !== 'running') {
      const d = kv(t.run.detail);
      return { comment: body, status: t.run.status, ms_reply_stored: reply ? Date.parse(reply.created_at) - t0 : null, ms_run_ended: Date.now() - t0, ms_first_tool_after_job: +d.ms_first_tool || null, ms_container: +d.ms_container || 0, ms_queue: +d.ms_queue || 0, cold_container: d.cold_container, egress: d.egress, rootfs_ro: d.rootfs_ro, model: d.model, detail: d.engine ? undefined : t.run.detail };
    }
    if (Date.now() - t0 > 240_000) return { comment: body, status: 'no result in 240 s' };
  }
}

const results = [];
const note = (name, o) => { results.push({ step: name, ...o }); console.log(`${name}: ${JSON.stringify(o)}`); };

// 1
let t = Date.now();
const st = await api('/api/assistants');
note('1 runner through the service binding', { ms: Date.now() - t, runner: st.runner, claude_connected: st.assistants?.claude?.connected, error: st.error });
if (!st.runner) { console.error('The host cannot reach the runner. Check the SANDBOX_RUNNER binding (DEPLOY.md step 7).'); process.exit(1); }

// 2
if (!st.assistants.claude.connected) {
  t = Date.now();
  const start = await api('/api/assistants/claude/connect', { method: 'POST', body: '{}' });
  note('2 sign-in started (cold container + claude auth login)', { ms_to_url: Date.now() - t, needs_code: start.needs_code });
  console.log(`\nOpen this URL, sign in to Claude, and copy the code that the page shows:\n\n  ${start.url}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const code = (await rl.question('Paste the code here (it is not shown again): ')).trim();
  rl.close();
  t = Date.now();
  let { status } = await api(`/api/assistants/connect/${start.id}/code`, { method: 'POST', body: JSON.stringify({ code }) });
  while (status === 'pending' && Date.now() - t < 120_000) { await sleep(500); status = (await api(`/api/assistants/connect/${start.id}`)).status; }
  note('2 sign-in finished (token exchange, archive sealed and stored in R2)', { status, ms: Date.now() - t });
  if (status !== 'connected') process.exit(1);
} else note('2 sign-in', { skipped: 'already connected' });

// 3
const slug = `cloud-measure/run-${Date.now().toString(36)}`;
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>How heat pumps work</title></head><body><h1>How heat pmups work</h1><p>A heat pump moves heat from one place to another. It does not burn fuel to make heat.</p><p>In winter, the outdoor unit takes heat from the cold air outside, even when the temperature is below zero, and a refrigerant carries that heat through a compressor, which raises its temperature a lot, and then the indoor unit releases the heat into the rooms of the house, where a fan or a set of radiators spreads it around so that every room gets warm.</p><p>In summer, the same machine runs the other way and cools the house.</p></body></html>';
await api(`/api/pages/${slug}`, { method: 'PUT', body: html, type: 'text/html' });
note('3 test page', { slug });

// 4
console.log(`Waiting ${LINGER_S + 40} s so the container stops…`);
await sleep((LINGER_S + 40) * 1000);
note('4 cold run (new container, archive restored)', await comment(slug, '@claude fix the typo in the title'));
// 5
await sleep(5000);
note('5 next run in the linger', await comment(slug, '@claude make the second paragraph shorter'));
// 6
console.log(`Waiting ${LINGER_S + 40} s so the container stops…`);
await sleep((LINGER_S + 40) * 1000);
t = Date.now();
await api('/api/assistants/warm', { method: 'POST', body: '{}' });
await sleep(8000);
note('6 warm on intent (8 s of typing)', await comment(slug, '@claude make the last paragraph one short sentence'));
// 7
const [a, b] = await Promise.all([comment(slug, '@claude make the first paragraph shorter'), (async () => { await sleep(300); return comment(slug, '@claude make it better'); })()]);
note('7a burst, first', a);
note('7b burst, second (waits for the first)', b);
// 8
await api(`/api/pages/${slug}`, { method: 'DELETE' }).catch((e) => console.log(`delete: ${e.message}`));

console.log('\n| Step | Status | First tool after the job | Reply stored after the comment | Container start | Queue | Egress | Read-only root |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of results.filter((x) => x.comment)) console.log(`| ${r.step} | ${r.status} | ${r.ms_first_tool_after_job ?? ''} ms | ${r.ms_reply_stored ?? ''} ms | ${r.cold_container === 'true' ? `${r.ms_container} ms` : 'none'} | ${r.ms_queue} ms | ${r.egress} | ${r.rootfs_ro} |`);
console.log(`
Compare with sandbox/PERF.md and cloud/COST.md. Expected (cloud/README.md, "Latency"): next run 0.8 to 1.0 s to the first tool and 3.5 to 5 s to the reply;
warm on intent the same; cold 2 to 4 s more than locally.

The numbers of the runner log (cloud/COST.md "Inputs"): in the Cloudflare dashboard, Workers & Pages > agent-pages-runner > Logs, filter
  ev = "container_started"   ms_boot (start to agentd answer), ms_restore, archive_bytes, hardening
  ev = "container_stopped"   s_billable (put it in cost-inputs.json), drain_ms, saved
  ev = "run"                 ms_first_tool, ms_reply, cold_container
and Containers > agent-pages-runner > Instances for the memory and CPU of each instance. Then: node cloud/cost.mjs`);
