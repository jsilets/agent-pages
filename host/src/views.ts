// The host's own HTML: the library and the viewer. Pages never run in these documents.
// A page runs only inside the sandboxed iframe, from the /raw or /s/<token>/raw route.

import kitCss from '../../kit/explain.css?raw';
import kitJs from '../../kit/explain.js?raw';
import assistantsJs from './assistants-ui.js?raw';
import marginJs from './margin.js?raw';

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
  thumb: '<path d="M7.5 10.5V20"/><path d="M14.3 6.3 13.5 10.5h4.9a1.8 1.8 0 0 1 1.75 2.2l-1.3 5.6A2.2 2.2 0 0 1 16.7 20H5.5A1.5 1.5 0 0 1 4 18.5V12a1.5 1.5 0 0 1 1.5-1.5h2l3.2-6.2a.8.8 0 0 1 .7-.4 2.3 2.3 0 0 1 2.9 2.4Z"/>',
  spark: '<path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5Z"/><path d="M18.5 15.5c.2 1.4.9 2.1 2.3 2.3-1.4.2-2.1.9-2.3 2.3-.2-1.4-.9-2.1-2.3-2.3 1.4-.2 2.1-.9 2.3-2.3Z"/>',
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

/* ─── The view: one scroller under the bar ───────────────────
   The frame of a page is as tall as the page, so the page does not scroll itself. The scroller holds the frame and the
   margin side by side, and its scroll bar is the only one, at the right edge of the window, under the bar. A deck frame is
   as tall as the view and sticks to its top. margin.js sets the height of the frame. */
.v-scroll { position: relative; flex: 1; min-height: 0; overflow: hidden auto; overscroll-behavior-y: contain; background: var(--bg); }
.v-body { position: relative; display: flex; justify-content: center; min-height: 100%; }
.v-stage { position: relative; flex: 1; min-width: 0; }
.v-stage > .v-frame { display: block; width: 100%; height: 100%; border: 0; background: var(--bg); }
.v-body[data-kind="deck"] .v-stage > .v-frame, .v-stage > .v-frame.is-self { position: sticky; top: 0; }
.v-stage > .v-frame.is-in { position: absolute; top: 0; left: 0; z-index: 1; opacity: 0; pointer-events: none; }
.v-body[data-kind="deck"] .v-stage > .v-frame.is-in { top: var(--st, 0); }
.v-stage > .v-frame.is-in.is-on { opacity: 1; transition: opacity 0.24s ease; }

/* ─── Comments: cards in the margin, aligned with their text in the page ───
   wide: a column of cards beside the page. mid: a thin column of markers, and the open card floats beside its marker.
   narrow: a thin gutter of markers, and the open card in a sheet at the bottom. margin.js sets --y in page pixels. */
.v-btn:disabled { opacity: 0.5; cursor: default; }
.cm-col { --cm-w: 316px; position: relative; z-index: 4; flex: none; width: var(--cm-w); box-sizing: border-box; }
.cm-col[hidden] { display: none; }
.v-body[data-cm="mid"] .cm-col { --cm-w: 40px; border-left: 0.5px solid var(--b); }
.v-body[data-cm="narrow"] .cm-col { --cm-w: 30px; }
.cm-ro { margin: 12px 16px 0 12px; padding: 8px 10px; border-radius: 8px; background: var(--bg2); color: var(--s); font-size: 12px; line-height: 1.45; }
.cm-ro a { font-weight: 600; }
.v-body:not([data-cm="wide"]) .cm-ro { display: none; }
.cm-pins { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px 0 12px; }
.cm-pins:empty { padding: 0; }
.v-body:not([data-cm="wide"]) .cm-pins { align-items: center; gap: 4px; padding: 8px 0 0; }
.v-body:not([data-cm="wide"]) .cm-pins:empty { padding: 0; }
.cm-rail { position: absolute; inset: 0; }

