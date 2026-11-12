// The host's own HTML: the library and the viewer. Pages never run in these documents.
// A page runs only inside the sandboxed iframe, from the /raw or /s/<token>/raw route.

import kitCss from '../../kit/explain.css?raw';
import kitJs from '../../kit/explain.js?raw';

/**
 * A short hash of the kit. Pages and thumbnails are cached for a year, and the host builds both
 * with the current kit, so their URLs carry this hash. A new kit gives new URLs.
 */
export const KIT = (() => {
  let h = 0x811c9dc5;
  const kit = kitCss + kitJs;
  for (let i = 0; i < kit.length; i++) h = Math.imul(h ^ kit.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
})();

export const esc = (s: string | number | null | undefined) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** JSON for a <script type="application/json"> block. */
export const data = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/** "Oct 11" in UTC, for the version list. */
const shortDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// ─── Icons: 24-unit grid, drawn with the current text color ──────────
export const ICON: Record<string, string> = {
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  left: '<path d="M14.5 17 9.5 12l5-5"/>',
  right: '<path d="m9.5 17 5-5-5-5"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.4.4l2.7-2.7a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10.5a4.5 4.5 0 0 0-6.4-.4l-2.7 2.7a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18.5" cy="12" r="1.2" fill="currentColor"/>',
  auto: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3v1.8M12 19.2V21M3 12h1.8M19.2 12H21M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M5.6 18.4l1.3-1.3M17.1 6.9l1.3-1.3"/>',
  moon: '<path d="M20 14.2A8 8 0 0 1 9.8 4a8 8 0 1 0 10.2 10.2Z"/>',
  open: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>',
  x: '<path d="m7 7 10 10M17 7 7 17"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  // Lucide eye (ISC).
  eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M8.5 11H7a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 17 11h-1.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="0.9" fill="currentColor"/><circle cx="4.8" cy="12" r="0.9" fill="currentColor"/><circle cx="4.8" cy="17.5" r="0.9" fill="currentColor"/>',
  pin: '<path d="M9 3.5h6l-.9 6.2 3.4 3.3V15h-11v-2l3.4-3.3z"/><path d="M12 15v5.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5S9.6 5.9 12 3.5Z"/>',
};
export const icon = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

const HOST_CSS = `
html, body { height: 100%; margin: 0; background: var(--bg); color: var(--p); font-family: var(--sans); -webkit-font-smoothing: antialiased; }
:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
:root { --press: #000; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --press: #fff; } }
:root[data-theme="dark"] { --press: #fff; }
button { font-family: var(--sans); }

/* ─── The bar ───────────────────────────────────────────── */
.v { --bar: 44px; display: flex; flex-direction: column; height: 100%; }
.v-bar { position: relative; z-index: 10; flex: none; display: flex; align-items: center; gap: 2px; height: var(--bar); padding: 0 8px 0 6px; border-bottom: 0.5px solid var(--b); background: var(--bg); box-sizing: border-box; }
.v-crumb { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; margin-left: 2px; font-size: 13.5px; line-height: 20px; }
.v-repo { flex: 0 1 auto; max-width: 30%; color: var(--s); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v-slash { color: var(--t); }
.v-title { flex: 0 1 auto; min-width: 0; font-weight: 600; letter-spacing: -0.005em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v-frame { flex: 1; display: block; width: 100%; border: 0; background: var(--bg); }

.v-icon { position: relative; flex: none; display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--s); cursor: pointer; text-decoration: none; }
.v-icon:hover, .v-icon[aria-expanded="true"] { background: var(--bg2); color: var(--p); text-decoration: none; }
svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.v-icon.is-done { color: var(--ink); }

/* The version pill: the one place the version shows. Amber when the reader is not on the latest. */
.v-ver { flex: none; display: inline-flex; align-items: center; gap: 2px; height: 30px; margin-right: 6px; padding: 0 3px; border: 0.5px solid var(--b2); border-radius: 999px; font: 500 12px var(--mono); color: var(--s); }
.v-ver.is-old { background: var(--fill); border-color: var(--line); color: var(--ink); }
.v-step { position: relative; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 999px; color: inherit; }
.v-step:hover { background: var(--bg2); text-decoration: none; }
.v-ver.is-old .v-step:hover { background: color-mix(in srgb, var(--line) 18%, transparent); }
.v-step[aria-disabled="true"] { opacity: 0.3; pointer-events: none; }
.v-step svg { width: 14px; height: 14px; }
.v-cur { display: inline-flex; align-items: center; gap: 2px; height: 22px; padding: 0 4px 0 6px; border: 0; border-radius: 999px; background: transparent; font: inherit; color: inherit; cursor: pointer; }
.v-cur b { font-weight: 600; color: var(--p); }
.v-ver.is-old .v-cur b { color: var(--ink); }
.v-cur:hover, .v-cur[aria-expanded="true"] { background: var(--bg2); }
.v-ver.is-old .v-cur:hover, .v-ver.is-old .v-cur[aria-expanded="true"] { background: color-mix(in srgb, var(--line) 18%, transparent); }
.v-cur svg { width: 12px; height: 12px; opacity: 0.6; margin-left: 2px; }
.v-of { margin-left: 3px; opacity: 0.75; }
.v-item.v-latest { background: var(--fill); color: var(--ink); }
.v-item.v-latest > svg, .v-item.v-latest .v-meta { color: var(--ink); }
.v-item.v-latest:hover { background: color-mix(in srgb, var(--fill) 80%, var(--line)); }

.v-share { flex: none; height: 30px; margin-left: 6px; padding: 0 14px; border: 0; border-radius: 999px; background: var(--p); color: var(--bg); font: 600 13px var(--sans); cursor: pointer; }
.v-share:hover { background: var(--press); }
.v-share svg { display: none; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.v-present { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 30px; margin-left: 6px; padding: 0 12px 0 10px; border: 0.5px solid var(--b2); border-radius: 999px; background: transparent; color: var(--p); font: 600 13px var(--sans); cursor: pointer; }
.v-present:hover { background: var(--bg2); }
.v-present svg { width: 14px; height: 14px; fill: currentColor; stroke: none; }
/* The message page: not found, link revoked. */
.h-empty { display: grid; justify-items: center; gap: 4px; margin: 14vh auto 0; text-align: center; font-size: 13.5px; color: var(--s); }
.h-kind { font: 500 11px var(--mono); color: var(--s); border: 0.5px solid var(--b2); border-radius: 4px; padding: 0 5px; line-height: 16px; }

/* Tooltips: shown after a short pause, never while a menu is open. */
[data-tip]:hover::after, [data-tip]:focus-visible::after { content: attr(data-tip); position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%); z-index: 40; padding: 4px 7px; border-radius: 6px; background: var(--p); color: var(--bg); font: 500 11.5px/1.2 var(--sans); white-space: nowrap; pointer-events: none; animation: v-tip 0.12s 0.4s both; }
[data-tip-end]:hover::after, [data-tip-end]:focus-visible::after { left: auto; right: 0; transform: none; }
[data-tip-start]:hover::after, [data-tip-start]:focus-visible::after { left: 0; transform: none; }
[data-tip][aria-expanded="true"]::after { display: none; }
@keyframes v-tip { from { opacity: 0; } }

/* ─── Menus and popovers ────────────────────────────────── */
.v-pop { position: absolute; top: calc(var(--bar) - 4px); right: 8px; z-index: 30; min-width: 232px; max-width: calc(100vw - 16px); padding: 6px; box-sizing: border-box; background: var(--bg); border: 0.5px solid var(--b2); border-radius: 12px; box-shadow: 0 14px 36px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.06); transform-origin: top right; animation: v-pop 0.14s ease-out; }
.v-pop:not([hidden]) { display: flex; flex-direction: column; gap: 2px; }
.v-pop[hidden] { display: none; }
.v-pop[data-anchor] { position: fixed; }
@keyframes v-pop { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
.v-label { padding: 8px 10px 6px; font: 500 11.5px var(--sans); color: var(--t); }
.v-item { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 34px; padding: 6px 10px; box-sizing: border-box; border: 0; border-radius: 8px; background: transparent; color: var(--p); font: 500 13px var(--sans); text-align: left; text-decoration: none; cursor: pointer; }
.v-item:hover, .v-item:focus-visible { background: var(--bg2); outline: none; text-decoration: none; }
.v-item > svg { color: var(--s); }
.v-item .v-meta { margin-left: auto; font: 12px var(--mono); color: var(--t); white-space: nowrap; }
.v-item.is-danger, .v-item.is-danger > svg { color: var(--line); }
.v-item.is-armed { background: var(--fill); }
.v-hr { height: 0.5px; margin: 6px 4px; background: var(--b); }

.v-item.v-vitem { min-height: 30px; padding: 5px 10px; gap: 8px; }
.v-vitem .v-num { font: 500 12px var(--mono); min-width: 24px; color: var(--s); }
.v-vitem .v-meta { font: 12px var(--sans); color: var(--s); }
.v-vitem .v-tag { padding: 1px 6px; font-size: 10.5px; }
.v-vitem[aria-current="page"] { background: var(--bg2); }
.v-vitem[aria-current="page"] .v-num { font-weight: 600; color: var(--p); }
.v-tag { padding: 2px 7px; border-radius: 999px; background: var(--bg2); font: 500 11px var(--sans); color: var(--s); }

.v-seg { display: flex; gap: 2px; margin: 0 4px 4px; padding: 2px; border-radius: 9px; background: var(--bg2); }
.v-seg button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 8px; border: 0; border-radius: 7px; background: transparent; color: var(--s); font: 500 12.5px var(--sans); cursor: pointer; }
.v-seg button:hover { color: var(--p); }
.v-seg button[aria-pressed="true"] { background: var(--bg); color: var(--p); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.14), 0 0 0 0.5px var(--b); }
.v-seg svg { width: 14px; height: 14px; }

/* Share popover */
.v-sharepop { width: 344px; padding: 14px; }
.v-sharepop h2 { margin: 0; font: 600 14px var(--sans); }
.v-sharepop p { margin: 4px 0 12px; font-size: 12.5px; line-height: 1.45; color: var(--s); }
.v-sharepop .v-seg { margin: 0 0 8px; }
.v-create { width: 100%; height: 34px; border: 0; border-radius: 8px; background: var(--p); color: var(--bg); font: 600 13px var(--sans); cursor: pointer; }
.v-create:hover:not(:disabled) { background: var(--press); }
.v-create:disabled { opacity: 0.5; cursor: default; }
.v-links { list-style: none; margin: 8px 0 0; padding: 0; }
.v-links:empty { display: none; }
.v-links li { display: flex; align-items: center; gap: 4px; height: 36px; padding-left: 2px; border-top: 0.5px solid var(--b); }
.v-links code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px var(--mono); color: var(--s); }
.v-links .v-tag { margin-right: 4px; }
.v-links .v-icon { width: 28px; height: 28px; }
/* Sharing, as in Google Docs: the people you add, each with their own link, then the general access of the page. */
.v-add { display: flex; gap: 6px; margin-top: 12px; }
.v-add .v-create { flex: none; width: auto; height: 32px; padding: 0 14px; }
.v-sharepop .v-hint { margin: 6px 0 0; font-size: 12px; color: var(--t); }
.v-sec { margin: 16px 0 6px; font: 600 12px var(--sans); color: var(--s); }
.v-gen { display: flex; align-items: center; gap: 10px; }
.v-gen-ic { flex: none; display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--bg2); color: var(--s); }
.v-gen-ic svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.v-gen.is-on .v-gen-ic { background: color-mix(in srgb, var(--link) 16%, transparent); color: var(--link); }
.v-gen-t { flex: 1; min-width: 0; font-size: 13px; line-height: 17px; }
.v-gen-t b { display: block; font-weight: 600; }
.v-gen-t span { display: block; font-size: 12px; color: var(--s); }
.v-switch { flex: none; position: relative; width: 34px; height: 20px; padding: 0; border: 0; border-radius: 999px; background: var(--b2); cursor: pointer; }
.v-switch i { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--bg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25); transition: transform 0.15s; }
.v-switch[aria-checked="true"] { background: var(--link); }
.v-switch[aria-checked="true"] i { transform: translateX(14px); }
.v-pubrow { display: flex; align-items: center; gap: 4px; height: 36px; margin-top: 8px; padding-left: 2px; border-top: 0.5px solid var(--b); }
.v-pubrow code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px var(--mono); color: var(--s); }
.v-pubrow .v-icon { width: 28px; height: 28px; }
.v-check { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 13px; cursor: pointer; }
.v-check input { width: 15px; height: 15px; margin: 0; accent-color: var(--link); }
.v-check span { color: var(--t); font-size: 12px; }
.v-lname { display: block; box-sizing: border-box; flex: 1; min-width: 0; width: 100%; height: 32px; margin: 0; padding: 0 10px; border: 0.5px solid var(--b2); border-radius: 8px; background: var(--bg); color: var(--p); font: 13px var(--sans); }
.v-lname::placeholder { color: var(--t); }
.v-links .v-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.v-links .v-icon.is-armed { width: auto; padding: 0 8px; background: var(--fill); color: var(--ink); font: 600 12px var(--sans); }

.v-toast { position: fixed; left: 50%; bottom: 24px; z-index: 50; transform: translateX(-50%); padding: 8px 14px; border-radius: 999px; background: var(--p); color: var(--bg); font: 500 13px var(--sans); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); animation: v-pop 0.16s ease-out; }
.v-toast[hidden] { display: none; }

@media (max-width: 640px) {
  .v-repo, .v-slash, .v-step, #copy, .v-lbl { display: none; }
  /* On a phone, Present and Share show only their icons. */
  .v-present, .v-share { width: 32px; height: 32px; padding: 0; justify-content: center; }
  .v-share { display: inline-flex; align-items: center; }
  .v-share svg { display: block; }
  .v-sharepop { width: calc(100vw - 16px); }
}
@media (prefers-reduced-motion: reduce) {
  .v-pop, .v-toast, [data-tip]:hover::after, [data-tip]:focus-visible::after { animation: none; }
}

`;

export function shell(title: string, nonce: string, body: string, script = '', cssPath = '/_/explain.css') {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="/s/_/favicon.ico?v=2" sizes="32x32">
<link rel="icon" href="/s/_/favicon.svg?v=2" type="image/svg+xml">
<link rel="apple-touch-icon" href="/s/_/apple-touch-icon.png?v=2">
<link rel="stylesheet" href="${cssPath}">
<script nonce="${nonce}">try { const t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch {}</script>
<style>${HOST_CSS}</style>
<body>
${body}
${script ? `<script nonce="${nonce}">${script}</script>` : ''}
</body>
</html>`;
}

export interface PageRow {
  slug: string;
  title: string;
  repo: string | null;
  latest: number;
  /** When the first version was published. */
  created_at: string;
  /** When the newest version was published. */
  updated_at: string;
  /** When the page was pinned, or null. */
  pinned_at: string | null;
  /** The version that has thumbnails, or null. */
  thumb: number | null;
  /** The number of active share links. */
  shared: number;
  /** 'deck' for a slide deck, 'page' otherwise. */
  kind: string;
  /** The folder that holds the page, or null. */
  folder_id: string | null;
}

export interface VersionRow {
  version: number;
  sha: string | null;
  created_at: string;
}

export interface ViewerInput {
  slug: string;
  title: string;
  repo: string | null;
  kind: string;
  version: VersionRow;
  versions: VersionRow[];
  latest: number;
  /** True when the URL names no version, so it follows the latest one. */
  followsLatest: boolean;
}

const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

/** A deck asks for full screen itself (the F key), so its frame allows it. */
const frameAttrs = (kind: string) => `sandbox="${SANDBOX}"${kind === 'deck' ? ' allow="fullscreen"' : ''}`;

/** The Present button and the ⋯ menu items for a deck. */
const presentButton = (kind: string) => (kind === 'deck' ? `<button type="button" class="v-present" id="present" aria-label="Present">${icon('play')}<span class="v-lbl">Present</span></button>` : '');
const pdfItem = (pdf: string) =>
  `<button type="button" class="v-item" data-pdf="${pdf}">${icon('download')}<span>Download PDF</span></button>
    <div class="v-hr"></div>`;

/** The Appearance control and the ⋯ menu items that both viewers share. */
export function appearance() {
  return `<div class="v-label">Appearance</div>
    <div class="v-seg" role="group" aria-label="Appearance">
      <button type="button" data-theme-set="auto">${icon('auto')}Auto</button>
      <button type="button" data-theme-set="light">${icon('sun')}Light</button>
      <button type="button" data-theme-set="dark">${icon('moon')}Dark</button>
    </div>`;
}

/**
 * Popovers, the theme and the toast, for both viewers. One popover is open at a time.
 * A click in the frame does not reach this document, so the window blur event closes them.
 */
export const COMMON_SCRIPT = `
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let open = null;
function closePop(focus) {
  if (!open) return;
  open.pop.hidden = true;
  open.btn.setAttribute('aria-expanded', 'false');
  if (focus) open.btn.focus();
  open = null;
}
function items(pop) { return $$('a[href], button:not(:disabled)', pop).filter((e) => e.offsetParent); }
// A popover with data-anchor opens under its button wherever the button is; the others open under the bar.
function openPop(btn, pop, viaKey) {
  const was = open && open.pop === pop && open.btn === btn;
  closePop();
  if (was) return;
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  if (pop.hasAttribute('data-anchor')) pop.style.top = r.bottom + 4 + 'px';
  pop.style.right = Math.max(8, Math.min(window.innerWidth - r.right, window.innerWidth - pop.offsetWidth - 8)) + 'px';
  btn.setAttribute('aria-expanded', 'true');
  open = { pop, btn };
  pop.dispatchEvent(new Event('open'));
  if (viaKey) items(pop)[0]?.focus();
}
$$('[data-pop]').forEach((btn) => {
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', (e) => { e.stopPropagation(); openPop(btn, document.getElementById(btn.dataset.pop), e.detail === 0); });
});
$$('.v-pop').forEach((pop) => {
  pop.addEventListener('click', (e) => e.stopPropagation());
  pop.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const list = items(pop), i = list.indexOf(document.activeElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    e.preventDefault();
  });
});
document.addEventListener('click', () => closePop());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(true); });
window.addEventListener('blur', () => closePop());
// Capture scrolls on any element: the library scrolls inside .h-scroll, not the window.
document.addEventListener('scroll', () => { if (open && open.pop.hasAttribute('data-anchor')) closePop(); }, { passive: true, capture: true });

