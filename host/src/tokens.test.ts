// Connector tokens, runs and page delete through the HTTP routes of the Worker, with real SQL (see testdb.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDb } from './testdb';
import worker from './worker';

vi.mock('../../brand/favicon.ico?inline', () => ({ default: 'data:image/x-icon;base64,AA==' }));
vi.mock('../../brand/apple-touch-icon.png?inline', () => ({ default: 'data:image/png;base64,AA==' }));

const ORIGIN = 'https://pages.test';
const RUNNER = 'http://runner.test/run';
const page = (title: string) => `<html><head><title>${title}</title></head><body><main class="k-page"><p>First words.</p></main></body></html>`;

interface Job {
  mcp_url: string;
  callback_url: string;
  agent_label: string;
  engine: string;
  slug: string;
  comment_id: string;
}

/** A Worker with local storage. `jobs` has each job the Worker sent to the runner. */
function host(vars: Record<string, string> = {}) {
  const files = new Map<string, string>();
  const tasks: Promise<unknown>[] = [];
  const jobs: Job[] = [];
  const env = {
    ENVIRONMENT: 'development', ACCESS_AUD: '', ACCESS_TEAM: '', SANDBOX_RUNNER_URL: RUNNER, ...vars,
    DB: testDb(),
    PAGES: {
      get: async (key: string) => (files.has(key) ? { text: async () => files.get(key)! } : null),
      put: async (key: string, value: unknown) => void files.set(key, typeof value === 'string' ? value : ''),
      list: async ({ prefix }: { prefix: string }) => ({ objects: [...files.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
      delete: async (keys: string[]) => keys.forEach((k) => files.delete(k)),
    },
    BROWSER: { quickAction: async () => new Response('img') },
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === RUNNER) return jobs.push(JSON.parse(init.body as string)), new Response(null, { status: 202 });
    return new Response('{}');
  });
  const ctx = { waitUntil: (p: Promise<unknown>) => void tasks.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  /** One request. It returns after each waitUntil task of the request has ended. */
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env as never, ctx);
    await Promise.all(tasks.splice(0));
    return { status: res.status, body: (res.status === 204 || res.status === 202 ? null : await res.json()) as any };
  };
  const publish = (slug: string) => call('PUT', `/api/pages/${slug}`, page(slug));
  const comment = async (slug: string, body: string) => (await call('POST', `/api/pages/${slug}/comments`, { body })).body as { id: string };
  /** One call of the MCP connector with the token in `mcp_url`. */
  const mcp = (mcp_url: string, method: string, params?: unknown) => call('POST', new URL(mcp_url).pathname, { jsonrpc: '2.0', id: 1, method, params });
  const tool = async (mcp_url: string, name: string, args: unknown = {}) => (await mcp(mcp_url, 'tools/call', { name, arguments: args })).body.result as { isError?: boolean; content: { text: string }[]; structuredContent?: any };
  const rows = async (sql: string) => (await env.DB.prepare(sql).all()).results as any[];
  return { call, publish, comment, mcp, tool, rows, jobs, env };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connector token API', () => {
  it('gives each token a public id, lists it with the last 4 characters only, and revokes by the id or by the whole token', async () => {
    const h = host();
    const a = (await h.call('POST', '/api/connector-tokens', { label: 'chatgpt' })).body;
    const b = (await h.call('POST', '/api/connector-tokens', { label: 'other' })).body;
    expect(a.id).toMatch(/^[0-9a-f]{12}$/);
    expect(a.mcp_url).toBe(`${ORIGIN}/s/_mcp/${a.token}`);
    const list = (await h.call('GET', '/api/connector-tokens')).body;
    expect(list).toHaveLength(2);
    expect(list.find((t: { id: string }) => t.id === a.id)).toEqual({ id: a.id, last4: a.token.slice(-4), label: 'chatgpt', slug: null, expires_at: null, created_at: expect.any(String) });
    expect(JSON.stringify(list)).not.toContain(a.token);

    expect((await h.mcp(a.mcp_url, 'ping')).status).toBe(200);
    expect((await h.call('DELETE', `/api/connector-tokens/${a.id}`)).status).toBe(204);
    expect((await h.mcp(a.mcp_url, 'ping')).status).toBe(404);
    expect((await h.call('DELETE', `/api/connector-tokens/${a.id}`)).status).toBe(404);
    expect((await h.mcp(b.mcp_url, 'ping')).status).toBe(200);
    expect((await h.call('DELETE', `/api/connector-tokens/${b.token}`)).status).toBe(204);
    expect((await h.mcp(b.mcp_url, 'ping')).status).toBe(404);
    expect((await h.call('GET', '/api/connector-tokens')).body).toEqual([]);
  });
});

