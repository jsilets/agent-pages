// Starts Claude Code or Codex in a sandbox for a comment that mentions @claude or @chatgpt, and records each run in agent_runs.
// The Worker does not wait for the run. The runner answers 202 at once and reports the result later at
// POST /s/_run/<run id>, because a run takes longer than the 30 seconds that waitUntil gives a Worker.
import { noteActivity, pruneActivity } from './run-activity';
import { ENGINES, modelFor } from './assistants';
import { newToken, newTokenId, readJson, type Mention } from './lib';
import type { Comment, Env, Refusal, Thread } from './types';

/** The connector token of a run ends after this time. The runner stops a run after 180 seconds, and runs of one person wait in a queue. */
export const TOKEN_TTL_MS = 15 * 60 * 1000;
/** The runner stops the assistant after 180 seconds. A run with no result after this time shows as failed. */
export const STALE_MS = 5 * 60 * 1000;
/** The events of a run stay this long after the run ends. A new run on the page deletes the older ones. */
const ACTIVITY_TTL_MS = 10 * 60 * 1000;
/** The host asks the runner to warm up for one person at most one time in this period. */
export const WARM_EVERY_MS = 60 * 1000;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_DETAIL = 500;

/** What the host sends to the runner. sandbox/run-comment.mjs reads it. */
export interface Job {
  mcp_url: string;
  comment_id: string;
  slug: string;
  /** The mention: 'claude' or 'chatgpt'. The reply has this name as its author. */
  agent_label: string;
  engine: 'claude' | 'codex';
  /** The person who wrote the comment. The runner uses the Claude or ChatGPT sign-in of this person. */
  user: string;
  callback_url: string;
  /** The model that the person chose for this assistant (PUT /api/assistants/<name>), or null for the default of the runner. */
  model: string | null;
}

/** The latest run of a thread, as the comments API returns it. */
export interface RunStatus {
  /** The public id of the run, as the activity route returns it. */
  id?: string | null;
  /** The comment that started the run. */
  comment_id?: string;
  /** The mention that started the run: 'claude' or 'chatgpt'. */
  agent: string;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  /** The numbers of a run that is done, or the cause of a failure. 'not_signed_in' at the start means the person must connect the assistant. */
  detail: string | null;
}

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' } });

/** The mentions that the runner handles: SANDBOX_AGENTS as a comma list, or 'claude' and 'chatgpt'. */
export const sandboxAgents = (env: Env): string[] => (env.SANDBOX_AGENTS ?? 'claude,chatgpt').split(',').map((a) => a.trim().toLowerCase());

/**
 * Makes the connector token of one run. The token reaches only the page of the comment, and it ends after 15 minutes.
 * The same call deletes each connector token that has ended.
 */