const toastEl = $('#toast');
let toastTimer;
function toast(text, duration = 1800) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  if (duration) toastTimer = setTimeout(() => (toastEl.hidden = true), duration);
}

// Fetch in the viewer's authenticated session. Never open a second tab or browser profile.
$$('[data-pdf]').forEach((button) => button.addEventListener('click', async () => {
  button.disabled = true;
  button.querySelector('span').textContent = 'Preparing PDF…';
  closePop();
  toast('Preparing PDF…', 0);
  try {
    const response = await fetch(button.dataset.pdf, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Please try again.');
    if (!(response.headers.get('content-type') || '').includes('application/pdf')) throw new Error('Reload this page to sign in, then try again.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (response.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'page.pdf';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('PDF downloaded');
  } catch (err) {
    toast('PDF download failed: ' + (err.name === 'TimeoutError' ? 'The request timed out. Please try again.' : err.message), 0);
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = 'Download PDF';
  }
}));

// Publish times, in the reader's time zone: "Today, 9:41 PM" or "Oct 9, 9:41 PM".
$$('time[datetime]').forEach((t) => {
  const d = new Date(t.dateTime), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const same = (a, b) => a.toDateString() === b.toDateString();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  t.textContent = (same(d, now) ? 'Today' : same(d, y) ? 'Yesterday' : d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })) + ', ' + time;
  t.title = d.toLocaleString();
});

