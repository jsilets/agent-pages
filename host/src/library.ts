// The library: the home of the drive. A sidebar with the folder tree, then folders, pinned pages and recent pages.
// The server sends the pages and folders as JSON. The script draws every view from them, so opening a folder,
// moving a page, pinning and searching all redraw without a reload.

import { COMMON_SCRIPT, ICON, KIT, appearance, data, icon, shell, type PageRow } from './views';
import type { ActivityRow } from './worker';

export interface FolderRow {
  id: string;
  name: string;
  /** The folder that holds this one, or null at the top level. */
  parent_id: string | null;
  /** One of the kit's color ramps, or null for plain card stock. */
  color: string | null;
  created_at: string;
  updated_at: string;
}

// Lucide icons (ISC), on the same 24-unit stroke grid as the host's own icons.
const LUCIDE: Record<string, string> = {
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderPlus: '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  move: '<path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M2 13h10"/><path d="m9 16 3-3-3-3"/>',
  doc: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  deck: '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
};
// The assistants' own marks (Simple Icons, CC0). Shown only where the assistant is the one acting.
const AGENT_MARKS = { claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z", chatgpt: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" };
const lu = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${LUCIDE[name]}</svg>`;

// The brand mark without its tile, drawn in the text colour: dark on light, white on dark. The tile is for tabs and home screens.
const MARK = `<svg class="h-mark" viewBox="24 32 208 192" aria-hidden="true">
    <path opacity="0.3" d="M84 32 H172 A16 16 0 0 1 188 48 V60 H68 V48 A16 16 0 0 1 84 32 Z"/>
    <path opacity="0.55" d="M60 76 H196 A20 20 0 0 1 216 96 V104 H40 V96 A20 20 0 0 1 60 76 Z"/>
    <path fill-rule="evenodd" d="M48 120 H208 A24 24 0 0 1 232 144 V200 A24 24 0 0 1 208 224 H48 A24 24 0 0 1 24 200 V144 A24 24 0 0 1 48 120 Z M64 148 H140 A12 12 0 0 1 140 172 H64 A12 12 0 0 1 64 148 Z"/>
  </svg>`;

const LIB_CSS = `
/* ─── Library ───────────────────────────────────────────── */
body:has(> .l) { height: 100%; overflow: hidden; }
.l { display: grid; grid-template-columns: 236px minmax(0, 1fr); height: 100%; }
.l-main { display: flex; flex-direction: column; min-width: 0; height: 100%; }
.h-scroll { flex: 1; min-height: 0; overflow: auto; }

/* The sidebar. Its top row lines up with the bar. */
.l-side { --side: color-mix(in oklab, var(--bg2) 55%, var(--bg)); display: flex; flex-direction: column; gap: 1px; min-height: 0; overflow: auto; padding: 0 10px 16px; border-right: 0.5px solid var(--b); background: var(--side); box-sizing: border-box; }
.l-brand { color: var(--p); text-decoration: none; display: flex; align-items: center; gap: 9px; flex: none; height: 44px; margin-bottom: 6px; padding: 0 6px; font: 600 13.5px/20px var(--sans); letter-spacing: -0.005em; }
.l-brand:hover { text-decoration: none; }
.h-mark { flex: none; width: 17px; height: 16px; fill: currentColor; stroke: none; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .l-nav[aria-current="page"] { background: var(--bg3); } }
:root[data-theme="dark"] .l-nav[aria-current="page"] { background: var(--bg3); }
.l-nav { position: relative; display: flex; align-items: center; gap: 9px; height: 28px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: var(--s); font: 500 13px var(--sans); text-decoration: none; cursor: pointer; }
.l-nav:hover { background: color-mix(in oklab, var(--bg3) 55%, var(--side)); color: var(--p); text-decoration: none; }
.l-nav[aria-current="page"] { background: var(--bg); color: var(--p); box-shadow: 0 0 0 0.5px var(--b2), 0 1px 2px rgba(0, 0, 0, 0.06); }
.l-nav svg { width: 15px; height: 15px; color: var(--t); }
.l-nav[aria-current="page"] svg { color: var(--p); }
/* Counts show only on hover and on the current row, so the list stays quiet. */
.l-nav .l-n { margin-left: auto; font: 500 11.5px var(--sans); color: var(--t); font-variant-numeric: tabular-nums; opacity: 0; }
.l-nav:hover .l-n, .l-nav[aria-current="page"] .l-n { opacity: 1; }
.l-sec { display: flex; align-items: center; justify-content: space-between; margin: 20px 0 4px; padding: 0 2px 0 8px; font: 500 11.5px var(--sans); color: var(--t); }
.l-sec .v-icon { width: 24px; height: 24px; border-radius: 6px; }
.l-sec .v-icon svg { width: 14px; height: 14px; }
.l-tree { display: flex; flex-direction: column; gap: 1px; }
.l-tree .l-nav { padding-left: calc(8px + var(--d, 0) * 14px); gap: 4px; }
.l-caret { display: inline-grid; place-items: center; width: 16px; height: 16px; margin: 0 2px 0 -4px; border-radius: 4px; color: var(--t); transition: transform 0.18s cubic-bezier(0.25, 1, 0.5, 1); }
.l-caret svg { width: 12px; height: 12px; }
.l-caret.is-open { transform: rotate(90deg); }
.l-caret.is-none { visibility: hidden; }
.l-tree .l-glyph { width: 15px; height: 15px; margin-right: 6px; fill: var(--fo-front); stroke: var(--fo-edge); stroke-width: 1.4; }
.l-tree .l-nav.is-drop, .fo.is-drop .fo-obj { outline: 2px solid var(--link); outline-offset: 2px; }
.l-empty-tree { padding: 4px 8px; font-size: 12.5px; color: var(--t); }

/* The bar: what you are looking at, search, then the tools. */
.l-bar { --bar: 44px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 520px) minmax(0, 1fr); align-items: center; gap: 12px; padding: 0 10px 0 24px; }
.l-crumb { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 13.5px; }
.l-crumb a, .l-crumb span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.l-crumb a { color: var(--s); text-decoration: none; padding: 2px 4px; border-radius: 6px; }
.l-crumb a:hover { background: var(--bg2); color: var(--p); }
.l-crumb .l-here { font-weight: 600; padding: 2px 4px; }
.l-crumb .l-sep { flex: none; color: var(--t); }
.l-crumb .l-sep svg { width: 12px; height: 12px; }
#menu { display: none; }
.l-bar > #menu + .l-crumb { grid-column: 1; }
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

/* Content starts at the bar's left edge, so the heading sits under the breadcrumb. */
.h-main { max-width: 1480px; margin: 0; padding: 24px 28px 72px; }
.l-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 0 0 24px; }
.l-title h1 { margin: 0; font: 600 22px/28px var(--sans); letter-spacing: -0.015em; text-wrap: balance; }
.l-title p { margin: 0; font-size: 13px; color: var(--s); }
.l-title .v-icon { align-self: center; width: 28px; height: 28px; margin-left: -4px; }
.l-title .v-icon svg { width: 15px; height: 15px; }
.l-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 14px; }
.l-head h2 { display: flex; align-items: center; gap: 6px; margin: 0; font: 600 14px/20px var(--sans); }
.l-head h2 svg { width: 14px; height: 14px; color: var(--t); }
.l-head .l-more { font-size: 12.5px; color: var(--s); text-decoration: none; padding: 3px 6px; border-radius: 6px; border: 0; background: none; cursor: pointer; font-family: var(--sans); }
.l-head .l-more:hover { background: var(--bg2); color: var(--p); }
.l-block + .l-block { margin-top: 36px; }

/* ─── A folder: card stock with a tab, the newest pages standing in it ───
   The back and its tab are one SVG shape. The front panel covers the lower 58%, so the top of the newest
   page shows above it, zoomed until its heading reads. The pages behind it show only as edges.
   Hover, focus, a press or a page dragged over it lifts the pages and fans them inside the folder's own
   width, and the front tips forward. The same object is used in Home, inside a folder and as a drop target. */
.l-folders { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 24px 20px; }
.l-folders > .fo { max-width: 232px; }
.fo { --fo-front: color-mix(in oklab, var(--fill) 46%, var(--line)); --fo-back: color-mix(in oklab, var(--fill) 30%, var(--line)); --fo-edge: color-mix(in oklab, var(--line) 85%, var(--ink));
  position: relative; display: block; min-width: 0; color: inherit; text-decoration: none; outline: none; -webkit-tap-highlight-color: transparent; }
.fo:hover { text-decoration: none; }
.fo-obj { position: relative; display: block; aspect-ratio: 16 / 10; perspective: 600px; }
/* A soft contact shadow, so the folder sits on the page. */
.fo-obj::after { content: ""; position: absolute; left: 6%; right: 6%; bottom: -4%; height: 10%; border-radius: 50%; background: radial-gradient(closest-side, rgba(0, 0, 0, 0.16), transparent); z-index: -1; }
.fo-back { position: absolute; inset: 0; width: 100%; height: 100%; fill: var(--fo-back); stroke: none; overflow: visible; }
/* The pages. --i is 0 (back) to 2 (front, the newest). Closed, the back pages stand a little higher and narrower, so their edges show. */
.fo-sheet { position: absolute; left: 8%; right: 8%; top: 12%; aspect-ratio: 16 / 10; overflow: hidden; border-radius: 3px; background: #fff; box-shadow: 0 0 0 0.75px rgba(0, 0, 0, 0.2), 0 1px 3px rgba(0, 0, 0, 0.12);
  transform: translateY(calc((2 - var(--i)) * -5%)) scaleX(calc(1 - (2 - var(--i)) * 0.045));
  transition: transform 0.3s cubic-bezier(0.25, 1, 0.5, 1); transition-delay: calc((2 - var(--i)) * 20ms); }
