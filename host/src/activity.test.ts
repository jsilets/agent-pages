import { describe, expect, it } from 'vitest';
import { deriveActivity, withoutMention, type CommentRow, type RunRow, type VersionEvent } from './activity';

const NOW = Date.parse('2026-11-12T04:00:00.000Z');
const at = (minutesAgo: number, seconds = 0) => new Date(NOW - minutesAgo * 60_000 + seconds * 1000).toISOString();

const comment = (c: Partial<CommentRow> & Pick<CommentRow, 'id' | 'created_at'>): CommentRow => ({
  slug: 'plans/lead-plan', version: 1, anchor: null, quote: null, body: '@claude make this shorter', author: 'josh', mention: 'claude', parent_id: null, status: 'open', ...c,
});
const run = (r: Partial<RunRow> & Pick<RunRow, 'comment_id' | 'started_at'>): RunRow => ({ agent: 'claude', status: 'done', finished_at: null, detail: null, ...r });
const version = (slug: string, n: number, created_at: string): VersionEvent => ({ slug, version: n, created_at });

describe('deriveActivity', () => {
  it('gives a run that is done the version it stored and the reply of its assistant', () => {
    const items = deriveActivity(
      [version('plans/lead-plan', 1, at(900)), version('plans/lead-plan', 2, at(40, 80))],
      [
        comment({ id: 't1', created_at: at(41), anchor: 'claim-2', quote: 'Our limit', status: 'resolved' }),
        comment({ id: 'r1', created_at: at(40, 85), parent_id: 't1', author: 'claude', mention: null, body: 'Cut two paragraphs.' }),
      ],
      [run({ comment_id: 't1', started_at: at(41, 2), finished_at: at(40, 86) })],
      NOW,
    );
    expect(items).toEqual([
      {
        // 2026-11-12T03:19:02Z is second 1794453542, which is "todd7q" in base 36.
        kind: 'request', id: 'q:t1:todd7q', slug: 'plans/lead-plan', at: at(40, 86), started: at(41, 2), state: 'changed', agent: 'claude',
        ask: 'make this shorter', quote: 'Our limit', anchor: 'claim-2', author: 'josh', from: 1, version: 2, reply: 'Cut two paragraphs.', cause: null, open: false,
      },
      { kind: 'publish', id: 'v:plans/lead-plan:1', slug: 'plans/lead-plan', at: at(900), version: 1, first: true },
    ]);
  });

  it('shows a run that stored no version as a reply, and keeps the thread open', () => {
    const [item] = deriveActivity(
      [version('plans/lead-plan', 1, at(900))],
      [comment({ id: 't1', created_at: at(30) }), comment({ id: 'r1', created_at: at(29, 5), parent_id: 't1', author: 'claude', mention: null, body: 'Which paragraphs can I cut?' })],
      [run({ comment_id: 't1', started_at: at(30, 2), finished_at: at(29, 6) })],
      NOW,
    );
    expect(item).toMatchObject({ kind: 'request', state: 'replied', version: null, reply: 'Which paragraphs can I cut?', open: true });
  });

  it('shows a run with no result as working for 5 minutes, then as a timeout', () => {
    const rows = (minutesAgo: number) => deriveActivity([], [comment({ id: 't1', created_at: at(minutesAgo) })], [run({ comment_id: 't1', status: 'running', started_at: at(minutesAgo) })], NOW);
    expect(rows(2)[0]).toMatchObject({ state: 'working', cause: null, at: at(2) });
    expect(rows(6)[0]).toMatchObject({ state: 'failed', cause: 'timeout' });
  });

  it('reads the cause of a failure from the detail of the run', () => {
    const cause = (detail: string | null) => {
      const [item] = deriveActivity([], [comment({ id: 't1', created_at: at(9) })], [run({ comment_id: 't1', status: 'failed', started_at: at(9), finished_at: at(8), detail })], NOW);
      return item.kind === 'request' ? [item.state, item.cause] : null;
    };
    expect(cause('not_signed_in: ChatGPT has no sign-in in this sandbox')).toEqual(['failed', 'not_connected']);
    expect(cause('timeout: Claude did not finish in 180 s')).toEqual(['failed', 'timeout']);
    expect(cause('runner: it answered 500')).toEqual(['failed', 'error']);
    expect(cause(null)).toEqual(['failed', 'error']);
  });

  it('lists a version that no run stored as a publish', () => {
    const items = deriveActivity([version('notes/a', 1, at(500)), version('notes/a', 2, at(100))], [], [], NOW);
    expect(items).toEqual([
      { kind: 'publish', id: 'v:notes/a:2', slug: 'notes/a', at: at(100), version: 2, first: false },
      { kind: 'publish', id: 'v:notes/a:1', slug: 'notes/a', at: at(500), version: 1, first: true },
    ]);
  });

  it('lists a thread that started no run as a note with its number of replies', () => {
    const items = deriveActivity(
      [],
      [
        comment({ id: 't1', created_at: at(70), body: 'Check this number.', mention: null, anchor: 'claim-3', quote: 'to verify' }),
        comment({ id: 'r1', created_at: at(60), parent_id: 't1', body: 'Done.', mention: null }),
      ],
      [],
      NOW,
    );
    expect(items).toEqual([{ kind: 'note', id: 'c:t1', slug: 'plans/lead-plan', at: at(70), author: 'josh', body: 'Check this number.', quote: 'to verify', anchor: 'claim-3', replies: 1, open: true }]);
  });

  it('gives a reply that asks again its own request, with the anchor of the thread', () => {
    const items = deriveActivity(
      [version('plans/lead-plan', 2, at(9, 50))],
      [
        comment({ id: 't1', created_at: at(30), anchor: 'claim-1', quote: 'First line' }),
        comment({ id: 'r1', created_at: at(10), parent_id: 't1', body: '@claude cut the last two', version: 1 }),
      ],
      [run({ comment_id: 't1', started_at: at(30), finished_at: at(29) }), run({ comment_id: 'r1', started_at: at(10), finished_at: at(9, 55) })],
      NOW,
    );
    expect(items.map((i) => (i.kind === 'request' ? [i.ask, i.state, i.version, i.anchor] : i.kind))).toEqual([
      ['cut the last two', 'changed', 2, 'claim-1'],
      ['make this shorter', 'replied', null, 'claim-1'],
    ]);
  });

  it('keeps only the newest request of an open thread open, so one thread counts once', () => {
    const items = deriveActivity(
      [],
      [comment({ id: 't1', created_at: at(30), mention: 'chatgpt' }), comment({ id: 'r1', created_at: at(10), parent_id: 't1', body: '@chatgpt try again', mention: 'chatgpt' })],
      [
        run({ comment_id: 't1', agent: 'chatgpt', status: 'failed', started_at: at(30), finished_at: at(29), detail: 'not_signed_in: no sign-in' }),
        run({ comment_id: 'r1', agent: 'chatgpt', status: 'failed', started_at: at(10), finished_at: at(9), detail: 'not_signed_in: no sign-in' }),
      ],
      NOW,
    );
    expect(items.map((i) => (i.kind === 'request' ? [i.ask, i.state, i.open] : i.kind))).toEqual([
      ['try again', 'failed', true],
      ['make this shorter', 'failed', false],
    ]);
  });

  it('gives a request the same id when more runs arrive', () => {
    const comments = [comment({ id: 't1', created_at: at(30) }), comment({ id: 't2', created_at: at(20), slug: 'notes/a' })];
    const second = run({ comment_id: 't2', started_at: at(20), finished_at: at(19) });
    const idOf = (runs: RunRow[]) => deriveActivity([], comments, runs, NOW).find((i) => i.slug === 'notes/a')?.id;
    expect(idOf([second])).toBe(idOf([run({ comment_id: 't1', started_at: at(30), finished_at: at(29) }), second]));
  });

  it('keeps the newest items when there are more than the limit', () => {
    const versions = [1, 2, 3, 4].map((n) => version('notes/a', n, at(100 - n)));
    expect(deriveActivity(versions, [], [], NOW, 2).map((i) => i.id)).toEqual(['v:notes/a:4', 'v:notes/a:3']);
  });
});

describe('withoutMention', () => {
  it('removes the mention and keeps the request', () => {
    expect(withoutMention('@claude make this heading shorter')).toBe('make this heading shorter');
    expect(withoutMention('Please check this, @ChatGPT: every number')).toBe('Please check this, every number');
    expect(withoutMention('No mention here')).toBe('No mention here');
  });
});