const frame = $('iframe');
let theme = 'auto';
try { theme = localStorage.getItem('theme') || 'auto'; } catch {}
function applyTheme() {
  if (theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === theme)));
  if (!frame) return;
  // A search result links to /p/<slug>#claim-2. The hash goes to the frame, which scrolls to that claim.
  const src = frame.dataset.src + (theme === 'auto' ? '' : '&theme=' + theme) + location.hash;
  if (frame.getAttribute('src') !== src) frame.src = src;
}

// A deck keeps its slide in the hash. It reports each change, so a reload or a copied link opens the same slide.
const toDeck = (msg) => frame && frame.contentWindow.postMessage({ ns: 'k-deck', v: 1, ...msg }, '*');
addEventListener('message', (e) => {
  if (!frame || e.source !== frame.contentWindow) return;
  const d = e.data;
  if (d && d.ns === 'k-deck' && d.type === 'location' && typeof d.hash === 'string' && /^#[\\w\\-./&=]{0,200}$/.test(d.hash)) history.replaceState(history.state, '', location.pathname + d.hash);
});
$('#present')?.addEventListener('click', async () => {
  try { await frame.requestFullscreen(); } catch {}
  toDeck({ type: 'view', view: 'slide' });
  frame.focus();
});
// The deck hides its sidebar and controls while the frame is full screen.
document.addEventListener('fullscreenchange', () => toDeck({ type: 'present', on: !!frame && document.fullscreenElement === frame }));
$$('[data-theme-set]').forEach((b) => b.addEventListener('click', () => {
  theme = b.dataset.themeSet;
  try { if (theme === 'auto') localStorage.removeItem('theme'); else localStorage.setItem('theme', theme); } catch {}
  applyTheme();
}));
applyTheme();
`;

export function viewerHtml(input: ViewerInput, nonce: string) {
  const { slug, title, repo, version, versions, latest } = input;
  const n = version.version;
  const old = n !== latest;
  const href = (v: number) => (v === latest ? `/p/${esc(slug)}` : `/p/${esc(slug)}/v/${v}`);
  const step = (dir: 'left' | 'right', v: number, label: string) => {
    const ok = versions.some((x) => x.version === v);
    return `<a class="v-step" ${ok ? `href="${href(v)}"` : 'aria-disabled="true"'} aria-label="${label}" data-tip="${label}">${icon(dir)}</a>`;
  };
  const versionItems = versions
    .map(
      (v) => `<a class="v-item v-vitem" href="${href(v.version)}"${v.version === n ? ' aria-current="page"' : ''}>
        <span class="v-num">v${v.version}</span>
        ${v.version === latest ? '<span class="v-tag">Latest</span>' : ''}
        <time class="v-meta" datetime="${esc(v.created_at)}">${esc(shortDay(v.created_at))}</time></a>`,
    )
    .join('');
  const body = `<div class="v">
<header class="v-bar">
  <a class="v-icon" href="/" data-tip="All pages" data-tip-start aria-label="All pages">${icon('grid')}</a>
  <div class="v-crumb">${repo ? `<span class="v-repo">${esc(repo)}</span><span class="v-slash">/</span>` : ''}<span class="v-title">${esc(title)}</span></div>
  <div class="v-ver${old ? ' c-amber is-old' : ''}">
    ${step('left', n - 1, 'Previous version')}
    <button type="button" class="v-cur" data-pop="pop-ver" aria-label="Version ${n} of ${latest}. Show all versions"><b>v${n}</b><span class="v-of">/${latest}</span>${icon('down')}</button>
    ${step('right', n + 1, 'Next version')}
  </div>
  <button type="button" class="v-icon" id="copy" data-tip="Copy link" aria-label="Copy link">${icon('link')}</button>
  <a class="v-icon" href="/p/${esc(slug)}/views" data-tip="Views of the share links" aria-label="Views">${icon('eye')}</a>
  <button type="button" class="v-icon" data-pop="pop-more" data-tip="More" aria-label="More">${icon('more')}</button>
  ${presentButton(input.kind)}
  <button type="button" class="v-share" data-pop="pop-share" aria-label="Share">${icon('share')}<span class="v-lbl">Share</span></button>

  <div class="v-pop" id="pop-ver" hidden>
    ${old ? `<a class="v-item c-amber v-latest" href="/p/${esc(slug)}">${icon('right')}<span>Go to the latest version</span><span class="v-meta">v${latest}</span></a><div class="v-hr"></div>` : ''}
    <div class="v-label">${versions.length} ${versions.length === 1 ? 'version' : 'versions'}</div>
    ${versionItems}
  </div>
  <div class="v-pop" id="pop-more" hidden>
    ${appearance()}
    <div class="v-hr"></div>
    ${pdfItem(`/pdf/${esc(slug)}/${n}`)}
    <a class="v-item" href="/raw/${esc(slug)}/${n}?k=${KIT}" target="_blank" rel="noopener">${icon('open')}Open in new tab</a>
    <a class="v-item" href="/raw/${esc(slug)}/${n}?k=${KIT}" download="${esc(slug.replace('/', '-'))}-v${n}.html">${icon('download')}Download HTML</a>
    <div class="v-hr"></div>
    <button type="button" class="v-item is-danger c-red" id="del">${icon('trash')}<span>Delete page</span></button>
  </div>
  <div class="v-pop v-sharepop" id="pop-share" hidden>
    <h2>Share</h2>
    <form class="v-add" id="add">
      <input class="v-lname" id="pname" type="text" maxlength="80" placeholder="Add a person, for example Dana at Acme" aria-label="Name of the person" autocomplete="off">
      <button type="submit" class="v-create">Add</button>
    </form>
    <p class="v-hint">Each person gets their own link, so Views shows who read the page. Copy the link and send it to them.</p>
    <ul class="v-links" id="people"></ul>
    <div class="v-sec">General access</div>
    <div class="v-gen" id="gen">
      <span class="v-gen-ic" id="gen-ic"></span>
      <span class="v-gen-t"><b id="gen-t"></b><span id="gen-s"></span></span>
      <button type="button" class="v-switch" id="gen-on" role="switch" aria-checked="false" aria-label="Anyone with the link"><i></i></button>
    </div>
    <div id="pub"></div>
    <div class="v-sec">New links point to</div>
    <div class="v-seg" role="group" aria-label="New links point to">
      <button type="button" data-target="latest" aria-pressed="true">Latest version</button>
      <button type="button" data-target="${n}" aria-pressed="false">Only v${n}</button>
    </div>
  </div>
</header>
<iframe class="v-frame" title="${esc(title)}" ${frameAttrs(input.kind)} data-src="/raw/${esc(slug)}/${n}?k=${KIT}"></iframe>
</div>
<div class="v-toast" id="toast" role="status" hidden></div>
<script type="application/json" id="data">${data({ slug, version: n, followsLatest: input.followsLatest, icons: { link: ICON.link, check: ICON.check, x: ICON.x, globe: ICON.globe, lock: ICON.lock } })}</script>`;

  const script =
    COMMON_SCRIPT +
    `
const D = JSON.parse($('#data').textContent);
const svg = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + D.icons[name] + '</svg>';
const api = (path, init = {}) => fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } })
  .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.status === 204 ? null : r.json(); });
