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
.vw-main { max-width: 880px; margin: 0 auto; padding: 32px 28px 72px; }
.vw h1 { margin: 0; font: 600 22px/28px var(--sans); letter-spacing: -0.015em; }
.vw h2 { margin: 40px 0 10px; font: 600 15px/20px var(--sans); }
.vw-stats { display: flex; gap: 48px; margin: 20px 0 0; }
.vw-stats div { display: flex; flex-direction: column-reverse; }
.vw-stats dt { font-size: 12.5px; color: var(--s); }
.vw-stats dd { margin: 0; font: 600 22px/28px var(--sans); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.vw-parts { display: grid; grid-template-columns: minmax(0, 1fr) minmax(80px, 220px) 56px; align-items: center; gap: 8px 14px; font-size: 13px; }
.vw-parts .l { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.vw-bar { height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--p) 8%, transparent); overflow: hidden; }
.vw-bar i { display: block; height: 100%; border-radius: 3px; background: var(--link); }
.vw-parts .n { text-align: right; font-variant-numeric: tabular-nums; }
.vw-head, .vw-visit > summary { display: grid; grid-template-columns: minmax(0, 1fr) 80px 96px 140px 16px; align-items: center; gap: 14px; padding: 0 10px; }
.vw-head { height: 32px; font-size: 12px; color: var(--s); border-bottom: 0.5px solid var(--b); }
.vw-head .r, .vw-visit .r { text-align: right; }
.vw-visit { border-bottom: 0.5px solid var(--b); }
.vw-visit > summary { min-height: 44px; list-style: none; cursor: pointer; border-radius: 8px; font-size: 13px; }
.vw-visit > summary::-webkit-details-marker { display: none; }
.vw-visit > summary:hover { background: var(--bg2); }
.vw-visit > summary:focus-visible { outline: 2px solid var(--link); outline-offset: -2px; }
.vw-who { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 500; }
.vw-who.is-anon { color: var(--s); font-weight: 400; }
.vw-num { font-variant-numeric: tabular-nums; }
.vw-when { color: var(--s); font-variant-numeric: tabular-nums; }
.vw-caret { color: var(--t); transition: transform 0.15s; }
.vw-caret svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; }
.vw-visit[open] .vw-caret { transform: rotate(90deg); }
.vw-detail { padding: 4px 10px 18px; }
.vw-facts { display: flex; flex-wrap: wrap; gap: 6px 28px; margin: 0 0 14px; font-size: 12.5px; }
.vw-facts dt { color: var(--s); }
.vw-facts dd { margin: 0; }
.vw-facts div { display: flex; gap: 6px; }
.vw-none { margin: 0; font-size: 13px; color: var(--s); }
.vw-tag { display: inline-block; white-space: nowrap; margin-left: 8px; padding: 1px 7px; border-radius: 999px; background: var(--bg2); font: 500 11px/16px var(--sans); color: var(--s); vertical-align: 1px; }
.vw-links { width: 100%; border-collapse: collapse; font-size: 13px; }
.vw-links th { height: 32px; padding: 0 10px; text-align: left; font-weight: 400; font-size: 12px; color: var(--s); border-bottom: 0.5px solid var(--b); }
.vw-links td { height: 44px; padding: 0 10px; border-bottom: 0.5px solid var(--b); }
.vw-links .r { width: 80px; text-align: right; }
.vw-links .w { width: 140px; }
.vw-links .is-off td { color: var(--s); }
.vw-empty { margin-top: 24px; padding: 28px; border: 0.5px dashed var(--b2); border-radius: 12px; color: var(--s); font-size: 13.5px; line-height: 20px; }
.vw-empty b { display: block; margin-bottom: 4px; color: var(--p); font-size: 14px; }
@media (max-width: 760px) {
  .vw-main { padding: 20px 16px 56px; }
  .vw-stats { gap: 28px; }
  .vw-parts { grid-template-columns: minmax(0, 1fr) 72px 48px; }
  .vw-head, .vw-visit > summary { grid-template-columns: minmax(0, 1fr) 56px 44px 16px; gap: 10px; padding: 0 6px; }
  .vw-head .d, .vw-visit .d { display: none; }
  .vw-links .w { display: none; }
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
function partBars(rows: { label: string; ms: number }[]) {
  const top = Math.max(1, ...rows.map((r) => r.ms));
  return `<div class="vw-parts">${rows
    .map((r) => `<span class="l" title="${esc(r.label)}">${esc(r.label)}</span><span class="vw-bar"><i style="width:${Math.max(2, Math.round((100 * r.ms) / top))}%"></i></span><span class="n">${duration(r.ms)}</span>`)
    .join('')}</div>`;
}

export function viewsHtml(input: ViewsInput, nonce: string) {
  const { slug, title, repo, kind, views: v } = input;
  const unit = kind === 'deck' ? 'slide' : 'section';
  // A link is for one person, or it is the public link: "Anyone with the link", as in Google Drive.
  const linkLabel = (l: Views['links'][number]) => (l.kind === 'person' ? l.name || 'A person' : 'Anyone with the link');
  const linkOf = new Map(v.links.map((l) => [l.token, l]));
  const stats = [
    ['Visits', String(v.totals.views)],
    ['Average time', v.totals.avg_ms ? duration(v.totals.avg_ms) : '–'],
    ['Average completion', v.totals.avg_ms ? v.totals.avg_completion + '%' : '–'],
  ];
  const visits = v.visits
    .map((x) => {
      // A visit is named by the email from the form or by the person of the link. A public visit with no email has no name.
      const l = linkOf.get(x.token);
      const facts = [
        ['Link', l ? linkLabel(l) : 'A removed link'],
        ['Device', [x.os, x.device].filter(Boolean).join(' ')],
        ['Location', countryName(x.country)],
        ['From', x.referrer ?? ''],
      ].filter(([, val]) => val);
      const detail = `<div class="vw-detail"><dl class="vw-facts">${facts.map(([k, val]) => `<div><dt>${k}</dt><dd>${esc(val)}</dd></div>`).join('')}</dl>${
        x.parts.length ? partBars(x.parts.map((p) => ({ label: p.label, ms: p.ms }))) : '<p class="vw-none">The reader left before any time counted.</p>'
      }</div>`;
      return `<details class="vw-visit"><summary>
        <span class="vw-who${x.who ? '' : ' is-anon'}">${esc(x.who || 'Anonymous')}${x.downloads ? '<span class="vw-tag">Downloaded</span>' : ''}</span>
        <span class="vw-num r">${x.active_ms ? duration(x.active_ms) : '–'}</span>
        <span class="vw-num r">${x.completion}%</span>
        <span class="vw-when d">${time(x.started_at)}</span>
        <span class="vw-caret">${icon('right')}</span>
      </summary>${detail}</details>`;
    })
    .join('');
  const links = v.links
    .map((l) => {
      const tags = [l.version ? 'Version ' + l.version : '', l.require_email ? 'Email required' : '', l.revoked_at ? 'Removed' : ''].filter(Boolean);
      return `<tr${l.revoked_at ? ' class="is-off"' : ''}><td>${esc(linkLabel(l))}${tags.map((t) => `<span class="vw-tag">${t}</span>`).join('')}</td>
      <td class="vw-num r">${l.views}</td><td class="vw-when w">${l.last_at ? time(l.last_at) : '–'}</td></tr>`;
    })
    .join('');
  const body = `<style>${CSS}</style><div class="v">
<header class="v-bar">
  <a class="v-icon" href="/p/${esc(slug)}" data-tip="Back to the page" data-tip-start aria-label="Back to the page">${icon('left')}</a>
  <div class="v-crumb">${repo ? `<span class="v-repo">${esc(repo)}</span><span class="v-slash">/</span>` : ''}<span class="v-title">${esc(title)}</span><span class="v-slash vw-sep">/</span><span>Views</span></div>
</header>
<div class="vw"><main class="vw-main">
  <h1>Views</h1>
  ${
    v.totals.views
      ? `<dl class="vw-stats">${stats.map(([k, n]) => `<div><dt>${k}</dt><dd>${esc(n)}</dd></div>`).join('')}</dl>
  ${v.parts.length ? `<h2>Average time on each ${unit}</h2>${partBars(v.parts.map((p) => ({ label: p.label, ms: p.avg_ms })))}` : ''}
  <h2>Visits</h2>
  <div class="vw-head"><span>Visitor</span><span class="r">Time</span><span class="r">Completion</span><span class="d">Date</span><span></span></div>
  ${visits}`
      : `<div class="vw-empty"><b>No visits yet</b>${v.links.length ? 'A visit shows here when someone opens a share link of this page.' : 'Share the page from its Share button. A visit shows here when someone opens the link.'}</div>`
  }
  ${v.links.length ? `<h2>Links</h2><table class="vw-links"><thead><tr><th>Link</th><th class="r">Visits</th><th class="w">Last visit</th></tr></thead><tbody>${links}</tbody></table>` : ''}
</main></div>
</div>`;
  return shell(`Views – ${title}`, nonce, body, COMMON_SCRIPT);
}
