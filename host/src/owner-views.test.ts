// The owner's own visits to a share link do not count, and the owner skips the email gate.
// The suite calls the Worker's real fetch handler. A real SQLite database runs the repo's migrations behind
// a small D1 adapter, and the test signs Cloudflare Access tokens with its own key.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearKeyCache } from './auth';
import worker from './worker';

const TEAM = 'team';
const AUD = 'aud-123';
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const HOST = 'https://pages.example.com';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Share tokens are 32 random bytes in base64url, as newToken() makes them.
const OPEN = 'o'.repeat(43);
const GATED = 'g'.repeat(43);
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const gen = () =>
  crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;

/** The part of D1 that the Worker uses, over node:sqlite. */
function d1(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async (col?: string) => {
      const r = db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined;
      return r ? (col ? r[col] : { ...r }) : null;
    },
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])).map((r) => ({ ...r })) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (list: ReturnType<typeof stmt>[]) => Promise.all(list.map((s) => s.run())) };
}

let db: DatabaseSync;
let keys: CryptoKeyPair;
let stranger: CryptoKeyPair;
let env: Parameters<typeof worker.fetch>[1];

async function sign(email: string, key = keys.privateKey) {
  const head = enc({ alg: 'RS256', kid: 'k1' });
  const body = enc({ iss: ISS, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, email });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}

const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const headers = new Headers(init.headers);
  headers.set('user-agent', CHROME);
  if (init.cookie) headers.set('cookie', init.cookie);
  return worker.fetch(new Request(HOST + path, { ...init, headers }) as never, env, {} as never);
};
const start = (token: string, cookie?: string) =>
  call(`/s/${token}/view`, { method: 'POST', cookie, headers: { origin: HOST, 'content-type': 'application/json' }, body: JSON.stringify({ parts: ['Intro'] }) });
const visits = () => (db.prepare('SELECT COUNT(*) AS n FROM share_views').get() as { n: number }).n;

beforeAll(async () => {
  keys = await gen();
  stranger = await gen();
  const jwks = { keys: [{ ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' }] };
  // Access publishes its keys at <team>.cloudflareaccess.com/cdn-cgi/access/certs. The test serves its own key there.
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url) === `${ISS}/cdn-cgi/access/certs`) return new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } });
    throw new Error('unexpected fetch ' + url);
  });
  db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url).pathname;
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(dir + f, 'utf8'));
  const at = new Date().toISOString();
  db.prepare('INSERT INTO pages (slug, title, latest, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run('acme/plan', 'Plan', at, at);
  db.prepare('INSERT INTO versions (slug, version, bytes, created_at) VALUES (?, 1, 10, ?)').run('acme/plan', at);
  db.prepare("INSERT INTO shares (token, slug, kind, created_at) VALUES (?, 'acme/plan', 'public', ?)").run(OPEN, at);
  db.prepare("INSERT INTO shares (token, slug, kind, require_email, created_at) VALUES (?, 'acme/plan', 'public', 1, ?)").run(GATED, at);
  env = { DB: d1(db), ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ENVIRONMENT: 'test' } as never;
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  clearKeyCache();
  db.exec('DELETE FROM share_view_parts; DELETE FROM share_views;');
});

describe('the owner and share links', () => {
  it('counts a visit from a reader who did not sign in', async () => {
    const r = await start(OPEN);
    expect(r.status).toBe(201);
    expect(visits()).toBe(1);
  });

  it('does not count a visit from a person who signed in to the host', async () => {
    const r = await start(OPEN, `CF_Authorization=${await sign('owner@example.com')}`);
    expect(await r.json()).toEqual({ id: null });
    expect(visits()).toBe(0);
  });

  it('counts a visit when the Access cookie has a forged signature', async () => {
    const r = await start(OPEN, `CF_Authorization=${await sign('owner@example.com', stranger.privateKey)}`);
    expect(r.status).toBe(201);
    expect(visits()).toBe(1);
  });

  it('shows the email form to a reader, and the page to the owner, on a link that requires an email', async () => {
    const reader = await (await call(`/s/${GATED}`)).text();
    const owner = await (await call(`/s/${GATED}`, { cookie: `CF_Authorization=${await sign('owner@example.com')}` })).text();
    expect(reader).toContain('id="gate"');
    expect(owner).not.toContain('id="gate"');
    expect(owner).toContain('<iframe');
  });
});