const copyText = (text) => navigator.clipboard.writeText(text);

// Copy link: the icon turns into a check for a moment.
$('#copy').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  copyText(location.origin + '/p/' + D.slug + (D.followsLatest ? '' : '/v/' + D.version)).then(() => {
    btn.innerHTML = svg('check'); btn.classList.add('is-done', 'c-green');
    toast('Link copied');
    setTimeout(() => { btn.innerHTML = svg('link'); btn.classList.remove('is-done', 'c-green'); }, 1400);
  });
});

// Delete: the first click arms the item, the second click deletes.
$('#del').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  if (!b.classList.contains('is-armed')) { b.classList.add('is-armed'); b.querySelector('span').textContent = 'Click again to delete every version'; return; }
  try { await api('/api/pages/' + D.slug, { method: 'DELETE' }); location.href = '/'; } catch (err) { toast('Delete failed: ' + err.message); }
});
$('#pop-more').addEventListener('open', () => { const b = $('#del'); b.classList.remove('is-armed'); b.querySelector('span').textContent = 'Delete page'; });

// Sharing, as in Google Docs with DocSend's email gate: the people you add, each with a link of their own,
// then the general access: off, or anyone with the link, with an email first if you want.
let target = 'latest';
$$('[data-target]').forEach((b) => b.addEventListener('click', () => {
  target = b.dataset.target;
  $$('[data-target]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}));
const shareApi = '/api/pages/' + D.slug + '/shares';
const versionOf = () => (target === 'latest' ? 'latest' : +target);
const mk = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
function iconButton(name, label, tip, onclick, end) {
  const b = mk('button', 'v-icon'); b.type = 'button'; b.innerHTML = svg(name); b.setAttribute('aria-label', label); b.dataset.tip = tip;
  if (end) b.dataset.tipEnd = '';
  b.onclick = onclick;
  return b;
}
/** The button that takes a person's link away. The first click arms it, and the second click revokes the link. */
function revokeButton(s) {
  const r = iconButton('x', 'Remove ' + s.name, 'Remove', null, true); r.classList.add('c-red');
  r.onclick = async () => {
    if (!r.classList.contains('is-armed')) { r.classList.add('is-armed'); r.textContent = 'Remove'; delete r.dataset.tip; return; }
    await api('/api/shares/' + s.token, { method: 'DELETE' }); toast('Link for ' + s.name + ' removed'); loadLinks();
  };
  return r;
}
const copyLink = (url, what) => () => copyText(url).then(() => toast(what + ' copied'));
let publics = [];
async function loadLinks() {
  const list = await api(shareApi);
  const people = list.filter((s) => s.kind === 'person');
  publics = list.filter((s) => s.kind !== 'person');
  $('#people').replaceChildren(...people.map((s) => {
    const li = mk('li');
    const nm = mk('span', 'v-nm', s.name); nm.title = s.url;
    li.append(nm);
    if (s.version) li.append(mk('span', 'v-tag', 'v' + s.version));
    li.append(iconButton('link', 'Copy the link for ' + s.name, 'Copy link', copyLink(s.url, 'Link for ' + s.name)), revokeButton(s));
    return li;
  }));
  const on = publics.length > 0, gated = on && publics.every((s) => s.require_email);
  $('#gen').classList.toggle('is-on', on);
  $('#gen-ic').innerHTML = svg(on ? 'globe' : 'lock');
  $('#gen-t').textContent = on ? 'Anyone with the link' : 'Restricted';
  $('#gen-s').textContent = on ? (gated ? 'Anyone with the link can view after they give an email' : 'Anyone on the internet with the link can view') : 'Only the people you add can open this page';
  $('#gen-on').setAttribute('aria-checked', String(on));
  const pub = $('#pub');
  pub.replaceChildren();
  for (const s of publics) {
    const row = mk('div', 'v-pubrow');
    const code = mk('code', '', s.url.replace(/^https?:\\/\\//, '')); code.title = s.url;
    row.append(code);
    if (s.version) row.append(mk('span', 'v-tag', 'v' + s.version));
    row.append(iconButton('link', 'Copy the public link', 'Copy link', copyLink(s.url, 'Link'), true));
    pub.append(row);
  }
  if (on) {
    const lab = mk('label', 'v-check');
    const box = mk('input'); box.type = 'checkbox'; box.checked = gated; box.id = 'gate';
    box.onchange = async () => {
      try {
        await Promise.all(publics.map((s) => api('/api/shares/' + s.token, { method: 'PATCH', body: JSON.stringify({ require_email: box.checked }) })));
        toast(box.checked ? 'Readers give an email first' : 'No email needed');
      } catch (err) { toast('Could not change the link: ' + err.message); }
      loadLinks();
    };
    lab.append(box, document.createTextNode('Require email to view'), mk('span', '', 'Views shows each email'));
    pub.append(lab);
  }
}
$('#pop-share').addEventListener('open', loadLinks);
$('#add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#pname').value.trim();
  if (!name) { $('#pname').focus(); return; }
  try {
    const s = await api(shareApi, { method: 'POST', body: JSON.stringify({ kind: 'person', name, version: versionOf() }) });
    $('#pname').value = '';
    await copyText(s.url).then(() => toast('Link for ' + name + ' copied'), () => toast('Link for ' + name + ' made'));
    await loadLinks();
  } catch (err) { toast('Could not add ' + name + ': ' + err.message); }
});
// General access on makes the public link. Off revokes every public link at once, so nobody keeps an old one.
$('#gen-on').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true;
  try {
    if (publics.length) {
      await Promise.all(publics.map((s) => api('/api/shares/' + s.token, { method: 'DELETE' })));
      toast('Only the people you add can open this page');
    } else {
      const s = await api(shareApi, { method: 'POST', body: JSON.stringify({ kind: 'public', version: versionOf() }) });
      await copyText(s.url).then(() => toast('Public link copied'), () => toast('Public link made'));
    }
    await loadLinks();
  } catch (err) { toast('Could not change the access: ' + err.message); }
  b.disabled = false;
});
`;
  return shell(title, nonce, body, script);
}

/**
 * The reader report of a share link. The host adds it to the page in the frame of the share page.
 * The frame has no origin, so it only reports to the share page, which keeps the time (SHARE_COUNT).
 * It sends the headings of the parts once, the part in the middle of the screen when it changes, and the
 * activity of the reader, at most once a second. A part is a slide of a deck, or a section of a document
 * that starts at an h1 or h2 heading. A document with no heading is one part.
 */
export const READ_REPORTER = String.raw`(() => {
  if (parent === window) return;
  const send = (m) => parent.postMessage({ ns: 'ap-read', ...m }, '*');
  const deck = document.querySelector('main.k-deck');
  const slides = deck ? [...deck.querySelectorAll('.k-slide')] : [];
  const heads = deck ? [] : [...document.querySelectorAll('h1, h2')];
  const text = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '');
  const labels = deck ? slides.map((s, i) => (i + 1) + '. ' + (text(s.querySelector('h1, h2, blockquote')) || 'Slide')) : heads.length ? heads.map(text) : ['The page'];
  function current() {
    const mid = innerHeight / 2;
    if (deck) {
      // A slide that is not on screen has hidden="until-found". It keeps its box, so the box alone does not say which slide shows.
      const i = slides.findIndex((s) => { if (s.hidden) return false; const r = s.getBoundingClientRect(); return r.height > 0 && r.top <= mid && r.bottom >= mid; });
      return i;
    }
    let cur = 0;
    heads.forEach((h, i) => { if (h.getBoundingClientRect().top <= mid) cur = i; });
    return cur;
  }
  let part = -2, told = 0;
  const check = () => { const i = current(); if (i >= 0 && i !== part) { part = i; send({ type: 'part', part }); } };
  send({ type: 'hello', parts: labels });
  check();
  setInterval(check, 500);
  const active = () => { const n = Date.now(); if (n - told < 1000) return; told = n; send({ type: 'active' }); };
  for (const t of ['mousedown', 'mousemove', 'keydown', 'keyup', 'scroll', 'wheel', 'touchstart', 'click']) addEventListener(t, active, { passive: true, capture: true });
})();`;

/**
 * The share page counts the visit for the owner of the page, with Papermark's tracker (lib/tracking):
 * it counts time only while the tab shows and the reader was active in the last 5 minutes, on the part that
 * is on screen. It sends the time every 10 seconds, and with sendBeacon when the tab hides or closes.
 * The visit starts when the page in the frame says hello, so a client that runs no script makes no visit.
 * It keeps no cookie and nothing in the browser.
 */
const SHARE_COUNT = String.raw`
(() => {
  const INTERVAL = 10000, IDLE = 5 * 60000, MIN = 1000;
  const T = location.pathname.split('/')[2], url = (p) => '/s/' + T + '/' + p;
  const frame = $('iframe');
  let id = null, started = false, part = 0, lastActive = Date.now(), lastTick = Date.now(), acc = {}, download = false;
  const visible = () => document.visibilityState === 'visible';
  // Each second adds the time since the last second to the part on screen, while the tab shows and the reader is not idle.
  function tick() {
    const n = Date.now(), dt = Math.min(n - lastTick, 2000);
    lastTick = n;
    if (started && visible() && n - lastActive < IDLE) acc[part] = (acc[part] || 0) + dt;
  }
  function body() {
    tick();
    const total = Object.values(acc).reduce((a, b) => a + b, 0);
    if (!id || (total < MIN && !download)) return null;
    const b = { id, parts: acc, download };
    acc = {}; download = false;
    return JSON.stringify(b);
  }
  function send() { const b = body(); if (b) fetch(url('ping'), { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: b }).catch(() => {}); }
  function beacon() { const b = body(); if (b && !navigator.sendBeacon(url('ping'), new Blob([b], { type: 'application/json' }))) fetch(url('ping'), { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: b }).catch(() => {}); }
  addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d || d.ns !== 'ap-read') return;
    if (d.type === 'hello' && !started) {
      started = true; lastActive = Date.now(); lastTick = Date.now();
      fetch(url('view'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ referrer: document.referrer, parts: d.parts }) })
        .then((r) => (r.ok ? r.json() : null)).then((x) => { if (x && x.id) id = x.id; }).catch(() => {});
    } else if (d.type === 'part' && Number.isInteger(d.part)) { tick(); part = d.part; }
    else if (d.type === 'active') lastActive = Date.now();
  });
  // The reader can use the bar of the share page too. The frame does not see that.
  for (const t of ['mousemove', 'mousedown', 'keydown', 'touchstart']) addEventListener(t, () => { lastActive = Date.now(); }, { passive: true });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-pdf], a[download]')) { download = true; send(); } });
  setInterval(tick, 1000);
  setInterval(send, INTERVAL);
  document.addEventListener('visibilitychange', () => { if (!visible()) beacon(); else { lastTick = Date.now(); lastActive = Date.now(); } });
  addEventListener('pagehide', beacon);
})();
`;

export function sharedHtml(input: { token: string; title: string; repo: string | null; kind: string; version: VersionRow }, nonce: string) {
  const raw = `/s/${esc(input.token)}/raw?k=${KIT}`;
  const body = `<div class="v">
