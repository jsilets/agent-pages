import { describe, expect, it } from 'vitest';
import '../../kit/explain.js';
import { activeRuns, editEvents, handleRunProgress, locate, pageActivity, parseProgress, quoteText, recordActivity, reduceActivity, type ActivityEvent } from './activity';
import { route } from './lib';
import { testDb } from './testdb';
import type { Env } from './types';

type Hit = { a: [number, number]; b: [number, number]; exact: boolean } | null;
const { findQuote } = (globalThis as unknown as { Explain: { findQuote: (texts: string[], quote: string, hint?: string, fromNode?: number) => Hit } }).Explain;

/** The text nodes of an HTML fragment, in order, as a browser makes them: one for each run of text between tags. */
const textNodes = (html: string) => html.split(/<[^>]+>/).filter((t) => t !== '');
/** The text that a match covers. */
const cut = (texts: string[], h: NonNullable<Hit>) => texts.slice(h.a[0], h.b[0] + 1).map((t, i, all) => t.slice(i === 0 ? h.a[1] : 0, i === all.length - 1 ? h.b[1] : undefined)).join('');

const PAGE = `<main><h1>How a heat pump heats a house</h1>
<p class="k-lede">A heat pump moves heat from the outside air. It uses about <b>one third</b> of the energy of a gas boiler.</p>
<section id="moves"><h2>A heat pump moves heat.</h2>
<p>Heat pumps move heat from <b>one place</b> to another place, and they use <em>much less
   energy</em> than a boiler.</p></section>
<section id="cost"><h2>The cost</h2><ul><li>Insulate the roof first.</li><li>Seal the gaps.</li></ul>
<p>A grant makes that time shorter.</p><p>A grant makes that time shorter.</p></section></main>`;

describe('findQuote', () => {
  const texts = textNodes(PAGE);
  it('finds a quote that inline tags and line breaks split into several text nodes', () => {
    const h = findQuote(texts, quoteText('Heat pumps move heat from <b>one place</b> to another place, and they use <em>much less\n energy</em> than a boiler.'))!;
    expect(h.exact).toBe(true);
    expect(texts[h.a[0]].slice(h.a[1], h.a[1] + 10)).toBe('Heat pumps');
    expect(h.b[0] - h.a[0]).toBe(4);
    expect(cut(texts, h).replace(/\s+/g, ' ')).toBe('Heat pumps move heat from one place to another place, and they use much less energy than a boiler.');
  });
  it('finds a quote across two list items that have no white space between them', () => {
    expect(cut(texts, findQuote(texts, 'Insulate the roof first. Seal the gaps.')!)).toBe('Insulate the roof first.Seal the gaps.');
  });
  it('takes a quote that is only the start of the old text', () => {
    const h = findQuote(texts, 'Heat pumps move heat from one pla')!;
    expect(h.exact).toBe(true);
    expect(cut(texts, h)).toBe('Heat pumps move heat from one pla');
  });
  it('takes the longest start of a quote when the end is not in the page text', () => {
    const h = findQuote(texts, 'It uses about one third of the energy of a gas boiler. data-x="not in the text"')!;
    expect(h.exact).toBe(false);
    expect(cut(texts, h)).toBe('It uses about one third of the energy of a gas boiler.');
  });
  it('returns null for a quote that is not in the page, for a short start, and for a quote under 4 characters', () => {
    expect(findQuote(texts, 'This sentence is not in the page at all.')).toBeNull();
    expect(findQuote(texts, 'Heat pumps mXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')).toBeNull();
    expect(findQuote(texts, 'the')).toBeNull();
  });
  it('returns null for a quote that occurs two times and has no hint', () => {
    expect(findQuote(texts, 'A grant makes that time shorter.')).toBeNull();
    expect(findQuote(texts, 'A grant makes that time shorter.', 'no such text in the page')).toBeNull();
  });
  it('takes the first match at or after the hint, or after the given text node', () => {
    const first = findQuote(texts, 'A grant makes that time shorter.', 'Seal the gaps.')!;
    expect(texts[first.a[0] - 2]).toBe('Seal the gaps.');
    expect(findQuote(texts, 'A grant makes that time shorter.', '', first.a[0] + 1)!.a[0]).toBe(first.a[0] + 1);
    expect(findQuote(texts, 'A grant makes that time shorter.', 'Seal the gaps.', first.a[0] + 1)!.a[0]).toBe(first.a[0] + 1);
    // "heat" occurs many times: the hint picks the one in the second heading.
    expect(findQuote(texts, 'moves heat', 'than a boiler')).toBeNull();
    expect(texts[findQuote(texts, 'moves heat', 'gas boiler.')!.a[0]]).toBe('A heat pump moves heat.');
  });
});

