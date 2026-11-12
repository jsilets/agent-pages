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
const data = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/** "Oct 11" in UTC, for the version list. */
const shortDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// ─── Icons: 24-unit grid, drawn with the current text color ──────────
const ICON: Record<string, string> = {
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
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M8.5 11H7a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 17 11h-1.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="0.9" fill="currentColor"/><circle cx="4.8" cy="12" r="0.9" fill="currentColor"/><circle cx="4.8" cy="17.5" r="0.9" fill="currentColor"/>',
  pin: '<path d="M9 3.5h6l-.9 6.2 3.4 3.3V15h-11v-2l3.4-3.3z"/><path d="M12 15v5.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  comment: '<path d="M5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H12l-4.5 3.5V16h-2A1.5 1.5 0 0 1 4 14.5v-8A1.5 1.5 0 0 1 5.5 5Z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5S9.6 5.9 12 3.5Z"/>',
};
const icon = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

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
.v-links { list-style: none; margin: 12px 0 0; padding: 0; }
.v-links:empty::before { content: "No active links."; display: block; padding: 4px 2px; font-size: 12.5px; color: var(--t); }
.v-links li { display: flex; align-items: center; gap: 4px; height: 36px; padding-left: 2px; border-top: 0.5px solid var(--b); }
.v-links code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px var(--mono); color: var(--s); }
.v-links .v-tag { margin-right: 4px; }
.v-links .v-icon { width: 28px; height: 28px; }
.v-links .v-icon.is-armed { width: auto; padding: 0 8px; background: var(--fill); color: var(--ink); font: 600 12px var(--sans); }

/* The comments panel: a column to the right of the page. */
.v-body { flex: 1; min-height: 0; display: flex; }
.v-side { flex: none; display: flex; flex-direction: column; width: 340px; max-width: 100%; box-sizing: border-box; border-left: 0.5px solid var(--b); background: var(--bg); }
.v-side[hidden] { display: none; }
.v-side-head { flex: none; display: flex; align-items: center; justify-content: space-between; height: 40px; padding: 0 6px 0 14px; border-bottom: 0.5px solid var(--b); }
.v-side-head h2 { margin: 0; font: 600 13.5px var(--sans); }
.v-threads { flex: 1; min-height: 0; overflow: auto; padding: 4px 14px; }
.v-threads:empty::before { content: "No open comments."; display: block; padding: 10px 0; font-size: 12.5px; color: var(--t); }
.v-thread { padding: 12px 0; border-bottom: 0.5px solid var(--b); }
.v-cmt { font-size: 13px; line-height: 1.45; }
.v-cmt + .v-cmt { margin: 10px 0 0 10px; padding-left: 10px; border-left: 1.5px solid var(--b2); }
.v-cmt-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; font-size: 12px; color: var(--t); }
.v-cmt-head b { font-weight: 600; color: var(--p); overflow-wrap: anywhere; }
.v-cmt p { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.v-cmt blockquote { margin: 4px 0; padding-left: 8px; border-left: 2px solid var(--b2); color: var(--s); font-size: 12.5px; overflow-wrap: anywhere; }
.v-side textarea, .v-side input { display: block; width: 100%; box-sizing: border-box; padding: 7px 9px; border: 0.5px solid var(--b2); border-radius: 8px; background: var(--bg); color: var(--p); font: 13px/1.4 var(--sans); resize: vertical; }
.v-run { margin: 8px 0 0; font-size: 12px; color: var(--t); }
.v-acts { display: flex; gap: 6px; margin-top: 8px; }
.v-acts textarea { flex: 1; min-width: 0; }
.v-btn { flex: none; align-self: flex-start; height: 30px; padding: 0 10px; border: 0.5px solid var(--b2); border-radius: 8px; background: transparent; color: var(--p); font: 500 12.5px var(--sans); cursor: pointer; }
.v-btn:hover { background: var(--bg2); }
.v-compose { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-top: 0.5px solid var(--b); }
.v-hint { margin: 0; font-size: 11.5px; color: var(--t); }

.v-toast { position: fixed; left: 50%; bottom: 24px; z-index: 50; transform: translateX(-50%); padding: 8px 14px; border-radius: 999px; background: var(--p); color: var(--bg); font: 500 13px var(--sans); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); animation: v-pop 0.16s ease-out; }
.v-toast[hidden] { display: none; }

