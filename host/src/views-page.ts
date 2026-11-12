// The Views page of a document: who read its share links, for how long, and how far.
// It follows DocSend's Activity tab and Papermark's document page: the totals, the average time on each part,
// one row for each visit that opens to show the time on each part, and the links with their counts.
// The server draws the whole page. A visit opens with <details>, so the page needs no script of its own.

import { COMMON_SCRIPT, esc, icon, shell } from './views';
import type { summarize } from './share-views';

type Views = ReturnType<typeof summarize>;

export interface ViewsInput {
  slug: string;
  title: string;
  repo: string | null;
  kind: string;
  views: Views;
}

const CSS = `
/* The slash before "Views" shows at every width. The viewer hides its other slashes on a phone. */
.v-crumb .vw-sep { display: inline; }
.vw { flex: 1; min-height: 0; overflow: auto; }
.vw-main { max-width: 1040px; margin: 0 auto; padding: 28px 28px 72px; }
.vw h1 { margin: 0; font: 600 22px/28px var(--sans); letter-spacing: -0.015em; }
.vw-lede { margin: 6px 0 0; max-width: 680px; font-size: 13.5px; line-height: 20px; color: var(--s); }
.vw h2 { margin: 36px 0 12px; font: 600 15px/20px var(--sans); }
.vw-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 24px; }
.vw-card { padding: 14px 16px; border: 0.5px solid var(--b2); border-radius: 12px; }
.vw-card b { display: block; font: 600 24px/30px var(--sans); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.vw-card span { font-size: 12.5px; color: var(--s); }
.vw-parts { display: grid; grid-template-columns: minmax(0, 1fr) 200px 64px 72px; align-items: center; gap: 8px 14px; font-size: 13px; }
.vw-parts .l { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.vw-bar { height: 8px; border-radius: 4px; background: color-mix(in srgb, var(--p) 8%, transparent); overflow: hidden; }
.vw-bar i { display: block; height: 100%; border-radius: 4px; background: var(--link); }
.vw-parts .n { text-align: right; font-variant-numeric: tabular-nums; }
.vw-parts .m { color: var(--t); text-align: right; font-size: 12px; }
.vw-head, .vw-visit > summary { display: grid; grid-template-columns: minmax(0, 1.6fr) 90px 140px minmax(0, 1fr) 130px 16px; align-items: center; gap: 14px; padding: 0 10px; }
.vw-head { height: 32px; font-size: 12px; color: var(--t); border-bottom: 0.5px solid var(--b); }
.vw-visit { border-bottom: 0.5px solid var(--b); }
.vw-visit > summary { min-height: 52px; list-style: none; cursor: pointer; border-radius: 8px; font-size: 13px; }
.vw-visit > summary::-webkit-details-marker { display: none; }
.vw-visit > summary:hover { background: var(--bg2); }
.vw-who b { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
.vw-who span, .vw-where span { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; color: var(--s); }
.vw-num { font-variant-numeric: tabular-nums; }
.vw-done { display: flex; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; }
.vw-done .vw-bar { flex: 1; height: 6px; }
.vw-when { color: var(--s); font-variant-numeric: tabular-nums; }
.vw-caret { color: var(--t); transition: transform 0.15s; }
.vw-caret svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; }
.vw-visit[open] .vw-caret { transform: rotate(90deg); }
.vw-visit .vw-parts { padding: 6px 10px 16px 10px; }
.vw-tag { margin-left: 6px; padding: 1px 6px; border-radius: 999px; background: var(--bg2); font: 500 11px var(--sans); color: var(--s); }
.vw-links { width: 100%; border-collapse: collapse; font-size: 13px; }
.vw-links th { height: 32px; padding: 0 10px; text-align: left; font-weight: 400; font-size: 12px; color: var(--t); border-bottom: 0.5px solid var(--b); }
.vw-links td { height: 44px; padding: 0 10px; border-bottom: 0.5px solid var(--b); }
.vw-links td.vw-num, .vw-links th.vw-num { text-align: right; }
.vw-links code { font: 12px var(--mono); color: var(--s); }
.vw-links .is-off td { color: var(--t); }
.vw-empty { margin-top: 28px; padding: 28px; border: 0.5px dashed var(--b2); border-radius: 12px; color: var(--s); font-size: 13.5px; line-height: 20px; }
.vw-empty b { display: block; margin-bottom: 4px; color: var(--p); font-size: 14px; }
@media (max-width: 760px) {
  .vw-main { padding: 18px 16px 56px; }
  .vw-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .vw-parts { grid-template-columns: minmax(0, 1fr) 90px 52px; }
  .vw-parts .m { display: none; }
  .vw-head { display: none; }
  .vw-visit > summary { grid-template-columns: minmax(0, 1fr) 64px 16px; padding: 8px 6px; }
  .vw-visit > summary .vw-done, .vw-visit > summary .vw-where, .vw-visit > summary .vw-when { display: none; }
  .vw-links .vw-hide { display: none; }
}
`;

/** A time as Papermark and DocSend show it: 45s, 3m 20s, 1h 5m. */
export function duration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '');
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

let regions: Intl.DisplayNames | null = null;
try { regions = new Intl.DisplayNames(['en'], { type: 'region' }); } catch {}
const countryName = (c: string | null) => (c ? (regions?.of(c) ?? c) : '');

const time = (iso: string) => `<time datetime="${esc(iso)}">${esc(iso.slice(0, 16).replace('T', ' '))}</time>`;