/* The front page is zoomed to its top left, so its heading is large enough to read above the front panel. */
.fo-sheet img { display: block; width: 150%; max-width: none; margin-left: -12%; height: auto; }
/* Closed, the pages behind the newest are plain paper edges. Their content shows once the folder opens. */
.fo-sheet img { transition: opacity 0.2s; }
.fo-sheet:not(.is-front) img { opacity: 0; }
.fo:hover .fo-sheet img, .fo:focus-visible .fo-sheet img, .fo.is-press .fo-sheet img, .fo.is-drop .fo-sheet img { opacity: 1; }
.fo-sheet.is-blank { background: linear-gradient(var(--bg3), var(--bg3)) 10% 22% / 54% 9% no-repeat, linear-gradient(var(--bg2), var(--bg2)) 10% 44% / 78% 5% no-repeat, #fff; }
.fo-front { position: absolute; left: 0; right: 0; top: 34%; bottom: 0; border-radius: 5px 5px 8px 8px; background: linear-gradient(to bottom, color-mix(in oklab, var(--fo-front) 92%, #fff), var(--fo-front) 40%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 -1px 2px rgba(0, 0, 0, 0.08);
  transform-origin: 50% 100%; transition: transform 0.3s cubic-bezier(0.25, 1, 0.5, 1); }
.fo-label { display: flex; align-items: flex-start; gap: 6px; margin-top: 10px; min-width: 0; }
.fo-text { flex: 1; min-width: 0; }
.fo-name { display: block; overflow: hidden; font: 600 13.5px/20px var(--sans); letter-spacing: -0.005em; color: var(--p); white-space: nowrap; text-overflow: ellipsis; }
.fo-meta { display: block; font: 12px/18px var(--sans); color: var(--s); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.fo-menu { flex: none; width: 26px; height: 26px; margin: -2px -6px 0 0; opacity: 0; }
.fo:hover .fo-menu, .fo-menu:focus-visible, .fo-menu[aria-expanded="true"] { opacity: 1; }
/* Open: the pages rise and fan inside the folder's width, the front tips forward. */
.fo:hover .fo-sheet, .fo:focus-visible .fo-sheet, .fo.is-press .fo-sheet, .fo.is-drop .fo-sheet { transform: translate(var(--x), var(--y)) rotate(var(--r)) scale(var(--s)); transition-delay: calc(var(--i) * 30ms); }
.fo:hover .fo-front, .fo:focus-visible .fo-front, .fo.is-press .fo-front, .fo.is-drop .fo-front { transform: rotateX(-14deg); }
.fo:focus-visible .fo-obj { outline: 2px solid var(--link); outline-offset: 4px; border-radius: 8px; }
@media (hover: none) { .fo-menu { display: none; } }
/* Dark: the ramp's fill is its deep tone and its line the light one. The stock stays deep, with a lifted front. */
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .fo { --fo-front: color-mix(in oklab, var(--fill) 76%, var(--line)); --fo-back: color-mix(in oklab, var(--fill) 90%, var(--line)); --fo-edge: var(--line); } :root:not([data-theme="light"]) .fo-sheet { background: #222; box-shadow: 0 0 0 0.75px rgba(255, 255, 255, 0.2), 0 2px 6px rgba(0, 0, 0, 0.5); } :root:not([data-theme="light"]) .fo-front { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 -1px 3px rgba(0, 0, 0, 0.3); } }
:root[data-theme="dark"] .fo { --fo-front: color-mix(in oklab, var(--fill) 76%, var(--line)); --fo-back: color-mix(in oklab, var(--fill) 90%, var(--line)); --fo-edge: var(--line); }
:root[data-theme="dark"] .fo-sheet { background: #222; box-shadow: 0 0 0 0.75px rgba(255, 255, 255, 0.2), 0 2px 6px rgba(0, 0, 0, 0.5); }
:root[data-theme="dark"] .fo-front { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 -1px 3px rgba(0, 0, 0, 0.3); }

/* ─── A page card: the top of the page, then its title. Each version after the first adds a sheet behind it, up to two. ─── */
/* Pages use the folders' grid, so a page card sits under a folder, at the same width. */
.h-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 24px 20px; }
.h-card { position: relative; padding-top: 7px; }
.h-link { display: block; color: inherit; text-decoration: none; outline: none; }
.h-link:hover { text-decoration: none; }
.h-thumb { --ring: var(--b); position: relative; display: grid; place-items: center; aspect-ratio: 16 / 10; overflow: hidden; border-radius: 10px; background: var(--bg2); box-shadow: 0 0 0 0.5px var(--ring); transition: box-shadow 0.15s; }
.h-thumb[data-sheets="1"] { box-shadow: 0 0 0 0.5px var(--ring), 0 -7px 0 -4px var(--bg3), 0 -7px 0 -3.5px var(--b); }
.h-thumb[data-sheets="2"] { box-shadow: 0 0 0 0.5px var(--ring), 0 -7px 0 -4px var(--bg3), 0 -7px 0 -3.5px var(--b), 0 -14px 0 -8px var(--bg3), 0 -14px 0 -7.5px var(--b); }
.h-link:hover .h-thumb { --ring: var(--b2); }
.h-card.is-sel .h-thumb, .h-link:focus-visible .h-thumb { outline: 2px solid var(--link); outline-offset: 2px; }
.h-card.is-dragging { opacity: 0.4; }
.h-img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
.h-dark { display: none; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .h-light { display: none; } :root:not([data-theme="light"]) .h-dark { display: block; } }
:root[data-theme="dark"] .h-light { display: none; }
:root[data-theme="dark"] .h-dark { display: block; }
.h-ph { font: 500 20px var(--mono); letter-spacing: -0.04em; color: var(--t); }
.h-title { display: block; min-width: 0; margin-top: 10px; overflow: hidden; font: 600 13.5px/20px var(--sans); letter-spacing: -0.005em; color: var(--p); white-space: nowrap; text-overflow: ellipsis; }
.h-sub { display: flex; align-items: center; gap: 6px; margin-top: 1px; min-width: 0; font: 12px/18px var(--sans); color: var(--s); }
.h-sub > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.h-sub svg, .h-acc svg { width: 13px; height: 13px; color: var(--t); flex: none; }
.h-v { margin-left: auto; font: 500 11.5px var(--mono); color: var(--t); }
/* A card is narrow: its title gets two lines, and the version shows in the list and the viewer. */
.h-card .h-v { display: none; }
.h-card .h-title { display: -webkit-box; white-space: normal; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.h-menu { position: absolute; top: 15px; right: 8px; width: 28px; height: 28px; background: var(--bg); box-shadow: 0 0 0 0.5px var(--b2), 0 2px 6px rgba(0, 0, 0, 0.08); opacity: 0; }
.h-menu:hover, .h-menu[aria-expanded="true"] { background: var(--bg); }
.h-card:hover .h-menu, .h-card.is-sel .h-menu, .h-row:hover .h-menu, .h-row.is-sel .h-menu, .h-menu:focus-visible, .h-menu[aria-expanded="true"] { opacity: 1; }
@media (hover: none) {
  .h-card .h-menu { opacity: 1; top: auto; bottom: -5px; right: -8px; background: transparent; box-shadow: none; }
  .h-card .h-sub { padding-right: 22px; }
  .h-row .h-menu { opacity: 1; }
}

/* The list: one row a page. */
.h-list { display: flex; flex-direction: column; gap: 2px; }
.h-row { position: relative; }
.h-row .h-link { display: grid; grid-template-columns: 52px minmax(0, 1fr) minmax(0, 200px) 150px 32px 16px; align-items: center; gap: 14px; height: 48px; padding: 0 48px 0 8px; border-radius: 10px; }
.h-row .h-link:hover, .h-row.is-sel .h-link { background: var(--bg2); }
.h-row.is-sel .h-link, .h-hit.is-sel { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--link) 55%, transparent); }
.h-row .h-thumb { border-radius: 5px; }
.h-row .h-ph { font-size: 10px; }
.h-row .h-title { margin: 0; font-weight: 500; }
.h-where { min-width: 0; overflow: hidden; display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--s); white-space: nowrap; }
.h-where svg { width: 13px; height: 13px; color: var(--t); flex: none; }
.h-where span { overflow: hidden; text-overflow: ellipsis; }
.h-row .h-when { font-size: 12.5px; color: var(--s); white-space: nowrap; }
.h-row .h-v { margin: 0; text-align: right; }
.h-acc { display: grid; place-items: center; }
.h-row .h-menu { top: 10px; background: transparent; box-shadow: none; }
.h-row .h-menu:hover, .h-row .h-menu[aria-expanded="true"] { background: var(--bg3); }
.h-kind { font: 500 11px var(--sans); color: var(--s); border: 0.5px solid var(--b2); border-radius: 4px; padding: 0 5px; line-height: 16px; }

/* Search results: the best match on each page. */
.h-hits { display: flex; flex-direction: column; gap: 2px; max-width: 760px; }
.h-hit { display: block; padding: 10px 12px; border-radius: 10px; color: inherit; text-decoration: none; }
.h-hit:hover, .h-hit.is-sel { background: var(--bg2); text-decoration: none; }
.h-hit-head { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.h-hit .h-title { flex: 0 1 auto; margin: 0; }
.h-hit .h-where { flex: 0 1 auto; }
.h-hit-where { display: block; margin-top: 2px; font: 500 12.5px/18px var(--sans); color: var(--s); }
.h-hit-snip { display: -webkit-box; margin-top: 3px; overflow: hidden; font: 13px/1.5 var(--sans); color: var(--s); -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
mark { padding: 0 1px; border-radius: 3px; background: color-mix(in srgb, var(--link) 20%, transparent); color: var(--p); }
.h-none { margin: 4px 0 0; font-size: 13.5px; color: var(--s); }
.l-empty { display: grid; gap: 4px; justify-items: start; padding: 22px; border-radius: 12px; border: 1px dashed var(--b2); font-size: 13.5px; color: var(--s); }
.l-empty b { font-weight: 600; color: var(--p); }

/* The folder editor: name and color. Also used to make a new folder. */
.l-edit { width: 280px; padding: 12px; gap: 10px !important; }
.l-edit input { height: 34px; padding: 0 10px; border: 0.5px solid var(--b2); border-radius: 8px; background: var(--bg); color: var(--p); font: 500 13.5px var(--sans); outline: none; }
.l-edit input:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--link) 18%, transparent); border-color: var(--link); }
.l-swatches { display: flex; flex-wrap: wrap; gap: 6px; }
.l-sw { width: 22px; height: 22px; border-radius: 999px; border: 0; padding: 0; cursor: pointer; background: color-mix(in oklab, var(--line) 72%, var(--fill)); box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.2); }
.l-sw[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px var(--p); }
.l-edit-row { display: flex; gap: 6px; }
.l-edit-row .v-create { flex: 1; }
.l-edit .is-danger { color: var(--s); }
.l-movelist { max-height: 320px; overflow: auto; }

/* The phone: the sidebar becomes a drawer, and two folders sit side by side. */
.l-scrim { display: none; }
@media (max-width: 760px) {
  .l { grid-template-columns: minmax(0, 1fr); }
  .l-side { position: fixed; inset: 0 auto 0 0; z-index: 40; width: 272px; padding-top: env(safe-area-inset-top, 0px); transform: translateX(-100%); transition: transform 0.26s cubic-bezier(0.25, 1, 0.5, 1); }
  .l.is-drawer .l-side { transform: none; box-shadow: 0 0 40px rgba(0, 0, 0, 0.2); }
  .l.is-drawer .l-scrim { display: block; position: fixed; inset: 0; z-index: 39; background: rgba(0, 0, 0, 0.32); }
  .l-bar { grid-template-columns: auto minmax(0, 1fr) auto; gap: 6px; padding: 0 6px; }
  #menu { display: inline-grid; }
  .l-crumb { display: none; }
  .h-search kbd, .h-tools .v-seg { display: none; }
  .h-main { padding: 16px 16px 56px; }
  .l-title h1 { font-size: 20px; line-height: 26px; }
  /* One swipeable row, so Recent stays on the first screen however many folders there are. */
  .l-folders { grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: 42%; gap: 16px; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none; margin: 0 -16px; padding: 14px 16px 4px; scroll-padding-inline: 16px; }
  .l-folders::-webkit-scrollbar { display: none; }
  .l-folders > .fo { scroll-snap-align: start; }
  .h-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 12px; }
  .h-row .h-link { grid-template-columns: 52px minmax(0, 1fr) 32px; }
  .h-row .h-where, .h-row .h-when, .h-row .h-acc, .h-card .h-v, .h-card .h-kind { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .fo-sheet, .fo-front, .l-caret, .l-side, .h-thumb { transition: none; }
}

/* ─── Layout options and Activity ───────────────────────── */
.l-body { flex: 1; min-height: 0; display: flex; }
.l-body > .h-scroll { flex: 1; min-width: 0; }
.l-rail { display: none; }
.l-shells { display: flex; gap: 4px; padding: 0 6px 6px; }
.l-shells a { flex: 1; padding: 6px 4px; border-radius: 8px; text-align: center; font: 500 12px var(--sans); color: var(--s); text-decoration: none; box-shadow: inset 0 0 0 0.5px var(--b2); }
.l-shells a[aria-current="true"] { background: var(--p); color: var(--bg); box-shadow: none; }

/* Status: amber waits for you, a pulse means an assistant is working, red failed. */
.st { --st: var(--t); display: inline-block; flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--st); }
.st.is-needs { --st: #d99a1e; }
.st.is-failed { --st: #d6453d; }
.st.is-running { --st: var(--link); animation: st-pulse 1.6s ease-in-out infinite; }
@keyframes st-pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--st) 45%, transparent); } 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--st) 0%, transparent); } }
.l-nav .st { margin-left: auto; }
.l-nav .st + .l-n { margin-left: 6px; }
.l-nav .l-n.is-on { opacity: 1; color: var(--p); }
.fo-name .st { margin: 0 0 1px 7px; vertical-align: middle; }
.h-badge { position: absolute; left: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px 0 6px; border-radius: 999px; background: var(--bg); box-shadow: 0 0 0 0.5px var(--b2), 0 2px 6px rgba(0, 0, 0, 0.12); font: 500 11.5px var(--sans); color: var(--p); }
.h-badge .a-mark { width: 12px; height: 12px; }
.h-thumb { position: relative; }

