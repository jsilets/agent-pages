#!/usr/bin/env node
// Measures one run from outside: writes a comment, then reads the comments API until the run ends.
//
//   node sandbox/measure.mjs http://localhost:8802 <group>/<name> "@claude fix the typo in the title"
//
// It prints the times from the comment POST, in milliseconds, with the reply of the assistant and the run record.
// t_post is the time of the comment POST. The runner log has t_first_tool, so the difference is the time to the first tool call.
const [base, slug, body] = process.argv.slice(2);
if (!base || !slug || !body) { console.error('usage: measure.mjs <host URL> <slug> <comment text>'); process.exit(2); }
const api = async (path, init) => { const r = await fetch(base + path, init); if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`); return r.json(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const before = (await api(`/api/pages/${slug}`)).latest;
const t0 = Date.now();
const c = await api(`/api/pages/${slug}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
const out = { comment_id: c.id, comment: body, t_post: new Date(t0).toISOString(), version_before: before, ms_post_answered: Date.now() - t0 };
for (;;) {
  await sleep(200);
  const t = (await api(`/api/pages/${slug}/comments`)).find((x) => x.id === c.id);
  const now = Date.now() - t0;
  if (t.run) out.ms_run_recorded ??= Date.parse(t.run.started_at) - t0;
  if (t.run?.status === 'running') out.ms_run_seen_running ??= now;
  const reply = t.replies[0];
  if (reply && !out.reply) Object.assign(out, { ms_reply_stored: Date.parse(reply.created_at) - t0, reply: reply.body, reply_author: reply.author, thread_status: t.status });
  if (t.run && t.run.status !== 'running') { Object.assign(out, { ms_run_ended: now, run_status: t.run.status, run_detail: t.run.detail, thread_status: t.status }); break; }
  if (now > 240_000) { out.error = 'no result in 240 s'; break; }
  if (!t.run && now > 5000) { out.error = 'the host recorded no run: is SANDBOX_RUNNER_URL set?'; break; }
}
out.version_after = (await api(`/api/pages/${slug}`)).latest;
console.log(JSON.stringify(out, null, 2));
