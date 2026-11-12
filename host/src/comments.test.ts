// Comment anchors, edit and delete, reopen and the runner warm-up through the HTTP routes of the Worker, with real SQL (see testdb.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { route } from './lib';
import { testDb } from './testdb';
import worker from './worker';

vi.mock('../../brand/favicon.ico?inline', () => ({ default: 'data:image/x-icon;base64,AA==' }));
vi.mock('../../brand/apple-touch-icon.png?inline', () => ({ default: 'data:image/png;base64,AA==' }));

const ORIGIN = 'https://pages.test';
const page = `<html><head><title>T</title></head><body><main class="k-page"><p id="a">First words.</p></main></body></html>`;

/** A Worker with local storage. `sent` has each request that the Worker sent out, with its headers and body. */
function host(vars: Record<string, string> = {}) {
  const files = new Map<string, string>();
  const tasks: Promise<unknown>[] = [];
  const sent: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const env = {
    ENVIRONMENT: 'development', ACCESS_AUD: '', ACCESS_TEAM: '', ...vars,
    DB: testDb(),
    PAGES: {
      get: async (key: string) => (files.has(key) ? { text: async () => files.get(key)! } : null),
      put: async (key: string, value: unknown) => void files.set(key, typeof value === 'string' ? value : ''),
      list: async () => ({ objects: [], truncated: false }),
      delete: async () => {},
    },
    BROWSER: { quickAction: async () => new Response('img') },
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ? JSON.parse(init.body as string) : null });
    return new Response(null, { status: 202 });
  });
  const ctx = { waitUntil: (p: Promise<unknown>) => void tasks.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env as never, ctx);
    await Promise.all(tasks.splice(0));
    return { status: res.status, body: (res.status === 204 ? null : await res.json()) as any };
  };
  return { call, sent, db: env.DB };
}

afterEach(() => vi.unstubAllGlobals());

describe('routes', () => {
  it('parses the warm-up route and the resolve route that reopens', () => {
    expect(route('/api/assistants/warm')).toEqual({ kind: 'api-warm' });
    expect(route('/api/assistants/warm/x')).toEqual({ kind: 'not-found' });
    expect(route('/api/comments/0123456789abcdef01234567/resolve')).toEqual({ kind: 'api-comment-resolve', id: '0123456789abcdef01234567' });
  });
});

describe('comment anchors', () => {
  it('stores the quote with the text next to it, the anchor, the slide and the version, and keeps only the part of the context next to the quote', async () => {
    const h = host();
    await h.call('PUT', '/api/pages/g/n', page);
    const long = 'x'.repeat(70);
    const c = (await h.call('POST', '/api/pages/g/n/comments', { body: 'Why?', quote: 'First', prefix: long + 'END', suffix: 'START' + long, anchor: 'a', slide: 's2' })).body;
    expect(c).toMatchObject({ quote: 'First', anchor: 'a', slide: 's2', version: 1 });
    expect(c.prefix).toHaveLength(64);
    expect(c.prefix.endsWith('END')).toBe(true);
    expect(c.suffix).toHaveLength(64);
    expect(c.suffix.startsWith('START')).toBe(true);
    const [t] = (await h.call('GET', '/api/pages/g/n/comments')).body;
    expect(t).toMatchObject({ id: c.id, quote: 'First', prefix: c.prefix, suffix: c.suffix, anchor: 'a', slide: 's2' });
  });
  it('drops the context of a comment with no quote, and keeps a comment without context working', async () => {
    const h = host();
    await h.call('PUT', '/api/pages/g/n', page);
    expect((await h.call('POST', '/api/pages/g/n/comments', { body: 'Overall fine.', prefix: 'p', suffix: 's' })).body).toMatchObject({ quote: null, prefix: null, suffix: null, slide: null });
    expect((await h.call('POST', '/api/pages/g/n/comments', { body: 'Old style.', quote: 'First words.' })).body).toMatchObject({ quote: 'First words.', prefix: null, suffix: null });
  });
  it('refuses a slide id over 200 characters', async () => {
    const h = host();
    await h.call('PUT', '/api/pages/g/n', page);
    expect((await h.call('POST', '/api/pages/g/n/comments', { body: 'x', slide: 's'.repeat(201) })).status).toBe(413);
  });
});

