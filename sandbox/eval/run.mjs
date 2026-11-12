#!/usr/bin/env node
// Runs the fixed evaluation set of tasks.json against a host and its runner, and stores what each assistant did.
// It has no dependencies.
//
//   node sandbox/eval/run.mjs --host http://localhost:8804 --label sonnet [--agent claude|chatgpt] [--tasks typo,better] [--repeat 2]
//
// For each task it publishes a new copy of the document (a new slug, so no old thread is on the page), writes the
// comment as the person, and waits until the run ends. The runner decides the model: start it with
// SANDBOX_CLAUDE_MODEL=opus (or SANDBOX_CODEX_MODEL=…) for another model. The host must have SANDBOX_RUNNER_URL.
//
// It writes results/<label>.json: for each run the comment, the reply, the thread status, the tool calls and the times
// from the run detail, and the lines of the page that changed. judge.md is the rubric for a person who scores them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const host = arg('host', 'http://localhost:8804');
const label = arg('label');
const agent = arg('agent', 'claude');
const only = arg('tasks')?.split(',');
const repeat = +arg('repeat', 1);
const set = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
const tasks = set.tasks.filter((t) => !only || only.includes(t.id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, init) => { const r = await fetch(host + path, init); if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`); return r.headers.get('content-type')?.includes('json') ? r.json() : r.text(); };

/** The HTML of a document as the host gets it. A deck uses the kit, so the CLI packs it first. */
function docHtml(doc) {
  const src = join(HERE, doc.file);
  if (!doc.deck) return readFileSync(src, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'eval-'));
  try {
    const out = join(dir, 'deck.html');
    execFileSync(process.execPath, [join(HERE, '../../cli/agent-pages.mjs'), 'pack', src, '-o', out], { stdio: 'ignore' });
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The lines that changed: a longest common subsequence of the lines of the body. */
export function changedLines(before, after) {
  const body = (h) => (/<body[^>]*>([\s\S]*)<\/body>/i.exec(h)?.[1] ?? h).split('\n').map((l) => l.trim()).filter(Boolean);
  const a = body(before), b = body(after);
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const removed = [], added = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) removed.push(a[i++]); else added.push(b[j++]);
  }
  removed.push(...a.slice(i));
  added.push(...b.slice(j));
  return { removed, added };
}

const words = (html) => html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

async function one(task, n) {
  const doc = set.docs[task.doc];
  const slug = `eval-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${task.id}-${n}-${Date.now().toString(36)}`;
  const html = docHtml(doc);
  await api(`/api/pages/${slug}`, { method: 'PUT', headers: { 'content-type': 'text/html; charset=utf-8' }, body: html });
  const page = await api(`/api/pages/${slug}`);
  const before = await api(`/raw/${slug}/${page.latest}`);
  const t0 = Date.now();
  const c = await api(`/api/pages/${slug}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: `@${agent} ${task.comment}`, ...(task.slide ? { slide: task.slide } : {}) }) });
  let thread;
  for (;;) {
    await sleep(500);
    thread = (await api(`/api/pages/${slug}/comments`)).find((x) => x.id === c.id);
    if (thread.run && thread.run.status !== 'running') break;
    if (Date.now() - t0 > 240_000) break;
  }
  const after = await api(`/api/pages/${slug}`);
  const afterHtml = after.latest === page.latest ? before : await api(`/raw/${slug}/${after.latest}`);
  const reply = thread.replies.find((r) => r.author === agent);
  const detail = Object.fromEntries((thread.run?.detail ?? '').split(' ').filter((kv) => kv.includes('=')).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  const diff = changedLines(before, afterHtml);
  return {
    task: task.id, expect: task.expect, comment: task.comment, slug, run: n,
    status: thread.run?.status ?? 'none', model: detail.model ?? null, tools: detail.tools ?? null, turns: detail.turns ? +detail.turns : null,
    ms_reply: reply ? Date.parse(reply.created_at) - t0 : null, ms_first_tool: detail.ms_first_tool ? +detail.ms_first_tool : null,
    edited: after.latest !== page.latest, versions: after.latest - page.latest, thread_status: thread.status,
    reply: reply?.body ?? null, replies: thread.replies.filter((r) => r.author === agent).length,
    words_before: words(diff.removed.join(' ')), words_after: words(diff.added.join(' ')),
    removed: diff.removed.map((l) => l.slice(0, 1500)), added: diff.added.map((l) => l.slice(0, 1500)),
    run_detail: thread.run?.status === 'failed' ? thread.run.detail : undefined,
  };
}

// The tests import changedLines. The runs start only when this file is the program.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (!label || !/^[a-z0-9._-]+$/i.test(label)) { console.error('usage: run.mjs --host <url> --label <name> [--agent claude|chatgpt] [--tasks a,b] [--repeat n]'); process.exit(2); }
  const out = [];
  for (let n = 1; n <= repeat; n++) for (const t of tasks) {
    const r = await one(t, n);
    out.push(r);
    console.log(`${r.task} #${n}: ${r.status} edited=${r.edited} thread=${r.thread_status} ${r.ms_reply ?? '-'} ms tools=${r.tools} | ${String(r.reply).slice(0, 140)}`);
  }
  mkdirSync(join(HERE, 'results'), { recursive: true });
  const file = join(HERE, 'results', `${label}.json`);
  writeFileSync(file, JSON.stringify({ label, agent, host, at: new Date().toISOString(), runs: out }, null, 2) + '\n');
  console.log(file);
}