describe('quoteText and locate', () => {
  it('gives the visible text of an HTML fragment that is cut in a tag or in an entity', () => {
    expect(quoteText('<p class="k-lede">A &amp; B <b>bold</b> text</p>')).toBe('A & B bold text');
    expect(quoteText('k-lede">The answer <b>is</b> here <span cla')).toBe('The answer is here');
    expect(quoteText('Fish &amp; chips &am')).toBe('Fish & chips');
    expect(quoteText('<p>Text</p><script type="text/plain">a -> b')).toBe('Text');
    expect(quoteText('<img src="x" onerror="alert(1)">')).toBe('');
  });
  it('gives the text and the last id before an old_text that occurs one time', () => {
    const old = '<p>Heat pumps move heat from <b>one place</b>';
    expect(locate(PAGE, old)).toEqual({ before: 'A heat pump moves heat from the outside air. It uses about one third of the energy of a gas boiler. A heat pump moves heat.'.slice(-80), anchor: 'moves' });
    expect(locate(PAGE, '<section id="cost"><h2>The cost</h2>')?.anchor).toBe('cost');
    expect(locate(PAGE, '<h1>How a heat pump')).toEqual({ before: '', anchor: null });
  });
  it('gives null for an old_text that occurs two times or not at all', () => {
    expect(locate(PAGE, '<p>A grant makes that time shorter.</p>')).toBeNull();
    expect(locate(PAGE, 'no such text')).toBeNull();
    expect(locate(PAGE, '')).toBeNull();
  });
  it('makes one edit event for each edit, as plain text with its position', () => {
    const [e] = editEvents(PAGE, [{ old_text: '<li>Seal the gaps.</li>', new_text: '<li>Seal <b>each</b> gap.</li>' }], 'T');
    expect(e).toEqual({ seq: null, at: 'T', kind: 'edit', data: { quote: 'Seal the gaps.', text: 'Seal each gap.', before: 'A heat pump moves heat. Heat pumps move heat from one place to another place, and they use much less energy than a boiler. The cost Insulate the roof first.'.slice(-80), anchor: 'cost' } });
  });
});

