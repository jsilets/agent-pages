// Checks the Cloudflare Access JWT that Access adds to each request it lets through.
// Access at the edge is the first check. This is the second, so a request that reaches
// the Worker by another path still needs a valid token for this application.

export interface Identity {
  /** The email for a person, or the client ID for a service token. */
  who: string;
  kind: 'person' | 'service';
}

interface Jwk extends JsonWebKey {
  kid: string;
}

type FetchKeys = (url: string) => Promise<{ keys: Jwk[] }>;

const cache = new Map<string, { at: number; keys: Jwk[] }>();
const KEY_TTL_MS = 60 * 60 * 1000;

const defaultFetch: FetchKeys = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Access certs returned ${res.status}`);
  return res.json();
};

function b64urlBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function keysFor(issuer: string, kid: string, fetchKeys: FetchKeys): Promise<Jwk | undefined> {
  const hit = cache.get(issuer);
  const fresh = hit && Date.now() - hit.at < KEY_TTL_MS;
  let key = fresh ? hit.keys.find((k) => k.kid === kid) : undefined;
  if (!key) {
    // An unknown kid means Access rotated its keys, so fetch them again.
    const { keys } = await fetchKeys(`${issuer}/cdn-cgi/access/certs`);
    cache.set(issuer, { at: Date.now(), keys });
    key = keys.find((k) => k.kid === kid);
  }
  return key;
}

/**
 * Returns the identity in a valid token, or null. The token must be RS256, signed by
 * the team's current key, not expired, issued by the team, and for this audience.
 */
export async function verifyAccessJwt(
  token: string | null,
  opts: { team: string; aud: string; now?: number; fetchKeys?: FetchKeys },
): Promise<Identity | null> {
  if (!token || !opts.team || !opts.aud) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = b64urlJson(parts[0]);
    const claims = b64urlJson(parts[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    const issuer = `https://${opts.team}.cloudflareaccess.com`;
    const jwk = await keysFor(issuer, header.kid, opts.fetchKeys ?? defaultFetch);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), signed))) return null;
    const now = Math.floor((opts.now ?? Date.now()) / 1000);
    const auds: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !auds.includes(opts.aud)) return null;
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null;
    if (typeof claims.email === 'string' && claims.email) return { who: claims.email, kind: 'person' };
    if (typeof claims.common_name === 'string' && claims.common_name) return { who: claims.common_name, kind: 'service' };
    return null;
  } catch {
    return null;
  }
}

/** Clears the key cache. Tests use it. */
export function clearKeyCache() {
  cache.clear();
}

/**
 * The Access token from the CF_Authorization cookie. A share link skips Access, so its requests carry no
 * Cf-Access-Jwt-Assertion header, but the browser of a person who signed in still sends this cookie.
 */
export function accessCookie(cookie: string | null): string | null {
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'CF_Authorization') return part.slice(i + 1).trim() || null;
  }
  return null;
}