/* An activity item: who did what, on which page, because of which request. */
.a-mark { flex: none; width: 15px; height: 15px; fill: currentColor; }
.a-list { display: flex; flex-direction: column; gap: 10px; max-width: 880px; }
.a-item { display: grid; grid-template-columns: minmax(0, 1fr) 132px; gap: 4px 18px; padding: 14px 16px; border-radius: 12px; background: var(--bg); box-shadow: 0 0 0 0.5px var(--b2); }
.a-item.is-done.is-new { box-shadow: 0 0 0 1px color-mix(in srgb, #d99a1e 70%, var(--b2)); }
.a-who { display: flex; align-items: center; gap: 7px; min-width: 0; font: 500 13px/20px var(--sans); color: var(--s); }
.a-who b { font-weight: 600; color: var(--p); }
.a-who .a-when { margin-left: auto; font-size: 12px; color: var(--t); white-space: nowrap; font-variant-numeric: tabular-nums; }
.a-page { display: block; margin: 2px 0 0; font: 600 15px/21px var(--sans); color: var(--p); text-decoration: none; }
.a-page:hover { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.a-req { margin: 6px 0 0; padding: 0 0 0 10px; border-left: 2px solid var(--b2); font: 13.5px/1.5 var(--sans); color: var(--p); }
.a-req .a-on { display: block; margin-top: 2px; font-size: 12px; color: var(--t); }
.a-out { margin: 8px 0 0; font: 13.5px/1.5 var(--sans); color: var(--s); }
.a-out.is-failed { color: #c23b33; }
.a-live { display: flex; align-items: center; gap: 8px; margin-top: 8px; font: 500 12.5px var(--sans); color: var(--link); font-variant-numeric: tabular-nums; }
.a-bar { flex: 1; max-width: 160px; height: 3px; border-radius: 3px; background: color-mix(in srgb, var(--link) 16%, transparent); overflow: hidden; }
.a-bar::after { content: ""; display: block; width: 36%; height: 100%; border-radius: 3px; background: var(--link); animation: a-slide 1.6s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
@keyframes a-slide { from { transform: translateX(-100%); } to { transform: translateX(280%); } }
.a-acts { display: flex; gap: 6px; margin-top: 12px; }
.a-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border: 0; border-radius: 8px; background: var(--bg2); color: var(--p); font: 500 12.5px var(--sans); text-decoration: none; cursor: pointer; }
.a-btn:hover { background: var(--bg3); text-decoration: none; }
.a-btn.is-main { background: var(--p); color: var(--bg); }
.a-btn svg { width: 14px; height: 14px; }
.a-shot { grid-column: 2; grid-row: 1 / span 6; align-self: start; display: block; border-radius: 8px; overflow: hidden; box-shadow: 0 0 0 0.5px var(--b2); }
.a-shot .h-thumb { border-radius: 0; box-shadow: none; }
.a-ver { display: flex; align-items: center; gap: 10px; padding: 7px 4px; font: 13px var(--sans); color: var(--s); border-bottom: 0.5px solid var(--b); }
.a-ver b { font-weight: 500; color: var(--p); }
.a-ver a { color: inherit; text-decoration: none; }
.a-ver .a-when { margin-left: auto; color: var(--t); font-size: 12px; }
.a-none { margin: 0; font-size: 13px; color: var(--t); }

/* Option A: an inbox at the top of the sidebar. Home shows what waits for you before the folders. */
.l-strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
.l-strip .a-item { grid-template-columns: minmax(0, 1fr); }
.l-strip .a-shot { display: none; }

/* Option B: folders are spaces. A rail beside the content shows the activity of the current space and asks in it. */
[data-shell="b"] .l-rail { display: flex; flex-direction: column; flex: none; width: 340px; min-height: 0; overflow: auto; border-left: 0.5px solid var(--b); background: color-mix(in oklab, var(--bg2) 40%, var(--bg)); }
.r-ask { position: sticky; top: 0; z-index: 1; padding: 14px 14px 12px; background: inherit; border-bottom: 0.5px solid var(--b); }
.r-scope { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; font: 500 12px var(--sans); color: var(--s); }
.r-scope b { font-weight: 600; color: var(--p); }
.r-box { display: flex; flex-direction: column; gap: 8px; padding: 10px 10px 8px 12px; border-radius: 12px; background: var(--bg); box-shadow: 0 0 0 0.5px var(--b2); }
.r-box textarea { min-height: 44px; padding: 0; border: 0; resize: none; background: transparent; color: var(--p); font: 13.5px/1.45 var(--sans); outline: none; }
.r-box textarea::placeholder { color: var(--t); }
.r-row { display: flex; align-items: center; gap: 6px; }
.r-who { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border: 0; border-radius: 999px; background: var(--bg2); color: var(--s); font: 500 12px var(--sans); cursor: pointer; }
.r-who[aria-pressed="true"] { background: var(--p); color: var(--bg); }
.r-who .a-mark { width: 12px; height: 12px; }
.r-send { margin-left: auto; width: 28px; height: 28px; border-radius: 8px; }
.r-feed { display: flex; flex-direction: column; gap: 8px; padding: 14px; }
.r-feed h3 { display: flex; align-items: center; gap: 6px; margin: 6px 2px 2px; font: 600 12.5px var(--sans); color: var(--s); }
.r-feed .a-item { grid-template-columns: minmax(0, 1fr); padding: 12px 13px; }
.r-feed .a-shot { display: none; }
.r-feed .a-page { font-size: 13.5px; line-height: 19px; }
.r-feed .a-req, .r-feed .a-out { font-size: 12.5px; }
[data-shell="b"] .l-side .l-nav[data-nav="recent"], [data-shell="b"] .l-side .l-nav[data-nav="pinned"], [data-shell="b"] .l-side .l-nav[data-nav="shared"] { display: none; }
[data-shell="b"] .l-tree .l-nav { height: 34px; }
[data-shell="b"] .l-tree .l-glyph { width: 18px; height: 18px; }

/* Option C: no fixed sidebar. Home is a desk: what moved since you last looked, then the shelf of folders. */
[data-shell="c"] .l { grid-template-columns: minmax(0, 1fr); }
[data-shell="c"] .l-side { position: fixed; inset: 0 auto 0 0; z-index: 40; width: 272px; transform: translateX(-100%); transition: transform 0.26s cubic-bezier(0.25, 1, 0.5, 1); }
[data-shell="c"] .l.is-drawer .l-side { transform: none; box-shadow: 0 0 40px rgba(0, 0, 0, 0.2); }
[data-shell="c"] .l.is-drawer .l-scrim { display: block; position: fixed; inset: 0; z-index: 39; background: rgba(0, 0, 0, 0.24); }
[data-shell="c"] #menu { display: inline-grid; }
[data-shell="c"] .l-bar { grid-template-columns: auto minmax(0, 1fr) minmax(0, 560px) minmax(0, 1fr); padding-left: 10px; }
[data-shell="c"] .l-bar > #menu + .l-crumb { grid-column: 2; }
[data-shell="c"] .h-main { max-width: 1320px; margin: 0 auto; }
.d-head { margin: 8px 0 26px; }
.d-head h1 { margin: 0; font: 600 26px/32px var(--sans); letter-spacing: -0.02em; }
.d-head p { margin: 6px 0 0; font-size: 13.5px; color: var(--s); }
.d-desk { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 28px; align-items: start; }
.d-col h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font: 600 14px/20px var(--sans); }
.d-col h2 .l-n { font: 500 12px var(--sans); color: var(--t); }
.d-col .a-list { max-width: none; }
.d-col + .d-col .a-item { grid-template-columns: minmax(0, 1fr); }
.d-col + .d-col .a-shot { display: none; }
.d-shelf { display: grid; grid-auto-flow: column; grid-auto-columns: 168px; gap: 18px; overflow-x: auto; padding: 14px 2px 6px; scrollbar-width: thin; }
.d-shelf .fo { max-width: none; }
@media (max-width: 1100px) { .d-desk { grid-template-columns: minmax(0, 1fr); } [data-shell="b"] .l-rail { width: 300px; } }
@media (max-width: 760px) { [data-shell="b"] .l-rail { display: none; } .a-item { grid-template-columns: minmax(0, 1fr); } .a-shot { display: none; } [data-shell="c"] .l-bar { grid-template-columns: auto minmax(0, 1fr) auto; } }

`;

/**
 * The library. The script draws it from the JSON block. The address keeps the view:
 * `/` is Home, `/?f=<folder id>` a folder, `/?v=recent|pinned|shared` a list.
 */
export function libraryHtml(pages: PageRow[], folders: FolderRow[], activity: ActivityRow[], nonce: string) {
  const body = `<style>${LIB_CSS}</style>
<div class="l" id="app">
  <aside class="l-side" id="side" aria-label="Library">
    <a class="l-brand" href="/">${MARK}Pages</a>
    <div id="side-top"></div>
    <a class="l-nav" href="/" data-nav="home">${lu('home')}Home</a>
    <a class="l-nav" href="/?v=recent" data-nav="recent">${lu('clock')}Recent</a>
    <a class="l-nav" href="/?v=pinned" data-nav="pinned">${icon('pin')}Pinned<span class="l-n" id="n-pinned"></span></a>
    <a class="l-nav" href="/?v=shared" data-nav="shared">${lu('users')}Shared by link<span class="l-n" id="n-shared"></span></a>
    <div class="l-sec">Folders<button type="button" class="v-icon" id="new-folder" aria-label="New folder" data-tip="New folder" data-tip-end>${lu('plus')}</button></div>
    <nav class="l-tree" id="tree" aria-label="Folders"></nav>
  </aside>
  <div class="l-scrim" id="scrim"></div>
  <div class="l-main">
    <header class="v-bar l-bar">
      <button type="button" class="v-icon" id="menu" aria-label="Folders">${lu('panel')}</button>
      <div class="l-crumb" id="crumb"></div>
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
        <div class="v-label">Layout option</div>
        <div class="l-shells" id="shells"><a href="/?shell=a">A. Inbox</a><a href="/?shell=b">B. Spaces</a><a href="/?shell=c">C. Desk</a></div>
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
    <div class="l-body"><div class="h-scroll" id="scroll"><main class="h-main" id="main"></main></div><aside class="l-rail" id="rail" aria-label="Activity here"></aside></div>
  </div>
</div>
<div class="v-pop" id="pop-card" data-anchor hidden>
  <button type="button" class="v-item" data-act="pin">${icon('pin')}<span>Pin</span></button>
  <button type="button" class="v-item" data-act="move">${lu('move')}Move to folder</button>
  <button type="button" class="v-item" data-act="copy">${icon('link')}Copy link</button>
  <a class="v-item" data-act="tab" target="_blank" rel="noopener">${icon('open')}Open in new tab</a>
</div>
<div class="v-pop l-movelist" id="pop-move" data-anchor hidden></div>
<div class="v-pop l-edit" id="pop-folder" data-anchor hidden>
  <input id="fname" type="text" maxlength="80" placeholder="Folder name" aria-label="Folder name" autocomplete="off">
  <div class="l-swatches" id="swatches" role="group" aria-label="Color"></div>
  <div class="l-edit-row"><button type="button" class="v-create" id="fsave">Create folder</button></div>
  <button type="button" class="v-item is-danger" id="fdelete" hidden>${icon('trash')}Delete folder, keep its pages</button>
</div>
<div class="v-toast" id="toast" role="status" hidden></div>
<script type="application/json" id="data">${data({ pages, folders, activity, kit: KIT, marks: AGENT_MARKS, icons: { inbox: LUCIDE.inbox, activity: LUCIDE.activity, send: LUCIDE.send, check: LUCIDE.check, alert: LUCIDE.alert, home: LUCIDE.home, open: ICON.open, more: ICON.more, pin: ICON.pin, lock: ICON.lock, globe: ICON.globe, right: ICON.right, pencil: LUCIDE.pencil, folder: LUCIDE.folder, deck: LUCIDE.deck, doc: LUCIDE.doc } })}</script>`;

  const script =
    COMMON_SCRIPT +
    `
const D = JSON.parse($('#data').textContent);
const svg = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + D.icons[name] + '</svg>';
const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pages = D.pages, folders = D.folders;
const COLORS = ['blue', 'teal', 'green', 'amber', 'coral', 'pink', 'purple', 'red', 'gray'];
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

let view = 'grid';
try { if (localStorage.getItem('library-view') === 'list') view = 'list'; } catch {}
let hits = null, sel = -1, menuSlug = null, editId = null, editColor = null, dragSlug = null;
const expanded = new Set();
try { JSON.parse(localStorage.getItem('library-open') || '[]').forEach((id) => expanded.add(id)); } catch {}

// ─── Where we are ─────────────────────────────────────────
function placeFromUrl() {
  const u = new URLSearchParams(location.search);
  const f = u.get('f');
  if (f && folders.some((x) => x.id === f)) return { folder: f };
  const v = u.get('v');
  return { list: v === 'recent' || v === 'pinned' || v === 'shared' || v === 'activity' ? v : 'home' };
}
let place = placeFromUrl();
const urlOf = (p) => p.folder ? '/?f=' + encodeURIComponent(p.folder) : p.list === 'home' ? '/' : '/?v=' + p.list;
function go(p, push = true) {
  place = p; hits = null; sel = -1;
  $('#q').value = ''; $('#q').parentElement.classList.remove('has-q');
  if (push) history.pushState(null, '', urlOf(p));
  closeDrawer();
  render();
  $('#scroll').scrollTop = 0;
}
addEventListener('popstate', () => { place = placeFromUrl(); hits = null; render(); });

// ─── The folder tree ──────────────────────────────────────
const folderOf = (id) => folders.find((f) => f.id === id);
const childrenOf = (id) => folders.filter((f) => f.parent_id === id).sort((a, b) => a.name.localeCompare(b.name));
const pathOf = (id) => { const out = []; for (let f = folderOf(id), n = 0; f && n < 64; f = folderOf(f.parent_id), n++) out.unshift(f); return out; };
/** Every page in a folder and the folders below it, newest first. */
function pagesUnder(id) {
  const ids = new Set([id]);
  for (let grew = true; grew;) { grew = false; for (const f of folders) if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) { ids.add(f.id); grew = true; } }
  return pages.filter((p) => ids.has(p.folder_id)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
const ramp = (f) => 'c-' + (f && f.color ? f.color : 'gray');

function renderTree() {
  const here = place.folder;
  pathOf(here).forEach((f) => f.id !== here && expanded.add(f.id));
  const row = (f, d) => {
    const kids = childrenOf(f.id), open = expanded.has(f.id);
    return '<a class="l-nav ' + ramp(f) + '" href="' + urlOf({ folder: f.id }) + '" data-go-folder="' + f.id + '" style="--d:' + d + '"' + (here === f.id ? ' aria-current="page"' : '') + '>'
      + '<span class="l-caret' + (kids.length ? (open ? ' is-open' : '') : ' is-none') + '" data-caret="' + f.id + '">' + svg('right') + '</span>'
      + '<svg class="l-glyph fo" viewBox="0 0 24 24" aria-hidden="true">' + D.icons.folder + '</svg>' + h(f.name)
      + (SHELL === 'b' || SHELL === 'a' ? dot(folderState(f.id), STATE_LABEL[folderState(f.id)]) : '')
      + '<span class="l-n">' + pagesUnder(f.id).length + '</span></a>'
      + (open ? kids.map((k) => row(k, d + 1)).join('') : '');
  };
  const top = childrenOf(null);
  $('#tree').innerHTML = top.length ? top.map((f) => row(f, 0)).join('') : '<p class="l-empty-tree">No folders yet.</p>';
  $$('[data-nav]').forEach((a) => { if (!here && a.dataset.nav === place.list) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const pinned = pages.filter((p) => p.pinned_at).length, shared = pages.filter((p) => p.shared).length;
  $('#n-pinned').textContent = pinned || '';
  $('#n-shared').textContent = shared || '';
}
$('#tree').addEventListener('click', (e) => {
  const caret = e.target.closest('[data-caret]');
  if (caret && !caret.classList.contains('is-none')) {
    e.preventDefault();
    const id = caret.dataset.caret;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    try { localStorage.setItem('library-open', JSON.stringify([...expanded])); } catch {}
    renderTree();
    return;
  }
  const a = e.target.closest('[data-go-folder]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); go({ folder: a.dataset.goFolder }); }
});
$$('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); go({ list: a.dataset.nav }); }));

// ─── Pieces ───────────────────────────────────────────────
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 172800) return 'yesterday';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const tUrl = (p, theme) => '/t/' + p.slug + '/' + p.thumb + '/' + theme + '.webp?k=' + D.kit;
const imgs = (p, cls) => '<img class="' + cls + ' h-light" src="' + tUrl(p, 'light') + '" alt="" loading="lazy" decoding="async"><img class="' + cls + ' h-dark" src="' + tUrl(p, 'dark') + '" alt="" loading="lazy" decoding="async">';
const thumb = (p, sheets) => '<span class="h-thumb" data-thumb="' + p.slug + '"' + (sheets ? ' data-sheets="' + sheets + '"' : '') + '>' + (p.thumb ? imgs(p, 'h-img') : '<span class="h-ph">&lt;/&gt;</span>') + '</span>';
const access = (p) => '<span class="h-acc" title="' + (p.shared ? 'Shared by link' : 'Only you') + '">' + svg(p.shared ? 'globe' : 'lock') + '</span>';
const menu = (p) => '<button type="button" class="v-icon h-menu" aria-label="More for ' + h(p.title) + '" data-tip="More" data-tip-end aria-expanded="false">' + svg('more') + '</button>';
const kind = (p) => p.kind === 'deck' ? '<span class="h-kind">Deck</span>' : '';
const where = (p) => { const f = folderOf(p.folder_id); return f ? f.name : 'Not in a folder'; };
// Outside a folder, a card says which folder holds the page. Inside one, it says when it was published.
const subText = (p) => place.folder ? 'Published ' + ago(p.updated_at) : where(p) + ', ' + ago(p.updated_at);
const card = (p) => '<article class="h-card" data-slug="' + p.slug + '" draggable="true"><a class="h-link" href="/p/' + p.slug + '" draggable="false">'
  + thumb(p, Math.min(2, p.latest - 1)).replace(/<\\/span>$/, (() => { const r = working().find((x) => x.slug === p.slug); return r ? '<span class="h-badge">' + markOf(r.agent) + AGENT[r.agent] + ' is working</span></span>' : '</span>'; })()) + '<span class="h-title">' + h(p.title) + '</span>'
  + '<span class="h-sub">' + access(p) + kind(p) + '<span>' + h(subText(p)) + '</span><span class="h-v">v' + p.latest + '</span></span></a>' + menu(p) + '</article>';
const row = (p) => '<article class="h-row" data-slug="' + p.slug + '" draggable="true"><a class="h-link" href="/p/' + p.slug + '" draggable="false">'
  + thumb(p, 0) + '<span class="h-title">' + h(p.title) + ' ' + kind(p) + '</span><span class="h-where">' + svg('folder') + '<span>' + h(where(p)) + '</span></span>'
  + '<span class="h-when">Published ' + ago(p.updated_at) + '</span><span class="h-v">v' + p.latest + '</span>' + access(p) + '</a>' + menu(p) + '</article>';

// The fan: the back page leans left, the middle one right, the newest stands in front.
// Open, the pages rise out of the folder at full size and spread a little. They stay inside the back panel's width, so its edges and tab still show.
const FAN = [{ x: '-4%', y: '-15%', r: '-2.5deg', s: 1 }, { x: '4%', y: '-13%', r: '2deg', s: 1 }, { x: '0%', y: '-7%', r: '0deg', s: 1 }];
// The back and its tab, on a 300 by 200 grid: a rounded tab on the left that slopes down into the back panel.
const FOLDER_BACK = '<svg class="fo-back" viewBox="0 0 300 200" preserveAspectRatio="none" aria-hidden="true"><path d="M0 12C0 5.4 5.4 0 12 0H92C98 0 101.5 2.4 104.6 6.6L111 15.4C113.6 19 116.4 20 121 20H288C294.6 20 300 25.4 300 32V188C300 194.6 294.6 200 288 200H12C5.4 200 0 194.6 0 188Z"/></svg>';
function folderCard(f) {
  const inside = pagesUnder(f.id), kids = childrenOf(f.id).length;
  const top = inside.slice(0, 3).reverse();
  const sheets = (top.length ? top : [null]).map((p, j, all) => {
    const i = 3 - all.length + j, fan = FAN[i];
    return '<span class="fo-sheet' + (i === 2 ? ' is-front' : '') + (p && p.thumb ? '' : ' is-blank') + '" style="--i:' + i + ';--x:' + fan.x + ';--y:' + fan.y + ';--r:' + fan.r + ';--s:' + fan.s + '"' + (p ? ' data-sheet="' + p.slug + '"' : '') + '>' + (p && p.thumb ? imgs(p, '') : '') + '</span>';
  }).join('');
  const bits = [inside.length + (inside.length === 1 ? ' page' : ' pages')];
  if (kids) bits.push(kids + (kids === 1 ? ' folder' : ' folders'));
  const when = inside[0] ? ago(inside[0].updated_at) : '';
  return '<a class="fo ' + ramp(f) + '" href="' + urlOf({ folder: f.id }) + '" data-folder="' + f.id + '">'
    + '<span class="fo-obj">' + FOLDER_BACK + sheets + '<span class="fo-front"></span></span>'
    + '<span class="fo-label"><span class="fo-text"><span class="fo-name">' + h(f.name) + dot(folderState(f.id), STATE_LABEL[folderState(f.id)]) + '</span><span class="fo-meta">' + h(bits.join(', ')) + (when ? ', ' + h(when) : '') + '</span></span>'
    + '<button type="button" class="v-icon fo-menu" data-edit="' + f.id + '" aria-label="Edit ' + h(f.name) + '" data-tip="Edit" data-tip-end aria-expanded="false">' + svg('more') + '</button></span></a>';
}

const mark = (s) => h(s).replace(/\\u0002/g, '<mark>').replace(/\\u0003/g, '</mark>');
const unmark = (s) => s.replace(/[\\u0002\\u0003]/g, '');
function hit(x) {
  const inTitle = unmark(x.snippet) === x.title;
  const p = pages.find((q) => q.slug === x.slug);
  return '<a class="h-hit" data-slug="' + x.slug + '" href="/p/' + x.slug + (x.anchor ? '#' + x.anchor : '') + '"><span class="h-hit-head"><span class="h-title">' + (inTitle ? mark(x.snippet) : h(x.title)) + '</span>'
    + '<span class="h-where">' + svg('folder') + '<span>' + h(p ? where(p) : '') + '</span></span></span>'
    + (x.heading ? '<span class="h-hit-where">' + (unmark(x.snippet) === x.heading ? mark(x.snippet) : h(x.heading)) + '</span>' : '')
    + (inTitle || !x.snippet || unmark(x.snippet) === x.heading ? '' : '<span class="h-hit-snip">' + mark(x.snippet) + '</span>') + '</a>';
}

const block = (title, list, more) => '<section class="l-block"><div class="l-head"><h2>' + title + '</h2>' + (more || '') + '</div><div class="h-' + view + '">' + list.map(view === 'grid' ? card : row).join('') + '</div></section>';
const folderBlock = (list, title) => '<section class="l-block"><div class="l-head"><h2>' + title + '</h2></div><div class="l-folders">' + list.map(folderCard).join('') + '</div></section>';
const byNew = (a, b) => b.updated_at.localeCompare(a.updated_at);

function renderCrumb() {
  const c = $('#crumb');
  let html = '';
  if (place.folder) {
    const path = pathOf(place.folder);
    html = '<a href="/" data-crumb="">Home</a>' + path.map((f, i) => '<span class="l-sep">' + svg('right') + '</span>' + (i === path.length - 1 ? '<span class="l-here">' + h(f.name) + '</span>' : '<a href="' + urlOf({ folder: f.id }) + '" data-crumb="' + f.id + '">' + h(f.name) + '</a>')).join('');
  } else html = '<span class="l-here">' + ({ home: SHELL === 'b' ? 'Everything' : 'Home', recent: 'Recent', pinned: 'Pinned', shared: 'Shared by link', activity: 'Activity' })[place.list] + '</span>';
  c.innerHTML = html;
}
$('#crumb').addEventListener('click', (e) => {
  const a = e.target.closest('[data-crumb]');
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  go(a.dataset.crumb ? { folder: a.dataset.crumb } : { list: 'home' });
});

function render() {
  const main = $('#main');
  $$('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  renderTree();
  renderCrumb();
  renderSideTop();
  renderRail();
  if (hits) {
    main.innerHTML = hits.length
      ? '<div class="l-head"><h2>' + hits.length + (hits.length === 1 ? ' page matches' : ' pages match') + '</h2></div><div class="h-hits">' + hits.map(hit).join('') + '</div>'
      : '<p class="h-none">No page has text that matches \\u201c' + h($('#q').value.trim()) + '\\u201d.</p>';
  } else if (!pages.length && !folders.length) {
    main.innerHTML = '<div class="l-empty"><b>No pages yet</b><span>Publish one with <code>agent-pages publish &lt;page&gt;</code>.</span></div>';
  } else if (place.folder) {
    const f = folderOf(place.folder), kids = childrenOf(f.id), here = pages.filter((p) => p.folder_id === f.id).sort(byNew);
    const all = pagesUnder(f.id);
    document.title = f.name + ' \\u2013 Pages';
    main.innerHTML = '<div class="l-title"><h1>' + h(f.name) + '</h1><button type="button" class="v-icon" data-edit="' + f.id + '" aria-label="Edit folder" data-tip="Edit folder" aria-expanded="false">' + svg('pencil') + '</button><p>' + all.length + (all.length === 1 ? ' page' : ' pages') + (all[0] ? ', last published ' + ago(all[0].updated_at) : '') + '</p></div>'
      + (kids.length ? folderBlock(kids, 'Folders') : '')
      + (here.length ? block('Pages', here) : (kids.length ? '' : '<div class="l-empty"><b>This folder is empty</b><span>Drag a page here, or choose Move to folder from a page\\u2019s menu.</span></div>'));
  } else {
    document.title = 'Pages';
    const pinned = pages.filter((p) => p.pinned_at).sort((a, b) => b.pinned_at.localeCompare(a.pinned_at));
    const recent = [...pages].sort(byNew);
    if (place.list === 'activity') { document.title = 'Activity \u2013 Pages'; main.innerHTML = '<div class="l-title"><h1>Activity</h1><p>Requests you made to assistants in page comments, and what came of them.</p></div>' + activityHtml(null); }
    else if (place.list === 'recent') main.innerHTML = block('Recent', recent);
    else if (place.list === 'pinned') main.innerHTML = pinned.length ? block('Pinned', pinned) : '<div class="l-empty"><b>No pinned pages</b><span>Pin a page from its menu, or press p.</span></div>';
    else if (place.list === 'shared') { const s = recent.filter((p) => p.shared); main.innerHTML = s.length ? block('Shared by link', s) : '<div class="l-empty"><b>No shared pages</b><span>A page shows here once it has a share link.</span></div>'; }
    else {
      const top = childrenOf(null);
      const n = needs();
      if (SHELL === 'c') main.innerHTML = deskHtml();
      else main.innerHTML = (SHELL === 'a' && n.length ? '<section class="l-block"><div class="l-head"><h2>' + dot('needs', '') + 'Needs you</h2><button type="button" class="l-more" data-see="activity">Open Activity</button></div><div class="l-strip">' + n.slice(0, 3).map(actItem).join('') + '</div></section>' : '')
        + (top.length ? folderBlock(top, 'Folders') : '')
        + (pinned.length ? block(svg('pin') + 'Pinned', pinned) : '')
        + block('Recent', recent.slice(0, 12), recent.length > 12 ? '<button type="button" class="l-more" data-see="recent">See all ' + recent.length + '</button>' : '');
    }
  }
  select(Math.min(sel, entries().length - 1), false);
}

// ─── Layout option. ?shell=a|b|c picks one, and the choice is kept in this browser. ───
const SHELL = (() => {
  const q = new URLSearchParams(location.search).get('shell');
  try { if (q) localStorage.setItem('ap-shell', q); return ['a', 'b', 'c'].includes(q) ? q : (localStorage.getItem('ap-shell') || 'a'); } catch { return q || 'a'; }
})();
document.body.dataset.shell = SHELL;
$$('#shells a').forEach((a) => a.setAttribute('aria-current', String(a.getAttribute('href').endsWith(SHELL))));

// ─── Activity: assistant runs (from comments) and published versions ───
const AGENT = { claude: 'Claude', chatgpt: 'ChatGPT' };
const markOf = (a) => '<svg class="a-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="' + (D.marks[a] || '') + '"/></svg>';
const runs = D.activity.filter((a) => a.kind === 'run');
const versionsAct = D.activity.filter((a) => a.kind === 'version');
const runKey = (r) => r.slug + '@' + r.at;
const reviewed = (() => { try { return new Set(JSON.parse(localStorage.getItem('ap-reviewed') || '[]')); } catch { return new Set(); } })();
const saveReviewed = () => { try { localStorage.setItem('ap-reviewed', JSON.stringify([...reviewed])); } catch {} };
const isNeeds = (r) => r.status === 'failed' || (r.status === 'done' && !reviewed.has(runKey(r)));
const needs = () => runs.filter(isNeeds);
const working = () => runs.filter((r) => r.status === 'running');
function slugState(slug) {
  const rs = runs.filter((r) => r.slug === slug);
  return rs.some((r) => r.status === 'running') ? 'running' : rs.some((r) => r.status === 'failed') ? 'failed' : rs.some(isNeeds) ? 'needs' : '';
}
function folderState(id) {
  const st = pagesUnder(id).map((p) => slugState(p.slug));
  return st.includes('running') ? 'running' : st.includes('failed') ? 'failed' : st.includes('needs') ? 'needs' : '';
}
const dot = (st, label) => st ? '<span class="st is-' + st + '" title="' + label + '"></span>' : '';
const STATE_LABEL = { running: 'An assistant is working here', needs: 'A change waits for your review', failed: 'A request failed' };
function dur(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; }
function actItem(r) {
  const p = pageOf(r.slug);
  const title = p ? p.title : r.slug;
  const verb = r.status === 'running' ? 'is working on' : r.status === 'failed' ? 'could not finish' : 'changed';
  const when = r.status === 'running' ? '' : '<span class="a-when">' + ago(r.finished_at || r.at) + '</span>';
  let out = '';
  if (r.status === 'running') out = '<div class="a-live" data-since="' + r.at + '"><span class="a-bar"></span><span class="a-t">' + dur(Date.now() - Date.parse(r.at)) + '</span></div>';
  else if (r.status === 'failed') out = '<p class="a-out is-failed">' + h(r.detail && r.detail.startsWith('not_signed_in') ? AGENT[r.agent] + ' is not connected, so the request did not run.' : (r.detail || 'The run failed.')) + '</p>';
  else out = '<p class="a-out">' + h(r.detail || '') + (r.ms ? ' Took ' + dur(r.ms) + '.' : '') + '</p>';
  const acts = r.status === 'done' && isNeeds(r)
    ? '<div class="a-acts"><a class="a-btn is-main" href="/p/' + r.slug + '">Review the change</a><button type="button" class="a-btn" data-reviewed="' + h(runKey(r)) + '">' + svg('check') + 'Mark reviewed</button></div>'
    : r.status === 'failed' ? '<div class="a-acts"><button type="button" class="a-btn is-main" data-connect="' + r.agent + '">Connect ' + AGENT[r.agent] + '</button><a class="a-btn" href="/p/' + r.slug + '">Open the comment</a></div>' : '';
  return '<article class="a-item is-' + r.status + (isNeeds(r) ? ' is-new' : '') + '">'
    + '<div class="a-who">' + markOf(r.agent) + '<span><b>' + AGENT[r.agent] + '</b> ' + verb + '</span>' + when + '</div>'
    + '<a class="a-page" href="/p/' + r.slug + '">' + h(title) + '</a>'
    + '<blockquote class="a-req">' + h(r.request.replace(/^@\\w+\\s*/, '')) + '<span class="a-on">You asked' + (r.quote ? ' about \u201c' + h(r.quote) + '\u201d' : '') + ', ' + ago(r.at) + '</span></blockquote>'
    + out + acts
    + (p ? '<a class="a-shot" href="/p/' + r.slug + '" tabindex="-1" aria-hidden="true">' + thumb(p) + '</a>' : '')
    + '</article>';
}
const verRow = (v) => { const p = pageOf(v.slug); return p ? '<div class="a-ver">' + svg('activity') + '<a href="/p/' + v.slug + '"><b>' + h(p.title) + '</b>, version ' + v.version + ' published</a><span class="a-when">' + ago(v.at) + '</span></div>' : ''; };
const listOr = (items, none) => items.length ? '<div class="a-list">' + items.join('') + '</div>' : '<p class="a-none">' + none + '</p>';
function activityHtml(scope) {
  const inScope = (x) => !scope || pagesUnder(scope).some((p) => p.slug === x.slug);
  const n = needs().filter(inScope), w = working().filter(inScope);
  const done = runs.filter((r) => !isNeeds(r) && r.status !== 'running' && inScope(r));
  return '<section class="l-block"><div class="l-head"><h2>' + dot(n.length ? 'needs' : '', '') + 'Needs you</h2></div>' + listOr(n.map(actItem), 'Nothing waits for you.') + '</section>'
    + '<section class="l-block"><div class="l-head"><h2>' + dot(w.length ? 'running' : '', '') + 'Working now</h2></div>' + listOr(w.map(actItem), 'No assistant is working.') + '</section>'
    + '<section class="l-block"><div class="l-head"><h2>Earlier</h2></div>' + listOr(done.map(actItem), 'No earlier requests.') + '<div style="margin-top:14px">' + versionsAct.filter(inScope).slice(0, 12).map(verRow).join('') + '</div></section>';
}
// Running timers tick once a second.
setInterval(() => $$('.a-live[data-since]').forEach((el) => { el.querySelector('.a-t').textContent = dur(Date.now() - Date.parse(el.dataset.since)); }), 1000);
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-reviewed]');
  if (b) { reviewed.add(b.dataset.reviewed); saveReviewed(); render(); toast('Marked reviewed'); return; }
  const c = e.target.closest('[data-connect]');
  if (c) toast('Connecting an assistant is not built in this prototype');
});

// Option A: the inbox rows at the top of the sidebar.
function renderSideTop() {
  const el = $('#side-top');
  if (SHELL !== 'a') { el.innerHTML = ''; return; }
  const n = needs().length, w = working().length, on = place.list === 'activity';
  el.innerHTML = '<a class="l-nav" href="/?v=activity" data-nav="activity"' + (on ? ' aria-current="page"' : '') + '>' + svg('inbox') + 'Needs you' + dot(n ? 'needs' : '', '') + '<span class="l-n is-on">' + (n || '') + '</span></a>'
    + '<a class="l-nav" href="/?v=activity#working" data-nav="activity">' + svg('activity') + 'Working now' + dot(w ? 'running' : '', '') + '<span class="l-n is-on">' + (w || '') + '</span></a>'
    + '<div style="height:12px"></div>';
}

// Option B: the rail. Its scope follows where you are: everything at Home, one folder inside a folder.
function renderRail() {
  const el = $('#rail');
  if (SHELL !== 'b') { el.innerHTML = ''; return; }
  const f = place.folder ? folderOf(place.folder) : null;
  const n = needs().filter((r) => !f || pagesUnder(f.id).some((p) => p.slug === r.slug));
  const w = working().filter((r) => !f || pagesUnder(f.id).some((p) => p.slug === r.slug));
  const rest = runs.filter((r) => !isNeeds(r) && r.status !== 'running' && (!f || pagesUnder(f.id).some((p) => p.slug === r.slug)));
  el.innerHTML = '<div class="r-ask"><p class="r-scope">Ask in <b>' + (f ? h(f.name) : 'all pages') + '</b></p>'
    + '<div class="r-box"><textarea id="ask" placeholder="' + (f ? 'Make a page from the notes in this folder\u2026' : 'Ask for a new page or a change\u2026') + '"></textarea>'
    + '<div class="r-row"><button type="button" class="r-who" aria-pressed="true">' + markOf('claude') + 'Claude</button><button type="button" class="r-who" aria-pressed="false">' + markOf('chatgpt') + 'ChatGPT</button>'
    + '<button type="button" class="v-icon r-send" id="ask-send" aria-label="Send">' + svg('send') + '</button></div></div></div>'
    + '<div class="r-feed">'
    + (n.length ? '<h3>' + dot('needs', '') + 'Needs you</h3>' + n.map(actItem).join('') : '')
    + (w.length ? '<h3>' + dot('running', '') + 'Working now</h3>' + w.map(actItem).join('') : '')
    + (rest.length ? '<h3>Earlier</h3>' + rest.map(actItem).join('') : '')
    + (!n.length && !w.length && !rest.length ? '<p class="a-none">No requests in this folder yet.</p>' : '')
    + '</div>';
}
document.addEventListener('click', (e) => {
  const w = e.target.closest('.r-who');
  if (w) { $$('.r-who').forEach((x) => x.setAttribute('aria-pressed', String(x === w))); return; }
  if (e.target.closest('#ask-send')) toast('Sending a request from here is not built in this prototype');
});

// Option C: the desk.
function deskHtml() {
  const n = needs(), w = working();
  const top = childrenOf(null);
  const recent = [...pages].sort(byNew);
  const count = n.length + w.length;
  return '<div class="d-head"><h1>' + (count ? (n.length ? n.length + (n.length === 1 ? ' change waits' : ' changes wait') + ' for you' : 'Nothing waits for you') : 'All caught up') + '</h1>'
    + '<p>' + (w.length ? w.length + (w.length === 1 ? ' assistant is' : ' assistants are') + ' working. ' : '') + pages.length + ' pages in ' + folders.length + ' folders.</p></div>'
    + '<div class="d-desk"><div class="d-col"><h2>' + dot(n.length ? 'needs' : '', '') + 'Needs you<span class="l-n">' + (n.length || '') + '</span></h2>' + listOr(n.slice(0, 3).map(actItem), 'Nothing waits for you.') + (n.length > 3 ? '<button type="button" class="l-more" data-see="activity" style="margin-top:10px">See all ' + n.length + '</button>' : '') + '</div>'
    + '<div class="d-col"><h2>' + dot(w.length ? 'running' : '', '') + 'Working now<span class="l-n">' + (w.length || '') + '</span></h2>' + listOr(w.map(actItem), 'No assistant is working.') + '</div></div>'
    + '<section class="l-block" style="margin-top:40px"><div class="l-head"><h2>Folders</h2></div><div class="d-shelf">' + top.map(folderCard).join('') + '</div></section>'
    + block('Recent', recent.slice(0, 12), recent.length > 12 ? '<button type="button" class="l-more" data-see="recent">See all ' + recent.length + '</button>' : '');
}
const entries = () => $$('#main [data-slug]');
function select(i, scroll = true) {
  sel = i;
  entries().forEach((el, j) => el.classList.toggle('is-sel', j === i));
  if (scroll && i >= 0) entries()[i].scrollIntoView({ block: 'nearest' });
}
const current = () => entries()[sel];
const pageOf = (slug) => pages.find((p) => p.slug === slug);

// ─── Opening a folder: its pages fly from the folder to their places ───
function openFolder(el) {
  const id = el.dataset.folder;
  const from = $$('.fo-sheet[data-sheet]', el).map((s) => ({ slug: s.dataset.sheet, rect: s.getBoundingClientRect(), img: s.querySelector('img:not([hidden])') }));
  go({ folder: id });
  if (reduce || !from.length) return;
  for (const s of from) {
    const target = $('#main [data-thumb="' + CSS.escape(s.slug) + '"]');
    if (!target) continue;
    const to = target.getBoundingClientRect();
    if (to.top > innerHeight) continue;
    const ghost = document.createElement('div');
    ghost.style.cssText = 'position:fixed;z-index:30;overflow:hidden;pointer-events:none;border-radius:3px;background:var(--bg2);box-shadow:0 10px 24px rgba(0,0,0,.18);left:' + s.rect.left + 'px;top:' + s.rect.top + 'px;width:' + s.rect.width + 'px;height:' + s.rect.height + 'px';
    const shown = [...target.querySelectorAll('img')].find((i) => getComputedStyle(i).display !== 'none');
    if (shown) { const c = shown.cloneNode(); c.style.cssText = 'width:100%;height:100%;object-fit:cover;object-position:top;display:block'; ghost.append(c); }
    document.body.append(ghost);
    target.style.visibility = 'hidden';
    const dx = to.left - s.rect.left, dy = to.top - s.rect.top, sx = to.width / s.rect.width, sy = to.height / s.rect.height;
    ghost.animate([{ transform: 'none', borderRadius: '3px' }, { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')', borderRadius: (10 / sx) + 'px' }],
      { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }).finished.then(() => { target.style.visibility = ''; ghost.remove(); });
    ghost.style.transformOrigin = '0 0';
  }
}

// A press shows the open folder for a moment before it opens, so a tap on a phone shows the fan too.
$('#main').addEventListener('pointerdown', (e) => { const f = e.target.closest('.fo'); if (f && !e.target.closest('.fo-menu')) f.classList.add('is-press'); });
addEventListener('pointerup', () => setTimeout(() => $$('.fo.is-press').forEach((f) => f.classList.remove('is-press')), 160));
addEventListener('pointercancel', () => $$('.fo.is-press').forEach((f) => f.classList.remove('is-press')));

$('#main').addEventListener('click', (e) => {
  const see = e.target.closest('[data-see]');
  if (see) { go({ list: see.dataset.see }); return; }
  const edit = e.target.closest('[data-edit]');
  if (edit) { e.preventDefault(); e.stopPropagation(); openEditor(edit, edit.dataset.edit, e.detail === 0); return; }
  const fo = e.target.closest('.fo');
  if (fo && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    const delay = matchMedia('(hover: none)').matches && !reduce ? 150 : 0;
    fo.classList.add('is-press');
    setTimeout(() => openFolder(fo), delay);
    return;
  }
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

// ─── Writes. Each one changes the page at once and undoes the change if the host refuses it. ───
const api = (path, method, body) => fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.status === 204 ? null : r.json(); });

const copyLink = (slug) => navigator.clipboard.writeText(location.origin + '/p/' + slug).then(() => toast('Link copied'), () => toast('Could not copy the link'));
async function togglePin(slug) {
  const p = pageOf(slug), was = p.pinned_at;
  p.pinned_at = was ? null : new Date().toISOString();
  render();
  toast(was ? 'Unpinned' : 'Pinned');
  try { await api('/api/pages/' + slug + '/pin', was ? 'DELETE' : 'PUT'); } catch { p.pinned_at = was; render(); toast('Could not change the pin'); }
}
async function movePage(slug, folderId) {
  const p = pageOf(slug), was = p.folder_id;
  if (was === folderId) return;
  p.folder_id = folderId;
  render();
  const f = folderOf(folderId);
  toast(f ? 'Moved to ' + f.name : 'Moved out of folders');
  try { await api('/api/pages/' + slug + '/folder', 'PUT', { folder_id: folderId }); } catch (err) { p.folder_id = was; render(); toast('Could not move the page: ' + err.message); }
}

$('#pop-card').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !menuSlug) return;
  if (act === 'move') { const anchor = $('#main [data-slug="' + CSS.escape(menuSlug) + '"] .h-menu'); closePop(); openMove(anchor, e.detail === 0); return; }
  closePop();
  if (act === 'pin') togglePin(menuSlug);
  if (act === 'copy') copyLink(menuSlug);
});

function openMove(anchor, viaKey) {
  const p = pageOf(menuSlug), pop = $('#pop-move');
  const rows = [];
  const walk = (parent, d) => childrenOf(parent).forEach((f) => { rows.push({ f, d }); walk(f.id, d + 1); });
  walk(null, 0);
  pop.innerHTML = '<div class="v-label">Move \\u201c' + h(p.title) + '\\u201d to</div>'
    + rows.map(({ f, d }) => '<button type="button" class="v-item ' + ramp(f) + '" data-to="' + f.id + '" style="padding-left:' + (10 + d * 14) + 'px"' + (p.folder_id === f.id ? ' aria-current="true" disabled' : '') + '><svg class="l-glyph fo" viewBox="0 0 24 24" aria-hidden="true" style="width:15px;height:15px;fill:var(--fo-front);stroke:var(--fo-edge)">' + D.icons.folder + '</svg>' + h(f.name) + '</button>').join('')
    + (rows.length ? '' : '<p class="h-none" style="padding:4px 10px 8px">Make a folder first.</p>')
    + (p.folder_id ? '<div class="v-hr"></div><button type="button" class="v-item" data-to="">Not in a folder</button>' : '');
  if (anchor) openPop(anchor, pop, viaKey);
}
$('#pop-move').addEventListener('click', (e) => {
  const b = e.target.closest('[data-to]');
  if (!b || b.disabled) return;
  closePop();
  movePage(menuSlug, b.dataset.to || null);
});

// ─── Folder editor: new folder, rename, color, delete ───
$('#swatches').innerHTML = COLORS.map((c) => '<button type="button" class="l-sw c-' + c + '" data-color="' + c + '" aria-label="' + c + '" aria-pressed="false"></button>').join('');
function openEditor(anchor, id, viaKey) {
  editId = id;
  const f = id ? folderOf(id) : null;
  editColor = f ? f.color : null;
  $('#fname').value = f ? f.name : '';
  $('#fsave').textContent = f ? 'Save' : (place.folder ? 'Create folder here' : 'Create folder');
  $('#fdelete').hidden = !f;
  $$('#swatches [data-color]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === editColor)));
  openPop(anchor, $('#pop-folder'), viaKey);
  setTimeout(() => $('#fname').focus(), 0);
}
$('#swatches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]');
  if (!b) return;
  editColor = editColor === b.dataset.color ? null : b.dataset.color;
  $$('#swatches [data-color]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.color === editColor)));
});
async function saveFolder() {
  const name = $('#fname').value.trim();
  if (!name) { $('#fname').focus(); return; }
  closePop();
  try {
    if (editId) {
      const f = await api('/api/folders/' + editId, 'PATCH', { name, color: editColor });
      Object.assign(folderOf(editId), f);
      toast('Saved');
    } else {
      const f = await api('/api/folders', 'POST', { name, color: editColor, parent_id: place.folder || null });
      folders.push(f);
      if (place.folder) expanded.add(place.folder);
      toast('Created ' + f.name);
    }
    render();
  } catch (err) { toast('Could not save the folder: ' + err.message); }
}
$('#fsave').addEventListener('click', saveFolder);
$('#fname').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveFolder(); } });
$('#fdelete').addEventListener('click', async () => {
  const f = folderOf(editId);
  closePop();
  try {
    await api('/api/folders/' + f.id, 'DELETE');
    pages.forEach((p) => { if (p.folder_id === f.id) p.folder_id = f.parent_id; });
    folders.forEach((x) => { if (x.parent_id === f.id) x.parent_id = f.parent_id; });
    folders.splice(folders.indexOf(f), 1);
    toast('Deleted ' + f.name + '. Its pages moved up.');
    if (place.folder === f.id) go(f.parent_id ? { folder: f.parent_id } : { list: 'home' }); else render();
  } catch (err) { toast('Could not delete the folder: ' + err.message); }
});
$('#new-folder').addEventListener('click', (e) => { e.stopPropagation(); openEditor(e.currentTarget, null, e.detail === 0); });