@media (max-width: 640px) {
  .v-repo, .v-slash, .v-step, #copy, .v-lbl { display: none; }
  /* On a phone, Present and Share show only their icons. */
  .v-present, .v-share { width: 32px; height: 32px; padding: 0; justify-content: center; }
  .v-share { display: inline-flex; align-items: center; }
  .v-share svg { display: block; }
  .v-sharepop { width: calc(100vw - 16px); }
  .v-body { position: relative; }
  .v-side { position: absolute; inset: 0; width: auto; border-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .v-pop, .v-toast, [data-tip]:hover::after, [data-tip]:focus-visible::after { animation: none; }
}

/* ─── Library ───────────────────────────────────────────── */
/* Only the area under the header scrolls, so the scroll bar starts below the header and the header keeps its full width. */
body:has(> .h-bar) { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.h-scroll { flex: 1; min-height: 0; overflow: auto; }
.h-bar { --bar: 44px; flex: none; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 520px) minmax(0, 1fr); gap: 12px; padding: 0 8px 0 16px; }
.h-brand { display: flex; align-items: center; gap: 6px; font: 600 13.5px/20px var(--sans); letter-spacing: -0.005em; }
/* The mark without its tile: drawn in the text colour, so it inverts with the theme. The tile is for tabs and home screens. */
.h-mark { width: 14px; height: 13px; fill: currentColor; stroke: none; }
.h-search { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 9px 0 11px; border-radius: 999px; background: var(--bg2); color: var(--t); cursor: text; }
.h-search:focus-within { background: var(--bg); box-shadow: inset 0 0 0 0.5px var(--b2), 0 0 0 3px color-mix(in srgb, var(--link) 18%, transparent); }
.h-search svg { width: 15px; height: 15px; }
.h-search input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; background: transparent; color: var(--p); font: 500 13.5px var(--sans); outline: none; }
.h-search input::placeholder { color: var(--t); }
.h-search input::-webkit-search-cancel-button { display: none; }
.h-search:focus-within kbd, .h-search.has-q kbd { visibility: hidden; }
kbd { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box; border-radius: 5px; box-shadow: inset 0 0 0 0.5px var(--b2); font: 500 11px var(--mono); color: var(--s); }
.h-tools { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
.h-tools .v-seg { margin: 0 2px 0 0; }
.h-tools .v-seg button { position: relative; flex: none; width: 30px; height: 26px; padding: 0; }
.h-keys { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 7px 12px; margin: 0; padding: 0 10px 8px; font: 12.5px var(--sans); color: var(--s); }
.h-keys dt { display: flex; gap: 3px; }
.h-keys dd { margin: 0; }

.h-main { max-width: 1240px; margin: 0 auto; padding: 18px 24px 72px; }
.h-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 20px; }
.h-chip { height: 28px; padding: 0 12px; border: 0.5px solid var(--b2); border-radius: 999px; background: transparent; color: var(--s); font: 500 12px var(--mono); cursor: pointer; }
.h-chip.is-all { font: 500 12.5px var(--sans); }
.h-chip:hover { background: var(--bg2); color: var(--p); }
.h-chip[aria-pressed="true"] { border-color: var(--p); background: var(--p); color: var(--bg); }
.h-label { display: flex; align-items: center; gap: 6px; margin: 0 0 12px; font: 500 12px var(--sans); color: var(--s); }
.h-label svg { width: 13px; height: 13px; }
.h-grid + .h-label, .h-list + .h-label { margin-top: 34px; }

