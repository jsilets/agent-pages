// What happened to the pages, as one list for the library: versions, comments and assistant runs.
// The comments and agent_runs tables come from the comment branch (0004, 0006). This file reads their rows only.

/** One stored version of a page. */
export interface VersionEvent {
  slug: string;
  version: number;
  created_at: string;
}

/** One row of the comments table. A reply has parent_id set to the first comment of its thread. */
export interface CommentRow {
  id: string;
  slug: string;
  /** The page version the comment was written on. */
  version: number;
  anchor: string | null;
  quote: string | null;
  body: string;
  author: string;
  mention: string | null;
  parent_id: string | null;
  status: string;
  created_at: string;
}

/** One assistant run, without its id. The id is a secret, so the library never reads it. */
export interface RunRow {
  comment_id: string;
  agent: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  detail: string | null;
}

/** A run with no result after this time counts as failed. The comment branch uses the same limit. */
export const STALE_MS = 5 * 60 * 1000;
/** A version or a reply belongs to a run when it is this near to the end of the run. */
const SLACK_MS = 15 * 1000;

/** A version that no run stored: an agent or a person published it. */
export interface Publish {
  kind: 'publish';
  id: string;
  slug: string;
  at: string;
  version: number;
  /** True for the first version of the page. */
  first: boolean;
}

/** A comment that asked an assistant for a change, and what came of it. */
export interface Request {
  kind: 'request';
  id: string;
  slug: string;
  /** When the run ended, or when it started if it has no end. */
  at: string;
  started: string;
  /** working: the run has no result yet. changed: it stored a version. replied: it wrote back and stored nothing. */
  state: 'working' | 'changed' | 'replied' | 'failed';
  agent: string;
  /** The comment without its mention. */
  ask: string;
  quote: string | null;
  anchor: string | null;
  author: string;
  /** The version the comment was written on. */
  from: number;
  /** The version the run stored, or null. */
  version: number | null;
  /** What the assistant wrote back, or null. */
  reply: string | null;
  cause: 'not_connected' | 'timeout' | 'error' | null;
  /** False when the thread is resolved. */
  open: boolean;
}

/** A comment thread that started no run. */
export interface Note {
  kind: 'note';
  id: string;
  slug: string;
  at: string;
  author: string;
  body: string;
  quote: string | null;
  anchor: string | null;
  replies: number;
  open: boolean;
}

export type Item = Publish | Request | Note;

/** The comment as the person wrote it, without "@claude" or "@chatgpt". */
export const withoutMention = (body: string) => body.replace(/@(claude|chatgpt)\b[,:]?\s*/gi, '').replace(/\s+/g, ' ').trim();

/**
 * The id of a request: the comment and the second the run started, in base 36.
 * It does not change when more runs arrive, so an address that names it stays good.
 */
export const requestId = (commentId: string, startedAt: string) => `q:${commentId}:${Math.floor(Date.parse(startedAt) / 1000).toString(36)}`;

function causeOf(detail: string | null): Request['cause'] {
  if (detail?.startsWith('not_signed_in')) return 'not_connected';
  if (detail?.startsWith('timeout')) return 'timeout';
  return 'error';
}

/**
 * Joins the rows into the list of things that happened, newest first.
 * A run that is done owns the version stored during the run and the reply its assistant wrote.
 * Each other version is a publish. Each thread with no run is a note.
 */
export function deriveActivity(versions: VersionEvent[], comments: CommentRow[], runs: RunRow[], now: number, limit = 200): Item[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const repliesOf = new Map<string, CommentRow[]>();
  for (const c of comments) if (c.parent_id) repliesOf.set(c.parent_id, [...(repliesOf.get(c.parent_id) ?? []), c]);
  const claimed = new Set<string>();
  /** The newest request of each thread. Only that one can be open. */
  const lastOf = new Map<string, Request>();
  const items: Item[] = [];

  const oldestFirst = [...runs].sort((a, b) => a.started_at.localeCompare(b.started_at));
  for (const run of oldestFirst) {
    const ask = byId.get(run.comment_id);
    if (!ask) continue;
    const first = ask.parent_id ? byId.get(ask.parent_id) : ask;
    if (!first) continue;
    const start = Date.parse(run.started_at);
    const end = run.finished_at ? Date.parse(run.finished_at) : null;
    const during = (iso: string) => end !== null && Date.parse(iso) >= start && Date.parse(iso) <= end + SLACK_MS;

    let state: Request['state'];
    let cause: Request['cause'] = null;
    let version: number | null = null;
    let reply: string | null = null;
    if (run.status === 'running') {
      if (now - start > STALE_MS) { state = 'failed'; cause = 'timeout'; } else state = 'working';
    } else if (run.status === 'done') {
      const stored = versions
        .filter((v) => v.slug === ask.slug && v.version > ask.version && during(v.created_at) && !claimed.has(`${v.slug}#${v.version}`))
        .sort((a, b) => a.version - b.version)[0];
      if (stored) { claimed.add(`${stored.slug}#${stored.version}`); version = stored.version; }
      reply = (repliesOf.get(first.id) ?? []).filter((c) => c.author === run.agent && during(c.created_at)).at(-1)?.body ?? null;
      state = stored ? 'changed' : 'replied';
    } else {
      state = 'failed';
      cause = causeOf(run.detail);
    }
    const item: Request = {
      kind: 'request', id: requestId(ask.id, run.started_at), slug: ask.slug, at: run.finished_at ?? run.started_at, started: run.started_at, state, agent: run.agent,
      ask: withoutMention(ask.body), quote: ask.quote ?? first.quote, anchor: ask.anchor ?? first.anchor, author: ask.author,
      from: ask.version, version, reply, cause, open: first.status === 'open',
    };
    // A newer run of the same thread takes the place of the older one. The older one stays in the list, closed.
    const older = lastOf.get(first.id);
    if (older) older.open = false;
    lastOf.set(first.id, item);
    items.push(item);
  }

  for (const v of versions) {
    if (!claimed.has(`${v.slug}#${v.version}`)) items.push({ kind: 'publish', id: `v:${v.slug}:${v.version}`, slug: v.slug, at: v.created_at, version: v.version, first: v.version === 1 });
  }
  for (const c of comments) {
    if (c.parent_id || lastOf.has(c.id)) continue;
    const replies = repliesOf.get(c.id) ?? [];
    items.push({ kind: 'note', id: `c:${c.id}`, slug: c.slug, at: c.created_at, author: c.author, body: c.body, quote: c.quote, anchor: c.anchor, replies: replies.length, open: c.status === 'open' });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
