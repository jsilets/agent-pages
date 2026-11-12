import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, checkCallbackUrl, eventCapabilities, eventFor, eventMethods, grantTtl, matches, notifyEventSubscribers, parseArgs, secretBytes, signature, subscriptionId } from './events';
import { rpc } from './mcp';
import type { Comment, Env } from './types';

const TOKEN = 'A'.repeat(43);
const ORIGIN = 'https://pages.example';
const CALLBACK = 'https://receiver.example.com/mcp-events/callback_123';
// The test vector of the Standard Webhooks libraries and of the Svix documentation.
const VECTOR = { secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: 1614265330, body: '{"test": 2432232314}', signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' };
const SECRET = VECTOR.secret;

const comment = (over: Partial<Comment> = {}): Comment => ({
  id: 'c1', slug: 'team/plan', version: 3, anchor: null, quote: 'the old words', body: '@chatgpt reword this', author: 'a@b.example', mention: 'chatgpt', parent_id: null, status: 'open', created_at: '2026-10-01T12:05:00.000Z', ...over,
});

/** What a receiver computes for a delivery, with Node's HMAC and not with the code under test. */
const expected = (secret: string, h: Headers, body: string) => `v1,${createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${h.get('webhook-id')}.${h.get('webhook-timestamp')}.${body}`).digest('base64')}`;

interface Call {
  url: string;
  headers: Headers;
  body: string;
  redirect: unknown;
}

/** Replaces fetch with a receiver. It records each request and answers with `answer`. */
function receiver(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call = { url, headers: new Headers(init.headers), body: init.body as string, redirect: init.redirect };
    calls.push(call);
    return answer(call);
  });
  return calls;
}
const echo = (c: Call) => Response.json({ challenge: JSON.parse(c.body).challenge });

/** A D1 stand-in. `first` and `all` return the given rows, and each statement that runs is recorded with its arguments. */
function fakeEnv(rows: { first?: unknown; all?: unknown[] } = {}, ENVIRONMENT = 'production') {
  const ran: { sql: string; args: unknown[] }[] = [];
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => ((args = a), stmt),
        first: async () => rows.first ?? null,
        all: async () => ({ results: rows.all ?? [] }),
        run: async () => (ran.push({ sql, args }), { meta: { changes: 1 } }),
      };
      return stmt;
    },
  };
  return { env: { DB, ENVIRONMENT } as unknown as Env, ran };
}

const call = (env: Env, method: string, params: unknown) => rpc(eventMethods, env, { jsonrpc: '2.0', id: 1, method, params }, { token: TOKEN, label: 'chatgpt', origin: ORIGIN }) as Promise<{ result?: any; error?: any }>;
const subscribe = (over: Record<string, unknown> = {}) => ({ name: 'comment.created', arguments: {}, delivery: { mode: 'webhook', url: CALLBACK, secret: SECRET }, cursor: null, ...over });

afterEach(() => vi.unstubAllGlobals());

describe('signature', () => {
  it('matches the Standard Webhooks test vector', async () => {
    expect(await signature([VECTOR.secret], VECTOR.id, VECTOR.timestamp, VECTOR.body)).toBe(VECTOR.signature);
  });
  it('gives one signature for each secret, with a space between them', async () => {
    const other = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
    const both = (await signature([other, VECTOR.secret], VECTOR.id, VECTOR.timestamp, VECTOR.body)).split(' ');
    expect(both).toHaveLength(2);
    expect(both[1]).toBe(VECTOR.signature);
    expect(both[0]).not.toBe(VECTOR.signature);
  });
});

describe('secretBytes', () => {
  it('takes whsec_ and base64 of 24 to 64 bytes', () => {
    expect(secretBytes(VECTOR.secret)).toHaveLength(24);
    expect(secretBytes(`whsec_${Buffer.alloc(64).toString('base64')}`)).toHaveLength(64);
  });
  it('refuses every other value', () => {
    expect(secretBytes(`whsec_${Buffer.alloc(23).toString('base64')}`)).toBeNull();
    expect(secretBytes(`whsec_${Buffer.alloc(65).toString('base64')}`)).toBeNull();
    expect(secretBytes(VECTOR.secret.slice(6))).toBeNull();
    expect(secretBytes('whsec_not base64!')).toBeNull();
    expect(secretBytes(undefined)).toBeNull();
  });
});

describe('subscriptionId', () => {
  it('is the same for the same token, URL, name and arguments, in any key order', async () => {
    const a = await subscriptionId(TOKEN, CALLBACK, 'comment.created', { slug: 'a/b', mention: 'chatgpt' });
    expect(a).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(await subscriptionId(TOKEN, CALLBACK, 'comment.created', { mention: 'chatgpt', slug: 'a/b' })).toBe(a);
  });
  it('changes when one part changes', async () => {
    const base = [TOKEN, CALLBACK, 'comment.created', { mention: 'chatgpt' }] as const;
    const ids = await Promise.all([
      subscriptionId(...base),
      subscriptionId('B'.repeat(43), base[1], base[2], base[3]),
      subscriptionId(base[0], `${CALLBACK}4`, base[2], base[3]),
      subscriptionId(base[0], base[1], 'comment.resolved', base[3]),
      subscriptionId(base[0], base[1], base[2], { mention: 'claude' }),
    ]);
    expect(new Set(ids).size).toBe(5);
  });
  it('rests on canonical JSON', () => {
    expect(canonicalJson({ b: [1, { d: 1, c: null }], a: 'x' })).toBe('{"a":"x","b":[1,{"c":null,"d":1}]}');
  });
});

describe('arguments', () => {
  it('fills in the default mention', () => {
    expect(parseArgs(undefined)).toEqual({ mention: 'chatgpt' });
    expect(parseArgs({})).toEqual({ mention: 'chatgpt' });
    expect(parseArgs({ slug: 'team/plan', mention: 'claude' })).toEqual({ slug: 'team/plan', mention: 'claude' });
  });
  it('refuses what the inputSchema refuses', () => {
    for (const bad of [{ slug: 'no-group' }, { slug: 7 }, { mention: 'gemini' }, { document_id: 'x' }, [], 'x']) expect(() => parseArgs(bad), JSON.stringify(bad)).toThrow(/arguments/);
  });
  it('matches a comment by mention and by page', () => {
    expect(matches({ mention: 'chatgpt' }, comment())).toBe(true);
    expect(matches({ mention: 'chatgpt', slug: 'team/plan' }, comment())).toBe(true);
    expect(matches({ mention: 'chatgpt', slug: 'team/other' }, comment())).toBe(false);
    expect(matches({ mention: 'chatgpt' }, comment({ mention: 'claude' }))).toBe(false);
    expect(matches({ mention: 'chatgpt' }, comment({ mention: null }))).toBe(false);
  });
});

describe('checkCallbackUrl', () => {
  it('takes an https URL on a public host', () => {
    for (const ok of [CALLBACK, 'https://8.8.8.8/cb', 'https://[2606:4700:4700::1111]/cb', 'https://chatgpt.com:8443/x?y=1']) expect(checkCallbackUrl(ok), ok).toBeNull();
  });
  it('refuses http, and a URL with a password', () => {
    expect(checkCallbackUrl('http://receiver.example.com/cb')).toMatch(/https/);
    expect(checkCallbackUrl('ftp://receiver.example.com/cb')).toMatch(/https/);
    expect(checkCallbackUrl('https://user:pw@receiver.example.com/cb')).toMatch(/password/);
    expect(checkCallbackUrl('not a url')).toMatch(/not a URL/);
    expect(checkCallbackUrl(undefined)).toMatch(/not a URL/);
  });
  it('refuses private, local and other non-public addresses', () => {
    const bad = [
      'https://localhost/cb', 'https://api.localhost/cb', 'https://printer.local/cb', 'https://db.internal/cb', 'https://intranet/cb', 'https://localhost./cb',
      'https://127.0.0.1/cb', 'https://10.1.2.3/cb', 'https://172.16.0.1/cb', 'https://172.31.255.255/cb', 'https://192.168.1.1/cb', 'https://169.254.169.254/cb', 'https://100.64.0.1/cb',
      'https://0.0.0.0/cb', 'https://224.0.0.1/cb', 'https://255.255.255.255/cb', 'https://198.18.0.1/cb', 'https://192.0.2.1/cb',
      // Other ways to write 127.0.0.1 and 10.0.0.1. The URL parser turns each into four numbers.
      'https://2130706433/cb', 'https://0x7f000001/cb', 'https://0177.0.0.1/cb', 'https://127.1/cb', 'https://0xa.0.0.1/cb',
      'https://[::1]/cb', 'https://[::]/cb', 'https://[::ffff:127.0.0.1]/cb', 'https://[::ffff:8.8.8.8]/cb', 'https://[fc00::1]/cb', 'https://[fd12:3456::1]/cb', 'https://[fe80::1]/cb',
      'https://[ff02::1]/cb', 'https://[64:ff9b::a00:1]/cb', 'https://[2001:db8::1]/cb', 'https://[2001::1]/cb', 'https://[2002:a00:1::1]/cb',
    ];
    for (const url of bad) expect(checkCallbackUrl(url), url).toMatch(/public host/);
  });
  it('leaves public addresses next to the private ranges alone', () => {
    for (const ok of ['https://172.32.0.1/cb', 'https://11.0.0.1/cb', 'https://100.128.0.1/cb', 'https://192.169.0.1/cb', 'https://[2a00:1450:4001::1]/cb']) expect(checkCallbackUrl(ok), ok).toBeNull();
  });
  it('allows http to this machine in development only', () => {
    expect(checkCallbackUrl('http://localhost:8802/cb', true)).toBeNull();
    expect(checkCallbackUrl('http://127.0.0.1:8802/cb', true)).toBeNull();
    expect(checkCallbackUrl('http://127.0.0.1:8802/cb')).toMatch(/https/);
    expect(checkCallbackUrl('http://192.168.1.1/cb', true)).toMatch(/https/);
    expect(checkCallbackUrl('https://192.168.1.1/cb', true)).toMatch(/public host/);
  });
});

describe('grantTtl', () => {
  const MIN = 60_000;
  const HOUR = 3600_000;
  it('grants the default with no ttlMs and no more than the request with one', () => {
    expect(grantTtl(undefined)).toBe(24 * HOUR);
    expect(grantTtl(2 * HOUR)).toBe(2 * HOUR);
    expect(grantTtl('soon')).toBe(24 * HOUR);
  });
  it('holds a short request at the minimum and a long or endless one at the maximum', () => {
    expect(grantTtl(1)).toBe(5 * MIN);
    expect(grantTtl(365 * 24 * HOUR)).toBe(30 * 24 * HOUR);
    expect(grantTtl(null)).toBe(30 * 24 * HOUR);
  });
});

describe('eventFor', () => {
  it('puts the comment in data and nothing else', () => {
    expect(eventFor(comment(), ORIGIN)).toEqual({
      eventId: 'evt_c1',
      name: 'comment.created',
      timestamp: '2026-10-01T12:05:00.000Z',
      data: { comment_id: 'c1', slug: 'team/plan', text: '@chatgpt reword this', quote: 'the old words', author: 'a@b.example', url: 'https://pages.example/p/team/plan', thread_id: 'c1' },
      cursor: null,
    });
  });
  it('names the thread of a reply and leaves out a quote that is not there', () => {
    const data = eventFor(comment({ id: 'c2', parent_id: 'c1', quote: null }), ORIGIN).data;
    expect(data.thread_id).toBe('c1');
    expect('quote' in data).toBe(false);
  });
});

describe('the JSON-RPC methods', () => {
  it('declares the events capability and lists comment.created with webhook delivery', async () => {
    expect(eventCapabilities).toEqual({ events: {} });
    const { result } = await call(fakeEnv().env, 'events/list', undefined);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ name: 'comment.created', delivery: ['webhook'] });
    expect(Object.keys(result.events[0].inputSchema.properties)).toEqual(['slug', 'mention']);
    expect(Object.keys(result.events[0].payloadSchema.properties)).toEqual(['comment_id', 'slug', 'text', 'quote', 'author', 'url', 'thread_id']);
  });

  it('verifies the callback with a signed challenge, then stores the subscription', async () => {
    const calls = receiver(echo);
    const { env, ran } = fakeEnv({ first: { n: 0, found: null, verified_at: null } });
    const before = Date.now();
    const { result } = await call(env, 'events/subscribe', subscribe({ arguments: { slug: 'team/plan' }, ttlMs: 3600_000 }));
    const id = await subscriptionId(TOKEN, CALLBACK, 'comment.created', { slug: 'team/plan', mention: 'chatgpt' });
    expect(result).toEqual({ id, refreshBefore: expect.any(String), cursor: null, truncated: false });
    expect(Date.parse(result.refreshBefore) - before).toBeGreaterThanOrEqual(3600_000);
    expect(Date.parse(result.refreshBefore) - before).toBeLessThan(3600_000 + 5000);

    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.url).toBe(CALLBACK);
    expect(c.redirect).toBe('manual');
    expect(JSON.parse(c.body)).toEqual({ type: 'verification', challenge: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(c.headers.get('webhook-id')).toMatch(/^msg_verification_/);
    expect(c.headers.get('x-mcp-subscription-id')).toBe(id);
    expect(c.headers.get('content-type')).toBe('application/json');
    expect(Math.abs(Number(c.headers.get('webhook-timestamp')) - before / 1000)).toBeLessThan(5);
    expect(c.headers.get('webhook-signature')).toBe(expected(SECRET, c.headers, c.body));

    const insert = ran.find((r) => r.sql.includes('INSERT INTO event_subscriptions'));
    expect(insert?.args.slice(0, 6)).toEqual([id, TOKEN, 'comment.created', '{"mention":"chatgpt","slug":"team/plan"}', CALLBACK, SECRET]);
    expect(insert?.args[7]).toBe(result.refreshBefore);
  });

  it('sends no second challenge while the verification of the token and the URL is fresh', async () => {
    const calls = receiver(echo);
    const { env, ran } = fakeEnv({ first: { n: 1, found: 1, verified_at: new Date(Date.now() - 3600_000).toISOString() } });
    const { result } = await call(env, 'events/subscribe', subscribe());
    expect(result.id).toMatch(/^sub_/);
    expect(calls).toHaveLength(0);
    expect(ran.some((r) => r.sql.includes('INSERT INTO event_subscriptions'))).toBe(true);
  });

  it('answers -32015 with a reason and stores nothing when verification fails', async () => {
    const cases: [(c: Call) => Response | Promise<Response>, string][] = [
      [() => Response.json({ challenge: 'another value' }), 'challenge_failed'],
      [() => new Response('ok'), 'challenge_failed'],
      [(c) => new Response(null, { status: 302, headers: { location: `https://elsewhere.example/?${JSON.parse(c.body).challenge}` } }), 'challenge_failed'],
      [() => new Response('no', { status: 404 }), 'http_4xx'],
      [() => new Response('no', { status: 503 }), 'http_5xx'],
      [() => Promise.reject(new TypeError('connect failed')), 'connection_refused'],
      [() => Promise.reject(new DOMException('too slow', 'TimeoutError')), 'timeout'],
    ];
    for (const [answer, reason] of cases) {
      receiver(answer);
      const { env, ran } = fakeEnv({ first: { n: 0, found: null, verified_at: null } });
      const { error } = await call(env, 'events/subscribe', subscribe());
      expect(error, reason).toMatchObject({ code: -32015, data: { reason } });
      expect(ran.some((r) => r.sql.includes('INSERT'))).toBe(false);
    }
  });

  it('refuses a bad request before it sends anything', async () => {
    const calls = receiver(echo);
    const { env } = fakeEnv({ first: { n: 0, found: null, verified_at: null } });
    const code = async (over: Record<string, unknown>) => (await call(env, 'events/subscribe', subscribe(over))).error?.code;
    expect(await code({ name: 'message.created' })).toBe(-32011);
    expect(await code({ arguments: { document_id: 'doc_123' } })).toBe(-32602);
    expect(await code({ delivery: { mode: 'poll', url: CALLBACK, secret: SECRET } })).toBe(-32014);
    expect(await code({ delivery: { mode: 'webhook', url: 'http://receiver.example.com/cb', secret: SECRET } })).toBe(-32602);
    expect(await code({ delivery: { mode: 'webhook', url: 'https://169.254.169.254/cb', secret: SECRET } })).toBe(-32602);
    expect(await code({ delivery: { mode: 'webhook', url: `${ORIGIN}/s/_mcp/x`, secret: SECRET } })).toBe(-32602);
    expect(await code({ delivery: { mode: 'webhook', url: CALLBACK, secret: 'whsec_c2hvcnQ=' } })).toBe(-32602);
    expect(await code({ delivery: { mode: 'webhook', url: CALLBACK } })).toBe(-32602);
    expect(calls).toHaveLength(0);
  });

  it('refuses one subscription more than the limit', async () => {
    receiver(echo);
    const { error } = await call(fakeEnv({ first: { n: 100, found: 0, verified_at: null } }).env, 'events/subscribe', subscribe());
    expect(error).toMatchObject({ code: -32013, data: { limit: 'subscriptions', max: 100 } });
  });

  it('unsubscribes by the same identity and returns an empty result', async () => {
    const { env, ran } = fakeEnv();
    const { result } = await call(env, 'events/unsubscribe', { name: 'comment.created', arguments: { mention: 'chatgpt', slug: 'team/plan' }, delivery: { mode: 'webhook', url: CALLBACK } });
    expect(result).toEqual({});
    expect(ran).toHaveLength(1);
    expect(ran[0].sql).toMatch(/^DELETE FROM event_subscriptions/);
    expect(ran[0].args).toEqual([await subscriptionId(TOKEN, CALLBACK, 'comment.created', { slug: 'team/plan', mention: 'chatgpt' }), TOKEN]);
  });
});