describe('the connector token of a run', () => {
  /** Two pages with one comment each. The @claude comment on team/a started a run, so `job` has the token of that run. */
  async function twoPages() {
    const h = host();
    await h.publish('team/a');
    await h.publish('team/b');
    const other = await h.comment('team/b', 'a comment on the other page');
    const mine = await h.comment('team/a', '@claude shorten it');
    expect(h.jobs).toHaveLength(1);
    return { h, other, mine, job: h.jobs[0] };
  }

  it('is new for each run, has the page as its scope, and ends 15 minutes later', async () => {
    const { h, mine, job } = await twoPages();
    expect(job).toMatchObject({ slug: 'team/a', comment_id: mine.id, agent_label: 'claude', engine: 'claude' });
    await h.comment('team/a', '@claude and again');
    expect(h.jobs[1].mcp_url).not.toBe(job.mcp_url);
    const list = (await h.call('GET', '/api/connector-tokens')).body as { label: string; slug: string; expires_at: string; created_at: string }[];
    expect(list.map((t) => [t.label, t.slug, Date.parse(t.expires_at) - Date.parse(t.created_at)])).toEqual([['claude', 'team/a', 900_000], ['claude', 'team/a', 900_000]]);
  });

  it('sees only its page in list_pages and in list_comments', async () => {
    const { h, mine, job } = await twoPages();
    expect((await h.tool(job.mcp_url, 'list_pages')).structuredContent.pages.map((p: { slug: string }) => p.slug)).toEqual(['team/a']);
    expect((await h.tool(job.mcp_url, 'list_comments', { status: 'all' })).structuredContent.threads.map((t: { id: string }) => t.id)).toEqual([mine.id]);
    expect((await h.tool(job.mcp_url, 'get_page', { slug: 'team/a' })).content[1].text).toContain('First words.');
  });

  it('refuses each tool call for another page, and for a comment on another page, with a tool error that names the scope', async () => {
    const { h, other, mine, job } = await twoPages();
    const refused = 'this connector token reaches only the page team/a, not team/b';
    const calls: [string, unknown][] = [
      ['get_page', { slug: 'team/b' }],
      ['list_comments', { slug: 'team/b' }],
      ['edit_page', { slug: 'team/b', edits: [{ old_text: 'First words.', new_text: 'Changed.' }] }],
      ['reply_to_comment', { comment_id: other.id, body: 'a reply on the other page' }],
    ];
    for (const [name, args] of calls) expect([name, await h.tool(job.mcp_url, name, args)]).toEqual([name, { isError: true, content: [{ type: 'text', text: refused }] }]);
    // An edit of its own page cannot name a comment of the other page.
    expect((await h.tool(job.mcp_url, 'edit_page', { slug: 'team/a', comment_id: other.id, edits: [{ old_text: 'First words.', new_text: 'Changed.' }] })).isError).toBe(true);
    expect((await h.call('GET', '/api/pages/team/b')).body.latest).toBe(1);
    expect((await h.call('GET', '/api/pages/team/a')).body.latest).toBe(1);
    expect((await h.call('GET', '/api/pages/team/b/comments')).body[0].replies).toEqual([]);

    // The same calls work on its own page.
    expect((await h.tool(job.mcp_url, 'edit_page', { slug: 'team/a', comment_id: mine.id, edits: [{ old_text: 'First words.', new_text: 'Changed.' }] })).structuredContent).toMatchObject({ slug: 'team/a', version: 2 });
    expect((await h.tool(job.mcp_url, 'reply_to_comment', { comment_id: mine.id, body: 'Done.', resolve: true })).structuredContent).toMatchObject({ slug: 'team/a', author: 'claude', resolved: true });
  });

  it('stops with a 404 when the run reports its result, and the token row is gone', async () => {
    const { h, job } = await twoPages();
    expect((await h.mcp(job.mcp_url, 'ping')).status).toBe(200);
    expect((await h.call('POST', new URL(job.callback_url).pathname, { status: 'done', detail: 'turns=5' })).status).toBe(200);
    const gone = await h.mcp(job.mcp_url, 'ping');
    expect([gone.status, gone.body]).toEqual([404, { error: 'no such connector' }]);
    expect(await h.rows('SELECT id FROM connector_tokens')).toEqual([]);
    expect((await h.call('GET', '/api/pages/team/a/comments')).body[0].run).toMatchObject({ agent: 'claude', status: 'done', detail: 'turns=5' });
  });

  it('stops with a 404 after 15 minutes, and the next run deletes the row', async () => {
    const { h, job } = await twoPages();
    vi.useFakeTimers({ now: Date.now() + 14 * 60_000, toFake: ['Date'] });
    expect((await h.mcp(job.mcp_url, 'ping')).status).toBe(200);
    vi.setSystemTime(Date.now() + 61_000);
    const late = await h.mcp(job.mcp_url, 'ping');
    expect([late.status, late.body]).toEqual([404, { error: 'no such connector' }]);
    await h.comment('team/a', '@claude one more');
    expect(await h.rows('SELECT substr(token, 1, 0) AS t FROM connector_tokens')).toHaveLength(1);
    expect((await h.mcp(h.jobs[1].mcp_url, 'ping')).status).toBe(200);
  });

  it('is gone when the runner does not take the job', async () => {
    const h = host();
    await h.publish('team/a');
    vi.stubGlobal('fetch', async () => new Response('no', { status: 500 }));
    await h.comment('team/a', '@claude shorten it');
    expect(await h.rows('SELECT id FROM connector_tokens')).toEqual([]);
    expect((await h.call('GET', '/api/pages/team/a/comments')).body[0].run).toMatchObject({ status: 'failed', detail: 'runner: it answered 500' });
  });
});