async function runToken(env: Env, agent: Mention, slug: string): Promise<{ token: string; tokenId: string }> {
  const token = newToken();
  const tokenId = newTokenId();
  const now = Date.now();
  await env.DB.prepare('DELETE FROM connector_tokens WHERE expires_at <= ?').bind(new Date(now).toISOString()).run();
  await env.DB.prepare('INSERT INTO connector_tokens (token, id, label, slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(token, tokenId, agent, slug, new Date(now + TOKEN_TTL_MS).toISOString(), new Date(now).toISOString())
    .run();
  return { token, tokenId };
}

/** Stores the end of a run and deletes the connector token of the run. Returns false when no run with that id is running, so a second report changes nothing. */
async function finishRun(env: Env, id: string, status: 'done' | 'failed', detail: string | null): Promise<boolean> {
  const res = await env.DB.prepare("UPDATE agent_runs SET status = ?2, finished_at = ?3, ms = CAST(ROUND((julianday(?3) - julianday(started_at)) * 86400000) AS INTEGER), detail = ?4 WHERE id = ?1 AND status = 'running'")
    .bind(id, status, new Date().toISOString(), detail)
    .run();
  if (!res.meta.changes) return false;
  await env.DB.prepare('DELETE FROM connector_tokens WHERE id = (SELECT token_id FROM agent_runs WHERE id = ?)').bind(id).run();
  // The end is an event too, so a viewer that polls the activity of the page sees it at once.
  await noteActivity(env, id, status);
  return true;
}

/**
 * Runs for a comment or a reply that a person wrote with a mention that SANDBOX_AGENTS has. With no SANDBOX_RUNNER_URL it does nothing.
 */
export async function runSandboxAgent(env: Env, comment: Comment, origin: string): Promise<void> {
  const agent = comment.mention;
  if (!agent || !env.SANDBOX_RUNNER_URL || !sandboxAgents(env).includes(agent)) return;
  const id = newToken();
  const { token, tokenId } = await runToken(env, agent, comment.slug);
  await env.DB.prepare("INSERT INTO agent_runs (id, comment_id, agent, status, started_at, token_id) VALUES (?, ?, ?, 'running', ?, ?)").bind(id, comment.id, agent, new Date().toISOString(), tokenId).run();
  // The first event of the run. The viewer shows the reaction on the comment from it.
  await pruneActivity(env, comment.slug, new Date(Date.now() - ACTIVITY_TTL_MS).toISOString()).catch((e) => console.error('activity prune', e));
  await noteActivity(env, id, 'started');
  try {
    const job: Job = { mcp_url: `${origin}/s/_mcp/${token}`, comment_id: comment.id, slug: comment.slug, agent_label: agent, engine: ENGINES[agent], user: comment.author, callback_url: `${origin}/s/_run/${id}`, model: await modelFor(env, comment.author, agent) };
    const res = await fetch(env.SANDBOX_RUNNER_URL, { method: 'POST', headers: { 'content-type': 'application/json', ...(env.SANDBOX_RUNNER_SECRET ? { 'x-runner-secret': env.SANDBOX_RUNNER_SECRET } : {}) }, body: JSON.stringify(job), signal: AbortSignal.timeout(10_000) });
    if (res.status !== 202) throw new Error(`it answered ${res.status}`);
  } catch (e) {
    await finishRun(env, id, 'failed', `runner: ${e instanceof Error ? e.message : String(e)}`.slice(0, MAX_DETAIL));
  }
}

/**
 * Turns the report of the runner into the status and the detail of the run. The runner sends status
 * 'done', 'failed', 'not_signed_in' or 'timeout', and an optional detail text. Anything else is a failure.
 */
export function runResult(body: unknown): { status: 'done' | 'failed'; detail: string | null } {
  const b = (body && typeof body === 'object' ? body : {}) as { status?: unknown; detail?: unknown };
  const detail = typeof b.detail === 'string' && b.detail.trim() ? b.detail.trim() : null;
  if (b.status === 'done') return { status: 'done', detail: detail && detail.slice(0, MAX_DETAIL) };
  const cause = b.status === 'not_signed_in' || b.status === 'timeout' ? b.status : null;
  return { status: 'failed', detail: ([cause, detail].filter(Boolean).join(': ') || 'the runner gave no cause').slice(0, MAX_DETAIL) };
}

/** POST /s/_run/<run id>: the runner reports the end of a run. An unknown id and a run that is not running get the same 404. */
export async function handleRunResult(req: Request, env: Env, id: string): Promise<Response> {
  if (req.method !== 'POST') return answer(405, { error: 'the route takes POST only' });
  const body = await readJson(req, MAX_RESULT_BYTES);
  if (body === undefined) return answer(400, { error: 'send the result as JSON of at most 64 KB' });
  const { status, detail } = runResult(body);
  return (await finishRun(env, id, status, detail)) ? answer(200, { status }) : answer(404, { error: 'no such run' });
}

interface RunRow extends RunStatus {
  /** The id of the first comment of the thread. */
  thread: string;
}

/** A run that is too old to be running counts as failed. */
const settled = <T extends RunStatus>(r: T, now: number): T => (r.status === 'running' && now - Date.parse(r.started_at) > STALE_MS ? { ...r, status: 'failed', detail: 'timeout: the runner sent no result' } : r);

/** The latest run of each thread, from rows that are oldest first. A run that is too old to be running counts as failed. */
export function latestRuns(rows: RunRow[], now: number): Map<string, RunStatus> {
  const out = new Map<string, RunStatus>();
  for (const { thread, ...r } of rows) out.set(thread, settled(r, now));
  return out;
}

/**
 * Adds two members to each thread of a page. `run` is the latest run that a comment of the thread started, or null.
 * `runs` has the latest run of each comment of the thread that started one, by comment id. The viewer shows it on that comment.
 */
export async function withRuns(env: Env, slug: string, threads: Thread[]): Promise<(Thread & { run: RunStatus | null; runs: Record<string, RunStatus> })[]> {
  const { results } = await env.DB.prepare(
    'SELECT COALESCE(c.parent_id, c.id) AS thread, r.comment_id, r.token_id AS id, r.agent, r.status, r.started_at, r.detail FROM agent_runs r JOIN comments c ON c.id = r.comment_id WHERE c.slug = ? ORDER BY r.started_at, r.rowid',
  )
    .bind(slug)
    .all<RunRow>();
  const now = Date.now();
  const runs = latestRuns(results, now);
  const byThread = new Map<string, Record<string, RunStatus>>();
  for (const { thread, ...r } of results) if (r.comment_id) byThread.set(thread, { ...byThread.get(thread), [r.comment_id]: settled(r, now) });
  return threads.map((t) => ({ ...t, run: runs.get(t.id) ?? null, runs: byThread.get(t.id) ?? {} }));
}

/**
 * Starts a run again for a comment that has a mention: the "Try again" button of the viewer. Returns the reason when no run can start.
 * A run of the comment that is too old to be running ends as failed first.
 */
export async function rerunComment(env: Env, comment: Comment, origin: string): Promise<Refusal | (() => Promise<void>)> {
  if (!comment.mention) return { status: 400, error: 'the comment has no @claude or @chatgpt' };
  if (!env.SANDBOX_RUNNER_URL || !sandboxAgents(env).includes(comment.mention)) return { status: 503, error: `no sandbox runner handles @${comment.mention}` };
  const { results } = await env.DB.prepare("SELECT id, started_at FROM agent_runs WHERE comment_id = ? AND status = 'running'").bind(comment.id).all<{ id: string; started_at: string }>();
  for (const r of results) {
    if (Date.now() - Date.parse(r.started_at) <= STALE_MS) return { status: 409, error: 'a run for this comment is running' };
    await finishRun(env, r.id, 'failed', 'timeout: the runner sent no result');
  }
  return () => runSandboxAgent(env, comment, origin);
}

/**
 * POST /api/assistants/warm: a person opened a comment box, so the runner can get a sandbox ready before the comment arrives.
 * The host sends POST <runner origin>/warm with { user } at most one time in 60 seconds for each person. D1 holds the time
 * of the last call, because a Worker has no memory between requests. Returns the request to the runner, for waitUntil,
 * or null when the host sends nothing: no runner, or a call for this person in the last 60 seconds.
 */
export async function warmRunner(env: Env, user: string, now = Date.now()): Promise<(() => Promise<void>) | null> {
  if (!env.SANDBOX_RUNNER_URL) return null;
  const res = await env.DB.prepare('INSERT INTO runner_warm (user, at) VALUES (?1, ?2) ON CONFLICT (user) DO UPDATE SET at = excluded.at WHERE runner_warm.at <= ?3')
    .bind(user, new Date(now).toISOString(), new Date(now - WARM_EVERY_MS).toISOString())
    .run();
  if (!res.meta.changes) return null;
  const url = new URL('/warm', env.SANDBOX_RUNNER_URL).href;
  const secret = env.SANDBOX_RUNNER_SECRET;
  return async () => {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-runner-secret': secret } : {}) }, body: JSON.stringify({ user }), signal: AbortSignal.timeout(10_000) });
  };
}