/* A card: the top of the page, then its title. Each version after the first adds a sheet behind it, up to two. */
.h-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 26px 20px; }
.h-card { position: relative; padding-top: 7px; }
.h-link { display: block; color: inherit; text-decoration: none; outline: none; }
.h-link:hover { text-decoration: none; }
.h-thumb { --ring: var(--b); position: relative; display: grid; place-items: center; aspect-ratio: 16 / 10; overflow: hidden; border-radius: 10px; background: var(--bg2); box-shadow: 0 0 0 0.5px var(--ring); transition: box-shadow 0.15s; }
.h-thumb[data-sheets="1"] { box-shadow: 0 0 0 0.5px var(--ring), 0 -7px 0 -4px var(--bg3), 0 -7px 0 -3.5px var(--b); }
.h-thumb[data-sheets="2"] { box-shadow: 0 0 0 0.5px var(--ring), 0 -7px 0 -4px var(--bg3), 0 -7px 0 -3.5px var(--b), 0 -14px 0 -8px var(--bg3), 0 -14px 0 -7.5px var(--b); }
.h-link:hover .h-thumb { --ring: var(--b2); }
.h-card.is-sel .h-thumb, .h-link:focus-visible .h-thumb { outline: 2px solid var(--link); outline-offset: 2px; }
.h-img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
.h-dark { display: none; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .h-light { display: none; } :root:not([data-theme="light"]) .h-dark { display: block; } }
:root[data-theme="dark"] .h-light { display: none; }
:root[data-theme="dark"] .h-dark { display: block; }
.h-ph { font: 500 20px var(--mono); letter-spacing: -0.04em; color: var(--t); }
.h-title { display: block; min-width: 0; margin-top: 10px; overflow: hidden; font: 600 13.5px/20px var(--sans); letter-spacing: -0.005em; color: var(--p); white-space: nowrap; text-overflow: ellipsis; }
.h-sub { display: flex; align-items: center; gap: 6px; margin-top: 1px; font: 12px/18px var(--sans); color: var(--s); }
.h-sub svg, .h-acc svg { width: 13px; height: 13px; color: var(--t); }
.h-v { margin-left: auto; font: 500 11.5px var(--mono); color: var(--t); }
.h-menu { position: absolute; top: 15px; right: 8px; width: 28px; height: 28px; background: var(--bg); box-shadow: 0 0 0 0.5px var(--b2), 0 2px 6px rgba(0, 0, 0, 0.08); opacity: 0; }
.h-menu:hover, .h-menu[aria-expanded="true"] { background: var(--bg); }
.h-card:hover .h-menu, .h-card.is-sel .h-menu, .h-row:hover .h-menu, .h-row.is-sel .h-menu, .h-menu:focus-visible, .h-menu[aria-expanded="true"] { opacity: 1; }
@media (hover: none) { .h-menu { opacity: 1; } }

/* The list: one row a page. Rows keep a 2px gap, so two hovered rows never touch. */
.h-list { display: flex; flex-direction: column; gap: 2px; }
.h-row { position: relative; }
.h-row .h-link { display: grid; grid-template-columns: 52px minmax(0, 1fr) minmax(0, 240px) 150px 32px 16px; align-items: center; gap: 14px; height: 48px; padding: 0 48px 0 8px; border-radius: 10px; }
.h-row .h-link:hover, .h-row.is-sel .h-link { background: var(--bg2); }
.h-row.is-sel .h-link, .h-hit.is-sel { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--link) 55%, transparent); }
.h-row .h-thumb { border-radius: 5px; }
.h-row .h-ph { font-size: 10px; }
.h-row .h-title { margin: 0; font-weight: 500; }
.h-repo { min-width: 0; overflow: hidden; font: 12px var(--mono); color: var(--s); white-space: nowrap; text-overflow: ellipsis; }
.h-row .h-when { font-size: 12.5px; color: var(--s); white-space: nowrap; }
.h-row .h-v { margin: 0; text-align: right; }
.h-acc { display: grid; place-items: center; }
.h-row .h-menu { top: 10px; background: transparent; box-shadow: none; }
.h-row .h-menu:hover, .h-row .h-menu[aria-expanded="true"] { background: var(--bg3); }