<header class="v-bar">
  <div class="v-crumb"><span class="v-title">${esc(input.title)}</span></div>
  <button type="button" class="v-icon" data-pop="pop-more" data-tip="More" data-tip-end aria-label="More">${icon('more')}</button>
  ${presentButton(input.kind)}
  <div class="v-pop" id="pop-more" hidden>
    ${appearance()}
    <div class="v-hr"></div>
    ${pdfItem(`/s/${esc(input.token)}/pdf`)}
    <a class="v-item" href="${raw}" target="_blank" rel="noopener">${icon('open')}Open in new tab</a>
    <a class="v-item" href="${raw}" download="${esc(input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page')}.html">${icon('download')}Download HTML</a>
  </div>
</header>
<iframe class="v-frame" title="${esc(input.title)}" ${frameAttrs(input.kind)} data-src="${raw}"></iframe>
</div>
<div class="v-toast" id="toast" role="status" hidden></div>`;
  return shell(input.title, nonce, body, COMMON_SCRIPT + SHARE_COUNT, '/s/_/explain.css');
}

/**
 * The email gate of a public link, as DocSend's "Require email to view": the reader gives an email, then the page shows.
 * The host keeps the pass in a cookie for the path of this link only. The page says who sees the email.
 */
export function gateHtml(input: { title: string }, nonce: string) {
  const body = `<style>