describe('reduceActivity', () => {
  let id = 0;
  const ev = (seq: number | null, kind: string, more: Partial<ActivityEvent> = {}): ActivityEvent => ({ id: ++id, seq, kind, ...more });
  it('follows a run from the start to the reply', () => {
    const events = [ev(null, 'started'), ev(1, 'started'), ev(2, 'tool', { tool: 'list_comments' }), ev(3, 'tool', { tool: 'get_page' })];
    expect(reduceActivity(events)).toMatchObject({ phase: 'reading', tool: 'get_page', quote: null, seq: 3 });
    events.push(ev(4, 'tool', { tool: 'edit_page' }), ev(5, 'focus', { quote: 'Old text', before: 'Before.', anchor: 'a' }));
    expect(reduceActivity(events)).toMatchObject({ phase: 'editing', quote: 'Old text', text: null, before: 'Before.', anchor: 'a', final: false });
    events.push(ev(6, 'typing', { quote: 'Old text', text: 'New' }), ev(7, 'typing', { quote: 'Old text', text: 'New text' }));
    expect(reduceActivity(events)).toMatchObject({ phase: 'editing', quote: 'Old text', text: 'New text', before: 'Before.', anchor: 'a', final: false });
    events.push(ev(null, 'edit', { quote: 'Old text', text: 'New text.', before: 'Before.', anchor: 'a' }), ev(null, 'version', { version: 4 }));
    expect(reduceActivity(events)).toMatchObject({ text: 'New text.', final: true, version: 4 });
    events.push(ev(8, 'tool', { tool: 'reply_to_comment' }));
    expect(reduceActivity(events)).toMatchObject({ phase: 'replying', quote: 'Old text', text: 'New text.', version: 4 });
    events.push(ev(null, 'done'));
    expect(reduceActivity(events)).toMatchObject({ phase: 'done', rev: id });
  });
  it('gives the same state when the host stored the events in another order of id', () => {
    const a = ev(1, 'tool', { tool: 'get_page' }), b = ev(2, 'focus', { quote: 'Old' }), c = ev(3, 'typing', { quote: 'Old', text: 'New' });
    expect(reduceActivity([c, a, b])).toEqual(reduceActivity([a, b, c]));
  });
  it('ignores an event that arrives late: its seq is under the highest seq before it', () => {
    const events = [ev(3, 'typing', { quote: 'Old', text: 'New text' }), ev(2, 'typing', { quote: 'Old', text: 'New' }), ev(1, 'tool', { tool: 'get_page' })];
    expect(reduceActivity(events)).toMatchObject({ phase: 'editing', text: 'New text', seq: 3, rev: id });
  });
  it('ignores an event that arrives two times', () => {
    const once = [ev(1, 'focus', { quote: 'Old' }), ev(2, 'typing', { quote: 'Old', text: 'New' })];
    const twice = [...once, ev(1, 'focus', { quote: 'Old' }), ev(2, 'typing', { quote: 'Old', text: 'N' })];
    expect({ ...reduceActivity(twice), rev: 0 }).toEqual({ ...reduceActivity(once), rev: 0 });
  });
  it('keeps the exact text of the edit_page call when a typing event for the same text arrives after it', () => {
    const events = [ev(1, 'focus', { quote: 'Old text' }), ev(null, 'edit', { quote: 'Old text', text: 'The whole new text.' }), ev(2, 'typing', { quote: 'Old te', text: 'The whole' })];
    expect(reduceActivity(events)).toMatchObject({ text: 'The whole new text.', final: true });
    events.push(ev(3, 'focus', { quote: 'Another place' }));
    expect(reduceActivity(events)).toMatchObject({ quote: 'Another place', text: null, final: false });
  });
  it('lists the edits of one edit_page call in order, and starts a new list for the next call', () => {
    const events = [ev(1, 'tool', { tool: 'edit_page' }), ev(null, 'edit', { quote: 'One', text: '1', anchor: 'a' }), ev(null, 'edit', { quote: 'Two', text: '2', before: 'B' })];
    expect(reduceActivity(events)).toMatchObject({ quote: 'Two', text: '2', final: true, edits: [{ quote: 'One', text: '1', before: null, anchor: 'a' }, { quote: 'Two', text: '2', before: 'B', anchor: null }] });
    // A typing event for an edit of the list changes nothing: the exact text of the call stays.
    events.push(ev(2, 'typing', { quote: 'One', text: '' }));
    expect(reduceActivity(events).edits).toHaveLength(2);
    events.push(ev(null, 'version', { version: 3 }), ev(3, 'tool', { tool: 'edit_page' }), ev(null, 'edit', { quote: 'Three', text: '3' }));
    expect(reduceActivity(events)).toMatchObject({ version: 3, edits: [{ quote: 'Three', text: '3' }] });
    // A tool that only reads ends the edit.
    events.push(ev(4, 'tool', { tool: 'get_page' }));
    expect(reduceActivity(events)).toMatchObject({ phase: 'reading', quote: null, edits: [] });
  });
  it('keeps at most 8 edits of one call', () => {
    const events = Array.from({ length: 12 }, (_, i) => ev(null, 'edit', { quote: 'Q' + i, text: 'T' + i }));
    expect(reduceActivity(events).edits.map((s) => s.quote)).toEqual(['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7']);
  });
  it('works with the host events alone, and changes nothing after the end of the run', () => {
    const events = [ev(null, 'started'), ev(null, 'tool', { tool: 'get_page' }), ev(null, 'tool', { tool: 'edit_page' }), ev(null, 'edit', { quote: 'Old', text: 'New' }), ev(null, 'version', { version: 2 }), ev(null, 'failed'), ev(null, 'tool', { tool: 'get_page' })];
    expect(reduceActivity(events)).toMatchObject({ phase: 'failed', quote: 'Old', text: 'New', final: true, version: 2 });
    expect(reduceActivity([])).toMatchObject({ phase: 'starting', rev: 0, seq: 0 });
  });
});

