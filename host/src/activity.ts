// Run activity: what an assistant does during a run, so the viewer can show its cursor in the page.
// The events come from two senders. The sandbox runner posts them at POST /s/_run/<run id>/progress while the
// assistant writes. The host adds its own events: from each tool call of the MCP connector, and from the start and
// the end of a run. The host events are the baseline: they arrive with no runner support, and they are exact.
// The table run_events holds the events. The state of a run is not stored: reduceActivity makes it from the events.
import { blobKey, plainText, readJson } from './lib';
import type { Env } from './types';

export type ActivityKind = 'started' | 'tool' | 'focus' | 'typing' | 'edit' | 'version' | 'done' | 'failed';
const RUNNER_KINDS = ['started', 'tool', 'focus', 'typing'] as const;

/** The runner sends at most this many characters of old_text and of new_text. The host cuts longer texts. */
export const MAX_QUOTE = 500;
export const MAX_TEXT = 2000;
/** The text before an edit that the viewer uses to pick one of two equal quotes. */
const MAX_BEFORE = 80;
const MAX_PROGRESS_BYTES = 16 * 1024;
/** A run that sends more events than this is not a run of an assistant. */
const MAX_SEQ = 5000;
/** A run with no result after this time counts as failed. sandbox.ts uses the same time. */
const STALE_MS = 5 * 60 * 1000;

export interface EventData {
  tool?: string;
  /** The text that the assistant replaces, as plain text. */
  quote?: string;
  /** The new text so far, as plain text. */
  text?: string;
  /** The plain text just before the quote in the page. */
  before?: string;
  /** The last element id before the quote in the page. */
  anchor?: string | null;
  version?: number;
  detail?: string;
}

export interface NewEvent {
  /** The number from the runner, or null for an event that the host made. */
  seq: number | null;
  at: string;
  kind: ActivityKind;
  data: EventData;
}

export interface ActivityEvent extends EventData {
  /** The order in which the host stored the event. */
  id: number;
  seq: number | null;
  kind: string;
}

/** The latest state of one run. */
export interface Activity {
  phase: 'starting' | 'reading' | 'editing' | 'replying' | 'done' | 'failed';
  tool: string | null;
  quote: string | null;
  text: string | null;
  /** True when text is the whole new text, from the edit_page call itself. */
  final: boolean;
  before: string | null;
  anchor: string | null;
  /** The version that the run stored, or null. */
  version: number | null;
  /** The id of the newest event of the run. */
  rev: number;
  /** The highest runner seq that changed the state. */
  seq: number;
}

/**
 * The visible text of an HTML fragment that may start or end in the middle of a tag: an old_text, or a new_text that
 * the assistant has not finished. The viewer shows this text and never the HTML.
 */