describe('edit and delete', () => {
  it('PATCH changes the body of your own comment, marks it as edited and reads the mention again', async () => {
    const h = host();
    await h.call('PUT', '/api/pages/g/n', page);
    const c = (await h.call('POST', '/api/pages/g/n/comments', { body: 'Fix this.', quote: 'First' })).body;
    expect(c.edited_at).toBeNull();
    const out = await h.call('PATCH', `/api/comments/${c.id}`, { body: '  @claude fix this.  ' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ id: c.id, body: '@claude fix this.', mention: 'claude', quote: 'First' });
    expect(Date.parse(out.body.edited_at)).not.toBeNaN();
    const [t] = (await h.call('GET', '/api/pages/g/n/comments')).body;
    expect(t).toMatchObject({ body: '@claude fix this.', edited_at: out.body.edited_at });
    // A changed mention starts no run: only a new comment does.
    expect(h.sent).toEqual([]);
  });
  it('PATCH refuses an empty body, a body over the limit, an unknown id and the comment of another person', async () => {
    const h = host();
    await h.call('PUT', '/api/pages/g/n', page);
    const c = (await h.call('POST', '/api/pages/g/n/comments', { body: 'Mine.' })).body;
    expect((await h.call('PATCH', `/api/comments/${c.id}`, { body: '   ' })).status).toBe(400);
    expect((await h.call('PATCH', `/api/comments/${c.id}`, { body: 'x'.repeat(4001) })).status).toBe(413);
    expect((await h.call('PATCH', `/api/comments/${c.id}`, 'not json')).status).toBe(400);
    expect((await h.call('PATCH', `/api/comments/${'f'.repeat(24)}`, { body: 'x' })).status).toBe(404);
    await h.db.prepare('UPDATE comments SET author = ? WHERE id = ?').bind('ann@example.com', c.id).run();
    expect(await h.call('PATCH', `/api/comments/${c.id}`, { body: 'Changed.' })).toEqual({ status: 403, body: { error: 'you can change only your own comments' } });
    expect((await h.call('GET', '/api/pages/g/n/comments')).body[0].body).toBe('Mine.');
  });
  it('DELETE of a reply deletes the reply only, and DELETE of the first comment deletes the thread with its runs', async () => {
    const h = host();
    await h.call('PUT', '/api/pages/g/n', page);
    const root = (await h.call('POST', '/api/pages/g/n/comments', { body: 'Root.' })).body;
    const r1 = (await h.call('POST', '/api/pages/g/n/comments', { body: 'One.', parent_id: root.id })).body;
    await h.call('POST', '/api/pages/g/n/comments', { body: 'Two.', parent_id: root.id });
    const other = (await h.call('POST', '/api/pages/g/n/comments', { body: 'Other thread.' })).body;
    await h.db.prepare("INSERT INTO agent_runs (id, comment_id, agent, status, started_at) VALUES ('run1', ?, 'claude', 'done', '2026-11-11T10:00:00Z')").bind(root.id).run();
    await h.db.prepare("INSERT INTO run_events (run_id, slug, seq, at, kind, data) VALUES ('run1', 'g/n', 1, '2026-11-11T10:00:01Z', 'note', '{}')").run();
    expect(await h.call('DELETE', `/api/comments/${r1.id}`)).toEqual({ status: 200, body: { deleted: 1 } });
    expect((await h.call('GET', '/api/pages/g/n/comments')).body.find((t: { id: string }) => t.id === root.id).replies.map((c: { body: string }) => c.body)).toEqual(['Two.']);
    expect(await h.call('DELETE', `/api/comments/${root.id}`)).toEqual({ status: 200, body: { deleted: 2 } });
    expect((await h.call('GET', '/api/pages/g/n/comments')).body.map((t: { id: string }) => t.id)).toEqual([other.id]);
    expect(await h.db.prepare('SELECT COUNT(*) AS n FROM agent_runs').first()).toEqual({ n: 0 });
    expect(await h.db.prepare('SELECT COUNT(*) AS n FROM run_events').first()).toEqual({ n: 0 });
    expect((await h.call('DELETE', `/api/comments/${root.id}`)).status).toBe(404);
  });
  it('DELETE refuses the comment of another person and keeps it', async () => {
    const h = host();
    await h.call('PUT', '/api/pages/g/n', page);
    const c = (await h.call('POST', '/api/pages/g/n/comments', { body: 'Theirs.' })).body;
    await h.db.prepare('UPDATE comments SET author = ? WHERE id = ?').bind('ann@example.com', c.id).run();
    expect(await h.call('DELETE', `/api/comments/${c.id}`)).toEqual({ status: 403, body: { error: 'you can delete only your own comments' } });
    expect((await h.call('GET', '/api/pages/g/n/comments')).body).toHaveLength(1);
  });
});

describe('resolve and reopen', () => {
  it('PUT resolves a thread, DELETE opens it again, and an unknown id is a 404', async () => {
    const h = host();
    await h.call('PUT', '/api/pages/g/n', page);
    const c = (await h.call('POST', '/api/pages/g/n/comments', { body: 'Fix this.' })).body;
    expect((await h.call('PUT', `/api/comments/${c.id}/resolve`)).status).toBe(204);
    expect((await h.call('GET', '/api/pages/g/n/comments?status=resolved')).body.map((t: { id: string }) => t.id)).toEqual([c.id]);
    expect((await h.call('DELETE', `/api/comments/${c.id}/resolve`)).status).toBe(204);
    expect((await h.call('GET', '/api/pages/g/n/comments?status=open')).body.map((t: { id: string }) => t.id)).toEqual([c.id]);
    expect((await h.call('DELETE', `/api/comments/${'f'.repeat(24)}/resolve`)).status).toBe(404);
    expect((await h.call('POST', `/api/comments/${c.id}/resolve`)).status).toBe(405);
  });
});

describe('POST /api/assistants/warm', () => {
  it('sends POST <runner origin>/warm with the user and the secret, at most one time in 60 seconds for each user', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T10:00:00Z'));
    try {
      const h = host({ SANDBOX_RUNNER_URL: 'http://runner.test:8811/run', SANDBOX_RUNNER_SECRET: 'shh' });
      expect(await h.call('POST', '/api/assistants/warm')).toEqual({ status: 202, body: { sent: true } });
      expect(h.sent).toEqual([{ url: 'http://runner.test:8811/warm', headers: expect.objectContaining({ 'x-runner-secret': 'shh', 'content-type': 'application/json' }), body: { user: expect.any(String) } }]);
      vi.setSystemTime(new Date('2026-11-11T10:00:59Z'));
      expect((await h.call('POST', '/api/assistants/warm')).body).toEqual({ sent: false });
      vi.setSystemTime(new Date('2026-11-11T10:01:00Z'));
      expect((await h.call('POST', '/api/assistants/warm')).body).toEqual({ sent: true });
      expect(h.sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('sends nothing with no runner, and refuses GET', async () => {
    const h = host();
    expect(await h.call('POST', '/api/assistants/warm')).toEqual({ status: 202, body: { sent: false } });
    expect((await h.call('GET', '/api/assistants/warm')).status).toBe(405);
    expect(h.sent).toEqual([]);
  });
});
