// MCP Events: an outside assistant subscribes to comment.created through the MCP connector, and the Worker
// POSTs each matching comment to the callback URL of the subscription as a signed webhook.
// The contract is OpenAI's page https://developers.openai.com/plugins/build/mcp-events and the draft it names.
import { isSlug, newId, type Mention } from './lib';
import { RpcError, type Comment, type Env, type Handler } from './types';

export const EVENT = 'comment.created';

/** The lifetime of a subscription when the request has no ttlMs, and the limits on a requested ttlMs. */
const DEFAULT_TTL_MS = 24 * 3600_000;
const MIN_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 30 * 24 * 3600_000;
/** How long one echoed challenge covers the same connector token and callback URL. */
const VERIFY_CACHE_MS = 24 * 3600_000;
/** After a new secret arrives, deliveries carry the signature of the old secret too for this long. */
const ROTATION_MS = 10 * 60_000;
const SEND_TIMEOUT_MS = 10_000;
const RETRY_WAIT_MS = 1000;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_SUBSCRIPTIONS = 100;

// The page names only -32015. The other codes come from the revision of the draft that has -32015.
const INVALID_PARAMS = -32602;
const NOT_FOUND = -32011;
const RESOURCE_EXHAUSTED = -32013;
const UNSUPPORTED = -32014;
const CALLBACK_ENDPOINT_ERROR = -32015;

const text = { type: 'string' } as const;

export const EVENTS = [
  {
    name: EVENT,
    description: 'A person wrote a comment or a reply on a page, and the comment mentions the assistant.',
    delivery: ['webhook'],
    inputSchema: {
      type: 'object',
      properties: {
        slug: { ...text, description: 'Only the comments on this page, <group>/<name>. Default: every page.' },
        mention: { ...text, enum: ['claude', 'chatgpt'], default: 'chatgpt', description: 'Only the comments that mention this assistant, as @claude or @chatgpt.' },
      },
      additionalProperties: false,
    },
    payloadSchema: {
      type: 'object',
      properties: {
        comment_id: { ...text, description: 'Pass it to reply_to_comment and edit_page.' },
        slug: { ...text, description: 'The page the comment is on.' },
        text: { ...text, description: 'The comment, as the person wrote it.' },
        quote: { ...text, description: 'The page text the comment is about. A comment on the whole page has no quote.' },
        author: text,
        url: { ...text, description: 'The page in the viewer.' },
        thread_id: { ...text, description: 'The first comment of the thread. It equals comment_id unless the comment is a reply.' },
      },
      required: ['comment_id', 'slug', 'text', 'author', 'url', 'thread_id'],
      additionalProperties: false,
    },
  },
];

// ─── Pure parts ─────────────────────────────────────────────────────

/** JSON with the keys of each object in sorted order, so two equal values give the same text. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export interface EventArgs {
  slug?: string;
  mention: Mention;
}

/** Checks the subscription arguments against the inputSchema and fills in the default mention. */
export function parseArgs(raw: unknown): EventArgs {
  const bad = (why: string) => new RpcError(INVALID_PARAMS, `arguments: ${why}`);
  if (raw == null) return { mention: 'chatgpt' };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('must be an object');
  const { slug, mention = 'chatgpt', ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length) throw bad(`unknown argument ${Object.keys(rest)[0]}`);
  if (slug !== undefined && (typeof slug !== 'string' || !isSlug(slug))) throw bad('slug must be <group>/<name>');
  if (mention !== 'claude' && mention !== 'chatgpt') throw bad('mention must be claude or chatgpt');
  return slug === undefined ? { mention } : { slug, mention };
}

/** True when the comment is one that a subscription with these arguments gets. */
export const matches = (args: EventArgs, c: Pick<Comment, 'slug' | 'mention'>) => c.mention === args.mention && (args.slug === undefined || args.slug === c.slug);

