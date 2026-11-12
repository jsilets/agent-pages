// Pure helpers for the Worker: slugs, page metadata, tokens, route parsing and search text.

export type Theme = 'light' | 'dark';

/** A slug is `<group>/<name>`. Each part is lowercase letters, digits and hyphens. */
const PART = '[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?';
const SLUG_RE = new RegExp(`^${PART}/${PART}$`);

export function isSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

export interface PageMeta {
  title: string;
  repo: string | null;
  sha: string | null;
}

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Reads the title from `<title>`. Reads the repo and the commit from the SNAPSHOT comment
 * ("SNAPSHOT: <repo> at <sha> (<branch>) on <date>"), which agents read and people never see.
 * Pages from before that comment held the commit in the `.k-stamp` line, so that is the fallback.
 */
export function parseMeta(html: string, slug: string): PageMeta {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (t && decode(t[1])) || slug.split('/')[1];
  const isSha = (x: string | undefined) => !!x && /^[0-9a-f]{4,40}$|^no-git$/.test(x);
  const snap = html.match(/<!--\s*SNAPSHOT:\s*(\S+)\s+at\s+(\S+)/);
  if (snap) return { title, repo: snap[1], sha: isSha(snap[2]) ? snap[2] : null };
  const stamp = html.match(/<p class="k-stamp"[^>]*>([\s\S]*?)<\/p>/i);
  if (!stamp) return { title, repo: null, sha: null };
  const [repo, sha] = decode(stamp[1]).split(' · ').map((x) => x.trim());
  return { title, repo: repo || null, sha: isSha(sha) ? sha : null };
}

/** 32 random bytes in base64url: the share token. */
export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isToken(s: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(s);
}

/** A folder id: 12 random bytes in base64url. */
export function newFolderId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
}

export function isFolderId(s: string): boolean {
  return /^[A-Za-z0-9_-]{16}$/.test(s);
}

/** The kit's color ramps. A folder takes one of them, or none. */
export const FOLDER_COLORS = ['blue', 'teal', 'green', 'amber', 'coral', 'pink', 'purple', 'red', 'gray'] as const;
export type FolderColor = (typeof FOLDER_COLORS)[number];
export const isFolderColor = (v: unknown): v is FolderColor => (FOLDER_COLORS as readonly unknown[]).includes(v);

export type Route =
  | { kind: 'library' }
  | { kind: 'view'; slug: string; version: number | null }
  | { kind: 'views-page'; slug: string }
  | { kind: 'raw'; slug: string; version: number }
  | { kind: 'kit-css' }
  | { kind: 'share-css' }
  | { kind: 'icon'; name: IconName }
  | { kind: 'api-list' }
  | { kind: 'api-page'; slug: string }
  | { kind: 'api-shares'; slug: string }
  | { kind: 'api-share'; token: string }
  | { kind: 'api-pin'; slug: string }
  | { kind: 'api-refresh'; slug: string }
  | { kind: 'api-search' }
  | { kind: 'api-folders' }
  | { kind: 'api-folder'; id: string }
  | { kind: 'api-page-folder'; slug: string }
  | { kind: 'api-seen'; slug: string }
  | { kind: 'api-activity' }
  | { kind: 'thumb'; slug: string; version: number; theme: Theme }
  | { kind: 'pdf'; slug: string; version: number }
  | { kind: 'share-view'; token: string }
  | { kind: 'share-raw'; token: string }
  | { kind: 'share-pdf'; token: string }
  | { kind: 'share-start'; token: string }
  | { kind: 'share-ping'; token: string }
  | { kind: 'api-views'; slug: string }
  | { kind: 'not-found' };

const NUM = /^[1-9][0-9]{0,8}$/;

/** The site icons. They sit under /s/_/, which Access lets through, so share links show them too. */
export const ICONS = ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png'] as const;
export type IconName = (typeof ICONS)[number];