// ─── Drag a page onto a folder, in the grid or in the sidebar ───
document.addEventListener('dragstart', (e) => {
  const c = e.target.closest && e.target.closest('[data-slug][draggable="true"]');
  if (!c) return;
  dragSlug = c.dataset.slug;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', location.origin + '/p/' + dragSlug);
  c.classList.add('is-dragging');
});
document.addEventListener('dragend', () => { dragSlug = null; $$('.is-dragging, .is-drop').forEach((x) => x.classList.remove('is-dragging', 'is-drop')); });
const dropTarget = (e) => dragSlug && e.target.closest && e.target.closest('.fo[data-folder], .l-tree [data-go-folder]');
document.addEventListener('dragover', (e) => {
  const t = dropTarget(e);
  $$('.is-drop').forEach((x) => x !== t && x.classList.remove('is-drop'));
  if (!t) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  t.classList.add('is-drop');
});
document.addEventListener('drop', (e) => {
  const t = dropTarget(e);
  if (!t) return;
  e.preventDefault();
  t.classList.remove('is-drop');
  movePage(dragSlug, t.dataset.folder || t.dataset.goFolder);
});

// ─── The drawer on a phone ───
const closeDrawer = () => $('#app').classList.remove('is-drawer');
$('#menu').addEventListener('click', (e) => { e.stopPropagation(); $('#app').classList.toggle('is-drawer'); });
$('#scrim').addEventListener('click', closeDrawer);

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
