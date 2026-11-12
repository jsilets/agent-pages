import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRunResult, latestRuns, runResult, runSandboxAgent, STALE_MS, withRuns } from './sandbox';
import type { Comment, Env, Thread } from './types';

const ORIGIN = 'https://pages.example';
const ID = 'R'.repeat(43);

/** A D1 stand-in. It records each statement with its values, and answers from the given functions. */
function fakeDb(o: { first?: (q: string) => unknown; all?: (q: string) => unknown[]; changes?: number } = {}) {
  const ran: { q: string; args: unknown[] }[] = [];
  const DB = {
    prepare(q: string) {
      const call = { q, args: [] as unknown[] };
      const stmt = {
        bind(...a: unknown[]) {
          call.args = a;
          return stmt;
        },
        async first() {
          ran.push(call);
          return o.first?.(q) ?? null;
        },
        async all() {
          ran.push(call);
          return { results: o.all?.(q) ?? [] };
        },
        async run() {
          ran.push(call);
          return { meta: { changes: o.changes ?? 1 } };
        },
      };
      return stmt;
    },
  };
  return { DB, ran };
}

const comment = (c: Partial<Comment> = {}): Comment => ({ id: 'c'.repeat(24), slug: 'g/n', version: 1, anchor: null, quote: null, prefix: null, suffix: null, slide: null, body: '@claude fix it', author: 'ann@example.com', mention: 'claude', parent_id: null, status: 'open', created_at: '2026-01-01T00:00:00.000Z', ...c });

afterEach(() => vi.unstubAllGlobals());

describe('runResult', () => {
  it('takes a run that is done, with its detail', () => {
    expect(runResult({ status: 'done', detail: ' turns=5 ' })).toEqual({ status: 'done', detail: 'turns=5' });
    expect(runResult({ status: 'done' })).toEqual({ status: 'done', detail: null });
  });
  it('puts the cause first for a failure, so the viewer can tell a missing sign-in from the rest', () => {
    expect(runResult({ status: 'not_signed_in', detail: 'Not logged in' })).toEqual({ status: 'failed', detail: 'not_signed_in: Not logged in' });
    expect(runResult({ status: 'timeout' })).toEqual({ status: 'failed', detail: 'timeout' });
    expect(runResult({ status: 'failed', detail: 'exit code 1' })).toEqual({ status: 'failed', detail: 'exit code 1' });
  });
  it('counts every other body as a failure', () => {
    for (const b of [null, 'done', {}, { status: 'running' }, { status: 7 }]) expect(runResult(b)).toEqual({ status: 'failed', detail: 'the runner gave no cause' });
    expect(runResult({ status: 'failed', detail: 'x'.repeat(900) }).detail).toHaveLength(500);
  });
});

describe('latestRuns', () => {
  const now = Date.parse('2026-01-01T01:00:00.000Z');
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  it('keeps the newest run of each thread', () => {
    const runs = latestRuns(
      [
        { thread: 'a', agent: 'claude', status: 'failed', started_at: at(60_000), detail: 'exit code 1' },
        { thread: 'b', agent: 'chatgpt', status: 'done', started_at: at(50_000), detail: null },
        { thread: 'a', agent: 'claude', status: 'running', started_at: at(1000), detail: null },
      ],
      now,
    );
    expect([...runs]).toEqual([
      ['a', { agent: 'claude', status: 'running', started_at: at(1000), detail: null }],
      ['b', { agent: 'chatgpt', status: 'done', started_at: at(50_000), detail: null }],
    ]);
  });
  it('shows a run with no result after 5 minutes as failed', () => {
    expect(latestRuns([{ thread: 'a', agent: 'claude', status: 'running', started_at: at(STALE_MS - 1000), detail: null }], now).get('a')?.status).toBe('running');
    expect(latestRuns([{ thread: 'a', agent: 'claude', status: 'running', started_at: at(STALE_MS + 1000), detail: null }], now).get('a')).toEqual({ agent: 'claude', status: 'failed', started_at: at(STALE_MS + 1000), detail: 'timeout: the runner sent no result' });
  });
});

describe('withRuns', () => {
  it('adds the latest run to its thread, and null to a thread with no run', async () => {
    const started_at = new Date().toISOString();
    const { DB } = fakeDb({ all: () => [{ thread: 't1', agent: 'claude', status: 'running', started_at, detail: null }] });
    const out = await withRuns({ DB } as unknown as Env, 'g/n', [{ ...comment({ id: 't1' }), replies: [] }, { ...comment({ id: 't2' }), replies: [] }] as Thread[]);
    expect(out.map((t) => [t.id, t.run])).toEqual([
      ['t1', { agent: 'claude', status: 'running', started_at, detail: null }],
      ['t2', null],
    ]);
  });
});