/* A card: the quiet form until it opens, like the comments of Google Docs. The open card is raised and moves toward the page. */
.cm-card { position: relative; box-sizing: border-box; padding: 10px 12px 12px; border-radius: 10px; background: color-mix(in srgb, var(--bg2) 70%, var(--bg)); box-shadow: 0 0 0 0.5px var(--b); color: var(--p); font-size: 13px; line-height: 1.5; cursor: pointer; outline-offset: 2px; transition: background-color 0.15s, box-shadow 0.15s; }
.cm-rail > .cm-card { position: absolute; top: 0; left: 12px; right: 16px; transform: translate3d(0, var(--y, 0), 0); transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), background-color 0.15s, box-shadow 0.15s; }
.cm-rail > .is-in { transition: none !important; }
.cm-card.is-hover:not(.is-active) { background: var(--bg2); box-shadow: 0 0 0 0.5px var(--b2); }
.cm-card.is-active { z-index: 2; cursor: default; background: var(--bg); box-shadow: 0 0 0 0.5px var(--b), 0 6px 20px rgba(0, 0, 0, 0.12), 0 1px 4px rgba(0, 0, 0, 0.06); }
.v-body[data-cm="wide"] .cm-rail > .cm-card.is-active { transform: translate3d(-14px, var(--y, 0), 0); }
.cm-card.has-new:not(.is-active) { box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--link) 55%, transparent); }
.cm-list { display: flex; flex-direction: column; gap: 12px; }
.cm-c { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 10px; }
.cm-c.is-new { animation: cm-in 0.42s cubic-bezier(0.2, 0.8, 0.2, 1); }
@keyframes cm-in { from { opacity: 0; transform: translateY(6px); } }
.cm-ava { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--bg3); box-shadow: inset 0 0 0 0.5px var(--b); color: var(--s); font: 600 11px/1 var(--sans); letter-spacing: 0.02em; }
.cm-ava.is-agent { background: var(--a); color: var(--a-on); box-shadow: none; }
.cm-main { min-width: 0; }
.cm-head { display: flex; align-items: flex-start; gap: 4px; min-height: 28px; }
.cm-names { flex: 1; min-width: 0; display: flex; flex-direction: column; padding-top: 0; }
.cm-names b { overflow: hidden; font-weight: 600; font-size: 13px; line-height: 16px; white-space: nowrap; text-overflow: ellipsis; }
.cm-names time { font-size: 11.5px; line-height: 15px; color: var(--t); white-space: nowrap; }
/* The first comment keeps room for the resolve button in the corner. */
.cm-list > .cm-c:first-of-type .cm-head, .cm-list > .cm-quote + .cm-c .cm-head { padding-right: 30px; }
.cm-body { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px; line-height: 1.5; }
.cm-card:not(.is-active) .cm-body { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.cm-at { color: var(--link); font-weight: 600; }
.cm-quote { display: flex; flex-direction: column; gap: 3px; padding: 1px 0 1px 9px; border-left: 2.5px solid rgba(229, 168, 35, 0.8); color: var(--s); font-size: 12px; line-height: 1.4; }
.cm-quote q { display: -webkit-box; overflow: hidden; overflow-wrap: anywhere; -webkit-line-clamp: 2; -webkit-box-orient: vertical; quotes: none; }
.cm-card.is-active .cm-quote q { -webkit-line-clamp: 6; }
/* Beside the page, the mark in the page shows the quote. A card shows it only when the text changed. */
.v-body[data-cm="wide"] .cm-rail .cm-quote:not(.is-changed):not(.is-off) { display: none; }
.cm-quote.is-changed { border-left-color: var(--b2); }
.cm-quote.is-changed q { text-decoration: line-through; text-decoration-color: var(--t); }
.cm-flag { align-self: flex-start; padding: 0 6px; border-radius: 4px; background: var(--bg2); color: var(--s); font: 600 10.5px/17px var(--sans); }
.cm-quote.is-off q::after { content: " · not on this slide"; color: var(--t); }
.cm-more { display: flex; flex-direction: column; gap: 1px; padding-left: 38px; font-size: 12px; }
.cm-more.is-new { animation: cm-in 0.42s cubic-bezier(0.2, 0.8, 0.2, 1); }
.cm-n { color: var(--link); font-weight: 600; }
.cm-last { overflow: hidden; color: var(--s); white-space: nowrap; text-overflow: ellipsis; }
.cm-list .v-react, .cm-list .v-runfail { margin-top: 6px; }
.cm-done { position: absolute; top: 9px; right: 8px; width: 28px; height: 28px; opacity: 0; }
.cm-menu { flex: none; width: 26px; height: 26px; margin: -1px -4px 0 0; opacity: 0; }
.cm-card:hover :is(.cm-done, .cm-menu), .cm-card.is-active :is(.cm-done, .cm-menu), :is(.cm-done, .cm-menu):focus-visible, .cm-menu[aria-expanded="true"] { opacity: 1; }
@media (hover: none) { .cm-done, .cm-menu { opacity: 1; } }
.cm-foot { position: relative; margin-top: 12px; }
.cm-card:not(.is-active) .cm-foot { display: none; }
.cm-foot:not(.has-text):not(.has-focus) .cm-acts { display: none; }
.cm-card textarea { display: block; width: 100%; min-height: 34px; box-sizing: border-box; margin: 0; padding: 7px 12px; border: 0.5px solid var(--b2); border-radius: 17px; background: var(--bg); color: var(--p); font: 13px/1.45 var(--sans); resize: none; overflow-y: hidden; }
.cm-card textarea.cm-edit { margin-top: 6px; border-radius: 10px; }
.cm-card textarea::placeholder { color: var(--t); }
.cm-card textarea:focus { outline: none; border-color: var(--link); box-shadow: 0 0 0 3px color-mix(in srgb, var(--link) 18%, transparent); }
.cm-acts { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 8px; }
.cm-acts .v-btn { height: 28px; align-self: auto; border-color: transparent; border-radius: 999px; padding: 0 12px; }
.cm-acts .v-create { width: auto; height: 28px; padding: 0 14px; border-radius: 999px; }
.cm-hint { margin-right: auto; font: 500 11px var(--sans); color: var(--t); }
.cm-card.is-compose { cursor: default; background: var(--bg); }
.cm-card.is-compose .cm-main { position: relative; display: flex; flex-direction: column; gap: 8px; }
.cm-card.is-compose .cm-head { min-height: 28px; align-items: center; }
.cm-card.is-compose .cm-quote:empty { display: none; }
/* The assistants that "@" offers. */
.cm-pick { position: absolute; z-index: 5; left: 0; right: 0; top: calc(100% + 4px); padding: 4px; border: 0.5px solid var(--b2); border-radius: 10px; background: var(--bg); box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16); animation: v-pop 0.12s ease-out; }
.cm-opt { display: grid; grid-template-columns: 22px auto 1fr; grid-template-rows: auto auto; column-gap: 8px; align-items: center; padding: 5px 8px; border-radius: 7px; cursor: pointer; }
.cm-opt .cm-ava { grid-row: span 2; width: 22px; height: 22px; background: var(--a); color: var(--a-on); box-shadow: none; }
.cm-opt b { font-size: 12.5px; }
.cm-opt .cm-at { font: 500 11.5px var(--mono); color: var(--t); }
.cm-opt .cm-state { grid-column: 2 / 4; font-size: 11px; color: var(--s); }
.cm-opt .cm-state:empty { display: none; }
.cm-opt .cm-state.is-off { color: var(--line, #993C1D); }
.cm-opt.is-settings { grid-template-columns: 22px 1fr; margin-top: 2px; border-top: 0.5px solid var(--b); border-radius: 0 0 7px 7px; padding-top: 7px; }
.cm-opt.is-settings b { font-weight: 500; color: var(--s); }
.cm-gear { width: 22px; height: 14px; }
.cm-opt.is-on, .cm-opt:hover { background: var(--bg2); }
/* The markers: a card in short form, for the narrow layouts. They sit in the margin, never over the page. */
.cm-dot { display: none; place-items: center; position: relative; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50% 50% 50% 4px; background: #E5A823; color: #1a1a1a; font: 600 10.5px/1 var(--sans); cursor: pointer; box-shadow: 0 0 0 2px var(--bg), 0 1px 3px rgba(0, 0, 0, 0.2); transition: transform 0.15s; }
.cm-dot.is-agent { background: var(--a); color: var(--a-on); }
.cm-dot.is-hover, .cm-dot.is-active { transform: scale(1.12); }
.cm-dot.is-active { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px #E5A823; }
.cm-dot.has-new::after { content: ""; position: absolute; top: -2px; right: -2px; width: 8px; height: 8px; border-radius: 50%; background: var(--link); box-shadow: 0 0 0 2px var(--bg); }
.cm-dot i { position: absolute; right: -5px; bottom: -4px; min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box; border-radius: 7px; background: var(--p); color: var(--bg); font: 600 9px/14px var(--sans); font-style: normal; }
.cm-dot.is-draft { background: var(--p); color: var(--bg); font-size: 15px; }
.v-body:not([data-cm="wide"]) .cm-dot { display: grid; }
.v-body:not([data-cm="wide"]) .cm-rail > .cm-dot { position: absolute; top: 0; left: 8px; transform: translate3d(0, var(--y, 0), 0); transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1); }
.v-body[data-cm="narrow"] .cm-rail > .cm-dot { left: 4px; width: 22px; height: 22px; }
.v-body:not([data-cm="wide"]) :is(.cm-rail, .cm-pins) > .cm-card:not(.is-active) { display: none; }
/* The middle layout: the open card floats beside its marker, over the page, with the look of a popover. */
.v-body[data-cm="mid"] :is(.cm-rail, .cm-pins) > .cm-card.is-active { position: absolute; left: auto; right: 48px; width: 316px; background: var(--bg); box-shadow: 0 0 0 0.5px var(--b2), 0 14px 36px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.06); }
.v-body[data-cm="mid"] .cm-rail > .cm-card.is-active { transform: translate3d(0, var(--y, 0), 0); }
.v-body[data-cm="mid"] .cm-pins > .cm-card.is-active { top: 8px; }
.v-body[data-cm="mid"] :is(.cm-rail, .cm-pins) > .cm-card.is-active::after { content: ""; position: absolute; top: 14px; right: -6px; width: 10px; height: 10px; background: var(--bg); box-shadow: 0.5px -0.5px 0 0 var(--b2); transform: rotate(45deg); }
/* The sheet: the open card on a phone. */
.cm-sheet { position: fixed; z-index: 20; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; max-height: min(70%, 560px); border-radius: 16px 16px 0 0; background: var(--bg); box-shadow: 0 -10px 36px rgba(0, 0, 0, 0.2), 0 0 0 0.5px var(--b2); animation: cm-up 0.22s cubic-bezier(0.2, 0.8, 0.2, 1); padding-bottom: env(safe-area-inset-bottom); }
.cm-sheet[hidden] { display: none; }
.cm-sheet::before { content: ""; align-self: center; flex: none; width: 36px; height: 4px; margin-top: 8px; border-radius: 2px; background: var(--b2); }
@keyframes cm-up { from { transform: translateY(40px); opacity: 0; } }
.cm-sheet-head { flex: none; display: flex; align-items: center; justify-content: space-between; height: 40px; padding: 0 8px 0 16px; font: 600 13.5px var(--sans); }
.cm-slot { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 0 16px 16px; }
.cm-slot > .cm-card { padding: 0; background: none; box-shadow: none; }
.cm-slot > .cm-card .cm-done { top: -2px; right: -6px; opacity: 1; }
.cm-slot > .cm-card .cm-menu { opacity: 1; }
.cm-slot > .cm-card textarea { font-size: 16px; }
/* The button at a selection in the page. The layer lies over the frame and takes no pointer events itself. */
.cm-over { position: absolute; inset: 0; z-index: 3; overflow: hidden; pointer-events: none; }
.cm-add { position: absolute; top: 0; left: 0; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px 0 9px; border: 0; border-radius: 9px; background: var(--p); color: var(--bg); font: 600 12.5px var(--sans); white-space: nowrap; cursor: pointer; pointer-events: auto; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.2), 0 1px 3px rgba(0, 0, 0, 0.12); animation: cm-add 0.14s ease-out; }
.cm-add[hidden] { display: none; }
.cm-add:hover { background: var(--press); }
.cm-add svg { width: 15px; height: 15px; }
.cm-add kbd { height: 17px; box-shadow: none; background: color-mix(in srgb, var(--bg) 16%, transparent); color: inherit; opacity: 0.8; font-size: 10.5px; }
@keyframes cm-add { from { opacity: 0; scale: 0.92; } }
.v-body.is-ro .cm-add, .v-body.is-ro .cm-done { display: none; }
#cres { width: auto; gap: 5px; padding: 0 8px; font: 500 12px var(--sans); }
#cres[hidden] { display: none; }
#cres svg { width: 14px; height: 14px; }
.v-respop { width: 320px; max-height: min(420px, 70vh); overflow: auto; }
.v-resrow { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border-radius: 8px; }
.v-resrow:hover { background: var(--bg2); }
.v-resmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; line-height: 1.4; }
.v-resmain b { font-weight: 600; }
.v-resmain span { overflow-wrap: anywhere; }
.v-resmain q { color: var(--s); font-size: 12px; quotes: none; padding-left: 6px; border-left: 2px solid var(--b2); }
.v-resrow .v-link { flex: none; margin-top: 2px; }
/* The small menu of a comment: Edit and Delete. */
.cm-mpop { position: fixed; z-index: 45; min-width: 160px; padding: 4px; border: 0.5px solid var(--b2); border-radius: 10px; background: var(--bg); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.06); animation: v-pop 0.12s ease-out; }
.cm-mpop .v-item { min-height: 30px; padding: 5px 10px; }

