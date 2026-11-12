// The assistant routes: the sign-in state, the model of each person, and the sign-in itself, through the HTTP routes of
// the Worker with real SQL (see testdb.ts) and a fake sandbox runner.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { route } from './lib';
import { testDb } from './testdb';
import worker from './worker';

vi.mock('../../brand/favicon.ico?inline', () => ({ default: 'data:image/x-icon;base64,AA==' }));
vi.mock('../../brand/apple-touch-icon.png?inline', () => ({ default: 'data:image/png;base64,AA==' }));

const ORIGIN = 'https://pages.test';
const MODELS = [{ id: 'claude-fast', label: 'Faster', note: 'Good for most comments.' }, { id: 'claude-careful', label: 'More careful', note: 'Slower.' }];
const STATUS = { assistants: { claude: { connected: true, models: MODELS, default_model: 'claude-fast' }, chatgpt: { connected: false, models: [], default_model: null } } };

/** A Worker with a fake runner. `answers` maps a runner path to its answer. `sent` has each request to the runner. */
function host(answers: Record<string, unknown | ((body: Record<string, unknown>) => unknown)> = {}, vars: Record<string, string> = {}) {
  const sent: { url: string; secret: string | null; body: Record<string, unknown> }[] = [];
  const env = {
    ENVIRONMENT: 'development', ACCESS_AUD: '', ACCESS_TEAM: '', SANDBOX_RUNNER_URL: 'http://runner.test:8811/run', SANDBOX_RUNNER_SECRET: 'shh', ...vars,
    DB: testDb(),
    PAGES: { get: async () => null, put: async () => {}, list: async () => ({ objects: [], truncated: false }), delete: async () => {} },
    BROWSER: { quickAction: async () => new Response('img') },
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sent.push({ url, secret: new Headers(init.headers).get('x-runner-secret'), body });
    const a = answers[new URL(url).pathname];
    if (a === undefined) return new Response('no', { status: 404 });
    if (a instanceof Response) return a;
    return Response.json(typeof a === 'function' ? a(body) : a);
  });
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) => {
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env as never, ctx);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { call, sent, db: env.DB };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('routes', () => {
  it('parses each assistant route, and only for claude and chatgpt', () => {
    expect(route('/api/assistants')).toEqual({ kind: 'api-assistants' });
    expect(route('/api/assistants/claude')).toEqual({ kind: 'api-assistant', name: 'claude' });
    expect(route('/api/assistants/chatgpt/connect')).toEqual({ kind: 'api-assistant-connect', name: 'chatgpt' });
    expect(route('/api/assistants/claude/connection')).toEqual({ kind: 'api-assistant-connection', name: 'claude' });
    expect(route('/api/assistants/connect/abcdefgh-123')).toEqual({ kind: 'api-connect', id: 'abcdefgh-123' });
    expect(route('/api/assistants/connect/abcdefgh-123/code')).toEqual({ kind: 'api-connect-code', id: 'abcdefgh-123' });
    expect(route('/api/assistants/gemini').kind).toBe('not-found');
  });
});

describe('GET /api/assistants', () => {
  it('asks the runner for the state of the person, and returns each assistant with its models and the default', async () => {
    const h = host({ '/status': STATUS });
    const out = await h.call('GET', '/api/assistants');
    expect(out).toEqual({ status: 200, body: { runner: true, assistants: {
      claude: { handled: true, connected: true, models: MODELS, default_model: 'claude-fast', model: null },
      chatgpt: { handled: true, connected: false, models: [], default_model: null, model: null },
    } } });
    expect(h.sent).toEqual([{ url: 'http://runner.test:8811/status', secret: 'shh', body: { user: 'local' } }]);
  });
  it('drops a model with a bad id, cuts a long label and keeps at most 8 models', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: 'm' + i, label: 'L'.repeat(60), note: 'n' }));
    const h = host({ '/status': { assistants: { claude: { connected: true, models: [{ id: '<script>', label: 'x' }, ...many], default_model: 'm0' } } } });
    const { claude } = (await h.call('GET', '/api/assistants')).body.assistants;
    expect(claude.models).toHaveLength(8);
    expect(claude.models[0]).toEqual({ id: 'm0', label: 'L'.repeat(40), note: 'n' });
  });
  it('says that the runner did not answer, and still lists the assistants', async () => {
    const h = host({ '/status': new Response('down', { status: 500 }) });
    const out = (await h.call('GET', '/api/assistants')).body;
    expect(out.runner).toBe(false);
    expect(out.assistants.claude).toMatchObject({ handled: true, connected: null, models: [] });
  });
  it('says that the runner could not check one sign-in, with the text of the host and never the text of the runner', async () => {
    const h = host({ '/status': { assistants: { claude: { connected: true, models: MODELS }, chatgpt: { connected: false, error: 'docker: /var/run/docker.sock refused' } } } });
    const { assistants } = (await h.call('GET', '/api/assistants')).body;
    expect(assistants.chatgpt).toEqual({ handled: true, connected: false, models: [], default_model: null, model: null, error: 'the sandbox runner could not check the sign-in' });
    expect(assistants.claude.error).toBeUndefined();
  });
});