describe('parseProgress', () => {
  const now = '2026-01-01T00:00:00.000Z';
  it('takes the four kinds of the runner', () => {
    expect(parseProgress({ seq: 1, at: '2026-02-02T00:00:00Z', kind: 'started' }, now)).toEqual({ event: { seq: 1, at: '2026-02-02T00:00:00Z', kind: 'started', data: {} } });
    expect(parseProgress({ seq: 2, kind: 'tool', tool: 'mcp__pages__edit_page' }, now)).toEqual({ event: { seq: 2, at: now, kind: 'tool', data: { tool: 'edit_page' } } });
    expect(parseProgress({ seq: 2, kind: 'tool', tool: 'get_page' }, now)).toMatchObject({ event: { data: { tool: 'get_page' } } });
    expect(parseProgress({ seq: 3, at: 'not a time', kind: 'focus', quote: '<p>Old <b>text</b></p>' }, now)).toEqual({ event: { seq: 3, at: now, kind: 'focus', data: { quote: 'Old text' } }, oldText: '<p>Old <b>text</b></p>' });
    expect(parseProgress({ seq: 4, kind: 'typing', quote: '<p>Old', text: '<p>New <b>te' }, now)).toEqual({ event: { seq: 4, at: now, kind: 'typing', data: { quote: 'Old', text: 'New te' } } });
  });
  it('cuts a long quote and a long text', () => {
    const out = parseProgress({ seq: 1, kind: 'typing', quote: 'q'.repeat(900), text: 't'.repeat(9000) }, now);
    expect(typeof out === 'string' ? out : [out.event.data.quote!.length, out.event.data.text!.length]).toEqual([500, 2000]);
  });
  it('refuses a body with no seq, a wrong kind, or a missing member', () => {
    for (const b of [null, {}, { seq: 0, kind: 'started' }, { seq: 1.5, kind: 'started' }, { seq: '1', kind: 'started' }, { seq: 5001, kind: 'started' }, { seq: 1, kind: 'done' }, { seq: 1, kind: 'edit' }, { seq: 1, kind: 'tool' }, { seq: 1, kind: 'tool', tool: 'a b' }, { seq: 1, kind: 'focus' }, { seq: 1, kind: 'typing', quote: 'q' }])
      expect(typeof parseProgress(b, now)).toBe('string');
  });
});