/* Assistants: one color each, for the reaction, the chip in the bar and the cursor in the page. The kit has the same colors. */
.a-claude { --a: #C4541C; --a-on: #fff; }
.a-chatgpt { --a: #0B7F63; --a-on: #fff; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .a-claude { --a: #F0997B; --a-on: #1a1a1a; } :root:not([data-theme="light"]) .a-chatgpt { --a: #5DCAA5; --a-on: #1a1a1a; } }
:root[data-theme="dark"] .a-claude { --a: #F0997B; --a-on: #1a1a1a; }
:root[data-theme="dark"] .a-chatgpt { --a: #5DCAA5; --a-on: #1a1a1a; }

/* The reaction: the assistant took the comment. The dot shows while the run goes on. */
.v-react { display: inline-flex; align-items: center; gap: 5px; height: 24px; margin-top: 7px; padding: 0 9px 0 7px; box-sizing: border-box; border-radius: 999px; background: color-mix(in srgb, var(--a) 11%, transparent); box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--a) 42%, transparent); color: var(--a); font: 600 11.5px var(--sans); cursor: default; }
.v-react svg { width: 13px; height: 13px; stroke-width: 1.8; transform-origin: 30% 80%; }
.v-react.is-new { animation: v-react 0.4s cubic-bezier(0.3, 1.4, 0.5, 1); }
.v-react.is-new svg { animation: v-thumb 0.5s 0.12s ease-out; }
.v-react i { width: 5px; height: 5px; margin-left: 1px; border-radius: 50%; background: currentColor; animation: v-live 1.1s ease-in-out infinite alternate; }
@keyframes v-react { from { opacity: 0; transform: scale(0.7); } }
@keyframes v-thumb { 40% { transform: rotate(-16deg) scale(1.15); } }
@keyframes v-live { from { opacity: 0.25; } }
/* A run that did not finish: one quiet line with one action. */
.v-runfail { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; margin-top: 7px; font-size: 12px; color: var(--s); }
.v-link { padding: 0; border: 0; border-radius: 3px; background: none; color: var(--link); font: 600 12px var(--sans); cursor: pointer; }
.v-link:hover { text-decoration: underline; }
.v-link:disabled { opacity: 0.5; cursor: default; text-decoration: none; }

/* The assistants that work on this page now, like the avatars of the people in a shared document. */
.v-who { flex: none; display: flex; align-items: center; gap: 4px; margin-right: 8px; }
.v-who:empty { display: none; }
.v-whochip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px 0 4px; border: 0; border-radius: 999px; background: color-mix(in srgb, var(--a) 11%, transparent); color: var(--p); font: 500 12px var(--sans); white-space: nowrap; cursor: pointer; animation: v-pop 0.18s ease-out; }
.v-whochip:hover { background: color-mix(in srgb, var(--a) 18%, transparent); }
.v-whochip b { font-weight: 600; color: var(--a); }
.v-ava { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--a); color: var(--a-on); animation: v-ring 1.8s ease-out infinite; }
.v-ava svg { width: 10px; height: 10px; fill: currentColor; stroke: none; }
@keyframes v-ring { from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--a) 45%, transparent); } to { box-shadow: 0 0 0 6px transparent; } }
.v-ver.is-bump { animation: v-bump 0.9s ease-out; }
@keyframes v-bump { 0%, 30% { background: color-mix(in srgb, var(--link) 16%, transparent); border-color: var(--link); } }


