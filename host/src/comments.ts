// Comments in D1. People write them in the viewer, and assistants reply through the MCP connector.
import { newId, parseMention, type Mention } from './lib';
import type { Comment, Env, Refusal, Thread } from './types';

export const MAX_COMMENT = 4000;
const MAX_QUOTE = 1000;
const MAX_ANCHOR = 200;
/** The text before and after the quote that the viewer stores with a comment. A longer text loses its far end. */
export const MAX_CONTEXT = 64;

const COLUMNS = 'id, slug, version, anchor, quote, prefix, suffix, slide, body, author, mention, parent_id, status, created_at, edited_at';

export interface CommentInput {
  /** The page. A reply may leave it out: it goes to the page of its thread. */
  slug?: string;
  body: unknown;
  author: string;
  anchor?: unknown;
  quote?: unknown;
  /** The page text just before the quote and just after it. The viewer finds the quote again with them after an edit. */
  prefix?: unknown;
  suffix?: unknown;
  /** The id of the slide that has the quote, for a deck. */
  slide?: unknown;
  parent_id?: unknown;
}

const refuse = (status: number, error: string): Refusal => ({ error, status });
const optional = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export async function getComment(env: Env, id: string) {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM comments WHERE id = ?`).bind(id).first<Comment>();
}

/** Stores a comment on the latest version of its page. A reply to a reply joins the same thread. */
export async function addComment(env: Env, input: CommentInput): Promise<Comment | Refusal> {
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) return refuse(400, 'the comment has no body');
  if (body.length > MAX_COMMENT) return refuse(413, `the comment is over ${MAX_COMMENT} characters`);
  const anchor = optional(input.anchor);
  const quote = optional(input.quote);
  if (anchor && anchor.length > MAX_ANCHOR) return refuse(413, `the anchor is over ${MAX_ANCHOR} characters`);
  if (quote && quote.length > MAX_QUOTE) return refuse(413, `the quote is over ${MAX_QUOTE} characters`);
  const slide = optional(input.slide);
  if (slide && slide.length > MAX_ANCHOR) return refuse(413, `the slide id is over ${MAX_ANCHOR} characters`);
  // The context counts only with a quote. The prefix keeps its end and the suffix keeps its start: the parts next to the quote.
  const prefix = quote ? (optional(input.prefix)?.slice(-MAX_CONTEXT) ?? null) : null;
  const suffix = quote ? (optional(input.suffix)?.slice(0, MAX_CONTEXT) ?? null) : null;
  let slug = input.slug;
  let parent_id: string | null = null;
  if (input.parent_id != null) {
    const parent = typeof input.parent_id === 'string' ? await getComment(env, input.parent_id) : null;
    if (!parent || (slug && parent.slug !== slug)) return refuse(404, 'no such comment');
    parent_id = parent.parent_id ?? parent.id;
    slug = parent.slug;
  }
  const page = slug ? await env.DB.prepare('SELECT latest FROM pages WHERE slug = ?').bind(slug).first<{ latest: number }>() : null;
  if (!slug || !page) return refuse(404, 'no such page');
  const c: Comment = { id: newId(), slug, version: page.latest, anchor, quote, prefix, suffix, slide, body, author: input.author, mention: parseMention(body), parent_id, status: 'open', created_at: new Date().toISOString(), edited_at: null };
  await env.DB.prepare(`INSERT INTO comments (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(c.id, c.slug, c.version, c.anchor, c.quote, c.prefix, c.suffix, c.slide, c.body, c.author, c.mention, c.parent_id, c.status, c.created_at, null)
    .run();
  return c;
}

export interface ThreadFilter {
  slug?: string;
  /** Default: every status. */
  status?: 'open' | 'resolved';
  /** Keeps the threads where the first comment or a reply has this mention. */
  mention?: Mention;
}

/** The threads, oldest first, each with its replies. */
export async function listThreads(env: Env, f: ThreadFilter = {}): Promise<Thread[]> {
  const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM comments WHERE (?1 IS NULL OR slug = ?1) ORDER BY created_at, rowid LIMIT 5000`)
    .bind(f.slug ?? null)
    .all<Comment>();
  const threads = new Map<string, Thread>();
  for (const c of results) if (!c.parent_id) threads.set(c.id, { ...c, replies: [] });
  for (const c of results) if (c.parent_id) threads.get(c.parent_id)?.replies.push(c);
  return [...threads.values()].filter(
    (t) => (!f.status || t.status === f.status) && (!f.mention || t.mention === f.mention || t.replies.some((r) => r.mention === f.mention)),
  );
}

/** Resolves a thread by the id of its first comment. Returns false when no thread has that id. */
export async function resolveThread(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare("UPDATE comments SET status = 'resolved' WHERE id = ? AND parent_id IS NULL").bind(id).run();
  return res.meta.changes > 0;
}

/** Opens a resolved thread again by the id of its first comment. Returns false when no thread has that id. */
export async function reopenThread(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare("UPDATE comments SET status = 'open' WHERE id = ? AND parent_id IS NULL").bind(id).run();
  return res.meta.changes > 0;
}

/**
 * Changes the body of a comment. Only its author can change it. The mention follows the new body, but a change starts no run:
 * the assistant answers a comment when a person writes it, and "Try again" starts a run again.
 */
export async function editComment(env: Env, id: string, author: string, value: unknown): Promise<Comment | Refusal> {
  const c = await getComment(env, id);
  if (!c) return refuse(404, 'no such comment');
  if (c.author !== author) return refuse(403, 'you can change only your own comments');
  const body = typeof value === 'string' ? value.trim() : '';
  if (!body) return refuse(400, 'the comment has no body');
  if (body.length > MAX_COMMENT) return refuse(413, `the comment is over ${MAX_COMMENT} characters`);
  const edited: Comment = { ...c, body, mention: parseMention(body), edited_at: new Date().toISOString() };
  await env.DB.prepare('UPDATE comments SET body = ?, mention = ?, edited_at = ? WHERE id = ?').bind(edited.body, edited.mention, edited.edited_at, id).run();
  return edited;
}

/**
 * Deletes a comment. Only its author can delete it. The first comment of a thread takes the whole thread with it: the replies,
 * the runs of the thread, their events and their connector tokens. Returns the number of comments that it deleted.
 */
export async function deleteComment(env: Env, id: string, author: string): Promise<{ deleted: number } | Refusal> {
  const c = await getComment(env, id);
  if (!c) return refuse(404, 'no such comment');
  if (c.author !== author) return refuse(403, 'you can delete only your own comments');
  // ?1 is the comment. ?2 is 1 for the first comment of a thread, so the same statements serve a reply and a thread.
  const root = c.parent_id ? 0 : 1;
  const ids = 'SELECT id FROM comments WHERE id = ?1 OR (?2 = 1 AND parent_id = ?1)';
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${ids})`).bind(id, root).first<{ n: number }>();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM run_events WHERE run_id IN (SELECT id FROM agent_runs WHERE comment_id IN (${ids}))`).bind(id, root),
    env.DB.prepare(`DELETE FROM connector_tokens WHERE id IN (SELECT token_id FROM agent_runs WHERE comment_id IN (${ids}))`).bind(id, root),
    env.DB.prepare(`DELETE FROM agent_runs WHERE comment_id IN (${ids})`).bind(id, root),
    env.DB.prepare('DELETE FROM comments WHERE id = ?1 OR (?2 = 1 AND parent_id = ?1)').bind(id, root),
  ]);
  return { deleted: Number(count?.n ?? 0) };
}