/** Bars for the time on each part. The longest time fills the bar. */
function partBars(rows: { label: string; ms: number; note?: string }[]) {
  const top = Math.max(1, ...rows.map((r) => r.ms));
  return `<div class="vw-parts">${rows
    .map((r) => `<span class="l" title="${esc(r.label)}">${esc(r.label)}</span><span class="vw-bar"><i style="width:${Math.max(2, Math.round((100 * r.ms) / top))}%"></i></span><span class="n">${duration(r.ms)}</span><span class="m">${esc(r.note ?? '')}</span>`)
    .join('')}</div>`;
}

export function viewsHtml(input: ViewsInput, nonce: string) {
  const { slug, title, repo, kind, views: v } = input;
  const unit = kind === 'deck' ? 'slide' : 'section';
  const linkName = new Map(v.links.map((l) => [l.token, l.name]));
  const linkOf = (token: string) => {
    const l = v.links.find((x) => x.token === token);
    return l ? l.name || 'Link from ' + l.created_at.slice(0, 10) : 'A deleted link';
  };
  const cards = [
    [String(v.totals.views), v.totals.views === 1 ? 'Visit' : 'Visits'],
    [String(v.totals.visitors), v.totals.visitors === 1 ? 'Visitor' : 'Visitors'],
    [v.totals.avg_ms ? duration(v.totals.avg_ms) : '–', 'Average time'],
    [v.totals.avg_ms ? v.totals.avg_completion + '%' : '–', 'Average completion'],
  ];
  const visits = v.visits
    .map((x) => {
      const who = linkName.get(x.token) || (linkName.has(x.token) ? 'Anonymous' : linkOf(x.token));
      const device = [x.os, x.device].filter(Boolean).join(' · ');
      const place = [countryName(x.country), x.referrer ? 'from ' + x.referrer : ''].filter(Boolean).join(', ');
      const detail = x.parts.length
        ? partBars(x.parts.map((p) => ({ label: p.label, ms: p.ms })))
        : '<p class="vw-lede" style="padding: 0 10px 14px">This visit has no active time.</p>';
      return `<details class="vw-visit"><summary>
        <span class="vw-who"><b>${esc(who)}${x.downloads ? '<span class="vw-tag">Downloaded</span>' : ''}</b><span>${esc(device)}</span></span>
        <span class="vw-num">${x.active_ms ? duration(x.active_ms) : '–'}</span>
        <span class="vw-done"><span class="vw-bar"><i style="width:${x.completion}%"></i></span>${x.completion}%</span>
        <span class="vw-where"><span>${esc(place || '–')}</span></span>
        <span class="vw-when">${time(x.started_at)}</span>
        <span class="vw-caret">${icon('right')}</span>
      </summary>${detail}</details>`;
    })
    .join('');
  const links = v.links
    .map((l) => `<tr${l.revoked_at ? ' class="is-off"' : ''}><td>${esc(l.name || 'No name')}${l.revoked_at ? '<span class="vw-tag">Revoked</span>' : ''}<br><code>/s/${esc(l.token.slice(0, 10))}…</code></td>
      <td class="vw-hide">${l.version ? 'v' + l.version : 'Latest'}</td><td class="vw-hide">${time(l.created_at)}</td><td class="vw-num">${l.views}</td><td>${l.last_at ? time(l.last_at) : '–'}</td></tr>`)
    .join('');
  const body = `<style>${CSS}</style><div class="v">
<header class="v-bar">
  <a class="v-icon" href="/p/${esc(slug)}" data-tip="Back to the page" data-tip-start aria-label="Back to the page">${icon('left')}</a>
  <div class="v-crumb">${repo ? `<span class="v-repo">${esc(repo)}</span><span class="v-slash">/</span>` : ''}<span class="v-title">${esc(title)}</span><span class="v-slash vw-sep">/</span><span>Views</span></div>
</header>
<div class="vw"><main class="vw-main">
  <h1>Views</h1>
  <p class="vw-lede">Visits to the share links of this page, newest first. A visit counts time only while the page is on screen and the reader was active in the last 5 minutes. Your own visits do not count. To know who read the page, make one named link for each reader.</p>
  ${
    v.totals.views
      ? `<div class="vw-cards">${cards.map(([n, l]) => `<div class="vw-card"><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join('')}</div>
  ${v.parts.length ? `<h2>Average time on each ${unit}</h2>${partBars(v.parts.map((p) => ({ label: p.label, ms: p.avg_ms, note: p.visits + (p.visits === 1 ? ' visit' : ' visits') })))}` : ''}
  <h2>Visits</h2>
  <div class="vw-head"><span>Visitor</span><span>Time</span><span>Completion</span><span>Location</span><span>Date</span><span></span></div>
  ${visits}`
      : `<div class="vw-empty"><b>No visits yet</b>${v.links.length ? 'A visit shows here when someone opens a share link of this page.' : 'Make a share link from the Share button of the page. A visit shows here when someone opens it.'}</div>`
  }
  ${v.links.length ? `<h2>Links</h2><table class="vw-links"><thead><tr><th>Link</th><th class="vw-hide">Points to</th><th class="vw-hide">Made</th><th class="vw-num">Visits</th><th>Last visit</th></tr></thead><tbody>${links}</tbody></table>` : ''}
</main></div>
</div>`;
  return shell(`Views – ${title}`, nonce, body, COMMON_SCRIPT);
}