.v-dlg { width: 360px; max-width: calc(100vw - 32px); padding: 18px; box-sizing: border-box; border: 0.5px solid var(--b2); border-radius: 14px; background: var(--bg); color: var(--p); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.22); }
.v-dlg::backdrop { background: rgba(0, 0, 0, 0.3); }
.v-dlg h2 { margin: 0 0 6px; font: 600 15px var(--sans); }
.v-dlg p { margin: 0 0 10px; font-size: 13px; line-height: 1.5; color: var(--s); }
.v-dlg-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.v-dlg-acts .v-btn, .v-dlg-acts .v-create { width: auto; height: 32px; padding: 0 14px; align-self: auto; }
.v-sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.v-btn { flex: none; align-self: flex-start; height: 30px; padding: 0 10px; border: 0.5px solid var(--b2); border-radius: 8px; background: transparent; color: var(--p); font: 500 12.5px var(--sans); cursor: pointer; }
.v-btn:hover { background: var(--bg2); }

/* ─── Assistants: the sign-in and the model of each assistant ─── */
.a-dlg { width: 440px; padding: 0; overflow: hidden; }
.a-dlg[open] { display: flex; flex-direction: column; max-height: min(640px, calc(100vh - 32px)); }
.a-head { flex: none; display: flex; align-items: center; gap: 4px; height: 52px; padding: 0 10px 0 20px; }
.a-head h2 { flex: 1; margin: 0; }
.v-icon[hidden] { display: none; }
.a-back { margin-left: -10px; }
.a-body { flex: 1; min-height: 0; overflow: auto; padding: 0 20px 20px; }
.a-lede { margin: -2px 0 6px !important; }
.a-row { padding: 16px 0; border-top: 0.5px solid var(--b); }
.a-row:first-of-type { border-top: 0; padding-top: 8px; }
.a-top { display: flex; align-items: center; gap: 10px; }
.a-top .cm-ava { width: 30px; height: 30px; font-size: 12px; }
.a-who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.a-who b { font: 600 14px/18px var(--sans); }
.a-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; line-height: 18px; color: var(--s); }
.a-state::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--t); }
.a-state.is-on { color: var(--p); }
.a-state.is-on::before { background: #3B9B54; }
.a-top .v-create, .a-top .v-btn { width: auto; height: 30px; padding: 0 14px; border-radius: 999px; align-self: center; }
.v-btn.is-armed { background: var(--fill); color: var(--ink); border-color: transparent; }
.a-models { display: grid; gap: 6px; margin: 12px 0 0 40px; border: 0; padding: 0; }
.a-models legend { padding: 0; margin-bottom: 6px; font: 500 12px var(--sans); color: var(--s); }
.a-model { position: relative; display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 2px 8px; align-items: start; padding: 9px 12px 9px 10px; border-radius: 10px; box-shadow: inset 0 0 0 0.5px var(--b2); cursor: pointer; }
.a-model:hover { background: var(--bg2); }
.a-model:has(input:checked) { box-shadow: inset 0 0 0 1.5px var(--p); }
.a-model:has(input:focus-visible) { outline: 2px solid var(--link); outline-offset: 1px; }
.a-model input { grid-row: span 2; width: 15px; height: 15px; margin: 2px 0 0; accent-color: var(--p); }
.a-model b { display: flex; align-items: center; gap: 6px; font: 600 13px/18px var(--sans); }
.a-model span { font-size: 12px; line-height: 1.4; color: var(--s); }
.a-model .v-tag { padding: 0 6px; font: 500 10.5px/16px var(--sans); }
.a-none { margin: 12px 0 0 40px !important; font-size: 12.5px !important; }
/* The steps of a sign-in: one main button, then the code. */
.a-steps { display: grid; gap: 16px; margin: 14px 0 0; padding: 0; list-style: none; counter-reset: a-step; }
.a-steps > li { position: relative; display: grid; gap: 8px; padding-left: 34px; counter-increment: a-step; }
.a-steps > li::before { content: counter(a-step); position: absolute; left: 0; top: 0; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--bg2); font: 600 11.5px/1 var(--sans); color: var(--s); }
.a-steps > li.is-done::before { content: "✓"; background: var(--p); color: var(--bg); }
.a-steps h3 { margin: 1px 0 0; font: 600 13.5px/20px var(--sans); }
.a-steps p { margin: 0 !important; }
.a-go { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 40px; border: 0; border-radius: 10px; background: var(--p); color: var(--bg); font: 600 14px var(--sans); cursor: pointer; }
.a-go:hover:not(:disabled) { background: var(--press); }
.a-go:disabled { opacity: 0.5; cursor: default; }
.a-go svg { width: 15px; height: 15px; }
.a-field { display: flex; gap: 6px; }
.a-field input { flex: 1; min-width: 0; height: 40px; box-sizing: border-box; padding: 0 12px; border: 0.5px solid var(--b2); border-radius: 10px; background: var(--bg); color: var(--p); font: 500 14px var(--mono); }
.a-field input:focus { outline: none; border-color: var(--link); box-shadow: 0 0 0 3px color-mix(in srgb, var(--link) 18%, transparent); }
.a-field .v-btn { height: 40px; align-self: auto; padding: 0 14px; border-radius: 10px; font-weight: 600; }
.a-code { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 10px 10px 16px; border-radius: 12px; background: var(--bg2); }
.a-code output { font: 600 26px/1.2 var(--mono); letter-spacing: 0.08em; color: var(--p); user-select: all; }
.a-code .v-btn { height: 32px; align-self: auto; border-radius: 999px; padding: 0 14px; font-weight: 600; }
.a-live { display: flex; align-items: center; gap: 8px; min-height: 22px; margin-top: 16px; font-size: 13px; color: var(--s); }
.a-live:empty { display: none; }
.a-live.is-wait::before { content: ""; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--b2); border-top-color: var(--p); animation: a-spin 0.8s linear infinite; }
.a-live.is-on { color: var(--p); font-weight: 600; }
.a-live.is-on::before { content: "✓"; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: #3B9B54; color: #fff; font-size: 11px; }
.a-live.is-bad { color: var(--line, #A32D2D); }
@keyframes a-spin { to { transform: rotate(360deg); } }
.a-fine { margin-top: 14px !important; font-size: 12px !important; color: var(--t) !important; }
.v-create.is-danger { background: #A32D2D; color: #fff; }
.v-create.is-danger:hover { background: #8A2424; }

.v-toast { position: fixed; left: 50%; bottom: 24px; z-index: 50; transform: translateX(-50%); padding: 8px 14px; border-radius: 999px; background: var(--p); color: var(--bg); font: 500 13px var(--sans); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); animation: v-pop 0.16s ease-out; }
.v-toast[hidden] { display: none; }

@media (max-width: 640px) {
  .v-repo, .v-slash, .v-step, #copy, .v-lbl { display: none; }
  /* On a phone, Present and Share show only their icons. */
  .v-present, .v-share { width: 32px; height: 32px; padding: 0; justify-content: center; }
  .v-share { display: inline-flex; align-items: center; }
  .v-share svg { display: block; }
  .v-sharepop { width: calc(100vw - 16px); }
  #cres span { display: none; }
  .v-who { margin-right: 4px; }
  .v-whochip { padding: 0 4px; }
}
@media (prefers-reduced-motion: reduce) {
  .v-pop, .v-toast, [data-tip]:hover::after, [data-tip]:focus-visible::after, .v-react, .v-react svg, .v-react i, .v-whochip, .v-ava, .v-ver.is-bump, .cm-c.is-new, .cm-more.is-new, .cm-pick, .cm-sheet, .cm-add, .cm-mpop { animation: none; }
  .v-stage > .v-frame.is-in.is-on, .cm-rail > .cm-card, .cm-rail > .cm-dot, .cm-dot, .cm-card { transition: none; }
  .a-live.is-wait::before { animation: none; }
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
  /** The Access identity of the reader. The new comment shows it as its author. */
  who: string;
  /** The mentions that the sandbox runner handles, or none with no runner. */
  agents: string[];
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
function stamp(t) {
  const d = new Date(t.dateTime), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const same = (a, b) => a.toDateString() === b.toDateString();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  t.textContent = (same(d, now) ? 'Today' : same(d, y) ? 'Yesterday' : d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })) + ', ' + time;
  t.title = d.toLocaleString();
}
$$('time[datetime]').forEach(stamp);

// The viewer swaps this frame for a new one when the page gets a new version.
let frame = $('iframe');
let theme = 'auto';
try { theme = localStorage.getItem('theme') || 'auto'; } catch {}
function applyTheme() {
  if (theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === theme)));
  if (!frame) return;
  const src = srcOf(frame);
  if (frame.getAttribute('src') !== src) frame.src = src;
}
// A search result links to /p/<slug>#claim-2. The hash goes to the frame, which scrolls to that claim.
const srcOf = (f) => f.dataset.src + (theme === 'auto' ? '' : '&theme=' + theme) + location.hash;

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
  <div class="v-who" id="who"></div>
  <div class="v-ver${old ? ' c-amber is-old' : ''}">
    ${step('left', n - 1, 'Previous version')}
    <button type="button" class="v-cur" data-pop="pop-ver" aria-label="Version ${n} of ${latest}. Show all versions"><b>v${n}</b><span class="v-of">/${latest}</span>${icon('down')}</button>
    ${step('right', n + 1, 'Next version')}
  </div>
  <button type="button" class="v-icon" id="cres" data-pop="pop-res" aria-label="Resolved threads" hidden>${icon('check')}<span>0 resolved</span></button>
  <button type="button" class="v-icon" id="cnew" data-tip="Comment on the page" aria-label="Comment on the page" aria-keyshortcuts="Control+Alt+M Meta+Alt+M"${old ? ' hidden' : ''}>${icon('comment')}</button>
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
    <button type="button" class="v-item" id="assistants">${icon('spark')}<span>Assistants</span></button>
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
  <div class="v-pop v-respop" id="pop-res" hidden>
    <div class="v-label">Resolved threads</div>
    <div id="res-list"></div>
  </div>
</header>
<div class="v-scroll" id="scroll">
<div class="v-body" id="body" data-cm="wide" data-kind="${input.kind === 'deck' ? 'deck' : 'page'}">
<div class="v-stage"><iframe class="v-frame" title="${esc(title)}" ${frameAttrs(input.kind)} data-src="/raw/${esc(slug)}/${n}?k=${KIT}"></iframe>
  <div class="cm-over"><button type="button" class="cm-add" id="cm-add" aria-keyshortcuts="Control+Alt+M Meta+Alt+M" hidden>${icon('comment')}Comment<kbd></kbd></button></div>
</div>
<aside class="cm-col" id="cm-col" aria-label="Comments" hidden>
  ${old ? `<p class="cm-ro" id="cm-ro">This is version ${n}. Its comments are read-only. <a href="/p/${esc(slug)}">Open the latest version</a> to reply.</p>` : ''}
  <div class="cm-pins" id="cm-pins"></div>
  <div class="cm-rail" id="cm-rail"></div>
</aside>
</div>
</div>
</div>
<section class="cm-sheet" id="cm-sheet" aria-labelledby="cm-sheet-h" hidden>
  <div class="cm-sheet-head"><span id="cm-sheet-h">Comment</span><button type="button" class="v-icon" id="cm-close" aria-label="Close">${icon('x')}</button></div>
  <div class="cm-slot" id="cm-slot"></div>
</section>
<div class="v-toast" id="toast" role="status" hidden></div>
<div class="v-sr" id="live" role="status" aria-live="polite"></div>
<dialog class="v-dlg a-dlg" id="assist" aria-labelledby="assist-h">
  <div class="a-head"><button type="button" class="v-icon a-back" id="assist-back" aria-label="Back to all assistants" hidden>${icon('left')}</button><h2 id="assist-h">Assistants</h2><button type="button" class="v-icon" id="assist-x" aria-label="Close">${icon('x')}</button></div>
  <div class="a-body" id="assist-body"></div>
</dialog>
<dialog class="v-dlg" id="cm-confirm" aria-labelledby="cm-confirm-h" aria-describedby="cm-confirm-p">
  <h2 id="cm-confirm-h"></h2>
  <p id="cm-confirm-p"></p>
  <div class="v-dlg-acts"><button type="button" class="v-btn" id="cm-confirm-no" value="cancel">Cancel</button><button type="button" class="v-create is-danger" id="cm-confirm-ok" value="ok">Delete</button></div>
</dialog>
<script type="application/json" id="data">${data({ slug, kind: input.kind === 'deck' ? 'deck' : 'page', version: n, latest, kit: KIT, followsLatest: input.followsLatest, who: input.who, agents: input.agents, icons: { link: ICON.link, check: ICON.check, x: ICON.x, thumb: ICON.thumb, more: ICON.more } })}</script>`;

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

// Comments: the helpers that margin.js and the activity code share. Every text goes in with textContent, so a comment never becomes markup.
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// The assistants. A name from the API is text for a label and never markup.
const AGENTS = { claude: 'Claude', chatgpt: 'ChatGPT' };
const nameOf = (a) => AGENTS[a] || 'Assistant';
const tone = (a) => 'a-' + (a === 'chatgpt' ? 'chatgpt' : 'claude');
const say = (text) => { $('#live').textContent = text; };
// The reactions that the reader has seen. A new one pops in one time, and a refresh of the list draws it still.
const reacted = new Set();
// What the assistant did with the comment: a reaction while it works and after it answered, or one quiet line when it did not finish.
function reaction(r) {
  if (!r) return [];
  const who = nameOf(r.agent);
  if (r.status === 'failed') {
    const off = (r.detail || '').startsWith('not_signed_in');
    const row = el('div', 'v-runfail'), b = el('button', 'v-link', off ? 'Connect' : 'Try again');
    row.append(el('span', '', off ? who + ': not connected' : who + ' did not finish'), b);
    if (!off) row.title = r.detail || '';
    b.type = 'button';
    b.onclick = () => (off ? Assistants.connect(r.agent, () => retry(r.comment_id)) : retry(r.comment_id, b));
    return [row];
  }
  const on = r.status === 'running', chip = el('span', 'v-react ' + tone(r.agent)), label = who + (on ? ' is working on this comment' : ' took this comment');
  chip.innerHTML = svg('thumb');
  chip.append(el('span', '', who));
  if (on) chip.append(el('i'));
  chip.setAttribute('role', 'img'); chip.setAttribute('aria-label', label); chip.title = label;
  const key = r.id || r.comment_id + r.started_at;
  if (!reacted.has(key)) { reacted.add(key); chip.classList.add('is-new'); }
  return [chip];
}
async function retry(id, b) {
  if (b) b.disabled = true;
  try { await api('/api/comments/' + id + '/run', { method: 'POST' }); boost(); }
  catch (err) { toast('Could not start the run: ' + err.message); if (b) b.disabled = false; }
}

` +
    assistantsJs +
    marginJs +
    `

// ─── Activity: what the assistants do on this page ───
// The viewer asks the host for the activity of the page: every 500 ms while a run goes on, and every 2 seconds at other times,
// so a version that an agent publishes shows within about 2 seconds. An idle poll is one indexed query. A hidden tab does not poll.
// It shows each run three times: as the reaction on the comment, as a chip in the bar, and as a cursor in the page.
const VERBS = { starting: 'is starting', reading: 'is reading', editing: 'is editing', replying: 'is replying' };
const POINTER = '<span class="v-ava"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 1.8 13.6 6.6 8.9 8.4 7 13.4z"/></svg></span>';
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const stage = $('.v-stage');
// runs: the runs that are running, by public id. landed: the new text of each edit, to mark it in the next version.
const runs = new Map(), landed = new Map(), chips = new Map();
let cursor = 0, latest = D.latest, boostUntil = 0, pollTimer = 0, frameBusy = false, calmAt = 0, sent = false, sentKey = '', swapping = false;

// The frame has no origin, so the target origin is '*'. The page in it gets text only, and it shows it with textContent.
const toFrame = (msg, f = frame) => { if (f.contentWindow) f.contentWindow.postMessage({ ns: 'k-presence', v: 1, ...msg }, '*'); };
function sendPresence() {
  // An old version does not have the text that the assistant edits, so it shows no cursor.
  const show = D.followsLatest || D.version >= latest;
  // Before the first event with a place, the cursor starts at the text of the comment: its quote and the text before it.
  const list = show ? [...runs.values()].map((r) => { const h = r.hint || {}; return { id: r.id, agent: r.agent, name: nameOf(r.agent), phase: r.phase, quote: r.quote || h.quote || '', text: r.quote ? r.text || '' : '', final: r.final === true, before: (r.quote ? r.before : h.before) || '', anchor: r.anchor || h.anchor || '', hint: h.quote || '', steps: r.final && Array.isArray(r.edits) ? r.edits : [] }; }) : [];
  if (!list.length && !sent) return;
  sent = list.length > 0;
  const key = JSON.stringify(list);
  toFrame({ type: 'state', runs: list });
  // The page needs a moment to say that its cursor moves. Only a new state gives it that moment.
  if (key !== sentKey) { sentKey = key; calmAt = Date.now() + 400; }
}
// A message from a frame is not trusted: the page in it can send anything. The viewer reads numbers and booleans only.
const waiters = [];
addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.ns !== 'k-presence' || d.v !== 1) return;
  const f = $$('iframe', stage).find((x) => x.contentWindow === e.source);
  if (!f) return;
  if (d.type === 'busy' && f === frame) frameBusy = d.on === true;
  const i = waiters.findIndex((w) => w.f === f && w.type === d.type);
  if (i >= 0) waiters.splice(i, 1)[0].ok(d);
});
// Sends a message to a frame and waits for the answer of the given type. No answer in time gives null.
const ask = (f, msg, type, ms) => new Promise((ok) => {
  const w = { f, type, ok };
  waiters.push(w);
  setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); ok(null); } }, ms);
  toFrame(msg, f);
});
// A frame that loads again (a new theme) lost its cursors.
const wire = (f) => f.addEventListener('load', () => { if (f === frame && runs.size) { sent = false; sentKey = ''; sendPresence(); } });
wire(frame);

function drawWho() {
  const who = $('#who');
  chips.forEach((b, id) => { if (!runs.has(id)) { b.remove(); chips.delete(id); } });
  runs.forEach((r) => {
    let b = chips.get(r.id);
    if (!b) {
      b = el('button', 'v-whochip ' + tone(r.agent)); b.type = 'button';
      b.innerHTML = POINTER;
      b.append(el('span', 'v-lbl'));
      b.onclick = () => toFrame({ type: 'reveal', id: r.id });
      chips.set(r.id, b); who.append(b);
    }
    const text = nameOf(r.agent) + ' ' + (VERBS[r.phase] || 'is working');
    if (b.dataset.text === text) return;
    b.dataset.text = text;
    b.lastChild.replaceChildren(el('b', '', nameOf(r.agent)), ' ' + (VERBS[r.phase] || 'is working'));
    b.title = text + '. Show the cursor in the page.';
    b.setAttribute('aria-label', b.title);
  });
}

async function pollActivity() {
  const a = await api('/api/pages/' + D.slug + '/activity?since=' + cursor);
  latest = Math.max(latest, a.latest);
  let changed = false;
  if (a.runs) {
    cursor = a.cursor;
    let refresh = false;
    const ended = new Set();
    for (const r of a.runs) {
      const was = runs.get(r.id), who = nameOf(r.agent);
      if (r.final && r.text && r.version) landed.set(r.id, { id: r.id, agent: r.agent, name: who, version: r.version, quote: r.text, before: r.before || '', anchor: r.anchor || '' });
      if (r.status === 'running') {
        runs.set(r.id, r);
        if (!was) { refresh = true; say(who + ' started to work on a comment.'); }
        else if (was.phase !== r.phase && r.phase === 'editing') say(who + ' is editing the page.');
      } else {
        runs.delete(r.id);
        refresh = true;
        if (was) say(r.status === 'done' ? who + ' answered the comment.' : (r.detail || '').startsWith('not_signed_in') ? who + ' is not connected.' : who + ' did not finish.');
        if (r.thread) ended.add(r.thread);
      }
    }
    changed = true;
    // The cards show the reaction of a new run, and the reply of a run that ended.
    ended.forEach((t) => Margin.answered(t));
    if (refresh && !ended.size) Margin.refresh();
  }
  // A run with no result after 5 minutes is not running. The comments API shows it as failed.
  runs.forEach((r, id) => { if (Date.now() - Date.parse(r.started_at) > 300000) { runs.delete(id); changed = true; } });
  if (changed) { drawWho(); sendPresence(); }
  if (D.followsLatest && latest > D.version) swapTo(latest);
}
async function tick() {
  try { if (!document.hidden) await pollActivity(); } catch {}
  pollTimer = setTimeout(tick, runs.size || Date.now() < boostUntil ? 500 : 2000);
}
// A comment or a retry may start a run. The host records it after the response, so the viewer polls fast for a moment.
function boost() { boostUntil = Date.now() + 10000; clearTimeout(pollTimer); pollTimer = setTimeout(tick, 300); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(pollTimer); tick(); } });
tick();

// ─── A new version, with no reload ───
// The next version loads in a second frame under the same sandbox, at the same place in the view. It reports its height
// first, so the view keeps its scroll position and nothing moves. When the cursor in the old frame has finished its text,
// the new frame fades in on top, and the old frame goes. The bar gets the new version.
async function swapTo(v) {
  if (swapping || document.fullscreenElement) return;
  swapping = true;
  const next = frame.cloneNode(false);
  try {
    next.removeAttribute('src');
    next.classList.remove('is-self');
    next.dataset.src = '/raw/' + D.slug + '/' + v + '?k=' + D.kit;
    next.classList.add('is-in'); next.setAttribute('aria-hidden', 'true'); next.tabIndex = -1;
    next.style.setProperty('--st', $('#scroll').scrollTop + 'px');
    const loaded = new Promise((ok, no) => { next.addEventListener('load', ok, { once: true }); next.addEventListener('error', no, { once: true }); setTimeout(no, 15000); });
    const sized = Margin.prepare(next);
    next.src = srcOf(next).replace(/#.*$/, '');
    stage.append(next);
    await loaded;
    await sized;
    // Let the cursor finish its text, so the reader sees what changes. Then wait no more than 4 seconds.
    const until = Date.now() + 4000;
    while ((frameBusy || Date.now() < calmAt) && Date.now() < until) await wait(50);
    const flash = [...landed.values()].filter((f) => f.version > D.version && f.version <= v).map((f) => ({ ...f, cursor: !runs.has(f.id) }));
    await ask(next, { type: 'restore', flash }, 'restored', 1500);
    next.classList.add('is-on');
    await wait(matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260);
    const focused = document.activeElement === frame, old = frame;
    frame = next; wire(next);
    old.remove();
    next.classList.remove('is-in', 'is-on'); next.removeAttribute('aria-hidden'); next.removeAttribute('tabindex'); next.style.removeProperty('--st');
    Margin.frame();
    if (focused) next.focus({ preventScroll: true });
    landed.forEach((f, id) => { if (f.version <= v) landed.delete(id); });
    setVersion(v);
    frameBusy = false; sent = false; sentKey = ''; sendPresence();
  } catch {
    // The frame did not load. A reload shows the new version, or the error.
    next.remove();
    location.reload();
    return;
  }
  swapping = false;
  if (latest > D.version) swapTo(latest);
}
// The bar, the version list and the links, for the version that the frame shows now.
function setVersion(v) {
  const was = D.version, path = (n) => '/p/' + D.slug + (n === v ? '' : '/v/' + n), raw = '/raw/' + D.slug + '/' + v + '?k=' + D.kit;
  D.version = v; D.latest = latest = Math.max(latest, v);
  $('.v-cur b').textContent = 'v' + v;
  $('.v-of').textContent = '/' + v;
  $('.v-cur').setAttribute('aria-label', 'Version ' + v + ' of ' + v + '. Show all versions');
  const prev = $('.v-step');
  prev.href = path(was); prev.removeAttribute('aria-disabled');
  const pop = $('#pop-ver'), items = $$('.v-vitem', pop);
  $('.v-label', pop).textContent = items.length + 1 + ' versions';
  items.forEach((a) => { a.removeAttribute('aria-current'); $('.v-tag', a)?.remove(); if (a.getAttribute('href') === '/p/' + D.slug) a.href = path(was); });
  const item = el('a', 'v-item v-vitem'), time = el('time', 'v-meta');
  item.href = path(v); item.setAttribute('aria-current', 'page');
  time.dateTime = new Date().toISOString(); stamp(time);
  item.append(el('span', 'v-num', 'v' + v), el('span', 'v-tag', 'Latest'), time);
  (items[0] || $('.v-label', pop)).before(item);
  if (!items.length) pop.append(item);
  $('[data-pdf]').dataset.pdf = '/pdf/' + D.slug + '/' + v;
  $$('#pop-more a').forEach((a) => { a.href = raw; if (a.hasAttribute('download')) a.download = D.slug.replace('/', '-') + '-v' + v + '.html'; });
  const only = $$('[data-target]').find((b) => b.dataset.target !== 'latest');
  if (target !== 'latest') target = String(v);
  only.dataset.target = v; only.textContent = 'Only v' + v;
  const pill = $('.v-ver');
  pill.classList.remove('is-bump'); void pill.offsetWidth; pill.classList.add('is-bump');
  say('The page shows version ' + v + '.');
}
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
