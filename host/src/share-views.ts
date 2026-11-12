// Views of share links, on the model of Papermark (github.com/mfts/papermark) and DocSend.
// One visit is one load of a share link. The share page measures the active time on each part of the page
// (a slide of a deck, a section of a document) and reports it every 10 seconds. Completion is the share of
// the parts that the visit saw. A share link needs no login, so a visit keeps no name and no IP address.

/** Papermark's numbers (lib/tracking/tracking-config.ts): the report interval, the idle limit, and the least time that counts. */
export const TRACKING = { INTERVAL_MS: 10_000, IDLE_MS: 5 * 60_000, MIN_MS: 1000 } as const;
/** The most parts that one page can have. */
export const MAX_PARTS = 200;
/** The longest active time that one visit can have. */
export const MAX_ACTIVE_MS = 4 * 3600_000;

// Link previews (Slack, iMessage, WhatsApp and others), crawlers and headless browsers. The list follows
// Papermark's lib/utils/user-agent.ts. A view also starts only from a script, so a preview that runs no script makes none.
const BOTS = /bot\b|bot\/|crawler|spider|preview|facebookexternalhit|slackbot|twitterbot|linkedinbot|discordbot|whatsapp|telegrambot|skypeuripreview|embedly|quora link|vkshare|pinterest|headlesschrome|lighthouse|curl\/|wget\/|python-requests|go-http-client|node-fetch|axios\//i;
export const isBot = (ua: string | null) => !ua || BOTS.test(ua);

/** A coarse class of device: phone, tablet or desktop. */
export function deviceOf(ua: string | null): 'phone' | 'tablet' | 'desktop' {
  if (!ua) return 'desktop';
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android/i.test(ua)) return 'phone';
  return 'desktop';
}

/** The operating system, or null. */
export function osOf(ua: string | null): string | null {
  if (!ua) return null;
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/android/i.test(ua)) return 'Android';
  if (/cros/i.test(ua)) return 'ChromeOS';
  if (/mac os x|macintosh/i.test(ua)) return 'macOS';
  if (/windows/i.test(ua)) return 'Windows';
  if (/linux/i.test(ua)) return 'Linux';
  return null;
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

/** The headings of the parts of a page, as the share page sends them when a visit starts. */
export function cleanLabels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_PARTS).map((x, i) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, 80) : '') || `Part ${i + 1}`);
}

/** A report of the share page: the active time on each part since the report before it. */
export interface Ping {
  id: string;
  parts: Map<number, number>;
  download: boolean;
}

/**
 * Reads a report. The share page is public, so each value is checked. A report can add at most `maxMs`
 * in all: the time since the visit last reported, and a little more for a slow network. A part past `count` does not count.
 */
export function cleanPing(body: unknown, count: number, maxMs: number): Ping | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(b.id)) return null;
  const parts = new Map<number, number>();
  let left = Math.max(0, maxMs);
  if (b.parts && typeof b.parts === 'object') {
    for (const [k, v] of Object.entries(b.parts as Record<string, unknown>)) {
      const i = Number(k);
      if (!Number.isInteger(i) || i < 0 || i >= Math.max(count, 1) || typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
      const ms = Math.min(Math.round(v), left);
      if (ms <= 0) break;
      parts.set(i, (parts.get(i) || 0) + ms);
      left -= ms;
    }
  }
  return { id: b.id, parts, download: b.download === true };
}

export interface ViewRow {
  id: string;
  token: string;
  visitor: string;
  device: string;
  os: string | null;
  country: string | null;
  referrer: string | null;
  started_at: string;
  last_at: string;
  active_ms: number;
  parts: number;
  downloads: number;
}
export interface PartRow {
  view_id: string;
  part: number;
  label: string;
  ms: number;
}
export interface LinkRow {
  token: string;
  name: string | null;
  version: number | null;
  created_at: string;
  revoked_at: string | null;
}

/** Papermark's completion: the parts that the visit saw for at least the least time, out of all the parts. */
export function completion(seen: PartRow[], count: number) {
  if (!count) return 0;
  return Math.round((100 * new Set(seen.filter((p) => p.ms >= TRACKING.MIN_MS).map((p) => p.part)).size) / count);
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

/**
 * The views of a page for its owner, as DocSend and Papermark show them: the totals, the average time on
 * each part, a line for each link, and each visit with its own time on each part, newest first.
 */
export function summarize(links: LinkRow[], views: ViewRow[], parts: PartRow[]) {
  const byView = new Map<string, PartRow[]>();
  for (const p of parts) (byView.get(p.view_id) ?? byView.set(p.view_id, []).get(p.view_id)!).push(p);
  const visits = [...views].sort((a, b) => b.started_at.localeCompare(a.started_at)).map((v) => {
    const mine = (byView.get(v.id) || []).sort((a, b) => a.part - b.part);
    return {
      id: v.id, token: v.token, started_at: v.started_at, last_at: v.last_at, active_ms: v.active_ms,
      completion: completion(mine, v.parts), device: v.device, os: v.os, country: v.country, referrer: v.referrer, downloads: v.downloads,
      parts: mine.filter((p) => p.ms > 0).map((p) => ({ part: p.part, label: p.label, ms: p.ms })),
    };
  });
  // The average time on each part, over the visits that had any time. A part keeps the label of its newest visit.
  const per = new Map<number, { label: string; ms: number[] }>();
  for (const v of visits) for (const p of v.parts) {
    const cur = per.get(p.part) ?? per.set(p.part, { label: p.label, ms: [] }).get(p.part)!;
    cur.ms.push(p.ms);
  }
  const timed = visits.filter((v) => v.active_ms > 0);
  return {
    totals: {
      views: visits.length,
      visitors: new Set(views.map((v) => v.visitor)).size,
      avg_ms: avg(timed.map((v) => v.active_ms)),
      avg_completion: avg(timed.map((v) => v.completion)),
    },
    parts: [...per].sort((a, b) => a[0] - b[0]).map(([part, x]) => ({ part, label: x.label, avg_ms: avg(x.ms), visits: x.ms.length })),
    links: links.map((l) => {
      const mine = visits.filter((v) => v.token === l.token);
      return { ...l, views: mine.length, last_at: mine[0]?.started_at ?? null };
    }),
    visits,
  };
}