/** The same token, callback URL, event name and arguments always give the same id. The id is a routing handle, not a secret. */
export async function subscriptionId(token: string, url: string, name: string, args: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson([token, url, name, args])));
  return `sub_${[...new Uint8Array(hash).subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The key bytes of a Standard Webhooks secret: `whsec_` and then base64 of 24 to 64 bytes. Null for any other value. */
export function secretBytes(secret: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return null;
  try {
    const key = Uint8Array.from(atob(secret.slice(6)), (ch) => ch.charCodeAt(0));
    return key.length >= 24 && key.length <= 64 ? key : null;
  } catch {
    return null;
  }
}

/** The webhook-signature header of Standard Webhooks: one `v1,<base64 HMAC-SHA256>` for each secret, with a space between them. */
export async function signature(secrets: string[], id: string, timestamp: number, body: string): Promise<string> {
  const data = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  const out: string[] = [];
  for (const s of secrets) {
    const bytes = secretBytes(s);
    if (!bytes) continue;
    const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    out.push(`v1,${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, data))))}`);
  }
  return out.join(' ');
}

/** True for an IPv4 address that is not a public one: private, loopback, link-local, shared, test, multicast and reserved ranges. */
function privateV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** True for an IPv6 address, as the URL parser writes it, that is public: in 2000::/3 and in none of its special ranges. */
function publicV6(host: string): boolean {
  const [head, tail] = host.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const [first, second] = (tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t]).map((x) => parseInt(x, 16));
  if (first < 0x2000 || first > 0x3fff) return false; // loopback, mapped IPv4, unique local, link-local, multicast
  if (first === 0x2001 && (second < 0x200 || second === 0xdb8)) return false; // protocol assignments, Teredo, documentation
  return first !== 0x2002 && !(first === 0x3fff && second < 0x1000); // 6to4 carries an IPv4 address; 3fff::/20 is documentation
}

/**
 * Why the Worker must not POST to this callback URL, or null when it may. The check covers the scheme, addresses written
 * as numbers and names that stay local. A Worker cannot look a name up, so a public name that resolves to a private
 * address passes here. Development allows http://localhost and http://127.0.0.1 for the local test.
 */
export function checkCallbackUrl(raw: unknown, dev = false): string | null {
  let u: URL;
  try {
    u = new URL(typeof raw === 'string' ? raw : '');
  } catch {
    return 'the callback URL is not a URL';
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (dev && u.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) return null;
  if (u.protocol !== 'https:') return 'the callback URL must use https';
  if (u.username || u.password) return 'the callback URL must not carry a user name or a password';
  const local = 'the callback URL must name a public host';
  if (host.startsWith('[')) return publicV6(host.slice(1, -1)) ? null : local;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return privateV4(+v4[1], +v4[2], +v4[3]) ? local : null;
  // The URL parser turns each number form of an IPv4 address into four numbers, so a name whose last label is a number never gets here.
  if (!host.includes('.') || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return local;
  return null;
}

/** The lifetime the Worker grants for a requested ttlMs. No value is an error: the granted refreshBefore tells the client. */
export function grantTtl(ttlMs: unknown): number {
  if (ttlMs === null) return MAX_TTL_MS; // The client asks for no expiration. The Worker always grants a finite one.
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(ttlMs)));
}

/** The event object for a comment. The comment text is data: the event adds no instructions for the model. */
export function eventFor(c: Comment, origin: string) {
  return {
    eventId: `evt_${c.id}`,
    name: EVENT,
    timestamp: c.created_at,
    data: { comment_id: c.id, slug: c.slug, text: c.body, ...(c.quote ? { quote: c.quote } : {}), author: c.author, url: `${origin}/p/${c.slug}`, thread_id: c.parent_id ?? c.id },
    cursor: null,
  };
}

/** Compares two strings in a time that depends only on their lengths. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── Sending ────────────────────────────────────────────────────────

interface Target {
  id: string;
  url: string;
  secrets: string[];
}

interface Sent {
  /** 'delivered' for a 2xx answer. Else timeout, connection_refused, blocked, or http_3xx, http_4xx, http_5xx. */
  status: string;
  /** The response body of a 2xx answer, when the caller asked for it. */
  text?: string;
}

/** POSTs one signed body to a callback URL. It checks the address each time and follows no redirect. */
async function post(env: Env, to: Target, messageId: string, body: string, read = false): Promise<Sent> {
  if (checkCallbackUrl(to.url, env.ENVIRONMENT === 'development')) return { status: 'blocked' };
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(to.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'webhook-id': messageId,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': await signature(to.secrets, messageId, timestamp, body),
        'x-mcp-subscription-id': to.id,
      },
      body,
    });
    if (!res.ok || !read) await res.body?.cancel();
    return res.ok ? { status: 'delivered', text: read ? (await res.text()).slice(0, 4096) : undefined } : { status: `http_${Math.floor(res.status / 100)}xx` };
  } catch (e) {
    return { status: e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'connection_refused' };
  }
}

/** Sends a fresh challenge to the callback URL. Throws -32015 unless the callback answers 2xx and echoes the challenge. */
async function verifyCallback(env: Env, to: Target): Promise<void> {
  const challenge = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const sent = await post(env, to, `msg_verification_${newId()}`, JSON.stringify({ type: 'verification', challenge }), true);
  let echo: unknown;
  try {
    echo = (JSON.parse(sent.text ?? '') as { challenge?: unknown } | null)?.challenge;
  } catch {}
  if (sent.status === 'delivered' && typeof echo === 'string' && sameText(echo, challenge)) return;
  const reason = ['timeout', 'connection_refused', 'http_4xx', 'http_5xx'].includes(sent.status) ? sent.status : 'challenge_failed';
  throw new RpcError(CALLBACK_ENDPOINT_ERROR, 'CallbackEndpointError: the callback URL did not pass verification', { reason });
}

interface Row {
  id: string;
  arguments: string;
  callback_url: string;
  secret: string;
  prev_secret: string | null;
  prev_secret_until: string | null;
}

/** The subscriptions that are active and match the comment. A subscription stops when it expires, or when its connector token expires or is revoked. */
async function activeSubscriptions(env: Env, comment: Comment, now: string): Promise<Row[]> {
  if (!comment.mention) return [];
  const { results } = await env.DB.prepare(
    'SELECT s.id, s.arguments, s.callback_url, s.secret, s.prev_secret, s.prev_secret_until FROM event_subscriptions s JOIN connector_tokens t ON t.token = s.token WHERE s.event = ?1 AND s.expires_at > ?2 AND (t.expires_at IS NULL OR t.expires_at > ?2)',
  )
    .bind(EVENT, now)
    .all<Row>();
  return results.filter((s) => matches(JSON.parse(s.arguments) as EventArgs, comment));
}

/** True when the comment goes to one active subscription or more. sandbox.ts then starts no run for the same comment. */
export async function hasEventSubscriber(env: Env, comment: Comment): Promise<boolean> {
  return (await activeSubscriptions(env, comment, new Date().toISOString())).length > 0;
}

/**
 * POSTs the comment to each subscription that is active and matches it, and records the result on the subscription.
 * A 5xx answer or a network error gets one retry.
 */
export async function notifyEventSubscribers(env: Env, comment: Comment, origin: string): Promise<void> {
  const now = new Date().toISOString();
  const subs = await activeSubscriptions(env, comment, now);
  if (!subs.length) return;
  const event = eventFor(comment, origin);
  // One serialization: the signature covers these exact bytes.
  const body = JSON.stringify(event);
  if (new TextEncoder().encode(body).length > MAX_EVENT_BYTES) return console.error('event', event.eventId, 'is over 256 KiB');
  await Promise.all(
    subs.map(async (s) => {
      const to: Target = { id: s.id, url: s.callback_url, secrets: s.prev_secret && s.prev_secret_until && s.prev_secret_until > now ? [s.secret, s.prev_secret] : [s.secret] };
      let sent = await post(env, to, event.eventId, body);
      if (['timeout', 'connection_refused', 'http_5xx'].includes(sent.status)) {
        await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
        sent = await post(env, to, event.eventId, body);
      }
      if (sent.status !== 'delivered') console.error('event', event.eventId, s.id, sent.status);
      await env.DB.prepare('UPDATE event_subscriptions SET last_delivery_at = ?, last_status = ? WHERE id = ?').bind(new Date().toISOString(), sent.status, s.id).run();
    }),
  );
}

// ─── JSON-RPC ───────────────────────────────────────────────────────

interface SubscribeParams {
  name?: unknown;
  arguments?: unknown;
  delivery?: { mode?: unknown; url?: unknown; secret?: unknown } | null;
  ttlMs?: unknown;
}

/** The checks that events/subscribe and events/unsubscribe share: the event name, the arguments and the callback URL. */
async function subscriptionKey(env: Env, params: unknown, token: string, origin: string) {
  const p = (params && typeof params === 'object' ? params : {}) as SubscribeParams;
  if (p.name !== EVENT) throw new RpcError(NOT_FOUND, `no such event: ${String(p.name)}`, { kind: 'event' });
  const args = parseArgs(p.arguments);
  const mode = p.delivery?.mode ?? 'webhook';
  if (mode !== 'webhook') throw new RpcError(UNSUPPORTED, `${EVENT} has webhook delivery only`, { feature: 'deliveryMode', value: mode });
  const url = p.delivery?.url;
  const why = checkCallbackUrl(url, env.ENVIRONMENT === 'development') ?? (new URL(url as string).host === new URL(origin).host ? 'the callback URL must not be this host' : null);
  if (why) throw new RpcError(INVALID_PARAMS, why);
  return { p, args, url: url as string, id: await subscriptionId(token, url as string, EVENT, args) };
}

/** Extra JSON-RPC methods of the MCP connector. mcp.ts adds them to its own methods. */
export const eventMethods: Record<string, Handler> = {
  /** The catalog has one event, so the answer has no nextCursor and the method ignores `cursor`. */
  async 'events/list'() {
    return { events: EVENTS };
  },

  /** Creates the subscription, or refreshes the one with the same token, callback URL, event name and arguments. */
  async 'events/subscribe'(env, params, ctx) {
    const { p, args, url, id } = await subscriptionKey(env, params, ctx.token, ctx.origin);
    const secret = p.delivery?.secret;
    if (!secretBytes(secret)) throw new RpcError(INVALID_PARAMS, 'delivery.secret must be whsec_ and then the base64 of 24 to 64 bytes');
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    await env.DB.prepare('DELETE FROM event_subscriptions WHERE expires_at < ?').bind(iso(now - VERIFY_CACHE_MS)).run();
    const mine = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(id = ?2) AS found, MAX(CASE WHEN callback_url = ?3 THEN verified_at END) AS verified_at FROM event_subscriptions WHERE token = ?1')
      .bind(ctx.token, id, url)
      .first<{ n: number; found: number | null; verified_at: string | null }>();
    if (!mine?.found && (mine?.n ?? 0) >= MAX_SUBSCRIPTIONS) throw new RpcError(RESOURCE_EXHAUSTED, `a connector token has at most ${MAX_SUBSCRIPTIONS} subscriptions`, { limit: 'subscriptions', max: MAX_SUBSCRIPTIONS });
    // One echoed challenge covers this token and this callback URL for a day, so a refresh sends no new challenge.
    let verifiedAt = mine?.verified_at && mine.verified_at > iso(now - VERIFY_CACHE_MS) ? mine.verified_at : null;
    if (!verifiedAt) {
      await verifyCallback(env, { id, url, secrets: [secret as string] });
      verifiedAt = iso(now);
    }
    const expires = iso(now + grantTtl(p.ttlMs));
    await env.DB.prepare(
      `INSERT INTO event_subscriptions (id, token, event, arguments, callback_url, secret, verified_at, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (id) DO UPDATE SET
         prev_secret = CASE WHEN secret <> excluded.secret THEN secret ELSE prev_secret END,
         prev_secret_until = CASE WHEN secret <> excluded.secret THEN ?10 ELSE prev_secret_until END,
         secret = excluded.secret, verified_at = excluded.verified_at, expires_at = excluded.expires_at`,
    )
      .bind(id, ctx.token, EVENT, canonicalJson(args), url, secret, verifiedAt, expires, iso(now), iso(now + ROTATION_MS))
      .run();
    // comment.created has no replay, so the cursor is null and the request's cursor has no effect.
    return { id, refreshBefore: expires, cursor: null, truncated: false };
  },

  /** Deletes the subscription. A request for a subscription that does not exist gets the same empty result. */
  async 'events/unsubscribe'(env, params, ctx) {
    const { id } = await subscriptionKey(env, params, ctx.token, ctx.origin);
    await env.DB.prepare('DELETE FROM event_subscriptions WHERE id = ? AND token = ?').bind(id, ctx.token).run();
    return {};
  },
};

/** Extra capabilities for the `initialize` result. mcp.ts merges them into its own. */
export const eventCapabilities: Record<string, unknown> = { events: {} };