/* Search results: the best match on each page. A click opens the page at that claim. */
.h-hits { display: flex; flex-direction: column; gap: 2px; max-width: 760px; }
.h-hit { display: block; padding: 10px 12px; border-radius: 10px; color: inherit; text-decoration: none; }
.h-hit:hover, .h-hit.is-sel { background: var(--bg2); text-decoration: none; }
.h-hit-head { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.h-hit .h-title { flex: 0 1 auto; margin: 0; }
.h-hit .h-repo { flex: 0 1 auto; }
.h-hit-where { display: block; margin-top: 2px; font: 500 12.5px/18px var(--sans); color: var(--s); }
.h-hit-snip { display: -webkit-box; margin-top: 3px; overflow: hidden; font: 13px/1.5 var(--sans); color: var(--s); -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
mark { padding: 0 1px; border-radius: 3px; background: color-mix(in srgb, var(--link) 20%, transparent); color: var(--p); }
.h-none { margin: 4px 0 0; font-size: 13.5px; color: var(--s); }

.h-empty { display: grid; justify-items: center; gap: 4px; margin: 14vh auto 0; text-align: center; font-size: 13.5px; color: var(--s); }
.h-empty .h-thumb { width: 168px; margin-bottom: 14px; }
.h-empty b { font-weight: 600; color: var(--p); }

@media (max-width: 640px) {
  .h-bar { grid-template-columns: minmax(0, 1fr) auto; padding-left: 8px; }
  .h-brand, .h-search kbd { display: none; }
  .h-main { padding: 14px 14px 56px; }
  .h-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 22px 12px; }
  .h-row .h-link { grid-template-columns: 52px minmax(0, 1fr) 32px; }
  .h-row .h-repo, .h-row .h-when, .h-row .h-acc { display: none; }
}
@media (prefers-reduced-motion: reduce) { .h-thumb { transition: none; } }
`;

function shell(title: string, nonce: string, body: string, script = '', cssPath = '/_/explain.css') {
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
  updated_at: string;
  /** When the page was pinned, or null. */
  pinned_at: string | null;
  /** The version that has thumbnails, or null. */
  thumb: number | null;
  /** The number of active share links. */
  shared: number;
  /** 'deck' for a slide deck, 'page' otherwise. */
  kind: string;
}

/**
 * The library. The script draws it from the JSON block, so the grid or list choice,
 * the repo filter, pins and search results all redraw without a reload.
 */
export function libraryHtml(pages: PageRow[], nonce: string) {
  const body = `<header class="v-bar h-bar">
  <span class="h-brand"><svg class="h-mark" viewBox="24 32 208 192" aria-hidden="true">
    <path opacity="0.3" d="M84 32 H172 A16 16 0 0 1 188 48 V60 H68 V48 A16 16 0 0 1 84 32 Z"/>
    <path opacity="0.55" d="M60 76 H196 A20 20 0 0 1 216 96 V104 H40 V96 A20 20 0 0 1 60 76 Z"/>
    <path fill-rule="evenodd" d="M48 120 H208 A24 24 0 0 1 232 144 V200 A24 24 0 0 1 208 224 H48 A24 24 0 0 1 24 200 V144 A24 24 0 0 1 48 120 Z M64 148 H140 A12 12 0 0 1 140 172 H64 A12 12 0 0 1 64 148 Z"/>
  </svg>Pages</span>
  <label class="h-search">${icon('search')}<input id="q" type="search" placeholder="Search pages" autocomplete="off" spellcheck="false" aria-label="Search pages"><kbd>/</kbd></label>
  <div class="h-tools">
    <div class="v-seg" role="group" aria-label="Layout">
      <button type="button" data-view="grid" aria-label="Grid" data-tip="Grid">${icon('grid')}</button>
      <button type="button" data-view="list" aria-label="List" data-tip="List">${icon('list')}</button>
    </div>
    <button type="button" class="v-icon" data-pop="pop-more" data-tip="More" data-tip-end aria-label="More">${icon('more')}</button>
  </div>
  <div class="v-pop" id="pop-more" hidden>
    ${appearance()}
    <div class="v-hr"></div>
    <div class="v-label">Keyboard</div>
    <dl class="h-keys">
      <dt><kbd>/</kbd></dt><dd>Search</dd>
      <dt><kbd>j</kbd><kbd>k</kbd></dt><dd>Next and previous page</dd>
      <dt><kbd>o</kbd></dt><dd>Open</dd>
      <dt><kbd>c</kbd></dt><dd>Copy link</dd>
      <dt><kbd>p</kbd></dt><dd>Pin or unpin</dd>
    </dl>
  </div>
</header>
<div class="h-scroll"><main class="h-main" id="main"></main></div>
<div class="v-pop" id="pop-card" data-anchor hidden>
  <button type="button" class="v-item" data-act="pin">${icon('pin')}<span>Pin</span></button>
  <button type="button" class="v-item" data-act="copy">${icon('link')}Copy link</button>
  <a class="v-item" data-act="tab" target="_blank" rel="noopener">${icon('open')}Open in new tab</a>
</div>
<div class="v-toast" id="toast" role="status" hidden></div>
<script type="application/json" id="data">${data({ pages, kit: KIT, icons: { more: ICON.more, pin: ICON.pin, lock: ICON.lock, globe: ICON.globe } })}</script>`;

  const script =
    COMMON_SCRIPT +
    `
const D = JSON.parse($('#data').textContent);
const svg = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + D.icons[name] + '</svg>';
const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const repoOf = (p) => p.repo || p.slug.split('/')[0];
const pages = D.pages;
let view = 'grid', repo = '', hits = null, sel = -1, menuSlug = null;
try { view = localStorage.getItem('library-view') === 'list' ? 'list' : 'grid'; } catch {}

// "2h ago" for this week, then the date.
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd ago';
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
const thumb = (p, sheets) => '<span class="h-thumb"' + (sheets ? ' data-sheets="' + sheets + '"' : '') + '>' + (p.thumb
  ? ['light', 'dark'].map((t) => '<img class="h-img h-' + t + '" src="/t/' + p.slug + '/' + p.thumb + '/' + t + '.webp?k=' + D.kit + '" alt="" loading="lazy" decoding="async">').join('')
  : '<span class="h-ph">&lt;/&gt;</span>') + '</span>';
const access = (p) => '<span class="h-acc" title="' + (p.shared ? 'Shared by link' : 'Only you') + '">' + svg(p.shared ? 'globe' : 'lock') + '</span>';
const menu = (p) => '<button type="button" class="v-icon h-menu" aria-label="More for ' + h(p.title) + '" data-tip="More" data-tip-end aria-expanded="false">' + svg('more') + '</button>';
const kind = (p) => p.kind === 'deck' ? '<span class="h-kind">Deck</span>' : '';
const card = (p) => '<article class="h-card" data-slug="' + p.slug + '"><a class="h-link" href="/p/' + p.slug + '">'
  + thumb(p, Math.min(2, p.latest - 1)) + '<span class="h-title">' + h(p.title) + '</span>'
  + '<span class="h-sub">' + access(p) + kind(p) + '<span>Published ' + ago(p.updated_at) + '</span><span class="h-v">v' + p.latest + '</span></span></a>' + menu(p) + '</article>';
const row = (p) => '<article class="h-row" data-slug="' + p.slug + '"><a class="h-link" href="/p/' + p.slug + '">'
  + thumb(p, 0) + '<span class="h-title">' + h(p.title) + ' ' + kind(p) + '</span><span class="h-repo">' + h(repoOf(p)) + '</span>'
  + '<span class="h-when">Published ' + ago(p.updated_at) + '</span><span class="h-v">v' + p.latest + '</span>' + access(p) + '</a>' + menu(p) + '</article>';
const mark = (s) => h(s).replace(/\\u0002/g, '<mark>').replace(/\\u0003/g, '</mark>');
const unmark = (s) => s.replace(/[\\u0002\\u0003]/g, '');
const hitPath = (x) => '/p/' + x.slug + (x.anchor ? '#' + x.anchor : '');
function hit(x) {
  const inTitle = unmark(x.snippet) === x.title;
  return '<a class="h-hit" data-slug="' + x.slug + '" href="' + hitPath(x) + '"><span class="h-hit-head"><span class="h-title">' + (inTitle ? mark(x.snippet) : h(x.title)) + '</span>'
    + '<span class="h-repo">' + h(x.repo || x.slug.split('/')[0]) + '</span></span>'
    + (x.heading ? '<span class="h-hit-where">' + (unmark(x.snippet) === x.heading ? mark(x.snippet) : h(x.heading)) + '</span>' : '')
    + (inTitle || !x.snippet || unmark(x.snippet) === x.heading ? '' : '<span class="h-hit-snip">' + mark(x.snippet) + '</span>') + '</a>';
}

function render() {
  const main = $('#main');
  $$('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  if (hits) {
    main.innerHTML = hits.length
      ? '<div class="h-label">' + hits.length + (hits.length === 1 ? ' page matches' : ' pages match') + '</div><div class="h-hits">' + hits.map(hit).join('') + '</div>'
      : '<p class="h-none">No page has text that matches \\u201c' + h($('#q').value.trim()) + '\\u201d.</p>';
  } else if (!pages.length) {
    main.innerHTML = '<div class="h-empty"><span class="h-thumb"><span class="h-ph">&lt;/&gt;</span></span><b>No pages yet</b><span>Publish one with <code>agent-pages publish &lt;page&gt;</code>.</span></div>';
  } else {
    const repos = [...new Set(pages.map(repoOf))];
    if (!repos.includes(repo)) repo = '';
    const shown = pages.filter((p) => !repo || repoOf(p) === repo);
    const pinned = shown.filter((p) => p.pinned_at).sort((a, b) => b.pinned_at.localeCompare(a.pinned_at));
    const rest = shown.filter((p) => !p.pinned_at);
    const block = (label, list) => (label ? '<div class="h-label">' + label + '</div>' : '') + '<div class="h-' + view + '">' + list.map(view === 'grid' ? card : row).join('') + '</div>';
    main.innerHTML = (repos.length > 1 ? '<div class="h-chips" role="group" aria-label="Repo">' + ['', ...repos].map((r) => '<button type="button" class="h-chip' + (r ? '' : ' is-all') + '" data-repo="' + h(r) + '" aria-pressed="' + (r === repo) + '">' + (r ? h(r) : 'All') + '</button>').join('') + '</div>' : '')
      + (pinned.length ? block(svg('pin') + 'Pinned', pinned) : '') + (rest.length ? block(pinned.length ? 'Recent' : '', rest) : '');
  }
  select(Math.min(sel, entries().length - 1), false);
}
const entries = () => $$('#main [data-slug]');
function select(i, scroll = true) {
  sel = i;
  entries().forEach((el, j) => el.classList.toggle('is-sel', j === i));
  if (scroll && i >= 0) entries()[i].scrollIntoView({ block: 'nearest' });
}
const current = () => entries()[sel];
const pageOf = (slug) => pages.find((p) => p.slug === slug);

$('#main').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-repo]');
  if (chip) { repo = chip.dataset.repo; sel = -1; render(); return; }
  const btn = e.target.closest('.h-menu');
  if (btn) {
    e.preventDefault();
    e.stopPropagation();
    menuSlug = btn.closest('[data-slug]').dataset.slug;
    const p = pageOf(menuSlug), pop = $('#pop-card');
    $('[data-act="pin"] span', pop).textContent = p.pinned_at ? 'Unpin' : 'Pin';
    $('[data-act="tab"]', pop).href = '/p/' + p.slug;
    openPop(btn, pop, e.detail === 0);
  }
});