.g { display: grid; place-items: center; min-height: 100%; padding: 24px 16px; box-sizing: border-box; }
.g-card { width: 100%; max-width: 380px; }
.g-card h1 { margin: 0 0 6px; font: 600 20px/26px var(--sans); letter-spacing: -0.01em; }
.g-card p { margin: 0 0 18px; font-size: 13.5px; line-height: 20px; color: var(--s); }
.g-card label { display: block; margin-bottom: 6px; font: 500 12.5px var(--sans); color: var(--s); }
.g-card input { display: block; box-sizing: border-box; width: 100%; height: 40px; padding: 0 12px; border: 0.5px solid var(--b2); border-radius: 10px; background: var(--bg); color: var(--p); font: 15px var(--sans); }
.g-card .v-create { height: 40px; margin-top: 10px; border-radius: 10px; font-size: 14px; }
.g-card small { display: block; margin-top: 12px; font-size: 12px; line-height: 17px; color: var(--t); }
.g-err { min-height: 18px; margin-top: 6px; font-size: 12.5px; color: var(--line, #c33); }
</style>
<main class="g"><form class="g-card" id="gate">
  <h1>${esc(input.title)}</h1>
  <p>Enter your email to view this page.</p>
  <label for="email">Email</label>
  <input id="email" type="email" autocomplete="email" required autofocus placeholder="you@company.com">
  <div class="g-err" id="err" role="alert"></div>
  <button type="submit" class="v-create">Continue</button>
  <small>The owner of this page sees your email and how long you read each part.</small>
</form></main>`;
  const script = `
const form = document.getElementById('gate');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = form.querySelector('button'); b.disabled = true;
  const r = await fetch(location.pathname.replace(/\\/$/, '') + '/pass', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: document.getElementById('email').value }) }).catch(() => null);
  if (r && r.ok) { location.reload(); return; }
  document.getElementById('err').textContent = r ? ((await r.json().catch(() => ({}))).error || 'Try again.') : 'The network failed. Try again.';
  b.disabled = false;
});`;
  return shell(input.title, nonce, body, script, '/s/_/explain.css');
}

export function messageHtml(title: string, text: string, nonce: string, cssPath?: string) {
  return shell(title, nonce, `<main class="h-lib"><h1>${esc(title)}</h1><p class="h-empty">${esc(text)}</p></main>`, '', cssPath);
}