/** Maps a path to a route. Every slug is exactly two parts, so the routes never overlap. */
export function route(path: string): Route {
  const p = path.split('/').slice(1);
  const slug = p.length >= 3 ? `${p[1]}/${p[2]}` : '';
  const ok = isSlug(slug);
  if (path === '/') return { kind: 'library' };
  if (path === '/_/explain.css') return { kind: 'kit-css' };
  if (path === '/s/_/explain.css') return { kind: 'share-css' };
  if (path === '/favicon.ico') return { kind: 'icon', name: 'favicon.ico' };
  if (p[0] === 's' && p[1] === '_' && p.length === 3 && (ICONS as readonly string[]).includes(p[2])) return { kind: 'icon', name: p[2] as IconName };
  if (p[0] === 'p' && ok && p.length === 3) return { kind: 'view', slug, version: null };
  if (p[0] === 'p' && ok && p.length === 4 && p[3] === 'views') return { kind: 'views-page', slug };
  if (p[0] === 'p' && ok && p.length === 5 && p[3] === 'v' && NUM.test(p[4])) return { kind: 'view', slug, version: +p[4] };
  if (p[0] === 'raw' && ok && p.length === 4 && NUM.test(p[3])) return { kind: 'raw', slug, version: +p[3] };
  if (p[0] === 'pdf' && ok && p.length === 4 && NUM.test(p[3])) return { kind: 'pdf', slug, version: +p[3] };
  if (p[0] === 't' && ok && p.length === 5 && NUM.test(p[3]) && (p[4] === 'light.webp' || p[4] === 'dark.webp')) return { kind: 'thumb', slug, version: +p[3], theme: p[4] === 'light.webp' ? 'light' : 'dark' };
  if (path === '/api/search') return { kind: 'api-search' };
  if (path === '/api/activity') return { kind: 'api-activity' };
  if (path === '/api/folders') return { kind: 'api-folders' };
  if (p[0] === 'api' && p[1] === 'folders' && p.length === 3 && isFolderId(p[2])) return { kind: 'api-folder', id: p[2] };
  if (p[0] === 'api' && p[1] === 'pages') {
    const s = p.length >= 4 ? `${p[2]}/${p[3]}` : '';
    if (p.length === 2) return { kind: 'api-list' };
    if (isSlug(s) && p.length === 4) return { kind: 'api-page', slug: s };
    if (isSlug(s) && p.length === 5 && p[4] === 'shares') return { kind: 'api-shares', slug: s };
    if (isSlug(s) && p.length === 5 && p[4] === 'pin') return { kind: 'api-pin', slug: s };
    if (isSlug(s) && p.length === 5 && p[4] === 'refresh') return { kind: 'api-refresh', slug: s };
    if (isSlug(s) && p.length === 5 && p[4] === 'folder') return { kind: 'api-page-folder', slug: s };
    if (isSlug(s) && p.length === 5 && p[4] === 'seen') return { kind: 'api-seen', slug: s };
    if (isSlug(s) && p.length === 5 && p[4] === 'views') return { kind: 'api-views', slug: s };
  }
  if (p[0] === 'api' && p[1] === 'shares' && p.length === 3 && isToken(p[2])) return { kind: 'api-share', token: p[2] };
  if (p[0] === 's' && p.length === 2 && isToken(p[1])) return { kind: 'share-view', token: p[1] };
  if (p[0] === 's' && p.length === 3 && isToken(p[1]) && p[2] === 'raw') return { kind: 'share-raw', token: p[1] };
  if (p[0] === 's' && p.length === 3 && isToken(p[1]) && p[2] === 'pdf') return { kind: 'share-pdf', token: p[1] };
  if (p[0] === 's' && p.length === 3 && isToken(p[1]) && p[2] === 'view') return { kind: 'share-start', token: p[1] };
  if (p[0] === 's' && p.length === 3 && isToken(p[1]) && p[2] === 'ping') return { kind: 'share-ping', token: p[1] };
  return { kind: 'not-found' };
}

/** The R2 key of one stored version. */
export const blobKey = (slug: string, version: number) => `pages/${slug}/${version}.html`;


/** The R2 key of a deck's PDF. The kit hash is in the key, because a new kit draws the slides again. */
export const pdfKey = (slug: string, version: number, kit: string) => `pages/${slug}/${version}.${kit}.pdf`;

/** The R2 key of one thumbnail. It sits under the page's prefix, so deleting the page deletes it. */
export const thumbKey = (slug: string, version: number, theme: Theme) => `pages/${slug}/${version}.${theme}.webp`;

export const parseTheme = (v: string | null): Theme | null => (v === 'light' || v === 'dark' ? v : null);

/** Sets data-theme on the page's <html> tag, so the kit draws that theme whatever the OS uses. */
export function withTheme(html: string, theme: Theme): string {
  return html.replace(/<html\b([^>]*)>/i, (_, attrs: string) => `<html${attrs.replace(/\s+data-theme\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, '')} data-theme="${theme}">`);
}

/**
 * A packed page carries the kit CSS and JS from the day it was published. This swaps in the current kit,
 * so old pages and their thumbnails show the current look and drawing. A page without the packed kit is unchanged.
 * The JS swap is optional, so a caller can pass the CSS alone.
 */
export function withKit(html: string, css: string, js?: string): string {
  const start = html.indexOf('<style>\n/* explain.css');
  const end = start < 0 ? -1 : html.indexOf('</style>', start);
  if (end >= 0) html = html.slice(0, start) + '<style>\n' + css + '\n' + html.slice(end);
  if (js == null) return html;
  // cli/agent-pages.mjs packs the JS as <script>\n/* explain.js…</script>, with each "</script" escaped inside it.
  const js0 = html.indexOf('<script>\n/* explain.js');
  const js1 = js0 < 0 ? -1 : html.indexOf('</script>', js0);
  return js1 < 0 ? html : html.slice(0, js0) + '<script>\n' + js.replace(/<\/script/gi, '<\\/script') + '\n' + html.slice(js1);
}

// ─── Search ─────────────────────────────────────────────────────────

