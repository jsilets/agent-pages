import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessCookie, clearKeyCache, verifyAccessJwt } from './auth';

const TEAM = 'team';
const AUD = 'aud-123';
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

let keys: CryptoKeyPair;
let other: CryptoKeyPair;
let jwks: { keys: (JsonWebKey & { kid: string })[] };
let fetches = 0;
const fetchKeys = async () => {
  fetches++;
  return jwks;
};

async function sign(claims: Record<string, unknown>, opts: { kid?: string; key?: CryptoKey; alg?: string } = {}) {
  const head = enc({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1' });
  const body = enc(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}

const gen = () =>
  crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;

const exp = Math.floor(Date.now() / 1000) + 600;
const opts = { team: TEAM, aud: AUD, fetchKeys };

beforeAll(async () => {
  keys = await gen();
  other = await gen();
  jwks = { keys: [{ ...((await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey), kid: 'k1' }] };
});
beforeEach(() => {
  clearKeyCache();
  fetches = 0;
});

describe('verifyAccessJwt', () => {
  it('accepts a person token and returns the email', async () => {
    const t = await sign({ iss: ISS, aud: [AUD], exp, email: 'me@example.com' });
    expect(await verifyAccessJwt(t, opts)).toEqual({ who: 'me@example.com', kind: 'person' });
  });
  it('accepts a service token and returns the client ID', async () => {
    const t = await sign({ iss: ISS, aud: AUD, exp, common_name: 'abc.access' });
    expect(await verifyAccessJwt(t, opts)).toEqual({ who: 'abc.access', kind: 'service' });
  });
  it('refuses a wrong audience, issuer, expiry, signature or algorithm', async () => {
    const good = { iss: ISS, aud: [AUD], exp, email: 'me@example.com' };
    expect(await verifyAccessJwt(await sign({ ...good, aud: ['other'] }), opts)).toBe(null);
    expect(await verifyAccessJwt(await sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }), opts)).toBe(null);
    expect(await verifyAccessJwt(await sign({ ...good, exp: Math.floor(Date.now() / 1000) - 1 }), opts)).toBe(null);
    expect(await verifyAccessJwt(await sign(good, { key: other.privateKey }), opts)).toBe(null);
    expect(await verifyAccessJwt(await sign(good, { alg: 'HS256' }), opts)).toBe(null);
  });
  it('refuses a missing token, a junk token and an empty config', async () => {
    expect(await verifyAccessJwt(null, opts)).toBe(null);
    expect(await verifyAccessJwt('a.b.c', opts)).toBe(null);
    const t = await sign({ iss: ISS, aud: [AUD], exp, email: 'me@example.com' });
    expect(await verifyAccessJwt(t, { ...opts, aud: '' })).toBe(null);
  });
  it('caches the keys and fetches again for an unknown kid', async () => {
    const t = await sign({ iss: ISS, aud: [AUD], exp, email: 'me@example.com' });
    await verifyAccessJwt(t, opts);
    await verifyAccessJwt(t, opts);
    expect(fetches).toBe(1);
    expect(await verifyAccessJwt(await sign({ iss: ISS, aud: [AUD], exp, email: 'x@y.z' }, { kid: 'k2' }), opts)).toBe(null);
    expect(fetches).toBe(2);
  });
});

describe('accessCookie', () => {
  it('reads the Access token from the cookie header and nothing else', () => {
    expect(accessCookie('theme=dark; CF_Authorization=a.b.c; other=1')).toBe('a.b.c');
    expect(accessCookie('CF_Authorization=x.y.z')).toBe('x.y.z');
    expect(accessCookie('XCF_Authorization=a.b.c')).toBe(null);
    expect(accessCookie('CF_Authorization=')).toBe(null);
    expect(accessCookie(null)).toBe(null);
  });
});
