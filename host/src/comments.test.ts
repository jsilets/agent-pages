// Comment anchors, reopen and the runner warm-up through the HTTP routes of the Worker, with real SQL (see testdb.ts).
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
  return { call, sent };
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