const copyLink = (slug) => navigator.clipboard.writeText(location.origin + '/p/' + slug).then(() => toast('Link copied'), () => toast('Could not copy the link'));
async function togglePin(slug) {
  const p = pageOf(slug), was = p.pinned_at;
  p.pinned_at = was ? null : new Date().toISOString();
  render();
  toast(was ? 'Unpinned' : 'Pinned');
  const r = await fetch('/api/pages/' + slug + '/pin', { method: was ? 'DELETE' : 'PUT' }).catch(() => null);
  if (!r || !r.ok) { p.pinned_at = was; render(); toast('Could not change the pin'); }
}
$('#pop-card').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !menuSlug) return;
  if (act !== 'tab') closePop();
  if (act === 'pin') togglePin(menuSlug);
  if (act === 'copy') copyLink(menuSlug);
  if (act === 'tab') closePop();
});

$$('[data-view]').forEach((b) => b.addEventListener('click', () => {
  view = b.dataset.view;
  try { localStorage.setItem('library-view', view); } catch {}
  render();
}));

// Search: the host ranks matches with FTS5. A newer request cancels the one before it.
const q = $('#q');
let timer, ctl;
async function runSearch() {
  const text = q.value.trim();
  q.parentElement.classList.toggle('has-q', !!q.value);
  if (ctl) ctl.abort();
  if (!text) { hits = null; sel = -1; render(); return; }
  ctl = new AbortController();
  try {
    const r = await fetch('/api/search?q=' + encodeURIComponent(text), { signal: ctl.signal });
    if (!r.ok) throw new Error(r.statusText);
    hits = await r.json();
    sel = hits.length ? 0 : -1;
    render();
  } catch (err) { if (err.name !== 'AbortError') toast('Search failed'); }
}
q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, 120); });
q.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.stopPropagation(); if (q.value) { q.value = ''; runSearch(); } else q.blur(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); }
  else if (e.key === 'Enter') { e.preventDefault(); const el = current() || entries()[0]; if (el) location.href = el.querySelector('a, [href]')?.href || el.href; }
});

