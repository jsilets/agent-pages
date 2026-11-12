// Views of share links: anonymous counts, the time that a reader spends, and how far they get.
// A share link needs no login, so the host does not know who reads. It keeps no IP address and no name.
// A visitor is a hash of the IP address and the browser with a salt that changes each day, so the host
// can count people for one day and cannot link a visitor across days or recover the address.

/** The longest active time that one view can have. A tab that stays open all day does not count all day. */
export const MAX_ACTIVE_MS = 4 * 3600_000;
/** The most parts (sections or slides) that one view keeps. */
export const MAX_PARTS = 200;
/** A view from the same visitor on the same link within this time continues the view before it. */
export const SESSION_MS = 30 * 60_000;

/** One row of share_views. parts is JSON: for each section or slide, the active milliseconds on it. */
export interface ShareViewRow {
  id: string;
  token: string;
  visitor: string;
  device: string;
  country: string | null;
  referrer: string | null;
  started_at: string;
  last_at: string;
  active_ms: number;
  /** A document: the furthest point read, in percent. A deck: the number of slides reached. */
  depth: number;
  /** A deck: the number of slides. A document: 0. */
  slides: number;
  downloads: number;
  parts: string;
}

// Link previews (Slack, iMessage, WhatsApp and others), search engines and headless browsers do not count.
const BOTS = /bot\b|bot\/|crawler|spider|preview|facebookexternalhit|slackbot|twitterbot|linkedinbot|discordbot|whatsapp|telegrambot|skypeuripreview|embedly|quora link|vkshare|pinterest|headlesschrome|lighthouse|curl\/|wget\/|python-requests|go-http-client|node-fetch|axios\//i;
export const isBot = (ua: string | null) => !ua || BOTS.test(ua);

/** A coarse class of device: phone, tablet or desktop. */
export function deviceOf(ua: string | null): 'phone' | 'tablet' | 'desktop' {
  if (!ua) return 'desktop';
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android/i.test(ua)) return 'phone';
  return 'desktop';
}

/** The host name of the page that linked to the share link, or null for a direct visit or a link from this host. */
export function referrerHost(referrer: unknown, self: string): string | null {
  if (typeof referrer !== 'string' || !referrer) return null;
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    return host && host !== self ? host.slice(0, 100) : null;
  } catch {
    return null;
  }
}

/** The hash that stands for a visitor on one day. The salt is random, and the host deletes it after two days. */
export async function visitorHash(salt: string, ip: string, ua: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${ip}|${ua}`)));
  return [...bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A report from the share page: the active time and the time on each part since the report before it. */
export interface Ping {
  id: string;
  active: number;
  depth: number;
  slides: number;
  download: boolean;
  parts: Record<string, number>;
}

/**
 * Reads a report from the share page. The page is public, so each value is checked and capped.
 * One report can add at most the time since the view last reported, plus a small margin: `maxMs`.
 */
export function cleanPing(body: unknown, maxMs: number): Ping | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(b.id)) return null;
  const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), maxMs) : 0);
  const int = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), max) : 0);
  const parts: Record<string, number> = {};
  if (b.parts && typeof b.parts === 'object') {
    for (const [k, v] of Object.entries(b.parts as Record<string, unknown>).slice(0, 50)) {
      const key = k.replace(/\s+/g, ' ').trim().slice(0, 80);
      const t = ms(v);
      if (key && t) parts[key] = Math.min((parts[key] || 0) + t, maxMs);
    }
  }
  return { id: b.id, active: ms(b.active), depth: int(b.depth, 1000), slides: int(b.slides, 1000), download: b.download === true, parts };
}

/** Adds the time of a report to the parts of a view. A view keeps at most MAX_PARTS parts; a new part past that does not count. */
export function addParts(json: string, add: Record<string, number>): string {
  let parts: Record<string, number> = {};
  try {
    const p = JSON.parse(json);
    if (p && typeof p === 'object') parts = p;
  } catch {}
  for (const [k, v] of Object.entries(add)) {
    if (!(k in parts) && Object.keys(parts).length >= MAX_PARTS) continue;
    parts[k] = Math.min((parts[k] || 0) + v, MAX_ACTIVE_MS);
  }
  return JSON.stringify(parts);
}

export interface LinkStats {
  token: string;
  views: number;
  /** Distinct visitors. A visitor hash changes each day, so one person on two days counts twice. */
  people: number;
  /** The median active time of the views that had any. */
  median_ms: number;
  total_ms: number;
  last_at: string | null;
  downloads: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** How far a view got, as a percent. A deck counts the slides reached against the number of slides. */
export const reach = (v: Pick<ShareViewRow, 'depth' | 'slides'>) => (v.slides ? Math.min(100, Math.round((v.depth / v.slides) * 100)) : Math.min(100, v.depth));

/**
 * The summary for the owner of a page: one line for each link, the time on each part across all views,
 * and the newest views. A part keeps the order in which it first shows in the views, oldest view first,
 * which is the order of the page for most readers.
 */
export function summarize(tokens: string[], rows: ShareViewRow[], recent = 20) {
  const links: LinkStats[] = tokens.map((token) => {
    const mine = rows.filter((r) => r.token === token);
    const timed = mine.map((r) => r.active_ms).filter((t) => t > 0);
    return {
      token,
      views: mine.length,
      people: new Set(mine.map((r) => r.visitor)).size,
      median_ms: median(timed),
      total_ms: timed.reduce((a, b) => a + b, 0),
      last_at: mine.reduce<string | null>((a, r) => (!a || r.last_at > a ? r.last_at : a), null),
      downloads: mine.reduce((a, r) => a + r.downloads, 0),
    };
  });
  const parts = new Map<string, { ms: number; views: number }>();
  for (const r of [...rows].sort((a, b) => a.started_at.localeCompare(b.started_at))) {
    let p: Record<string, number> = {};
    try { p = JSON.parse(r.parts) || {}; } catch {}
    for (const [k, ms] of Object.entries(p)) {
      const cur = parts.get(k) || { ms: 0, views: 0 };
      parts.set(k, { ms: cur.ms + ms, views: cur.views + 1 });
    }
  }
  const newest = [...rows].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, recent)
    .map((r) => ({ token: r.token, started_at: r.started_at, active_ms: r.active_ms, reach: reach(r), device: r.device, country: r.country, referrer: r.referrer, downloads: r.downloads }));
  return { links, parts: [...parts].map(([key, v]) => ({ key, ...v })), recent: newest };
}