/**
 * Turns what the reader typed into an FTS5 query: every word must match, and the last
 * letters of each word may be missing ("legis" finds "legislation"). Returns null when no word is left.
 */
export function ftsQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length ? words.slice(0, 8).map((w) => `"${w}"*`).join(' ') : null;
}

/** One searchable part of a page: the text before the first claim, or one claim. */
export interface Chunk {
  /** The id of the claim's <section>, or '' for the text before the first claim. */
  anchor: string;
  heading: string;
  body: string;
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←' };

/** The visible text of an HTML fragment, on one line. */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENTITY[e.toLowerCase()] ?? m),
    )
    .replace(/\s+/g, ' ')
    .trim();
}

const CLAIM_RE = /<section\b([^>]*\bclass\s*=\s*(["'])(?:(?!\2).)*\bk-claim\b(?:(?!\2).)*\2[^>]*)>/gi;

/** The id the host gives the claim at this position when the page sets none. The raw route adds the same ids. */
export const claimId = (n: number) => `claim-${n}`;

/**
 * Splits a page into the text before the first claim and one chunk per `.k-claim` section.
 * A claim keeps its own id; a claim with no id gets claimId(n), as the raw route adds it.
 */
export function pageChunks(html: string): Chunk[] {
  const body = html.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/^[\s\S]*?<body\b[^>]*>/i, '');
  const starts = [...body.matchAll(CLAIM_RE)];
  const chunks: Chunk[] = [];
  const head = plainText(body.slice(0, starts[0]?.index ?? body.length));
  if (head) chunks.push({ anchor: '', heading: '', body: head.slice(0, 20000) });
  starts.forEach((m, i) => {
    const part = body.slice(m.index!, starts[i + 1]?.index ?? body.length);
    const id = m[1].match(/\bid\s*=\s*(["'])([^"']+)\1/i)?.[2] ?? claimId(i + 1);
    const h = part.match(/<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/i);
    const heading = h ? plainText(h[1]) : '';
    const rest = plainText(h ? part.replace(h[0], ' ') : part);
    chunks.push({ anchor: id, heading, body: rest.slice(0, 20000) });
  });
  return chunks;
}

// ─── Decks ──────────────────────────────────────────────────────────

export type PageKind = 'page' | 'deck';

/** A deck is a page whose HTML has <main class="k-deck">. */
export function pageKind(html: string): PageKind {
  // Packed kit scripts contain example <main> markup. Only inspect document markup.
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style|template|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const mains = markup.match(/<main\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? [];
  return mains.some((tag) => {
    const attrs = tag.matchAll(/\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g);
    return [...attrs].some(([, name, double, single, bare]) =>
      name.toLowerCase() === 'class' && (double ?? single ?? bare ?? '').split(/\s+/).includes('k-deck'));
  }) ? 'deck' : 'page';
}

/** One slide in the report that the kit's audit writes to the JSON block with the id k-deck-report. */
export interface SlideAudit {
  id: string;
  n: number;
  layout: string;
  /** How far the content runs past the canvas, in canvas pixels. */
  y: number;
  x: number;
  /** Paths of the boxes that hide part of their own content. */
  clip: string[];
  /** Paths of the text under the minimum size. */
  tiny: string[];
  fail: boolean;
}
export interface DeckAudit {
  pass: boolean;
  slides: SlideAudit[];
}

/** Reads the deck report from the rendered HTML that Browser Rendering returns. Returns null when the page wrote none. */
export function auditFromHtml(html: string): DeckAudit | null {
  // The last match: the runtime appends the block to <body>, after any inlined kit script.
  const m = [...html.matchAll(/<script\b(?=[^>]*\btype="application\/json")[^>]*\bid="k-deck-report"[^>]*>([\s\S]*?)<\/script>/g)].pop();
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]) as DeckAudit;
    return Array.isArray(r.slides) ? { pass: !!r.pass, slides: r.slides } : null;
  } catch {
    return null;
  }
}

/** The fix for an overflow of this many canvas pixels. */
export function overflowFix(px: number): string {
  if (px <= 40) return 'move elements a little';
  if (px <= 90) return 'make the gaps smaller';
  if (px <= 160) return 'make a title or paragraph smaller';
  return 'change the layout or split the slide';
}

/** One line for each problem slide, for the publish output. */
export function auditLines(a: DeckAudit): string[] {
  return a.slides.flatMap((s) => {
    const out: string[] = [];
    const at = `slide ${s.n} (#${s.id})`;
    if (s.y > 1) out.push(`${at}: the content is ${s.y}px taller than the slide. Fix: ${overflowFix(s.y)}`);
    if (s.x > 1) out.push(`${at}: the content is ${s.x}px wider than the slide`);
    s.clip.forEach((c) => out.push(`${at}: a box hides part of its content: ${c}`));
    if (s.tiny.length) out.push(`${at}: ${s.tiny.length} text ${s.tiny.length === 1 ? 'element is' : 'elements are'} under the minimum size, first: ${s.tiny[0]}`);
    return out;
  });
}