function move(d) {
  const n = entries().length;
  if (n) select(sel < 0 ? (d > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, sel + d)));
}
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); q.focus(); q.select(); } return; }
  if (open || e.target.closest('input, textarea, select, [contenteditable]')) return;
  const el = current(), slug = el && el.dataset.slug;
  if (e.key === '/') { e.preventDefault(); q.focus(); q.select(); }
  else if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if ((e.key === 'o' || e.key === 'Enter') && el) { e.preventDefault(); location.href = (el.matches('a') ? el : el.querySelector('a')).href; }
  else if (e.key === 'c' && slug) copyLink(slug);
  else if (e.key === 'p' && slug && !hits) togglePin(slug);
});

render();
`;
  return shell('Pages', nonce, body, script);
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
function appearance() {
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
const COMMON_SCRIPT = `
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
  <button type="button" class="v-icon" id="cbtn" data-tip="Comments" aria-label="Comments" aria-expanded="false" aria-controls="side">${icon('comment')}</button>
  <button type="button" class="v-icon" id="copy" data-tip="Copy link" aria-label="Copy link">${icon('link')}</button>
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
    <p>Anyone with a link can read this page without signing in. Revoke a link to stop it at once.</p>
    <div class="v-seg" role="group" aria-label="Link points to">
      <button type="button" data-target="latest" aria-pressed="true">Latest version</button>
      <button type="button" data-target="${n}" aria-pressed="false">Only v${n}</button>
    </div>
    <button type="button" class="v-create" id="create">Create link</button>
    <ul class="v-links" id="links"></ul>
  </div>