describe('runSandboxAgent', () => {
  const env = (db: ReturnType<typeof fakeDb>, url?: string) => ({ DB: db.DB, SANDBOX_RUNNER_URL: url }) as unknown as Env;
  it('does nothing for a comment with no mention, for a mention that SANDBOX_AGENTS does not have, and with no runner URL', async () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const db = fakeDb();
    await runSandboxAgent(env(db, 'http://runner/run'), comment({ mention: null }), ORIGIN);
    await runSandboxAgent({ ...env(db, 'http://runner/run'), SANDBOX_AGENTS: 'claude' }, comment({ mention: 'chatgpt' }), ORIGIN);
    await runSandboxAgent(env(db), comment(), ORIGIN);
    expect(fetched).not.toHaveBeenCalled();
    expect(db.ran).toEqual([]);
  });
  it('records a run and sends the job with the connector URL of a new token, for a comment and for a reply', async () => {
    for (const c of [comment(), comment({ id: 'd'.repeat(24), parent_id: 'c'.repeat(24) })]) {
      const fetched = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 202 }));
      vi.stubGlobal('fetch', fetched);
      const db = fakeDb();
      await runSandboxAgent(env(db, 'http://runner/run'), c, ORIGIN);
      const insert = db.ran.find((r) => r.q.startsWith('INSERT INTO agent_runs'))!;
      const runId = insert.args[0] as string;
      expect(insert.args.slice(1, 3)).toEqual([c.id, 'claude']);
      const token = db.ran.find((r) => r.q.startsWith('INSERT INTO connector_tokens'))!.args[0] as string;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fetched).toHaveBeenCalledOnce();
      expect(fetched.mock.calls[0][0]).toBe('http://runner/run');
      expect(JSON.parse(fetched.mock.calls[0][1].body as string)).toEqual({ mcp_url: `${ORIGIN}/s/_mcp/${token}`, comment_id: c.id, slug: 'g/n', agent_label: 'claude', engine: 'claude', user: 'ann@example.com', callback_url: `${ORIGIN}/s/_run/${runId}`, model: null });
      expect(runId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(db.ran.some((r) => r.q.startsWith('UPDATE agent_runs'))).toBe(false);
    }
  });
  it('sends the model that the author of the comment chose for the assistant', async () => {
    const fetched = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetched);
    const db = fakeDb({ first: (q) => (q.includes('FROM assistant_prefs') ? { model: 'claude-careful' } : null) });
    await runSandboxAgent(env(db, 'http://runner/run'), comment(), ORIGIN);
    expect(JSON.parse(fetched.mock.calls[0][1].body as string).model).toBe('claude-careful');
    expect(db.ran.find((r) => r.q.includes('FROM assistant_prefs'))!.args).toEqual(['ann@example.com', 'claude']);
  });
  it('sends the runner secret as the header x-runner-secret when the host has one, and no such header with no secret', async () => {
    for (const secret of ['s3cret', undefined]) {
      const fetched = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 202 }));
      vi.stubGlobal('fetch', fetched);
      await runSandboxAgent({ ...env(fakeDb(), 'http://runner/run'), SANDBOX_RUNNER_SECRET: secret }, comment(), ORIGIN);
      expect((fetched.mock.calls[0][1].headers as Record<string, string>)['x-runner-secret']).toBe(secret);
    }
  });
  it('records the start of the run as the first event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })));
    const db = fakeDb();
    await runSandboxAgent(env(db, 'http://runner/run'), comment(), ORIGIN);
    const runId = db.ran.find((r) => r.q.startsWith('INSERT INTO agent_runs'))!.args[0];
    const event = db.ran.find((r) => r.q.includes('INSERT INTO run_events'))!;
    expect([event.args[0], event.args[1], event.args[3]]).toEqual([runId, null, 'started']);
  });
  it('stores a failure when the runner does not take the job', async () => {
    for (const fetched of [vi.fn(async () => new Response('no', { status: 500 })), vi.fn(async () => Promise.reject(new Error('connection refused')))]) {
      vi.stubGlobal('fetch', fetched);
      const db = fakeDb();
      await runSandboxAgent(env(db, 'http://runner/run'), comment(), ORIGIN);
      const update = db.ran.find((r) => r.q.startsWith('UPDATE agent_runs'))!;
      expect(update.args[1]).toBe('failed');
      expect(update.args[3]).toMatch(/^runner: (it answered 500|connection refused)$/);
    }
  });
});

describe('handleRunResult', () => {
  const post = (body: string, db = fakeDb()) => handleRunResult(new Request(`${ORIGIN}/s/_run/${ID}`, { method: 'POST', body }), { DB: db.DB } as unknown as Env, ID).then(async (res) => ({ status: res.status, body: await res.json(), ran: db.ran }));
  it('stores the result of a run that is running', async () => {
    const out = await post(JSON.stringify({ status: 'not_signed_in', detail: 'Not logged in', ms_total: 900 }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ status: 'failed' });
    // The update of the run, the delete of its connector token, and the event that tells the viewer.
    expect(out.ran).toHaveLength(3);
    expect(out.ran[2].q).toContain('INSERT INTO run_events');
    expect(out.ran[2].args.slice(0, 2).concat(out.ran[2].args[3])).toEqual([ID, null, 'failed']);
    expect([out.ran[0].args[0], out.ran[0].args[1], out.ran[0].args[3]]).toEqual([ID, 'failed', 'not_signed_in: Not logged in']);
    expect(out.ran[0].q).toContain("status = 'running'");
  });
  it('answers 404 when no run with that id is running', async () => {
    const out = await post(JSON.stringify({ status: 'done' }), fakeDb({ changes: 0 }));
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: 'no such run' });
  });
  it('answers 400 for a body that is not JSON, and 405 for GET', async () => {
    expect((await post('{')).status).toBe(400);
    const res = await handleRunResult(new Request(`${ORIGIN}/s/_run/${ID}`), fakeDb() as unknown as Env, ID);
    expect(res.status).toBe(405);
  });
});