export function quoteText(html: string): string {
  let s = html;
  const gt = s.indexOf('>');
  const lt = s.indexOf('<');
  // The fragment starts inside a tag: class="k-lede">Text.
  if (gt >= 0 && (lt < 0 || gt < lt)) s = s.slice(gt + 1);
  s = s
    .replace(/<(script|style|template|svg)\b(?![\s\S]*<\/\1\s*>)[\s\S]*$/i, '')
    .replace(/<[^>]*$/, '')
    .replace(/&[#\w]{0,10}$/, '');
  return plainText(s);
}

/**
 * Where an old_text sits in the stored HTML: the plain text just before it, and the last element id before it.
 * Returns null when the old_text does not occur exactly once.
 */
export function locate(html: string, oldText: string): { before: string; anchor: string | null } | null {
  const at = oldText ? html.indexOf(oldText) : -1;
  if (at < 0 || html.indexOf(oldText, at + 1) >= 0) return null;
  const body = Math.max(0, html.search(/<body\b/i));
  const before = quoteText(html.slice(Math.max(body, at - 800), at)).slice(-MAX_BEFORE);
  // The old_text may start with the tag that has the id: <section id="costs">.
  const upTo = html.slice(body, at) + (oldText.match(/^\s*<[^>]*>/)?.[0] ?? '');
  const ids = [...upTo.matchAll(/<[a-z][^<>]*?\sid\s*=\s*(["'])([^"'<>]{1,200})\1/gi)];
  return { before, anchor: ids.length ? ids[ids.length - 1][2] : null };
}

/** The events of one edit_page call, in order: one 'edit' for each of the first 8 edits. html is the page before the edits. */
export function editEvents(html: string, edits: { old_text: string; new_text: string }[], at: string): NewEvent[] {
  return edits.slice(0, 8).map((e) => {
    const where = locate(html, e.old_text);
    return { seq: null, at, kind: 'edit' as const, data: { quote: quoteText(e.old_text).slice(0, MAX_QUOTE), text: quoteText(e.new_text).slice(0, MAX_TEXT), before: where?.before ?? '', anchor: where?.anchor ?? null } };
  });
}

const sameSpot = (a: string | null, b: string | undefined) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * The state of a run after its events. The events apply in the order of their id. An event from the runner with a seq
 * that is not above the highest seq before it changes nothing, so a late event and a repeated event never move the
 * cursor back. After the host saw the edit_page call, the runner's typing events for the same text change nothing.
 */
export function reduceActivity(events: ActivityEvent[]): Activity {
  const a: Activity = { phase: 'starting', tool: null, quote: null, text: null, final: false, before: null, anchor: null, version: null, rev: 0, seq: 0 };
  for (const e of [...events].sort((x, y) => x.id - y.id)) {
    a.rev = Math.max(a.rev, e.id);
    if (e.seq != null) {
      if (e.seq <= a.seq) continue;
      a.seq = e.seq;
    }
    if (a.phase === 'done' || a.phase === 'failed') continue;
    if (e.kind === 'tool') {
      a.tool = e.tool ?? null;
      if (e.tool === 'edit_page') a.phase = 'editing';
      else if (e.tool === 'reply_to_comment') a.phase = 'replying';
      else {
        a.phase = 'reading';
        Object.assign(a, { quote: null, text: null, final: false, before: null, anchor: null });
      }
    } else if (e.kind === 'focus' || e.kind === 'typing') {
      if (!e.quote || (a.final && sameSpot(a.quote, e.quote))) continue;
      const same = sameSpot(a.quote, e.quote);
      a.phase = 'editing';
      a.before = e.before ?? (same ? a.before : null);
      a.anchor = e.anchor ?? (same ? a.anchor : null);
      a.text = e.kind === 'typing' ? (e.text ?? '') : same ? a.text : null;
      a.quote = e.quote;
      a.final = false;
    } else if (e.kind === 'edit') {
      Object.assign(a, { phase: 'editing', quote: e.quote ?? null, text: e.text ?? '', final: true, before: e.before ?? null, anchor: e.anchor ?? null });
    } else if (e.kind === 'version') a.version = e.version ?? a.version;
    else if (e.kind === 'done' || e.kind === 'failed') a.phase = e.kind;
  }
  return a;
}

/** Claude Code names a connector tool mcp__<server>__edit_page. The viewer needs the last part. */
const toolName = (t: string) => t.slice(t.lastIndexOf('__') < 0 ? 0 : t.lastIndexOf('__') + 2);

/**
 * Checks one progress event from the runner. Returns the event to store, or the error text.
 * oldText is the old_text as the runner sent it, for a 'focus' event.
 */
export function parseProgress(body: unknown, now = new Date().toISOString()): { event: NewEvent; oldText?: string } | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const seq = b.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) return `seq must be a whole number from 1 to ${MAX_SEQ}`;
  const kind = RUNNER_KINDS.find((k) => k === b.kind);
  if (!kind) return `kind must be one of ${RUNNER_KINDS.join(', ')}`;
  const at = typeof b.at === 'string' && b.at.length <= 40 && !Number.isNaN(Date.parse(b.at)) ? b.at : now;
  const data: EventData = {};
  if (kind === 'tool') {
    if (typeof b.tool !== 'string' || !/^[\w.-]{1,96}$/.test(b.tool)) return 'a tool event needs the tool name';
    data.tool = toolName(b.tool);
  }
  if (kind === 'focus' || kind === 'typing') {
    if (typeof b.quote !== 'string' || !b.quote) return `a ${kind} event needs quote`;
    data.quote = quoteText(b.quote.slice(0, MAX_QUOTE));
  }
  if (kind === 'typing') {
    if (typeof b.text !== 'string') return 'a typing event needs text';
    data.text = quoteText(b.text.slice(0, MAX_TEXT));
  }
  return { event: { seq, at, kind, data }, ...(kind === 'focus' ? { oldText: (b.quote as string).slice(0, MAX_QUOTE) } : {}) };
}

/**
 * Stores one event of a run. Returns false when no run has that id, or when the run has ended and the event is not its end.
 * A second event with the same seq changes nothing and returns true. A run keeps only its newest typing event.
 */
export async function recordActivity(env: Env, runId: string, ev: NewEvent): Promise<boolean> {
  if (ev.kind === 'typing' && ev.seq != null) await env.DB.prepare("DELETE FROM run_events WHERE run_id = ? AND kind = 'typing' AND seq < ?").bind(runId, ev.seq).run();
  const ended = ev.kind === 'done' || ev.kind === 'failed' ? 1 : 0;
  const res = await env.DB.prepare(
    `INSERT INTO run_events (run_id, slug, seq, at, kind, data)
     SELECT r.id, c.slug, ?2, ?3, ?4, ?5 FROM agent_runs r JOIN comments c ON c.id = r.comment_id WHERE r.id = ?1 AND (r.status = 'running' OR ?6 = 1)
     ON CONFLICT (run_id, seq) DO UPDATE SET seq = excluded.seq`,
  )
    .bind(runId, ev.seq, ev.at, ev.kind, JSON.stringify(ev.data), ended)
    .run();
  return res.meta.changes > 0;
}

/** Stores host events of a run. A failure here must never break the tool call or the run, so it only logs. */
export async function noteActivity(env: Env, runId: string | undefined, kind: ActivityKind, data: EventData = {}): Promise<void> {
  if (!runId) return;
  try {
    await recordActivity(env, runId, { seq: null, at: new Date().toISOString(), kind, data });
  } catch (e) {
    console.error('activity', kind, e);
  }
}

/** Deletes the events of the runs on this page that ended before the given time. */
export async function pruneActivity(env: Env, slug: string, before: string): Promise<void> {
  await env.DB.prepare("DELETE FROM run_events WHERE slug = ?1 AND run_id IN (SELECT id FROM agent_runs WHERE status != 'running' AND finished_at < ?2)").bind(slug, before).run();
}

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' } });

/**
 * POST /s/_run/<run id>/progress: the runner reports what the assistant does. The secret run id is the only check.
 * An unknown id and a run that has ended get the same 404. A 'focus' event reads the page, so the host can add
 * the text before the quote.
 */
export async function handleRunProgress(req: Request, env: Env, id: string): Promise<Response> {
  if (req.method !== 'POST') return answer(405, { error: 'the route takes POST only' });
  const body = await readJson(req, MAX_PROGRESS_BYTES);
  if (body === undefined) return answer(400, { error: 'send the event as JSON of at most 16 KB' });
  const parsed = parseProgress(body);
  if (typeof parsed === 'string') return answer(400, { error: parsed });
  const { event, oldText } = parsed;
  if (oldText) {
    const page = await env.DB.prepare("SELECT c.slug AS slug, p.latest AS latest FROM agent_runs r JOIN comments c ON c.id = r.comment_id JOIN pages p ON p.slug = c.slug WHERE r.id = ? AND r.status = 'running'")
      .bind(id)
      .first<{ slug: string; latest: number }>();
    if (!page) return answer(404, { error: 'no such run' });
    const obj = await env.PAGES.get(blobKey(page.slug, page.latest));
    const where = obj ? locate(await obj.text(), oldText) : null;
    if (where) Object.assign(event.data, where);
  }
  return (await recordActivity(env, id, event)) ? answer(200, { seq: event.seq }) : answer(404, { error: 'no such run' });
}

/** One run in the answer of the activity route: the run, the hint from its comment, and its state. */
export interface RunActivity extends Activity {
  /** The public id of the run. It is the id of the run's connector token, and it is not the secret run id. */
  id: string;
  comment_id: string;
  /** The id of the first comment of the thread. */
  thread: string;
  agent: string;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  detail: string | null;
  /** The quote and the anchor of the comment. The viewer uses them when an event has no position. */
  hint: { quote: string | null; anchor: string | null };
}

export interface PageActivity {
  latest: number;
  /** The id of the newest event on the page. Send it as ?since= with the next request. */
  cursor: number;
  /** Not set when nothing changed since the cursor of the request. */
  runs?: RunActivity[];
}

interface RunRow {
  rid: string;
  id: string | null;
  comment_id: string;
  thread: string;
  agent: string;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  detail: string | null;
  quote: string | null;
  anchor: string | null;
}

interface EventRow {
  id: number;
  run_id: string;
  seq: number | null;
  kind: string;
  data: string | null;
}

const dataOf = (s: string | null): EventData => {
  try {
    return (s ? JSON.parse(s) : {}) as EventData;
  } catch {
    return {};
  }
};

/** The runs to show: each run that is running, and each run that got an event after `since`. */
export function activeRuns(runs: RunRow[], events: EventRow[], since: number, now: number): RunActivity[] {
  const byRun = new Map<string, ActivityEvent[]>();
  for (const e of events) byRun.set(e.run_id, [...(byRun.get(e.run_id) ?? []), { id: e.id, seq: e.seq, kind: e.kind, ...dataOf(e.data) }]);
  const out: RunActivity[] = [];
  for (const { rid, quote, anchor, ...r } of runs) {
    const state = reduceActivity(byRun.get(rid) ?? []);
    const stale = r.status === 'running' && now - Date.parse(r.started_at) > STALE_MS;
    if (!(r.status === 'running' && !stale) && !(since > 0 && state.rev > since)) continue;
    const status = stale ? 'failed' : r.status;
    out.push({ ...state, ...r, id: r.id ?? r.comment_id, status, detail: status === 'failed' ? (stale ? 'timeout: the runner sent no result' : r.detail) : null, phase: status === 'running' ? state.phase : status, hint: { quote, anchor } });
  }
  return out;
}

/**
 * GET /api/pages/<slug>/activity?since=<cursor>: the latest version of the page and the state of its runs.
 * The first query reads two rows. When the cursor did not move, the answer has no `runs`, and the host reads nothing more.
 * Returns null when no page has the slug.
 */
export async function pageActivity(env: Env, slug: string, since: number): Promise<PageActivity | null> {
  const head = await env.DB.prepare('SELECT latest, (SELECT MAX(id) FROM run_events WHERE slug = ?1) AS cursor FROM pages WHERE slug = ?1').bind(slug).first<{ latest: number; cursor: number | null }>();
  if (!head) return null;
  const cursor = head.cursor ?? 0;
  if (cursor === since) return { latest: head.latest, cursor };
  const [runs, events] = await Promise.all([
    env.DB.prepare(
      'SELECT r.id AS rid, r.token_id AS id, r.comment_id, COALESCE(c.parent_id, c.id) AS thread, r.agent, r.status, r.started_at, r.detail, c.quote, c.anchor FROM agent_runs r JOIN comments c ON c.id = r.comment_id WHERE c.slug = ? ORDER BY r.started_at, r.rowid',
    )
      .bind(slug)
      .all<RunRow>(),
    env.DB.prepare('SELECT id, run_id, seq, kind, data FROM run_events WHERE slug = ? ORDER BY id').bind(slug).all<EventRow>(),
  ]);
  return { latest: head.latest, cursor, runs: activeRuns(runs.results, events.results, since, Date.now()) };
}