</header>
<div class="v-body">
<iframe class="v-frame" title="${esc(title)}" ${frameAttrs(input.kind)} data-src="/raw/${esc(slug)}/${n}?k=${KIT}"></iframe>
<aside class="v-side" id="side" aria-label="Comments" hidden>
  <div class="v-side-head"><h2>Comments</h2><button type="button" class="v-icon" id="cclose" aria-label="Close comments">${icon('x')}</button></div>
  <div class="v-threads" id="threads"></div>
  <div class="v-compose">
    <input type="text" id="cquote" maxlength="1000" placeholder="Quote from the page (optional)" aria-label="Quote from the page">
    <textarea id="cbody" rows="3" maxlength="4000" placeholder="Add a comment" aria-label="Comment"></textarea>
    <p class="v-hint">Write @claude or @chatgpt to ask an assistant.</p>
    <button type="button" class="v-create" id="csend">Comment</button>
  </div>
</aside>
</div>
<div class="v-toast" id="toast" role="status" hidden></div>
<script type="application/json" id="data">${data({ slug, version: n, followsLatest: input.followsLatest, icons: { link: ICON.link, check: ICON.check, x: ICON.x } })}</script>`;

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

// Share links
let target = 'latest';
$$('[data-target]').forEach((b) => b.addEventListener('click', () => {
  target = b.dataset.target;
  $$('[data-target]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}));
async function loadLinks() {
  const list = await api('/api/pages/' + D.slug + '/shares');
  const ul = $('#links');
  ul.replaceChildren(...list.map((s) => {
    const li = document.createElement('li');
    const code = document.createElement('code'); code.textContent = s.url.replace(/^https?:\\/\\//, ''); code.title = s.url;
    const tag = document.createElement('span'); tag.className = 'v-tag'; tag.textContent = s.version ? 'v' + s.version : 'Latest';
    const c = document.createElement('button'); c.type = 'button'; c.className = 'v-icon'; c.innerHTML = svg('link'); c.setAttribute('aria-label', 'Copy link'); c.dataset.tip = 'Copy';
    c.onclick = () => copyText(s.url).then(() => toast('Link copied'));
    const r = document.createElement('button'); r.type = 'button'; r.className = 'v-icon c-red'; r.innerHTML = svg('x'); r.setAttribute('aria-label', 'Revoke link'); r.dataset.tip = 'Revoke'; r.dataset.tipEnd = '';
    r.onclick = async () => {
      if (!r.classList.contains('is-armed')) { r.classList.add('is-armed'); r.textContent = 'Revoke'; delete r.dataset.tip; return; }
      await api('/api/shares/' + s.token, { method: 'DELETE' }); toast('Link revoked'); loadLinks();
    };
    li.append(code, tag, c, r);
    return li;
  }));
}
$('#pop-share').addEventListener('open', loadLinks);
$('#create').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true;
  try {
    const s = await api('/api/pages/' + D.slug + '/shares', { method: 'POST', body: JSON.stringify({ version: target === 'latest' ? 'latest' : +target }) });
    await copyText(s.url).then(() => toast('Link created and copied'), () => toast('Link created'));
    await loadLinks();
  } catch (err) { toast('Could not create the link: ' + err.message); }
  b.disabled = false;
});

// Comments: a panel beside the page. Every text goes in with textContent, so a comment never becomes markup.
const side = $('#side'), cbtn = $('#cbtn'), cbody = $('#cbody');
const keep = (k, v) => { try { sessionStorage.setItem(k + D.slug, v); } catch {} };
const kept = (k) => { try { return sessionStorage.getItem(k + D.slug) || ''; } catch { return ''; } };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// The reply drafts, by thread id. A refresh draws the list again, and the drafts go back in.
const drafts = {};
let shown = null;
function comment(c) {
  const d = el('div', 'v-cmt'), head = el('div', 'v-cmt-head');
  head.append(el('b', '', c.author), el('span', '', when(c.created_at)));
  if (c.mention) head.append(el('span', 'v-tag', '@' + c.mention));
  d.append(head);
  if (c.quote) d.append(el('blockquote', '', c.quote));
  d.append(el('p', '', c.body));
  return d;
}
// One line for the latest run of the thread: the assistant works on it, or the run failed. A run that is done shows nothing.
function runLine(r) {
  if (!r || r.status === 'done') return [];
  const off = (r.detail || '').startsWith('not_signed_in');
  const who = r.agent === 'chatgpt' ? 'ChatGPT' : 'Claude';
  const p = el('p', 'v-run', r.status === 'running' ? who + ' is working…' : off ? who + ': not connected' : who + ' did not finish.');
  if (r.status === 'failed' && !off) p.title = r.detail || '';
  return [p];
}
function thread(t) {
  const a = el('article', 'v-thread'), acts = el('div', 'v-acts');
  const box = el('textarea'); box.rows = 1; box.maxLength = 4000; box.placeholder = 'Reply'; box.setAttribute('aria-label', 'Reply'); box.dataset.id = t.id; box.value = drafts[t.id] || '';
  box.oninput = () => { drafts[t.id] = box.value; };
  const send = () => post({ body: box.value, parent_id: t.id }, () => { delete drafts[t.id]; });
  box.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); };
  const reply = el('button', 'v-btn', 'Reply'); reply.type = 'button'; reply.onclick = send;
  const done = el('button', 'v-btn', 'Resolve'); done.type = 'button';
  done.onclick = async () => { try { await api('/api/comments/' + t.id + '/resolve', { method: 'PUT' }); toast('Thread resolved'); await loadComments(); } catch (err) { toast('Could not resolve: ' + err.message); } };
  acts.append(box, reply, done);
  a.append(comment(t), ...t.replies.map(comment), ...runLine(t.run), acts);
  return a;
}
async function loadComments(force) {
  const list = await api('/api/pages/' + D.slug + '/comments?status=open');
  const key = JSON.stringify(list);
  if (key === shown && !force) return;
  shown = key;
  const at = document.activeElement && document.activeElement.dataset.id;
  $('#threads').replaceChildren(...list.map(thread));
  if (at) $$('#threads textarea').find((b) => b.dataset.id === at)?.focus();
}
async function post(c, sent) {
  if (!c.body.trim()) return;
  try { await api('/api/pages/' + D.slug + '/comments', { method: 'POST', body: JSON.stringify(c) }); sent(); await loadComments(true); }
  catch (err) { toast('Could not send the comment: ' + err.message); }
}
function showSide(on) {
  side.hidden = !on;
  cbtn.setAttribute('aria-expanded', String(on));
  keep('comments:', on ? '1' : '');
  if (on) loadComments().catch((err) => toast('Could not load the comments: ' + err.message));
}
cbtn.addEventListener('click', () => showSide(side.hidden));
$('#cclose').addEventListener('click', () => showSide(false));
const sendNew = () => post({ body: cbody.value, quote: $('#cquote').value }, () => { cbody.value = ''; $('#cquote').value = ''; keep('draft:', ''); });
$('#csend').addEventListener('click', sendNew);
cbody.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendNew(); });
cbody.addEventListener('input', () => keep('draft:', cbody.value));
// A new version loads the viewer again. The panel and the comment draft come back from sessionStorage.
cbody.value = kept('draft:');
if (kept('comments:')) showSide(true);

// Every 5 seconds: the open panel loads its threads, and a viewer that follows the latest version asks for the latest number.
// An assistant that answers a comment stores a new version, so the page and the reply show with no reload by hand.
setInterval(async () => {
  if (document.hidden) return;
  try {
    if (!side.hidden) await loadComments();
    if (D.followsLatest && (await api('/api/pages/' + D.slug)).latest !== D.version) location.reload();
  } catch {}
}, 5000);
`;
  return shell(title, nonce, body, script);
}

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
  return shell(input.title, nonce, body, COMMON_SCRIPT, '/s/_/explain.css');
}

export function messageHtml(title: string, text: string, nonce: string, cssPath?: string) {
  return shell(title, nonce, `<main class="h-lib"><h1>${esc(title)}</h1><p class="h-empty">${esc(text)}</p></main>`, '', cssPath);
}