describe('notifyEventSubscribers', () => {
  const row = (id: string, args: object, over: object = {}) => ({ id, arguments: JSON.stringify(args), callback_url: `https://receiver.example.com/${id}`, secret: SECRET, prev_secret: null, prev_secret_until: null, ...over });
  const statusOf = (ran: { sql: string; args: unknown[] }[]) => ran.filter((r) => r.sql.startsWith('UPDATE')).map((r) => [r.args[2], r.args[1]]);

  it('POSTs the signed event to the subscriptions that match, and to no other', async () => {
    const calls = receiver(() => new Response(null, { status: 204 }));
    const { env, ran } = fakeEnv({ all: [row('sub_all', { mention: 'chatgpt' }), row('sub_page', { mention: 'chatgpt', slug: 'team/plan' }), row('sub_other', { mention: 'chatgpt', slug: 'team/other' }), row('sub_claude', { mention: 'claude' })] });
    await notifyEventSubscribers(env, comment(), ORIGIN);
    expect(calls.map((c) => c.url).sort()).toEqual(['https://receiver.example.com/sub_all', 'https://receiver.example.com/sub_page']);
    for (const c of calls) {
      expect(JSON.parse(c.body)).toEqual(eventFor(comment(), ORIGIN));
      expect(c.headers.get('webhook-id')).toBe('evt_c1');
      expect(c.headers.get('x-mcp-subscription-id')).toBe(c.url.split('/').pop());
      expect(c.headers.get('webhook-signature')).toBe(expected(SECRET, c.headers, c.body));
      expect(c.redirect).toBe('manual');
    }
    expect(statusOf(ran).sort()).toEqual([['sub_all', 'delivered'], ['sub_page', 'delivered']]);
  });

  it('sends nothing for a comment with no mention', async () => {
    const calls = receiver(() => new Response(null, { status: 204 }));
    await notifyEventSubscribers(fakeEnv({ all: [row('sub_all', { mention: 'chatgpt' })] }).env, comment({ mention: null, body: 'plain words' }), ORIGIN);
    expect(calls).toHaveLength(0);
  });

  it('retries a 5xx answer one time with the same event id', async () => {
    // The wait before the retry is real, so this test takes one second.
    let n = 0;
    const calls = receiver(() => new Response(null, { status: n++ ? 200 : 503 }));
    const { env, ran } = fakeEnv({ all: [row('sub_all', { mention: 'chatgpt' })] });
    await notifyEventSubscribers(env, comment(), ORIGIN);
    expect(calls.map((c) => c.headers.get('webhook-id'))).toEqual(['evt_c1', 'evt_c1']);
    expect(statusOf(ran)).toEqual([['sub_all', 'delivered']]);
  });

  it('does not retry a 410 answer or a redirect, and records why the delivery failed', async () => {
    for (const [status, recorded] of [[410, 'http_4xx'], [413, 'http_4xx'], [307, 'http_3xx']] as const) {
      const calls = receiver(() => new Response(null, { status, headers: { location: 'https://elsewhere.example/' } }));
      const { env, ran } = fakeEnv({ all: [row('sub_all', { mention: 'chatgpt' })] });
      await notifyEventSubscribers(env, comment(), ORIGIN);
      expect(calls).toHaveLength(1);
      expect(statusOf(ran)).toEqual([['sub_all', recorded]]);
    }
  });

  it('signs with the old secret too while a rotation is open', async () => {
    const old = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
    const calls = receiver(() => new Response(null, { status: 200 }));
    const open = row('sub_open', { mention: 'chatgpt' }, { prev_secret: old, prev_secret_until: new Date(Date.now() + 60_000).toISOString() });
    const closed = row('sub_closed', { mention: 'chatgpt' }, { prev_secret: old, prev_secret_until: new Date(Date.now() - 60_000).toISOString() });
    await notifyEventSubscribers(fakeEnv({ all: [open, closed] }).env, comment(), ORIGIN);
    const sig = (id: string) => calls.find((c) => c.url.endsWith(id))!;
    expect(sig('sub_open').headers.get('webhook-signature')).toBe(`${expected(SECRET, sig('sub_open').headers, sig('sub_open').body)} ${expected(old, sig('sub_open').headers, sig('sub_open').body)}`);
    expect(sig('sub_closed').headers.get('webhook-signature')).toBe(expected(SECRET, sig('sub_closed').headers, sig('sub_closed').body));
  });

  it('does not POST to a stored callback URL that the address check refuses', async () => {
    const calls = receiver(() => new Response(null, { status: 200 }));
    const { env, ran } = fakeEnv({ all: [row('sub_all', { mention: 'chatgpt' }, { callback_url: 'http://127.0.0.1:8802/cb' })] });
    await notifyEventSubscribers(env, comment(), ORIGIN);
    expect(calls).toHaveLength(0);
    expect(statusOf(ran)).toEqual([['sub_all', 'blocked']]);
  });
});