describe('PUT /api/assistants/<name>', () => {
  it('saves a model of the runner for the person, and null goes back to the default', async () => {
    const h = host({ '/status': STATUS });
    expect(await h.call('PUT', '/api/assistants/claude', { model: 'claude-careful' })).toEqual({ status: 200, body: { model: 'claude-careful' } });
    expect((await h.call('GET', '/api/assistants')).body.assistants.claude.model).toBe('claude-careful');
    expect(await h.db.prepare('SELECT user, assistant, model FROM assistant_prefs').all()).toMatchObject({ results: [{ user: 'local', assistant: 'claude', model: 'claude-careful' }] });
    expect(await h.call('PUT', '/api/assistants/claude', { model: null })).toEqual({ status: 200, body: { model: null } });
    expect((await h.db.prepare('SELECT COUNT(*) AS n FROM assistant_prefs').first())).toEqual({ n: 0 });
  });
  it('refuses a model that the runner does not have, a bad id and a bad body', async () => {
    const h = host({ '/status': STATUS });
    expect((await h.call('PUT', '/api/assistants/claude', { model: 'gpt-9' })).status).toBe(400);
    expect((await h.call('PUT', '/api/assistants/claude', { model: 'a b' })).status).toBe(400);
    expect((await h.call('PUT', '/api/assistants/claude', 'nope')).status).toBe(400);
    expect((await h.call('POST', '/api/assistants/claude', { model: null })).status).toBe(405);
  });
});