describe('the activity routes', () => {
  const RUN = 'R'.repeat(43);
  it('parses the paths', () => {
    expect(route(`/s/_run/${RUN}/progress`)).toEqual({ kind: 'run-progress', id: RUN });
    expect(route(`/s/_run/${RUN}`)).toEqual({ kind: 'run-result', id: RUN });
    expect(route('/s/_run/short/progress')).toEqual({ kind: 'not-found' });
    expect(route(`/s/_run/${RUN}/progress/x`)).toEqual({ kind: 'not-found' });
    expect(route('/api/pages/g/n/activity')).toEqual({ kind: 'api-activity', slug: 'g/n' });
    expect(route('/api/pages/g/activity')).toEqual({ kind: 'api-page', slug: 'g/activity' });
    expect(route(`/api/comments/${'a'.repeat(24)}/run`)).toEqual({ kind: 'api-comment-run', id: 'a'.repeat(24) });
    expect(route('/api/comments/nope/run')).toEqual({ kind: 'not-found' });
  });

  /** A page with one comment and one running run, in a real SQLite database with every migration. */
  async function setup() {
    const DB = testDb();
    const at = new Date().toISOString();
    await DB.prepare('INSERT INTO pages (slug, title, latest, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').bind('g/n', 'T', at, at).run();
    await DB.prepare("INSERT INTO comments (id, slug, version, quote, body, author, mention, status, created_at) VALUES ('c1', 'g/n', 1, 'the quote', '@claude x', 'ann', 'claude', 'open', ?)").bind(at).run();
    await DB.prepare("INSERT INTO agent_runs (id, comment_id, agent, status, started_at, token_id) VALUES (?, 'c1', 'claude', 'running', ?, 'tok1')").bind(RUN, at).run();
    const env = { DB, PAGES: { get: async () => ({ text: async () => PAGE }) } } as unknown as Env;
    const post = (body: unknown, id = RUN) => handleRunProgress(new Request(`https://h/s/_run/${id}/progress`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), env, id);
    return { env, DB, post };
  }

  it('stores the progress of a run and gives the state of the run to the viewer', async () => {
    const { env, post } = await setup();
    expect(await pageActivity(env, 'g/n', 0)).toEqual({ latest: 1, cursor: 0 });
    expect(await pageActivity(env, 'no/page', 0)).toBeNull();
    expect((await post({ seq: 1, kind: 'started' })).status).toBe(200);
    expect((await post({ seq: 2, kind: 'tool', tool: 'edit_page' })).status).toBe(200);
    expect((await post({ seq: 3, kind: 'focus', quote: '<li>Seal the gaps.</li>' })).status).toBe(200);
    for (const [seq, text] of [[4, 'Seal'], [6, 'Seal each gap.'], [5, 'Seal each']] as const) expect((await post({ seq, kind: 'typing', quote: '<li>Seal the gaps.</li>', text })).status).toBe(200);
    const a = (await pageActivity(env, 'g/n', 0))!;
    expect(a.runs).toHaveLength(1);
    expect(a.runs![0]).toMatchObject({ id: 'tok1', comment_id: 'c1', thread: 'c1', agent: 'claude', status: 'running', phase: 'editing', quote: 'Seal the gaps.', text: 'Seal each gap.', anchor: 'cost', hint: { quote: 'the quote', anchor: null } });
    expect(a.runs![0].before).toMatch(/Insulate the roof first\.$/);
    expect(JSON.stringify(a)).not.toContain(RUN);
    // The same cursor: nothing changed, and the answer has no runs.
    expect(await pageActivity(env, 'g/n', a.cursor)).toEqual({ latest: 1, cursor: a.cursor });
  });
  it('keeps one typing event for a run, and takes a repeated event with no change', async () => {
    const { DB, post } = await setup();
    for (const seq of [1, 2, 3, 3, 2]) expect((await post({ seq, kind: 'typing', quote: 'q', text: 't'.repeat(seq) })).status).toBe(200);
    const { results } = await DB.prepare("SELECT seq FROM run_events WHERE kind = 'typing' ORDER BY seq").all<{ seq: number }>();
    expect(results.map((r) => r.seq)).toEqual([2, 3]);
  });
  it('answers 404 for an unknown run and for a run that has ended, 400 for a bad body, and 405 for GET', async () => {
    const { env, DB, post } = await setup();
    expect((await post({ seq: 1, kind: 'started' }, 'X'.repeat(43))).status).toBe(404);
    expect((await post('{')).status).toBe(400);
    expect((await post({ seq: 1, kind: 'nope' })).status).toBe(400);
    expect((await post(JSON.stringify({ seq: 1, kind: 'typing', quote: 'q', text: 'x'.repeat(20000) }))).status).toBe(400);
    expect((await handleRunProgress(new Request('https://h/x'), env, RUN)).status).toBe(405);
    await DB.prepare("UPDATE agent_runs SET status = 'done' WHERE id = ?").bind(RUN).run();
    expect((await post({ seq: 1, kind: 'started' })).status).toBe(404);
    expect((await post({ seq: 2, kind: 'focus', quote: 'q' })).status).toBe(404);
    // The host still stores the end of the run.
    expect(await recordActivity(env, RUN, { seq: null, at: 'T', kind: 'done', data: {} })).toBe(true);
    expect(await recordActivity(env, RUN, { seq: null, at: 'T', kind: 'tool', data: {} })).toBe(false);
  });
  it('lists a run that ended only to a viewer that has an older cursor', () => {
    const run = { rid: RUN, id: 'tok1', comment_id: 'c1', thread: 'c1', agent: 'claude', status: 'done' as const, started_at: new Date().toISOString(), detail: 'turns=4', quote: null, anchor: null };
    const events = [{ id: 7, run_id: RUN, seq: null, kind: 'started', data: '{}' }, { id: 9, run_id: RUN, seq: null, kind: 'done', data: 'not json' }];
    expect(activeRuns([run], events, 0, Date.now())).toEqual([]);
    expect(activeRuns([run], events, 9, Date.now())).toEqual([]);
    expect(activeRuns([run], events, 8, Date.now())).toMatchObject([{ id: 'tok1', status: 'done', phase: 'done', detail: null, rev: 9 }]);
    const stale = { ...run, status: 'running' as const, started_at: new Date(Date.now() - 6 * 60_000).toISOString() };
    expect(activeRuns([stale], events.slice(0, 1), 0, Date.now())).toEqual([]);
    expect(activeRuns([stale], events.slice(0, 1), 3, Date.now())).toMatchObject([{ status: 'failed', phase: 'failed', detail: 'timeout: the runner sent no result' }]);
  });
});
