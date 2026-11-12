import { describe, expect, it } from 'vitest';
import { handleMcp, methods, PROTOCOLS, rpc, TOOLS } from './mcp';
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