describe('the sign-in', () => {
  const CLAUDE = { id: 'flow-claude-1', url: 'https://claude.ai/oauth/x', needs_code: true, expires_at: '2099-01-01T00:00:00Z' };
  it('starts a sign-in at the runner for the person and the engine, and keeps it for 30 minutes at most', async () => {
    const h = host({ '/connect': CLAUDE });
    const out = await h.call('POST', '/api/assistants/claude/connect');
    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({ id: 'flow-claude-1', url: 'https://claude.ai/oauth/x', needs_code: true });
    expect(Date.parse(out.body.expires_at) - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000);
    expect(h.sent[0]).toEqual({ url: 'http://runner.test:8811/connect', secret: 'shh', body: { user: 'local', engine: 'claude' } });
    const h2 = host({ '/connect': { id: 'flow-codex-1', url: 'https://auth.openai.com/device', user_code: 'ABCD-1234', needs_code: false, expires_at: '2099-01-01T00:00:00Z' } });
    expect((await h2.call('POST', '/api/assistants/chatgpt/connect')).body).toMatchObject({ user_code: 'ABCD-1234', needs_code: false });
    expect(h2.sent[0].body).toEqual({ user: 'local', engine: 'codex' });
  });
  it('refuses a sign-in page that is not https, and a bad id or code from the runner', async () => {
    for (const bad of [{ ...CLAUDE, url: 'javascript:alert(1)' }, { ...CLAUDE, url: 'http://evil.test/x' }, { ...CLAUDE, id: 'x' }, { ...CLAUDE, user_code: '<b>' }]) {
      expect((await host({ '/connect': bad }).call('POST', '/api/assistants/claude/connect')).status).toBe(502);
    }
  });
  it('passes the code straight to the runner, stores it nowhere and logs it nowhere', async () => {
    const code = 'secret-code-' + 'z'.repeat(80);
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
    const h = host({ '/connect': CLAUDE, '/connect/code': (b: Record<string, unknown>) => ({ status: b.code === code ? 'connected' : 'failed' }) });
    await h.call('POST', '/api/assistants/claude/connect');
    expect(await h.call('POST', '/api/assistants/connect/flow-claude-1/code', { code })).toEqual({ status: 200, body: { status: 'connected' } });
    expect(h.sent[1]).toEqual({ url: 'http://runner.test:8811/connect/code', secret: 'shh', body: { id: 'flow-claude-1', code } });
    for (const t of ['connect_flows', 'assistant_prefs', 'comments', 'agent_runs', 'run_events']) {
      expect(JSON.stringify((await h.db.prepare(`SELECT * FROM ${t}`).all()).results)).not.toContain('secret-code');
    }
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-code');
  });
  it('refuses an empty code, a code with spaces and a code over 2048 characters, before the runner sees it', async () => {
    const h = host({ '/connect': CLAUDE, '/connect/code': { status: 'connected' } });
    await h.call('POST', '/api/assistants/claude/connect');
    for (const code of ['', 'a b', 'x'.repeat(2049), 42]) expect((await h.call('POST', '/api/assistants/connect/flow-claude-1/code', { code })).status).toBe(400);
    expect(h.sent.map((s) => s.url)).toEqual(['http://runner.test:8811/connect']);
  });
  it('gives the state of a sign-in of the person only: another person gets 404', async () => {
    const h = host({ '/connect': CLAUDE, '/connect/status': { status: 'pending' } });
    await h.call('POST', '/api/assistants/claude/connect');
    expect(await h.call('GET', '/api/assistants/connect/flow-claude-1')).toEqual({ status: 200, body: { status: 'pending' } });
    await h.db.prepare('UPDATE connect_flows SET user = ?').bind('ann@example.com').run();
    expect((await h.call('GET', '/api/assistants/connect/flow-claude-1')).status).toBe(404);
    expect((await h.call('POST', '/api/assistants/connect/flow-claude-1/code', { code: 'abcdefgh' })).status).toBe(404);
  });
  it('turns an unknown state of the runner into failed, and forgets a sign-in that ended', async () => {
    const h = host({ '/connect': CLAUDE, '/connect/status': { status: 'weird', detail: 'x'.repeat(500) } });
    await h.call('POST', '/api/assistants/claude/connect');
    const out = (await h.call('GET', '/api/assistants/connect/flow-claude-1')).body;
    expect(out.status).toBe('failed');
    expect(out.detail.length).toBeLessThanOrEqual(200);
    expect((await h.call('GET', '/api/assistants/connect/flow-claude-1')).status).toBe(404);
  });
  it('DELETE disconnects the assistant at the runner', async () => {
    const h = host({ '/disconnect': { ok: true } });
    expect(await h.call('DELETE', '/api/assistants/chatgpt/connection')).toEqual({ status: 200, body: { ok: true } });
    expect(h.sent[0]).toEqual({ url: 'http://runner.test:8811/disconnect', secret: 'shh', body: { user: 'local', engine: 'codex' } });
  });
});

describe('the guards', () => {
  it('refuses a request from another site, and a write from another origin', async () => {
    const h = host({ '/status': STATUS, '/disconnect': { ok: true } });
    expect((await h.call('GET', '/api/assistants', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await h.call('GET', '/api/assistants', undefined, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await h.call('DELETE', '/api/assistants/claude/connection', undefined, { origin: 'null' })).status).toBe(403);
    expect(h.sent).toEqual([]);
  });
  it('answers 503 with no runner, or when the runner fails, and never shows the answer of the runner', async () => {
    expect((await host({}, { SANDBOX_RUNNER_URL: '' }).call('POST', '/api/assistants/claude/connect')).status).toBe(503);
    const out = await host({ '/connect': new Response('token=abc', { status: 500 }) }).call('POST', '/api/assistants/claude/connect');
    expect(out.status).toBe(503);
    expect(JSON.stringify(out.body)).not.toContain('token=abc');
  });
});
