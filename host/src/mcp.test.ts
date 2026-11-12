import { describe, expect, it } from 'vitest';
import { listThreads } from './comments';
import { handleMcp, methods, PROTOCOLS, rpc, TOOLS } from './mcp';
import { testDb } from './testdb';
import { RpcError, type Env, type Handler, type StoreVersion } from './types';

const TOKEN = 'A'.repeat(43);
const ORIGIN = 'https://pages.example';

/** A D1 stand-in that knows the given connector tokens and has no other rows. It records each SQL statement. */
function fakeEnv(tokens: Record<string, string> = {}) {
  const sql: string[] = [];
  const DB = {
    prepare(q: string) {
      sql.push(q);
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async first() {
          const label = q.includes('connector_tokens') ? tokens[args[0] as string] : undefined;
          return label === undefined ? null : { label };
        },
        async all() {
          return { results: [] };
        },
      };
      return stmt;
    },
  };
  return { env: { DB } as unknown as Env, sql };
}

const x = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const store: StoreVersion = async () => {
  throw new Error('the test must not store a version');
};
const ctx = { token: TOKEN, label: 'test', origin: ORIGIN };
const call = (msg: unknown, env = fakeEnv().env, handlers = methods(x, store)) => rpc(handlers, env, msg, ctx);
const post = (token: string, body: unknown, env: Env, headers: Record<string, string> = {}) =>
  handleMcp(new Request(`${ORIGIN}/s/_mcp/${token}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers }), env, x, token, ORIGIN, store);

describe('rpc', () => {
  it('answers initialize with the version the client asked for, when the connector speaks it', async () => {
    for (const v of ['2025-06-18', '2025-03-26']) {
      expect(await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } } })).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'agent-pages' } },
      });
    }
  });
  it('answers initialize with its own version when the client asks for one it does not speak', async () => {
    expect(await call({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '2024-11-05' } })).toMatchObject({ id: 'a', result: { protocolVersion: '2025-06-18' } });
    // 2026-07-28 has no initialize, so a client that starts with initialize gets a version that has it.
    expect(await call({ jsonrpc: '2.0', id: 'b', method: 'initialize', params: { protocolVersion: '2026-07-28' } })).toMatchObject({ id: 'b', result: { protocolVersion: '2025-06-18' } });
    expect(await call({ jsonrpc: '2.0', id: 2, method: 'initialize' })).toMatchObject({ result: { protocolVersion: PROTOCOLS[0], capabilities: { tools: {} } } });
  });
  it('answers ping with an empty result', async () => {
    expect(await call({ jsonrpc: '2.0', id: 7, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });
  it('lists the five tools, each with an object schema', async () => {
    const out = (await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: typeof TOOLS } };
    expect(out.result.tools.map((t) => t.name)).toEqual(['list_pages', 'get_page', 'list_comments', 'edit_page', 'reply_to_comment']);
    for (const t of out.result.tools) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe('object');
    }
    expect(out.result.tools[3].inputSchema.required).toEqual(['slug', 'edits']);
    // The reply of edit_page is optional. The model writes the edits before it, so the viewer shows the edit first.
    expect(Object.keys(out.result.tools[3].inputSchema.properties)).toEqual(['slug', 'edits', 'comment_id', 'reply']);
    expect((out.result.tools[3].inputSchema.properties as { reply: { required: string[] } }).reply.required).toEqual(['body']);
  });
  it('marks the three read tools as read-only, and the two write tools as writes that destroy nothing and stay on this host', async () => {
    const out = (await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: typeof TOOLS } };
    expect(out.result.tools.map((t) => [t.name, t.title, t.annotations])).toEqual([
      ['list_pages', 'List pages', { title: 'List pages', readOnlyHint: true }],
      ['get_page', 'Get page', { title: 'Get page', readOnlyHint: true }],
      ['list_comments', 'List comments', { title: 'List comments', readOnlyHint: true }],
      ['edit_page', 'Edit page', { title: 'Edit page', readOnlyHint: false, destructiveHint: false, openWorldHint: false }],
      ['reply_to_comment', 'Reply to comment', { title: 'Reply to comment', readOnlyHint: false, destructiveHint: false, openWorldHint: false }],
    ]);
  });
  it('answers an unknown method with -32601', async () => {
    expect(await call({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'no such method: resources/list' } });
    expect(await call({ jsonrpc: '2.0', id: 4, method: 'constructor' })).toMatchObject({ error: { code: -32601 } });
  });
  it('gives no answer to a notification or to a response', async () => {
    expect(await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(null);
    expect(await call({ jsonrpc: '2.0', method: 'notifications/unknown' })).toBe(null);
    expect(await call({ jsonrpc: '2.0', id: 9, result: {} })).toBe(null);
  });
  it('refuses a batch and a message that is not JSON-RPC 2.0', async () => {
    expect(await call([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await call({ id: 1, method: 'ping' })).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await call('ping')).toMatchObject({ error: { code: -32600 } });
  });
  it('answers an unknown tool with -32602', async () => {
    expect(await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } })).toMatchObject({ id: 5, error: { code: -32602, message: 'no such tool: delete_everything' } });
  });
  it('returns bad tool arguments as a tool error, not as a JSON-RPC error', async () => {
    expect(await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_page', arguments: { slug: '../x' } } })).toEqual({
      jsonrpc: '2.0',
      id: 6,
      result: { content: [{ type: 'text', text: 'slug must be <group>/<name>' }], isError: true },
    });
    expect(await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_page', arguments: { slug: 'a/b' } } })).toMatchObject({ result: { isError: true, content: [{ text: 'no page has the slug a/b' }] } });
  });
  it('returns a tool result as JSON text and as structured content', async () => {
    expect(await call({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'list_pages' } })).toEqual({
      jsonrpc: '2.0',
      id: 8,
      result: { content: [{ type: 'text', text: '{"pages":[]}' }], structuredContent: { pages: [] } },
    });
  });
  it('runs an added method with the params and the caller, and turns its errors into JSON-RPC errors', async () => {
    const seen: unknown[] = [];
    const added: Record<string, Handler> = {
      async 'added/echo'(_env, params, c) {
        seen.push(params, c);
        return { ok: true };
      },
      async 'added/refuse'() {
        throw new RpcError(-32602, 'bad url');
      },
      async 'added/crash'() {
        throw new Error('secret detail');
      },
    };
    const env = fakeEnv().env;
    expect(await call({ jsonrpc: '2.0', id: 1, method: 'added/echo', params: { url: 'u' } }, env, added)).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(seen).toEqual([{ url: 'u' }, ctx]);
    expect(await call({ jsonrpc: '2.0', id: 2, method: 'added/refuse' }, env, added)).toEqual({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'bad url' } });
    expect(await call({ jsonrpc: '2.0', id: 3, method: 'added/crash' }, env, added)).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'internal error' } });
  });
});

describe('get_page', () => {
  it('returns the page HTML without the packed kit CSS and JS', async () => {
    const stored = `<html><head><title>T</title><style>\n/* explain.css: v1 */ ${'a{}'.repeat(900)}\n</style></head><body><p>The text of the page.</p><script>\n/* explain.js: v1 */ ${'b();'.repeat(900)}\n</script></body></html>`;
    const env = {
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ slug: 'g/n', title: 'T', kind: 'page', latest: 2 }) }) }) },
      PAGES: { get: async (key: string) => (key === 'pages/g/n/2.html' ? { text: async () => stored } : null) },
    } as unknown as Env;
    const out = (await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page', arguments: { slug: 'g/n' } } }, env)) as { result: { content: { text: string }[] } };
    expect(JSON.parse(out.result.content[0].text)).toEqual({ slug: 'g/n', title: 'T', kind: 'page', version: 2, url: `${ORIGIN}/p/g/n` });
    const html = out.result.content[1].text;
    expect(html).toContain('<p>The text of the page.</p>');
    expect(html).not.toContain('explain.css: v1');
    expect(html).not.toContain('explain.js: v1');
    expect(html.match(/get_page leaves it out/g)).toHaveLength(2);
    expect(html.length).toBeLessThan(400);
  });
});

describe('edit_page with a reply', () => {
  const HTML = '<html><body><h1>How heat pmups work</h1><p>One.</p><p>Two.</p></body></html>';
  const RUN = 'R'.repeat(43);
  const at = '2026-11-12T00:00:00.000Z';
  /** A real database with one page, one thread and one running run, R2 as a map, and a store that makes the next version. */
  async function world() {
    const DB = testDb();
    const blobs = new Map<string, string>([['pages/g/n/1.html', HTML], ['pages/g/other/1.html', HTML]]);
    for (const slug of ['g/n', 'g/other']) await DB.prepare('INSERT INTO pages (slug, title, latest, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').bind(slug, 'T', at, at).run();
    await DB.prepare("INSERT INTO comments (id, slug, version, body, author, mention, status, created_at) VALUES ('c1', 'g/n', 1, '@claude fix the typo', 'ann', 'claude', 'open', ?)").bind(at).run();
    await DB.prepare("INSERT INTO comments (id, slug, version, body, author, status, created_at) VALUES ('c9', 'g/other', 1, 'on another page', 'ann', 'open', ?)").bind(at).run();
    await DB.prepare("INSERT INTO agent_runs (id, comment_id, agent, status, started_at, token_id) VALUES (?, 'c1', 'claude', 'running', ?, 'tok1')").bind(RUN, at).run();
    const env = { DB, PAGES: { get: async (key: string) => (blobs.has(key) ? { text: async () => blobs.get(key)! } : null) } } as unknown as Env;
    const stored: string[] = [];
    const store: StoreVersion = async (e, _x, slug, html, origin) => {
      const latest = (await e.DB.prepare('SELECT latest FROM pages WHERE slug = ?').bind(slug).first<{ latest: number }>())!.latest + 1;
      blobs.set(`pages/${slug}/${latest}.html`, html);
      await e.DB.prepare('UPDATE pages SET latest = ? WHERE slug = ?').bind(latest, slug).run();
      stored.push(html);
      return { slug, version: latest, kind: 'page', title: 'T', url: `${origin}/p/${slug}`, versionUrl: `${origin}/p/${slug}/v/${latest}` };
    };
    type Out = { result: { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, any> } };
    const edit = async (args: Record<string, unknown>, c: Record<string, unknown> = {}) =>
      (await rpc(methods(x, store), env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'edit_page', arguments: { slug: 'g/n', ...args } } }, { ...ctx, label: 'claude', slug: 'g/n', run: RUN, ...c })) as Out;
    const events = async () => (await DB.prepare('SELECT kind, data FROM run_events ORDER BY id').all<{ kind: string; data: string }>()).results.map((e) => [e.kind, JSON.parse(e.data)]);
    const latest = async () => (await DB.prepare("SELECT latest FROM pages WHERE slug = 'g/n'").first<{ latest: number }>())!.latest;
    return { env, stored, edit, events, latest, thread: async () => (await listThreads(env, { slug: 'g/n' }))[0] };
  }
  const fix = [{ old_text: 'pmups', new_text: 'pumps' }];

  it('stores the version and the reply in one call, resolves the thread, and returns the id of the reply', async () => {
    const w = await world();
    const out = await w.edit({ edits: fix, comment_id: 'c1', reply: { body: ' Fixed the typo in the heading. ', resolve: true } });
    expect(out.result.isError).toBeUndefined();
    const t = await w.thread();
    expect(t.status).toBe('resolved');
    expect(t.replies.map((r) => [r.body, r.author, r.parent_id])).toEqual([['Fixed the typo in the heading.', 'claude', 'c1']]);
    expect(out.result.structuredContent).toEqual({
      slug: 'g/n',
      version: 2,
      previous_version: 1,
      url: `${ORIGIN}/p/g/n`,
      version_url: `${ORIGIN}/p/g/n/v/2`,
      comment_id: 'c1',
      reply: { id: t.replies[0].id, thread_id: 'c1', body: 'Fixed the typo in the heading.', author: 'claude', resolved: true },
    });
    expect(JSON.parse(out.result.content[0].text)).toEqual(out.result.structuredContent);
    expect(w.stored).toEqual([HTML.replace('pmups', 'pumps')]);
  });
  it('gives the viewer the events of an edit_page call and then of a reply_to_comment call, in that order', async () => {
    const w = await world();
    await w.edit({ edits: fix, comment_id: 'c1', reply: { body: 'Fixed.', resolve: true } });
    expect(await w.events()).toEqual([
      ['tool', { tool: 'edit_page' }],
      ['edit', { quote: 'pmups', text: 'pumps', before: 'How heat', anchor: null }],
      ['version', { version: 2 }],
      ['tool', { tool: 'reply_to_comment' }],
    ]);
    // The same call with no reply ends with the version, as before.
    const plain = await world();
    await plain.edit({ edits: fix, comment_id: 'c1' });
    expect((await plain.events()).map(([k]) => k)).toEqual(['tool', 'edit', 'version']);
    expect((await plain.thread()).replies).toEqual([]);
  });
  it('leaves the thread open with resolve false, and with no resolve', async () => {
    for (const reply of [{ body: 'Done.', resolve: false }, { body: 'Done.' }]) {
      const w = await world();
      const out = await w.edit({ edits: fix, comment_id: 'c1', reply });
      expect(out.result.structuredContent!.reply.resolved).toBe(false);
      expect((await w.thread()).status).toBe('open');
    }
  });
  it('never resolves a thread with a reply that asks a question, from edit_page or from reply_to_comment', async () => {
    const w = await world();
    const out = await w.edit({ edits: fix, comment_id: 'c1', reply: { body: 'Fixed the typo. Should I also shorten the title?', resolve: true } });
    expect(out.result.structuredContent!.reply.resolved).toBe(false);
    expect((await w.thread()).status).toBe('open');
    const ask = async (body: string, resolve: boolean) =>
      (await rpc(methods(x, store), w.env, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reply_to_comment', arguments: { comment_id: 'c1', body, resolve } } }, { ...ctx, label: 'claude', slug: 'g/n' })) as { result: { structuredContent: { resolved: boolean } } };
    for (const body of ['Which part should change: the title or the second paragraph?', 'Do you mean "the heading?"', 'Shorter? ']) {
      expect((await ask(body, true)).result.structuredContent.resolved).toBe(false);
      expect((await w.thread()).status).toBe('open');
    }
    // A reply with no question can still resolve the thread.
    expect((await ask('This page has no typo left.', true)).result.structuredContent.resolved).toBe(true);
    expect((await w.thread()).status).toBe('resolved');
  });
  it('gives the assistant the slide of a thread on a deck, so "this slide" has a meaning', async () => {
    const w = await world();
    await w.env.DB.prepare("UPDATE comments SET slide = 'bets', quote = NULL WHERE id = 'c1'").run();
    const out = (await rpc(methods(x, store), w.env, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_comments', arguments: { slug: 'g/n' } } }, { ...ctx, label: 'claude', slug: 'g/n' })) as { result: { structuredContent: { threads: { id: string; slide: string | null }[] } } };
    expect(out.result.structuredContent.threads.map((t) => [t.id, t.slide])).toEqual([['c1', 'bets']]);
  });
  it('stores no version and no reply when an edit fails, and tells the assistant why', async () => {
    const w = await world();
    const out = await w.edit({ edits: [{ old_text: 'no such text', new_text: 'x' }], comment_id: 'c1', reply: { body: 'Fixed.', resolve: true } });
    expect(out.result).toEqual({ content: [{ type: 'text', text: 'Edit 1 of 1 failed: its old_text has 0 matches in the HTML, and it must have exactly 1. The tool stored nothing.' }], isError: true });
    expect([await w.latest(), w.stored, (await w.thread()).replies, (await w.thread()).status]).toEqual([1, [], [], 'open']);
    // The viewer gets no reply step for a call that stored nothing.
    expect((await w.events()).map(([k, d]) => [k, d.tool])).toEqual([['tool', 'edit_page']]);
    // The second call of the assistant, with a good edit, stores both.
    const again = await w.edit({ edits: fix, comment_id: 'c1', reply: { body: 'Fixed.', resolve: true } });
    expect(again.result.structuredContent!.reply.thread_id).toBe('c1');
    expect([await w.latest(), (await w.thread()).replies.length]).toEqual([2, 1]);
  });
  it('refuses a reply with no comment_id, with no text, or with too much text, and stores nothing', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ reply: { body: 'Fixed.' } }, /^reply needs comment_id/],
      [{ comment_id: 'c1', reply: { body: '  ' } }, /^reply\.body must be a string with text/],
      [{ comment_id: 'c1', reply: { resolve: true } }, /^reply\.body must be a string with text/],
      [{ comment_id: 'c1', reply: { body: 'x'.repeat(4001) } }, /^reply\.body is over 4000 characters/],
      [{ comment_id: 'c1', reply: { body: 'Fixed.', resolve: 'yes' } }, /^reply\.resolve must be true or false/],
      [{ comment_id: 'c1', reply: 'Fixed.' }, /^reply must be an object with body/],
    ];
    for (const [args, error] of cases) {
      const w = await world();
      const out = await w.edit({ edits: fix, ...args });
      expect(out.result.isError).toBe(true);
      expect(out.result.content[0].text).toMatch(error);
      expect([await w.latest(), w.stored.length, (await w.thread()).replies.length]).toEqual([1, 0, 0]);
    }
  });
  it('refuses a reply to a comment of another page, also for a token that reaches every page', async () => {
    for (const c of [{}, { slug: undefined }]) {
      const w = await world();
      const out = await w.edit({ edits: fix, comment_id: 'c9', reply: { body: 'Fixed.' } }, c);
      expect(out.result).toEqual({ content: [{ type: 'text', text: 'no comment on g/n has the id c9' }], isError: true });
      expect([await w.latest(), (await listThreads(w.env, { slug: 'g/other' }))[0].replies.length]).toEqual([1, 0]);
    }
    // A token with a scope does not reach the other page at all.
    const w = await world();
    const out = await w.edit({ slug: 'g/other', edits: fix, comment_id: 'c9', reply: { body: 'Fixed.' } });
    expect(out.result.content[0].text).toBe('this connector token reaches only the page g/n, not g/other');
    expect(w.stored).toEqual([]);
  });
  it('reports a reply that the database did not store, with the version that it did store', async () => {
    const w = await world();
    const prepare = w.env.DB.prepare.bind(w.env.DB);
    w.env.DB.prepare = ((q: string) => {
      if (q.startsWith('INSERT INTO comments')) throw new Error('the database is down');
      return prepare(q);
    }) as typeof w.env.DB.prepare;
    const out = await w.edit({ edits: fix, comment_id: 'c1', reply: { body: 'Fixed.', resolve: true } });
    expect(out.result.isError).toBeUndefined();
    expect(out.result.structuredContent).toMatchObject({ version: 2, reply_error: 'The edit is stored as version 2. The reply is not stored: internal error. Call reply_to_comment with comment_id c1.' });
    expect(out.result.structuredContent!.reply).toBeUndefined();
    expect([await w.latest(), (await w.thread()).status]).toEqual([2, 'open']);
  });
});

describe('handleMcp', () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
  it('answers 404 for a token of the wrong shape, with no database read', async () => {
    const { env, sql } = fakeEnv({ [TOKEN]: 'test' });
    const res = await post('short', init, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such connector' });
    expect(sql).toEqual([]);
  });
  it('answers the same 404 for a token that no row has', async () => {
    const { env } = fakeEnv({ [TOKEN]: 'test' });
    const res = await post('B'.repeat(43), init, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such connector' });
  });
  it('answers a known token with the JSON-RPC result as JSON', async () => {
    const { env } = fakeEnv({ [TOKEN]: 'test' });
    const res = await post(TOKEN, init, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } });
  });
  it('answers 202 with no body for notifications/initialized', async () => {
    const res = await post(TOKEN, { jsonrpc: '2.0', method: 'notifications/initialized' }, fakeEnv({ [TOKEN]: 'test' }).env);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });
  it('answers 405 for GET', async () => {
    const res = await handleMcp(new Request(`${ORIGIN}/s/_mcp/${TOKEN}`), fakeEnv({ [TOKEN]: 'test' }).env, x, TOKEN, ORIGIN, store);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
  it('answers 400 for a body that is not JSON and for a protocol version it does not speak', async () => {
    const { env } = fakeEnv({ [TOKEN]: 'test' });
    const bad = await post(TOKEN, '{', env);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: -32700 } });
    const old = await post(TOKEN, init, env, { 'mcp-protocol-version': '1999-01-01' });
    expect(old.status).toBe(400);
    expect(await old.json()).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2025-06-18', '2025-03-26', '2026-07-28'], requested: '1999-01-01' } } });
  });
});

describe('the answers for the sandbox runner at /s/_mcp/discover', () => {
  const SECRET = 'the-secret-of-the-runner';
  const env = () => ({ ...fakeEnv({ [TOKEN]: 'test' }).env, SANDBOX_RUNNER_SECRET: SECRET }) as Env;
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  it('answers initialize, server/discover and tools/list for the secret of the runner, with no connector token', async () => {
    const e = { ...fakeEnv().env, SANDBOX_RUNNER_SECRET: SECRET } as Env;
    const res = await post('discover', list, e, { 'x-runner-secret': SECRET });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const init = await post('discover', { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, e, { 'x-runner-secret': SECRET });
    expect(await init.json()).toMatchObject({ id: 2, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'agent-pages' } } });
    expect((await post('discover', { jsonrpc: '2.0', method: 'notifications/initialized' }, e, { 'x-runner-secret': SECRET })).status).toBe(202);
    const V = '2026-07-28';
    const modern = await post('discover', { jsonrpc: '2.0', id: 3, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {} } } }, e, { 'x-runner-secret': SECRET, 'mcp-protocol-version': V, 'mcp-method': 'server/discover' });
    expect(await modern.json()).toMatchObject({ id: 3, result: { resultType: 'complete', supportedVersions: PROTOCOLS } });
  });
  it('runs no tool there', async () => {
    const res = await post('discover', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_pages', arguments: {} } }, env(), { 'x-runner-secret': SECRET });
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such method: tools/call' } });
  });
  it('answers the 404 of an unknown token with no secret, with a wrong secret, and on a host that has no secret', async () => {
    for (const [e, headers] of [[env(), {}], [env(), { 'x-runner-secret': 'the-secret-of-the-runneR' }], [env(), { 'x-runner-secret': '' }], [fakeEnv().env, { 'x-runner-secret': SECRET }], [fakeEnv().env, {}]] as [Env, Record<string, string>][]) {
      const res = await post('discover', list, e, headers);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'no such connector' });
    }
    // The secret of the runner opens no connector token, and it does not replace one.
    expect((await post('B'.repeat(43), list, env(), { 'x-runner-secret': SECRET })).status).toBe(404);
  });
});

describe('MCP 2026-07-28', () => {
  const V = '2026-07-28';
  const meta = { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {} };
  const env = () => fakeEnv({ [TOKEN]: 'test' }).env;
  /** A request as a client of 2026-07-28 sends it: the version and the method in the headers and in the body. */
  const send = (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    post(TOKEN, { jsonrpc: '2.0', id: 1, method, params: { _meta: meta, ...params } }, env(), { 'mcp-protocol-version': V, 'mcp-method': method, ...headers }).then(async (res) => ({ status: res.status, body: (await res.json()) as any }));
  const serverInfo = { 'io.modelcontextprotocol/serverInfo': { name: 'agent-pages', title: 'Agent Pages', version: '0.1.0' } };

  it('answers server/discover with the versions, the tools capability, and the server identity', async () => {
    const out = await send('server/discover');
    expect(out.status).toBe(200);
    expect(out.body.result).toEqual({
      resultType: 'complete',
      supportedVersions: ['2025-06-18', '2025-03-26', '2026-07-28'],
      capabilities: { tools: {} },
      instructions: expect.stringContaining('get_page'),
      ttlMs: 300000,
      cacheScope: 'public',
      _meta: serverInfo,
    });
  });
  it('lists the tools with no initialize before it, with resultType and the cache fields', async () => {
    const out = await send('tools/list');
    expect(out.status).toBe(200);
    expect(out.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['list_pages', 'get_page', 'list_comments', 'edit_page', 'reply_to_comment']);
    expect(out.body.result).toMatchObject({ resultType: 'complete', ttlMs: 300000, cacheScope: 'public', _meta: serverInfo });
  });
  it('runs a tool call when the Mcp-Name header has the tool name, plain or in base64', async () => {
    for (const name of ['list_pages', `=?base64?${btoa('list_pages')}?=`]) {
      const out = await send('tools/call', { name: 'list_pages', arguments: {} }, { 'mcp-name': name });
      expect(out.status).toBe(200);
      expect(out.body.result).toEqual({ resultType: 'complete', content: [{ type: 'text', text: '{"pages":[]}' }], structuredContent: { pages: [] }, _meta: serverInfo });
    }
  });
  it('answers 400 and -32020 when a header is missing or differs from the body', async () => {
    const cases: [string, Record<string, unknown>, Record<string, string>][] = [
      ['tools/list', {}, { 'mcp-method': 'tools/call' }],
      ['tools/list', {}, { 'mcp-method': '' }],
      ['tools/list', {}, { 'mcp-protocol-version': '2025-06-18' }],
      ['tools/call', { name: 'list_pages' }, {}],
      ['tools/call', { name: 'list_pages' }, { 'mcp-name': 'edit_page' }],
    ];
    for (const [method, params, headers] of cases) {
      const out = await send(method, params, headers);
      expect([out.status, out.body.error.code, out.body.id]).toEqual([400, -32020, 1]);
      expect(out.body.error.message).toMatch(/^Header mismatch: the (MCP-Protocol-Version|Mcp-Method|Mcp-Name) header /);
    }
    const noHeader = await post(TOKEN, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }, env(), { 'mcp-method': 'tools/list' });
    expect([noHeader.status, ((await noHeader.json()) as any).error.code]).toEqual([400, -32020]);
  });
  it('answers 400 and -32602 when _meta has no protocol version or no client capabilities', async () => {
    for (const m of [undefined, {}, { 'io.modelcontextprotocol/protocolVersion': V }, { 'io.modelcontextprotocol/clientCapabilities': {} }]) {
      const out = await send('tools/list', { _meta: m });
      expect([out.status, out.body.error.code]).toEqual([400, -32602]);
    }
  });
  it('answers 404 and -32601 for a method that 2026-07-28 does not have: an unknown one and ping', async () => {
    for (const method of ['resources/list', 'ping']) {
      const out = await send(method);
      expect([out.status, out.body.error]).toEqual([404, { code: -32601, message: `no such method: ${method}` }]);
    }
  });
  it('still answers initialize and ping for a client of an older version', async () => {
    const init = await post(TOKEN, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: V } }, env(), { 'mcp-protocol-version': V });
    expect(await init.json()).toMatchObject({ result: { protocolVersion: '2025-06-18' } });
    const ping = await post(TOKEN, { jsonrpc: '2.0', id: 2, method: 'ping' }, env(), { 'mcp-protocol-version': '2025-06-18' });
    expect(await ping.json()).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });
});