describe('@chatgpt and the runner', () => {
  it('starts no run for @chatgpt when SANDBOX_AGENTS does not have chatgpt', async () => {
    const h = host({ SANDBOX_AGENTS: 'claude' });
    await h.publish('team/a');
    await h.comment('team/a', '@chatgpt shorten it');
    expect(h.jobs).toEqual([]);
    expect((await h.call('GET', '/api/pages/team/a/comments')).body[0].run).toBe(null);
  });

  it('sends @chatgpt to the runner with the codex engine, and @claude with the claude engine, with no SANDBOX_AGENTS', async () => {
    const h = host();
    await h.publish('team/a');
    const c = await h.comment('team/a', '@chatgpt shorten it');
    await h.comment('team/a', '@claude shorten it');
    expect(h.jobs.map((j) => [j.agent_label, j.engine])).toEqual([['chatgpt', 'codex'], ['claude', 'claude']]);
    expect(h.jobs[0]).toMatchObject({ slug: 'team/a', comment_id: c.id });
    const threads = (await h.call('GET', '/api/pages/team/a/comments')).body;
    expect(threads.map((t: { run: { agent: string; status: string } }) => [t.run.agent, t.run.status])).toEqual([['chatgpt', 'running'], ['claude', 'running']]);
    // The reply of the run has the name chatgpt.
    expect((await h.tool(h.jobs[0].mcp_url, 'reply_to_comment', { comment_id: c.id, body: 'Done.' })).structuredContent.author).toBe('chatgpt');
  });

  it('starts no run for @chatgpt with SANDBOX_AGENTS=chatgpt alone when the mention is @claude', async () => {
    const h = host({ SANDBOX_AGENTS: 'chatgpt' });
    await h.publish('team/a');
    await h.comment('team/a', '@claude shorten it');
    expect(h.jobs).toEqual([]);
  });
});

describe('page delete', () => {
  it('deletes the runs and the run tokens of the page, and keeps those of other pages', async () => {
    const h = host();
    await h.publish('team/a');
    await h.publish('team/b');
    await h.comment('team/a', '@claude shorten it');
    await h.comment('team/b', '@claude shorten it');
    await h.call('POST', '/api/connector-tokens', { label: 'chatgpt' });
    const state = async () => ({
      runs: (await h.rows('SELECT c.slug FROM agent_runs r LEFT JOIN comments c ON c.id = r.comment_id ORDER BY c.slug')).map((r) => r.slug),
      tokens: (await h.rows('SELECT label, slug FROM connector_tokens ORDER BY slug')).map((r) => [r.label, r.slug]),
    });
    expect(await state()).toEqual({ runs: ['team/a', 'team/b'], tokens: [['chatgpt', null], ['claude', 'team/a'], ['claude', 'team/b']] });

    expect((await h.call('DELETE', '/api/pages/team/a')).status).toBe(204);
    expect(await state()).toEqual({ runs: ['team/b'], tokens: [['chatgpt', null], ['claude', 'team/b']] });
    expect((await h.mcp(h.jobs[0].mcp_url, 'ping')).status).toBe(404);
    expect((await h.mcp(h.jobs[1].mcp_url, 'ping')).status).toBe(200);
    expect((await h.call('GET', '/api/pages/team/b/comments')).body[0].run).toMatchObject({ status: 'running' });
  });
});
