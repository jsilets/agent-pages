#!/usr/bin/env node
// Browser tests of the viewer: real mouse, real keys, real scrolling, in Chromium, WebKit and Firefox.
// Playwright is not a dependency of this repo. Install it in any folder and give its path in PLAYWRIGHT:
//
//   PLAYWRIGHT=/path/to/node_modules/playwright node tests/browser/run.mjs http://localhost:8802 [--engines chromium,webkit,firefox] [--only name,name] [--video dir] [--shots dir] [--dark] [--slow ms]
//
// The host must run in development mode with SANDBOX_RUNNER_URL pointing at host/dev/simulate-run.mjs, started with
// --connected claude (see README.md in this folder). The tests publish their own pages under browser-tests/ and delete them at the end.
import { createRequire } from 'node:module';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { docPage, deckPage } from './fixtures.mjs';

const args = process.argv.slice(2);
const BASE = (args.find((a) => /^https?:/.test(a)) || 'http://localhost:8802').replace(/\/$/, '');
const opt = (name) => { const i = args.indexOf('--' + name); return i < 0 ? null : args[i + 1]; };
if (!process.env.PLAYWRIGHT) { console.error('Set PLAYWRIGHT to the path of the playwright package, for example /tmp/pw/node_modules/playwright'); process.exit(2); }
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT);
const ENGINES = (opt('engines') || 'chromium,webkit,firefox').split(',');
const ONLY = opt('only') ? opt('only').split(',') : null;
const VIDEO = opt('video'), SHOTS = opt('shots'), DARK = args.includes('--dark');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const RUN = Date.now().toString(36);

// ─── Small helpers ───
class Fail extends Error {}
const ok = (v, msg) => { if (!v) throw new Fail(msg); };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a} and ${b} differ by more than ${tol}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, init = {}) {
  const r = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const publish = (slug, html) => api('/api/pages/' + slug, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: html });
const comment = (slug, body) => api('/api/pages/' + slug + '/comments', { method: 'POST', body: JSON.stringify(body) });
const threads = (slug) => api('/api/pages/' + slug + '/comments');
async function until(fn, msg, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(60); }
  throw new Fail(`${msg} (waited ${ms} ms${last instanceof Error ? ': ' + last.message : ''})`);
}

/** The frame of the page in the viewer. After a new version, it is a new frame. */
const pageFrame = (page) => page.frames().find((f) => f !== page.mainFrame() && /\/raw\//.test(f.url()) && !f.isDetached());
/** Opens the viewer and waits until the frame has its height and the margin has loaded. */
async function openViewer(page, slug, { cards = 0 } = {}) {
  await page.goto(BASE + '/p/' + slug);
  await until(() => page.evaluate(() => { const f = document.querySelector('.v-stage > iframe'); return f && f.style.height && parseFloat(f.style.height) > 0; }), 'the frame gets a height');
  await until(() => pageFrame(page)?.evaluate(() => document.documentElement.dataset.kHost !== undefined || !!document.querySelector('main.k-deck')), 'the page answers the viewer');
  if (cards) await until(() => page.evaluate((n) => document.querySelectorAll('.cm-card, .cm-dot').length >= n, cards), `${cards} cards show`);
  await pageFrame(page).evaluate(() => document.fonts.ready.then(() => true));
  await sleep(400);
}
/** The point at a character of a text in an element of the page, in the coordinates of the window. */
async function textPoint(page, selector, text, end = false) {
  const f = pageFrame(page);
  // The view scrolls the element into its middle part first, as a person scrolls before a selection.
  const elTop = await pageTop(page, selector), view = await rect(page, '#scroll');
  if (elTop < view.top + 60 || elTop > view.bottom - 120) {
    await page.evaluate((dy) => document.querySelector('#scroll').scrollBy(0, dy), elTop - (view.top + view.height / 3));
    await sleep(250);
  }
  const p = await f.evaluate(([sel, t, end]) => {
    const root = document.querySelector(sel), w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let all = '', nodes = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push([n, all.length]); all += n.data; }
    const at = all.indexOf(t);
    if (at < 0) return null;
    const i = end ? at + t.length - 1 : at;
    const [node, base] = nodes.filter(([, b]) => b <= i).pop();
    const r = document.createRange(); r.setStart(node, i - base); r.setEnd(node, i - base + 1);
    const b = r.getClientRects()[0] || r.getBoundingClientRect();
    return { x: end ? b.right - 0.5 : b.left + 0.5, y: b.top + b.height / 2 };
  }, [selector, text, end]);
  ok(p, `the text "${text}" is in ${selector}`);
  const o = await page.evaluate(() => { const r = document.querySelector('.v-stage > iframe:not(.is-in)').getBoundingClientRect(); return { x: r.left, y: r.top }; });
  return { x: o.x + p.x, y: o.y + p.y };
}
/** Selects text with the mouse: down at the start, a drag in steps, up at the end. */
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}
/** Clicks the Comment button at the selection, after its short entry animation, as a person does. */
async function clickAdd(page, what = 'the selection') {
  await until(() => page.evaluate(() => { const b = document.querySelector('#cm-add'); return !b.hidden && b.getAnimations().every((a) => a.playState === 'finished'); }), 'the Comment button shows for ' + what);
  await page.click('#cm-add');
}
const rect = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; }, sel);
/** The top of an element of the page, in the coordinates of the window. */
async function pageTop(page, selector) {
  const t = await pageFrame(page).evaluate((s) => document.querySelector(s).getBoundingClientRect().top, selector);
  const o = await rect(page, '.v-stage > iframe:not(.is-in)');
  return o.top + t;
}
/** The single scroll rule: one scroller, under the bar, at the right edge of the window. Nothing else scrolls. */
async function oneScroller(page) {
  const out = await page.evaluate(() => {
    const scrolls = [...document.querySelectorAll('*')].filter((e) => {
      if (e.closest('[hidden], dialog:not([open])') || !e.getClientRects().length) return false;
      const s = getComputedStyle(e);
      return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1;
    }).map((e) => e.id || e.className);
    const root = document.scrollingElement;
    const bar = document.querySelector('.v-bar').getBoundingClientRect(), sc = document.querySelector('#scroll').getBoundingClientRect();
    return { scrolls, rootScrolls: root.scrollHeight > root.clientHeight + 1, barBottom: bar.bottom, scTop: sc.top, scRight: sc.right, width: innerWidth, overflow: getComputedStyle(document.querySelector('#scroll')).overflowY };
  });
  ok(!out.rootScrolls, 'the window itself does not scroll');
  ok(out.scrolls.every((s) => s === 'scroll' || s === 'v-scroll'), 'only the view scrolls, not: ' + out.scrolls.join(', '));
  ok(out.scTop >= out.barBottom - 0.5, `the view starts under the bar (${out.scTop} < ${out.barBottom})`);
  near(out.scRight, out.width, 0.5, 'the scroll bar is at the right edge of the window');
  const inner = await pageFrame(page).evaluate(() => { const r = document.scrollingElement; return { sh: r.scrollHeight, ch: r.clientHeight, ov: getComputedStyle(document.documentElement).overflowY, deck: !!document.querySelector('main.k-deck') }; });
  ok(inner.deck || inner.ov === 'hidden' || inner.sh <= inner.ch + 1, `the page does not scroll itself (${inner.sh} > ${inner.ch})`);
  if (!inner.deck) ok(inner.sh <= inner.ch + 1, `the frame is as tall as the page (${inner.sh} > ${inner.ch})`);
  return out;
}
/** The cards beside the page: no two overlap, and none goes over the bar. */
async function cardsClean(page) {
  const list = await page.evaluate(() => [...document.querySelectorAll('.cm-rail > .cm-card, .cm-pins > .cm-card')].filter((c) => c.getClientRects().length).map((c) => { const r = c.getBoundingClientRect(); return { id: c.dataset.id, top: r.top, bottom: r.bottom }; }));
  const sorted = list.sort((a, b) => a.top - b.top);
  for (let i = 1; i < sorted.length; i++) ok(sorted[i].top >= sorted[i - 1].bottom - 0.5, `cards ${sorted[i - 1].id} and ${sorted[i].id} overlap`);
  return list;
}
/** The text of the page that a card is about, and the card: their tops in the window. */
async function cardAndMark(page, id, slug = SLUGS.doc) {
  const card = await rect(page, `.cm-card[data-id="${id}"]`);
  const t = await threads(slug);
  const th = t.find((x) => x.id === id);
  const markTop = await pageFrame(page).evaluate((q) => {
    // The quote can cross inline elements: look for it in the text of all the nodes, then take the node of its first character.
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), nodes = [];
    let all = '';
    for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push([n, all.length]); all += n.data; }
    const at = all.indexOf(q.slice(0, 24));
    if (at < 0) return null;
    const [node, base] = nodes.filter(([, b]) => b <= at).pop();
    const r = document.createRange(); r.setStart(node, at - base); r.setEnd(node, at - base + 1);
    return r.getClientRects()[0].top;
  }, th.quote);
  ok(markTop != null, 'the quote of the card is in the page');
  const o = await rect(page, '.v-stage > iframe:not(.is-in)');
  return { card, mark: o.top + markTop };
}
/** Opens the Assistants dialog and makes an assistant start not connected: a click on Disconnect, then a second click to confirm. */
async function disconnected(page, name) {
  await page.click('[data-pop="pop-more"]');
  await page.click('#assistants');
  await until(() => page.isVisible('#assist'), 'the Assistants dialog opens');
  const con = page.getByRole('button', { name: 'Connect ' + name, exact: true }), dis = page.getByRole('button', { name: 'Disconnect ' + name, exact: true });
  await until(async () => (await con.isVisible()) || (await dis.isVisible()), name + ' shows its state');
  if (await dis.isVisible()) {
    await dis.click();
    ok(/\?$/.test(await dis.textContent()), 'the first click on Disconnect asks to confirm');
    await dis.click();
  }
  await until(() => con.isVisible(), name + ' shows Connect');
  return con;
}
/** Sets the sign-ins through the host, as the dialog does: { claude: true, chatgpt: false }. A sign-in of Claude uses the code of the fake page. */
async function signIns(want) {
  const now = (await api('/api/assistants')).assistants;
  for (const a of Object.keys(want)) {
    if (now[a].connected === want[a]) continue;
    if (!want[a]) { await api('/api/assistants/' + a + '/connection', { method: 'DELETE' }); continue; }
    ok(a === 'claude', 'the tests connect only Claude through the host');
    const f = await api('/api/assistants/claude/connect', { method: 'POST' });
    const code = (await (await fetch(f.url)).text()).match(/<code id="code">([^<]+)<\/code>/)[1];
    await api('/api/assistants/connect/' + f.id + '/code', { method: 'POST', body: JSON.stringify({ code }) });
  }
}
/** What a person sees on the status chip: its name, its tooltip, its text, and the color of each dot. */
const chipSeen = (page) => page.evaluate(() => {
  const c = document.querySelector('#assist-chip');
  return { name: c.getAttribute('aria-label'), tip: c.dataset.tip, text: c.innerText.trim(), width: c.getBoundingClientRect().width,
    dots: [...c.querySelectorAll('.a-mark')].filter((m) => m.getClientRects().length).map((m) => { const d = m.querySelector('.a-dot'); if (!d || !d.getClientRects().length) return null; const s = getComputedStyle(d); return { bg: s.backgroundColor, border: s.borderTopWidth }; }) };
});
const CLAUDE_ONLY = 'Assistants: Claude connected, ChatGPT not connected';
const NONE = 'Connect an assistant. Assistants: Claude not connected, ChatGPT not connected';
/** The left and right edges of the column of the page in the window, and the width of the view. */
async function docEdges(page) {
  const o = await rect(page, '.v-stage > iframe:not(.is-in)');
  const m = await pageFrame(page).evaluate(() => { const r = (document.querySelector('main.k-page') || document.querySelector('.k-frame.k-cur')).getBoundingClientRect(); return { l: r.left, r: r.right }; });
  const view = await page.evaluate(() => document.querySelector('#body').clientWidth);
  return { left: o.left + m.l, right: o.left + m.r, view };
}
/**
 * Records the place of every card on each frame, after the browser laid out the frame. A ResizeObserver runs then, so the
 * record never forces a style change of its own, which could hide a transition.
 */
function cardTracker() {
  const log = (window.__cards = {}), probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;opacity:0';
  document.body.append(probe);
  let n = 0;
  // The top is in the coordinates of the page: a scroll of the view moves a card with its text, and that is no movement.
  new ResizeObserver(() => document.querySelectorAll('.cm-rail > .cm-card[data-id], .cm-pins > .cm-card[data-id]').forEach((c) => {
    const r = c.getBoundingClientRect(), f = document.querySelector('.v-stage > iframe:not(.is-in)')?.getBoundingClientRect().top || 0;
    (log[c.dataset.id] ||= []).push({ t: performance.now(), x: r.left, y: r.top - f, o: +getComputedStyle(c).opacity });
  })).observe(probe);
  const tick = () => { probe.style.width = (++n % 2) + 1 + 'px'; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
const trackCards = (page) => page.evaluate(cardTracker);
/** The largest distance between a card and its final place in any frame, and how long it moved or faded. */
async function travel(page, id) {
  await sleep(600);
  const list = await page.evaluate((id) => window.__cards[id] || [], id);
  ok(list.length > 3, `the card ${id} was recorded in ${list.length} frames`);
  const f = list[list.length - 1], far = list.map((s) => Math.hypot(s.x - f.x, s.y - f.y));
  const busy = list.filter((s, i) => far[i] > 0.5 || s.o < 0.99);
  return { px: Math.max(...far), ms: busy.length ? Math.round(busy[busy.length - 1].t - list[0].t) : 0, frames: list.length };
}
/**
 * Records, on each frame before the browser paints it, the left edge and the width of the frame of the page, each card
 * that shows (its left edge and its opacity) and the horizontal scroll of the view. Runs until window.__glideStop.
 */
function glideSampler() {
  const log = (window.__glide = []);
  window.__glideStop = false;
  const tick = () => {
    const f = document.querySelector('.v-stage > iframe:not(.is-in)').getBoundingClientRect(), sc = document.querySelector('#scroll'), col = document.querySelector('#cm-col');
    const cards = [...document.querySelectorAll('.cm-rail > .cm-card, .cm-pins > .cm-card')].filter((c) => c.getClientRects().length)
      .map((c) => ({ l: c.getBoundingClientRect().left, r: c.getBoundingClientRect().right, o: +getComputedStyle(c).opacity * +getComputedStyle(col).opacity }));
    log.push({ t: performance.now(), e: performance.timeOrigin + performance.now(), vw: document.querySelector('#body').clientWidth, x: f.left, w: f.width, cards, sl: sc.scrollLeft, sw: sc.scrollWidth - sc.clientWidth });
    if (!window.__glideStop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
/** Runs an action with the sampler on, waits for the page to settle, and returns the samples. */
async function sampled(page, action, ms = 600) {
  await page.evaluate(glideSampler);
  await action();
  await sleep(ms);
  return page.evaluate(() => { window.__glideStop = true; return window.__glide; });
}
/**
 * The movement of the column in the samples. inner is the left and right edge of the column in the frame (docEdges minus the
 * left of the frame). mid: follow the middle of the column, for a frame whose width changes. Returns the place in each
 * frame, the distance, the time from the last frame before it moves to the first frame at its end, the largest step of
 * one frame, and whether it moves in one direction only.
 */
function motion(log, inner, mid = false) {
  const at = log.map((s) => (mid ? s.x + s.w / 2 : s.x + inner.left));
  const steps = at.slice(1).map((v, i) => v - at[i]);
  const moving = steps.map((d, i) => (Math.abs(d) > 0.01 ? i : -1)).filter((i) => i >= 0);
  const total = at[at.length - 1] - at[0];
  const first = moving.length ? moving[0] : 0, last = moving.length ? moving[moving.length - 1] + 1 : 0;
  return {
    at: at.map((v) => Math.round(v * 10) / 10), total, frames: moving.length,
    ms: moving.length ? Math.round(log[last].t - log[first].t) : 0,
    max: Math.max(0, ...steps.map(Math.abs)),
    oneWay: steps.every((d) => Math.abs(d) <= 0.01 || Math.sign(d) === Math.sign(total)),
    turns: steps.filter((d) => Math.abs(d) > 0.01).reduce((n, d, i, all) => n + (i && Math.sign(d) !== Math.sign(all[i - 1]) ? 1 : 0), 0),
  };
}
/** Checks one glide: one direction, 150 to 260 ms, no step of more than 40% of the distance, and the end at the place. */
function glideOk(m, end, msg) {
  ok(m.oneWay, `${msg}: the column moves in one direction (${m.at.join(' ')})`);
  ok(m.ms >= 150 && m.ms <= 260, `${msg}: the glide takes 150 to 260 ms (${m.ms} ms: ${m.at.join(' ')})`);
  ok(m.max <= 0.4 * Math.abs(m.total), `${msg}: no frame moves more than 40% of the distance (${m.max.toFixed(1)} of ${Math.abs(m.total).toFixed(1)} px: ${m.at.join(' ')})`);
  near(m.at[m.at.length - 1], end, 0.5, `${msg}: the glide ends at the place`);
}
/** No card over the text of the column, no card that shows cut by the right edge of the view, and no horizontal scroll, in any sampled frame. */
function clearOfText(log, inner, msg) {
  log.forEach((s, i) => {
    ok(s.sl === 0 && s.sw <= 0, `${msg}: the view never scrolls sideways (frame ${i}: ${s.sl}, ${s.sw})`);
    s.cards.filter((c) => c.o > 0.01).forEach((c) => ok(c.l >= s.x + inner.right + 10, `${msg}: a card is over the text in frame ${i} (${c.l.toFixed(1)} < ${(s.x + inner.right).toFixed(1)} + 10)`));
    s.cards.filter((c) => c.o > 0.05).forEach((c) => ok(c.r <= s.vw + 8, `${msg}: a card that shows is cut by the edge of the view in frame ${i} (right ${c.r.toFixed(1)}, opacity ${c.o.toFixed(2)}, view ${s.vw})`));
  });
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${ENGINE}${DARK ? '-dark' : ''}-${name}.png`) }); };

// ─── The pages ───
let ENGINE = '';
const SLUGS = {};
async function fresh(kind) {
  const slug = `browser-tests/${ENGINE}-${kind}-${RUN}-${Math.random().toString(36).slice(2, 6)}`;
  await publish(slug, kind === 'deck' ? deckPage() : docPage());
  return slug;
}

// ─── The tests ───
const TESTS = {
  async 'one scroll, under the bar'(page) {
    SLUGS.doc = await fresh('doc');
    await comment(SLUGS.doc, { body: 'Is this right?', quote: 'The second paragraph follows it.', prefix: 'so a selection crosses three inline elements.', suffix: 'A selection can start' });
    await comment(SLUGS.doc, { body: 'A comment on the whole page.' });
    for (const w of [1440, 1280, 1024]) {
      await page.setViewportSize({ width: w, height: 860 });
      await openViewer(page, SLUGS.doc, { cards: 2 });
      // The cards that the page has when it loads show at their places, with no animation.
      if (w === 1440) {
        await page.addInitScript(`if (location.pathname.startsWith('/p/')) addEventListener('DOMContentLoaded', ${cardTracker.toString()})`);
        await openViewer(page, SLUGS.doc, { cards: 2 });
        for (const id of await page.evaluate(() => Object.keys(window.__cards))) {
          const t = await travel(page, id), list = await page.evaluate((id) => window.__cards[id], id);
          ok(t.px <= 2 && list.every((s) => s.o === 1), `a card shows at its place with no animation when the page loads (${t.px.toFixed(1)} px, ${t.ms} ms: ${JSON.stringify(list.slice(0, 4).map((s) => [Math.round(s.t), s.x, s.y, s.o]))})`);
        }
      }
      await oneScroller(page);
      await cardsClean(page);
      const doc = await docEdges(page), first = await rect(page, '.cm-rail > .cm-card');
      ok(first.left >= doc.right + 20 && first.right <= doc.view, `the cards are beside the page at ${w} px, not over it`);
      await shot(page, `wide-${w}`);
    }
  },

  async 'the page keeps its place when the margin opens, like Google Docs'(page) {
    const slug = await fresh('doc');
    for (const w of [2000, 1680, 1440, 1280]) {
      await page.setViewportSize({ width: w, height: 860 });
      for (const t of await threads(slug)) await api('/api/comments/' + t.id, { method: 'DELETE' });
      await openViewer(page, slug);
      const none = await docEdges(page), width = none.right - none.left;
      near(none.left, (none.view - width) / 2, 0.5, `with no thread, the column is in the middle of the view at ${w} px`);
      const t = await comment(slug, { body: 'Width check.', quote: 'The second paragraph follows it.', prefix: '', suffix: '' });
      await openViewer(page, slug, { cards: 1 });
      const one = await docEdges(page), card = await rect(page, `.cm-card[data-id="${t.id}"]`);
      ok(card.right <= one.view + 0.5, `the card is inside the view at ${w} px`);
      ok(card.left >= one.right + 20, `the card is beside the column, not over it, at ${w} px (${card.left} < ${one.right} + 20)`);
      if (w >= 1440) {
        // Room for the column in the middle and the cards at its right: the column does not move, not by one pixel.
        near(one.left, none.left, 0.5, `the column keeps its place when a thread shows at ${w} px`);
        near(card.left, one.right + 28, 1, `the cards keep the same distance from the column at ${w} px`);
        // The box for a new comment, then the last thread resolved: the column still does not move.
        await page.click('#cnew');
        await until(() => page.evaluate(() => !!document.querySelector('.cm-card.is-compose')), 'the comment box opens');
        near((await docEdges(page)).left, none.left, 0.5, `the column keeps its place while the comment box is open at ${w} px`);
        await page.keyboard.press('Escape');
        await page.click(`.cm-card[data-id="${t.id}"]`);
        await page.click(`.cm-card[data-id="${t.id}"] .cm-done`);
        await until(() => page.evaluate(() => document.querySelector('#cm-col').hidden), 'with the last thread resolved, the margin goes');
        near((await docEdges(page)).left, none.left, 0.5, `the column keeps its place when the last thread is resolved at ${w} px`);
      } else {
        // Too little room: the column moves left by the smallest distance that makes room for the cards.
        near(one.right, one.view - 324, 1, `the column moves left only as far as the cards need at ${w} px`);
        ok(one.left < none.left, `the column moved left at ${w} px`);
      }
    }
  },

  async 'the page glides when the margin opens and closes, like Google Docs'(page) {
    const slug = await fresh('doc');
    await page.setViewportSize({ width: 1280, height: 860 });
    await openViewer(page, slug);
    const none = await docEdges(page), f0 = (await rect(page, '.v-stage > iframe')).left;
    const inner = { left: none.left - f0, right: none.right - f0 };
    const composer = () => until(() => page.evaluate(() => !!document.querySelector('.cm-card.is-compose')?.isConnected), 'the comment box opens');
    // The first comment box: the column glides left, from the middle to the place that placeMargin gives.
    const open = await sampled(page, async () => { await page.click('#cnew'); await composer(); });
    const one = await docEdges(page);
    near(one.right, one.view - 324, 1, 'the column ends where placeMargin puts it');
    const mo = motion(open, inner);
    if (process.env.GLIDE_DEBUG) console.log(open.map((s) => Math.round(s.t) + ':' + s.x.toFixed(1)).join(' '));
    near(mo.at[0], none.left, 0.5, 'the glide starts at the middle');
    glideOk(mo, one.left, 'open');
    clearOfText(open, inner, 'open');
    ok(open.some((s) => s.cards.length), 'the box shows during the glide');
    console.log(`      1280 open: ${mo.ms} ms, ${mo.frames} frames, max step ${mo.max.toFixed(1)} of ${Math.abs(mo.total)} px: ${mo.at.filter((v, i, a) => i === 0 || v !== a[i - 1]).join(' → ')}`);
    // Esc: the same glide back.
    const close = await sampled(page, async () => { await page.keyboard.press('Escape'); await until(() => page.evaluate(() => document.querySelector('#cm-col').hidden), 'Esc closes the box'); });
    const mc = motion(close, inner);
    glideOk(mc, none.left, 'cancel');
    near((await docEdges(page)).left, none.left, 0.5, 'the column is in the middle again');
    console.log(`      1280 cancel: ${mc.ms} ms, ${mc.frames} frames, max step ${mc.max.toFixed(1)} px: ${mc.at.filter((v, i, a) => i === 0 || v !== a[i - 1]).join(' → ')}`);
    // Open, Esc, open, quickly: each glide starts where the column is, with no jump and no stack of glides.
    const quick = await sampled(page, async () => {
      await page.click('#cnew'); await composer(); await sleep(70);
      await page.keyboard.press('Escape'); await sleep(70);
      await page.click('#cnew'); await composer();
    }, 700);
    const mq = motion(quick, inner);
    ok(mq.max <= 0.4 * Math.abs(one.left - none.left), `quick: no jump (${mq.max.toFixed(1)} px: ${mq.at.join(' ')})`);
    ok(mq.turns <= 2, `quick: the column turns at most twice (${mq.turns}: ${mq.at.join(' ')})`);
    near(mq.at[mq.at.length - 1], one.left, 0.5, 'quick: the column ends at the place for the margin');
    clearOfText(quick, inner, 'quick');
    console.log(`      1280 quick: ${mq.turns} turns, max step ${mq.max.toFixed(1)} px: ${mq.at.filter((v, i, a) => i === 0 || v !== a[i - 1]).join(' → ')}`);
    // Post the comment: the margin stays, nothing moves. After the glide, the text is where the mouse and the marks expect it.
    await page.keyboard.type('Glide note.');
    const post = await sampled(page, async () => { await page.keyboard.press(`${MOD}+Enter`); await until(async () => (await threads(slug)).length === 1, 'the comment is stored'); });
    ok(motion(post, inner).frames === 0, 'posting the comment moves nothing');
    await page.keyboard.press('Escape');
    const p = await textPoint(page, '#p-second', 'paragraph');
    await page.mouse.dblclick(p.x + 4, p.y);
    await until(async () => (await pageFrame(page).evaluate(() => getSelection().toString())).trim() === 'paragraph', 'a double click after the glide selects the word under the mouse');
    await until(() => page.isVisible('#cm-add'), 'the Comment button shows at the selection');
    const btn = await rect(page, '#cm-add'), line = await pageTop(page, '#p-second');
    ok(btn.bottom <= line + 2 && btn.bottom > line - 60, 'the Comment button sits just above the selection');
    ok(btn.left >= one.left - 40 && btn.right <= one.right + 40, `the Comment button is over the column (${btn.left}–${btn.right}, column ${one.left}–${one.right})`);
    await clickAdd(page);
    await page.keyboard.type('On a word.');
    await page.keyboard.press(`${MOD}+Enter`);
    const t = await until(async () => (await threads(slug)).find((x) => x.quote === 'paragraph'), 'the comment on the word is stored');
    await until(() => page.$(`.cm-card[data-id="${t.id}"]`), 'its card shows');
    // The comment on the whole page sits at the top of the margin. Resolve it, so the card on the word can be level with its text.
    const whole = (await threads(slug)).find((x) => !x.quote);
    await api('/api/comments/' + whole.id + '/resolve', { method: 'PUT' });
    await until(() => page.evaluate((id) => !document.querySelector(`.cm-card[data-id="${id}"]`), whole.id), 'the card of the whole page goes', 8000);
    await sleep(400);
    near((await docEdges(page)).left, one.left, 0.5, 'the column stays at its place while a thread is open');
    const c = await rect(page, `.cm-card[data-id="${t.id}"]`), mark = await pageTop(page, '#p-second');
    near(c.top, mark - 12, 14, 'the card is level with its text');
    ok(c.left >= one.right + 10, 'the card is beside the column');
    // Resolve the last thread with its button: the margin goes, and the column glides back to the middle.
    await page.click(`.cm-card[data-id="${t.id}"]`);
    const res = await sampled(page, async () => { await page.click(`.cm-card[data-id="${t.id}"] .cm-done`); await until(() => page.evaluate(() => document.querySelector('#cm-col').hidden), 'the margin goes with the last thread'); }, 500);
    glideOk(motion(res, inner), none.left, 'resolve');
  },

  async 'the glide: a narrow view, a page that loads with threads, and reduced motion'(page) {
    const slug = await fresh('doc');
    // 1100 px: the column moves 154 px. The cards fade in only when they are inside the view.
    await page.setViewportSize({ width: 1100, height: 860 });
    await openViewer(page, slug);
    const n11 = await docEdges(page), f11 = (await rect(page, '.v-stage > iframe')).left, i11 = { left: n11.left - f11, right: n11.right - f11 };
    const o11 = await sampled(page, async () => { await page.click('#cnew'); await until(() => page.$('.cm-card.is-compose'), 'the comment box opens'); });
    const e11 = await docEdges(page);
    near(e11.right, e11.view - 324, 1, '1100: the column ends where placeMargin puts it');
    glideOk(motion(o11, i11), e11.left, '1100 open');
    clearOfText(o11, i11, '1100 open');
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => document.querySelector('#cm-col').hidden), 'Esc closes the box');
    await sleep(400);
    // 1040 px: the column must get narrower. It takes its new width at the start, then glides; no card is ever over it.
    await page.setViewportSize({ width: 1040, height: 860 });
    await openViewer(page, slug);
    const none = await docEdges(page);
    const open = await sampled(page, async () => { await page.click('#cnew'); await until(() => page.$('.cm-card.is-compose'), 'the comment box opens'); });
    const one = await docEdges(page), f1 = await rect(page, '.v-stage > iframe');
    near(one.right, one.view - 324, 1, 'the narrower column ends where placeMargin puts it');
    ok(one.right - one.left < none.right - none.left, 'the column is narrower');
    const m = motion(open, null, true);
    glideOk(m, f1.left + f1.width / 2, 'narrow open');
    // The width changes one time, before the column moves: the frames before it have the old width and the old middle.
    const wi = open.findIndex((s) => s.w === f1.width);
    ok(wi > 0 && open.slice(wi).every((s) => s.w === f1.width) && open.slice(0, wi).every((s) => s.w === open[0].w && s.x === open[0].x), `the frame takes its new width one time, at the start (${open.map((s) => s.w).join(' ')})`);
    near(m.at[wi], m.at[0], 0.5, 'the column keeps its middle when it gets narrower');
    clearOfText(open, { left: one.left - f1.left, right: one.right - f1.left }, 'narrow open');
    const close = await sampled(page, async () => { await page.keyboard.press('Escape'); await until(() => page.evaluate(() => document.querySelector('#cm-col').hidden), 'Esc closes the box'); });
    const mc = motion(close, null, true);
    ok(mc.oneWay && mc.ms >= 150 && mc.ms <= 260, `narrow close glides (${mc.ms} ms: ${mc.at.join(' ')})`);
    const wj = close.findIndex((s) => s.w !== f1.width);
    ok(wj > 0 && close.slice(wj).every((s) => s.w === close[close.length - 1].w) && close.slice(0, wj).every((s) => s.w === f1.width), `the frame takes its old width one time, at the end (${close.map((s) => s.w).join(' ')})`);
    near(mc.at[wj], mc.at[wj - 1], 0.5, 'the column keeps its middle when it gets wider');
    close.forEach((s, i) => ok(s.sl === 0 && s.sw <= 0, `narrow close: no sideways scroll in frame ${i}`));
    near((await docEdges(page)).left, none.left, 0.5, 'the column is in the middle again');

    // A page that loads with a thread: the column is at its place when the cards show, with no glide.
    await comment(slug, { body: 'Load note.', quote: 'The second paragraph follows it.', prefix: '', suffix: '' });
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.addInitScript(`if (location.pathname.startsWith('/p/')) addEventListener('DOMContentLoaded', () => requestAnimationFrame(${glideSampler.toString()}))`);
    await openViewer(page, slug, { cards: 1 });
    await sleep(300);
    const load = await page.evaluate(() => { window.__glideStop = true; return window.__glide; });
    const shown = load.findIndex((s) => s.cards.length);
    ok(shown >= 0, 'the card shows');
    const xs = new Set(load.map((s) => s.x));
    ok(xs.size <= 2, `the column takes no place between the middle and its place (${[...xs].join(', ')})`);
    ok(load.slice(shown).every((s) => s.x === load[load.length - 1].x), 'from the first frame with a card, the column does not move');
    ok(load.slice(shown).every((s) => s.cards.every((c) => c.o === 1)), 'the cards of a page that loads show with no fade');

    // Reduced motion: the column goes to its place in one frame.
    for (const t of await threads(slug)) await api('/api/comments/' + t.id, { method: 'DELETE' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openViewer(page, slug);
    const still = await sampled(page, async () => { await page.click('#cnew'); await until(() => page.$('.cm-card.is-compose'), 'the comment box opens'); });
    const ms = motion(still, { left: 0, right: 0 });
    ok(ms.frames === 1, `with reduced motion, the column moves in one frame (${ms.at.join(' ')})`);
    await page.emulateMedia({ reducedMotion: null });
  },

  async 'drag across inline elements, Comment button, post, card aligned'(page) {
    const slug = await fresh('doc');
    await openViewer(page, slug);
    // Record the Comment button on each frame: it must rise out of the selection, never come from a corner of the window.
    await page.evaluate(() => {
      const log = (window.__add = []), b = document.querySelector('#cm-add');
      const tick = () => { if (!b.hidden) { const r = b.getBoundingClientRect(); log.push({ t: performance.now(), x: r.left + r.width / 2, y: r.top + r.height / 2, o: +getComputedStyle(b).opacity }); } if (!window.__addStop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    await drag(page, await textPoint(page, '#p-first', 'bold words'), await textPoint(page, '#p-first', 'inline code', true));
    await until(() => page.isVisible('#cm-add'), 'the Comment button shows at the selection');
    await sleep(400);
    const rise = await page.evaluate(() => { window.__addStop = true; return window.__add; });
    const end = rise[rise.length - 1], far = Math.max(...rise.map((s) => Math.hypot(s.x - end.x, s.y - end.y)));
    ok(rise.length > 3, `the Comment button was sampled (${rise.length} frames)`);
    ok(far <= 8, `the Comment button is never more than 8 px from its place (${far.toFixed(1)} px)`);
    ok(rise.every((s) => Math.abs(s.x - end.x) <= 1), 'the Comment button does not move sideways');
    ok(rise.every((s) => s.y >= end.y - 0.5), 'the Comment button rises from the selection: it starts below its place, not above');
    ok(end.o === 1 && rise.find((s) => s.o === 1).t - rise[0].t <= 260, 'the Comment button is fully visible in 260 ms');
    const btn = await rect(page, '#cm-add'), line = await pageTop(page, '#p-first');
    ok(btn.bottom <= line + 2 && btn.bottom > line - 60, 'the Comment button sits just above the selection');
    await clickAdd(page);
    await until(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Comment'), 'the comment box has the focus');
    await page.keyboard.type('Three inline elements in one quote.');
    await trackCards(page);
    await page.keyboard.press(`${MOD}+Enter`);
    const t = await until(async () => (await threads(slug))[0], 'the comment is stored');
    // The new card comes in at its own place: a short fade and a few pixels, never a slide from the top of the margin.
    await until(() => page.$(`.cm-card[data-id="${t.id}"]`), 'the new card shows');
    const mine = await travel(page, t.id);
    ok(mine.px <= 12, `the new card is never more than 12 px from its place (${mine.px.toFixed(1)} px)`);
    ok(mine.ms <= 300, `the new card settles in 300 ms (${mine.ms} ms)`);
    // A comment from another person comes in the same way with the next refresh.
    const other = await comment(slug, { body: 'From another person.', quote: 'The second paragraph follows it.', prefix: '', suffix: '' });
    await until(() => page.$(`.cm-card[data-id="${other.id}"]`), 'the comment of another person shows', 8000);
    const theirs = await travel(page, other.id);
    ok(theirs.px <= 12, `a card that arrives is never more than 12 px from its place (${theirs.px.toFixed(1)} px)`);
    await api('/api/comments/' + other.id, { method: 'DELETE' });
    ok(t.quote === 'bold words, a link and inline code', `the quote crosses the inline elements: "${t.quote}"`);
    SLUGS.doc = slug;
    const card = await until(() => page.$(`.cm-card[data-id="${t.id}"].is-active`), 'the new card shows, open');
    await sleep(400);
    const { card: c, mark } = await cardAndMark(page, t.id);
    near(c.top, mark - 12, 14, 'the card is level with its text');
    await until(() => page.evaluate((id) => document.activeElement === document.querySelector(`.cm-card[data-id="${id}"]`), t.id), 'the focus goes to the new card');
    await oneScroller(page);
    await shot(page, 'posted');
    void card;
  },

  async 'a selection across two paragraphs, and in a table, list, code, heading and diagram'(page) {
    const slug = await fresh('doc');
    await openViewer(page, slug);
    const cases = [
      ['two paragraphs', ['#p-first', 'so a selection'], ['#p-second', 'second paragraph', true], /so a selection crosses three inline elements\. The second paragraph/],
      ['table', ['#table', 'Outdoor'], ['#table', '4,200', true], /Outdoor unit\s+4,200/],
      ['list', ['#list', 'Seal'], ['#list', 'windows', true], /^Seal the gaps around the windows$/],
      ['code', ['#code', 'grant'], ['#code', '0.5 * cost', true], /^grant = 0\.5 \* cost$/],
      ['heading', ['#costs h2', 'What'], ['#costs h2', 'costs', true], /^What it costs$/],
    ];
    for (const [name, a, b, re] of cases) {
      // A person takes a moment between a click and the next drag. A drag that starts some milliseconds after a click and a
      // focus change sometimes selects nothing in Chromium, which no person can do.
      await sleep(150);
      await page.mouse.click(5, 300);
      await sleep(150);
      await drag(page, await textPoint(page, ...a), await textPoint(page, ...b));
      await clickAdd(page, `a selection in a ${name}`);
      await page.keyboard.type('Note on the ' + name);
      await page.keyboard.press(`${MOD}+Enter`);
      const t = await until(async () => (await threads(slug)).find((x) => x.body === 'Note on the ' + name), `the ${name} comment is stored`);
      ok(re.test(t.quote), `the ${name} quote is "${t.quote}"`);
      await page.keyboard.press('Escape');
    }
    // A label of the flow diagram is SVG text.
    await page.mouse.click(5, 300);
    const svgText = await pageFrame(page).evaluate(() => [...document.querySelectorAll('.k-flow svg text')].find((t) => t.textContent === 'Heat pump') ? true : false);
    ok(svgText, 'the diagram has the label');
    await page.evaluate(() => document.querySelector('#scroll').scrollTo(0, 1000));
    await sleep(200);
    const lbl = await pageFrame(page).evaluate(() => { const t = [...document.querySelectorAll('.k-flow svg text')].find((t) => t.textContent === 'Heat pump'); const r = t.getBoundingClientRect(); return { l: r.left, r: r.right, y: r.top + r.height / 2 }; });
    const o = await rect(page, '.v-stage > iframe');
    await drag(page, { x: o.left + lbl.l + 1, y: o.top + lbl.y }, { x: o.left + lbl.r - 1, y: o.top + lbl.y });
    await clickAdd(page, 'a diagram label');
    await page.keyboard.type('Note on the diagram');
    await page.keyboard.press(`${MOD}+Enter`);
    const t = await until(async () => (await threads(slug)).find((x) => x.body === 'Note on the diagram'), 'the diagram comment is stored');
    ok(/Heat pum/.test(t.quote), `the diagram quote is "${t.quote}"`);
    await oneScroller(page);
    await cardsClean(page);
  },

  async 'keyboard: shortcut in the page, Esc, focus back, Tab to the cards'(page) {
    const slug = await fresh('doc');
    await openViewer(page, slug);
    const p = await textPoint(page, '#p-second', 'paragraph');
    await page.mouse.dblclick(p.x + 4, p.y);
    await until(async () => (await pageFrame(page).evaluate(() => getSelection().toString())).trim() === 'paragraph', 'a double click selects a word');
    await sleep(150);
    await page.keyboard.press(`${MOD}+Alt+KeyM`);
    await until(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Comment'), 'the shortcut in the page opens the comment box');
    ok(await page.evaluate(() => document.querySelector('.cm-card.is-compose q')?.textContent === 'paragraph'), 'the box quotes the selected word');
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => !document.querySelector('.cm-card.is-compose')?.isConnected), 'Esc closes the box');
    await until(() => page.evaluate(() => document.activeElement === document.querySelector('.v-stage > iframe')), 'the focus goes back to the page', 2000).catch(async (e) => { console.log(await page.evaluate(() => [document.activeElement?.outerHTML.slice(0, 120), document.hasFocus()])); throw e; });
    // The bar button, then Esc: the focus goes back to the button.
    await page.click('#cnew');
    await until(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Comment'), 'the bar button opens a page comment');
    await page.keyboard.type('A note on the page.');
    await page.keyboard.press(`${MOD}+Enter`);
    const t = await until(async () => (await threads(slug))[0], 'the page comment is stored');
    ok(!t.quote, 'a comment from the bar has no quote');
    await until(() => page.evaluate((id) => document.activeElement === document.querySelector(`.cm-card[data-id="${id}"]`), t.id), 'after posting, the focus is on the new card');
    await page.keyboard.press('Tab');
    ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Reply' || document.activeElement?.classList.contains('cm-menu') || document.activeElement?.classList.contains('cm-done')), 'Tab goes into the open card');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => !document.querySelector('.cm-card.is-active')), 'Esc closes the card');
  },

  async 'the wheel scrolls the page and the cards together, with no lag'(page) {
    const slug = await fresh('doc');
    await comment(slug, { body: 'First note.', quote: 'The second paragraph follows it.', prefix: 'three inline elements.', suffix: 'A selection can start' });
    await comment(slug, { body: 'Second note.', quote: 'The last paragraph of the page ends the document.', prefix: '', suffix: '' });
    await openViewer(page, slug, { cards: 2 });
    const ids = (await threads(slug)).map((t) => t.id);
    // The top of each quote in the page does not change: the frame does not scroll. Only the view moves.
    // The frame never scrolls inside, so these tops change only when the page lays out again.
    const sample = async () => { const docTops = await pageFrame(page).evaluate(() => ['#p-second', '#p-last'].map((s) => document.querySelector(s).getBoundingClientRect().top)); return page.evaluate(([ids, docTops]) => {
      const f = document.querySelector('.v-stage > iframe').getBoundingClientRect().top;
      return ids.map((id, i) => document.querySelector(`.cm-card[data-id="${id}"]`).getBoundingClientRect().top - (f + docTops[i]));
    }, [ids, docTops]); };
    const base = await sample();
    const o = await rect(page, '.v-stage > iframe');
    // The wheel over the page, then over the margin. Each sample reads the card and the frame in one task.
    for (const x of [o.left + 200, (await rect(page, '#cm-col')).left + 100]) {
      const before = await page.evaluate(() => document.querySelector('#scroll').scrollTop);
      await page.mouse.move(x, 400);
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 120);
        const d = await sample();
        d.forEach((v, k) => near(v, base[k], 0.5, 'a card moves with its text during the scroll'));
      }
      await sleep(500);
      const after = await page.evaluate(() => document.querySelector('#scroll').scrollTop);
      ok(after > before + 100, `the wheel over ${x < o.right ? 'the page' : 'the margin'} scrolls the view (${before} to ${after})`);
      (await sample()).forEach((v, k) => near(v, base[k], 0.5, 'after the scroll, a card is at the same place next to its text'));
      await page.evaluate(() => document.querySelector('#scroll').scrollTo(0, 0));
      await sleep(300);
    }
    // Keys in the page scroll the view too.
    await page.mouse.click(o.left + 30, 300);
    await page.keyboard.press('PageDown');
    await until(() => page.evaluate(() => document.querySelector('#scroll').scrollTop > 300), 'PageDown in the page scrolls the view');
    await oneScroller(page);
  },

  async 'a link in the page and a link to a claim scroll the view'(page) {
    const slug = await fresh('doc');
    await page.goto(BASE + '/p/' + slug + '#costs');
    await until(() => page.evaluate(() => document.querySelector('#scroll').scrollTop > 200), 'the hash #costs scrolls the view to the claim');
    const top = await pageTop(page, '#costs'), sc = await rect(page, '#scroll');
    near(top, sc.top + 16, 24, 'the claim is at the top of the view');
    await page.evaluate(() => document.querySelector('#scroll').scrollTo(0, 0));
    await sleep(300);
    const a = await textPoint(page, 'header + p', 'Go to the costs');
    await page.mouse.click(a.x + 10, a.y);
    await until(async () => Math.abs((await pageTop(page, '#costs')) - (sc.top + 16)) < 30, 'a link in the page scrolls the view to its target');
  },

  async 'edit, delete, resolve and reopen'(page) {
    const slug = await fresh('doc');
    const root = await comment(slug, { body: 'Please check this.', quote: 'The second paragraph follows it.', prefix: '', suffix: '' });
    await comment(slug, { body: 'A reply to delete.', parent_id: root.id });
    await openViewer(page, slug, { cards: 1 });
    await page.click(`.cm-card[data-id="${root.id}"]`);
    await until(() => page.$(`.cm-card[data-id="${root.id}"].is-active`), 'a click opens the card');
    // Edit the first comment.
    await page.click(`.cm-card[data-id="${root.id}"] [data-comment="${root.id}"] .cm-menu`);
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await page.keyboard.press(`${MOD}+A`);
    await page.keyboard.type('Please check this sentence.');
    await page.keyboard.press(`${MOD}+Enter`);
    await until(async () => (await threads(slug))[0].body === 'Please check this sentence.', 'the change is stored');
    ok((await threads(slug))[0].edited_at, 'the comment has edited_at');
    await until(() => page.evaluate((id) => /Edited/.test(document.querySelector(`[data-comment="${id}"] time`)?.textContent || ''), root.id), 'the card says Edited');
    // Delete the reply, after the person confirms.
    const reply = (await threads(slug))[0].replies[0];
    await page.click(`[data-comment="${reply.id}"] .cm-menu`);
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await until(() => page.isVisible('#cm-confirm'), 'a dialog asks to confirm');
    ok((await page.textContent('#cm-confirm-h')) === 'Delete this comment?', 'the dialog names a comment');
    await page.click('#cm-confirm-ok');
    await until(async () => (await threads(slug))[0].replies.length === 0, 'the reply is deleted');
    // Resolve, then reopen from the list in the bar.
    await page.click(`.cm-card[data-id="${root.id}"] .cm-done`);
    await until(async () => (await threads(slug))[0].status === 'resolved', 'the thread is resolved');
    await until(() => page.isVisible('#cres'), 'the bar shows the resolved threads');
    // The button: the icon and "1 resolved" on one line, as tall as the other buttons of the bar.
    const res = await page.evaluate(() => {
      const b = document.querySelector('#cres'), r = b.getBoundingClientRect(), i = b.querySelector('svg').getBoundingClientRect(), t = b.querySelector('span').getBoundingClientRect(), n = document.querySelector('#cnew').getBoundingClientRect();
      return { h: r.height, nh: n.height, ny: n.top, y: r.top, icon: i.top + i.height / 2, text: t.top + t.height / 2, gap: t.left - i.right, lines: t.height, label: b.textContent.trim() };
    });
    ok(res.label === '1 resolved', `the button says "1 resolved" (${res.label})`);
    near(res.icon, res.text, 1, 'the icon and the text of the resolved button are on one line');
    ok(res.gap >= 4 && res.gap <= 8, `the icon and the text have a small gap (${res.gap} px)`);
    ok(res.lines < 20, `the text of the resolved button is one line (${res.lines} px)`);
    near(res.h, res.nh, 0.5, 'the resolved button is as tall as the other buttons');
    near(res.y, res.ny, 0.5, 'the resolved button is level with the other buttons');
    // The keyboard opens the list on its first Reopen button, and Esc gives the focus back to the button.
    await page.focus('#cres');
    await page.keyboard.press('Enter');
    await until(() => page.evaluate(() => document.activeElement?.classList.contains('v-reopen')), 'the keyboard opens the list on Reopen');
    await sleep(250);
    const pop = await rect(page, '#pop-res'), btn = await rect(page, '#cres'), vw = await page.evaluate(() => innerWidth);
    ok(pop.left >= 8 && pop.right <= vw - 8, 'the list is inside the window');
    near(pop.right, btn.right, 1, 'the list lines up with its button');
    ok(pop.top >= btn.bottom, 'the list opens under its button');
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => document.activeElement?.id === 'cres' && document.querySelector('#pop-res').hidden), 'Esc closes the list and the focus goes back to its button');
    await page.click('#cres');
    await trackCards(page);
    await page.click('#res-list .v-reopen');
    await until(async () => (await threads(slug))[0].status === 'open', 'the thread is open again');
    await until(() => page.$(`.cm-card[data-id="${root.id}"]`), 'the card is back');
    const back = await travel(page, root.id);
    ok(back.px <= 12, `the card that opens again comes in at its place (${back.px.toFixed(1)} px: ${JSON.stringify((await page.evaluate((id) => window.__cards[id], root.id)).slice(0, 5).map((s) => [Math.round(s.t), s.x, s.y, s.o]))})`);
    // Delete the thread.
    await page.click(`[data-comment="${root.id}"] .cm-menu`);
    await page.getByRole('menuitem', { name: 'Delete thread' }).click();
    ok((await page.textContent('#cm-confirm-h')) === 'Delete this thread?', 'the dialog names the thread');
    await page.click('#cm-confirm-ok');
    await until(async () => (await threads(slug)).length === 0, 'the thread is deleted');
    await until(() => page.evaluate(() => document.querySelector('#cm-col').hidden), 'with no thread, the margin goes');
  },

  async '@claude: reaction, cursor, in-place typing, swap with no jump, reply'(page) {
    const slug = await fresh('doc');
    await openViewer(page, slug);
    await drag(page, await textPoint(page, '#p-second', 'The second'), await textPoint(page, '#p-second', 'follows it.', true));
    await clickAdd(page);
    await page.keyboard.type('@claude shorten this: The next paragraph.');
    ok(await page.evaluate(() => !document.querySelector('.cm-pick:not([hidden])')), 'the @ list closes after the name and a space');
    await page.keyboard.press(`${MOD}+Enter`);
    const t = await until(async () => (await threads(slug))[0], 'the comment is stored');
    await until(() => page.$(`.cm-card[data-id="${t.id}"] .v-react`), 'the card shows the reaction of Claude');
    await until(() => page.$('.v-whochip'), 'the bar shows Claude at work');
    const f = pageFrame(page);
    await until(() => f.$('.k-pr-cur'), 'the cursor shows in the page');
    const startX = await f.evaluate(() => { const p = document.querySelector('#p-second'); const r = document.createRange(); r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 1); return r.getClientRects()[0].left; });
    await until(() => f.evaluate(() => (document.querySelector('.k-pr-new')?.textContent || '').length > 3), 'the new text types in', 15000);
    const place = await f.evaluate(() => ({ ins: document.querySelector('.k-pr-new').getClientRects()[0].left, was: !!document.querySelector('.k-pr-was'), insIn: document.querySelector('.k-pr-new').parentElement.id }));
    near(place.ins, startX, 2, 'the new text starts where the old text starts');
    ok(place.was && place.insIn === 'p-second', 'the old text is still in its paragraph while it fades');
    await shot(page, 'typing');
    // The top of the text after the edit, in the window, in the frame that shows, until the new version shows.
    const seen = [];
    const end = Date.now() + 20000;
    let doneAt = 0;
    while (Date.now() < end && (!doneAt || Date.now() < doneAt + 800)) {
      const h = await page.$('.v-stage > iframe:not(.is-in)');
      const f = h && (await h.contentFrame());
      const y = f && (await f.evaluate(() => document.querySelector('#p-last')?.getBoundingClientRect().top).catch(() => null));
      const box = h && (await h.boundingBox().catch(() => null));
      if (y != null && box) seen.push({ src: await h.getAttribute('src'), y: Math.round(box.y + y) });
      if (!doneAt && (await page.evaluate(() => document.querySelector('.v-cur b').textContent === 'v2'))) doneAt = Date.now();
      await sleep(25);
    }
    ok(doneAt, 'the bar shows version 2');
    const cut = seen.findIndex((x) => x.src !== seen[0].src);
    ok(cut > 0, 'the frame of the new version swaps in');
    near(seen[cut].y, seen[cut - 1].y, 2, 'the text after the edit does not jump when the new version swaps in');
    near(seen[seen.length - 1].y, seen[cut - 1].y, 2, 'the text after the edit stays in place after the swap');
    ok((await pageFrame(page).evaluate(() => document.querySelector('#p-second').textContent)) === 'The next paragraph. A selection can start in the first paragraph and end here in the second one.', 'the new version has the new text');
    await until(async () => (await threads(slug))[0].replies.length === 1, 'Claude replies', 15000);
    await until(() => page.evaluate((id) => /Done/.test(document.querySelector(`.cm-card[data-id="${id}"]`)?.textContent || ''), t.id), 'the reply shows in the card', 8000);
    await oneScroller(page);
  },

  async 'a call with two edits shows the cursor at each edit in turn'(page) {
    const slug = await fresh('doc');
    await comment(slug, { body: '@claude [multi] shorten this: The second paragraph.', quote: 'The second paragraph follows it.', prefix: '', suffix: '' });
    await openViewer(page, slug, { cards: 1 });
    const f = pageFrame(page);
    const seen = [];
    await until(async () => {
      const s = await f.evaluate(() => [...document.querySelectorAll('.k-pr-new')].map((e) => e.parentElement.id || e.parentElement.tagName));
      if (s.length && s.join() !== seen[seen.length - 1]) seen.push(s.join());
      return s.length >= 2;
    }, 'two previews show, one after the other', 25000);
    ok(seen[0] === 'p-second', `the first edit types first (${seen.join(' | ')})`);
    ok(seen.some((s) => s.split(',').length === 2), 'the second edit types after the first one');
    await until(() => page.evaluate(() => document.querySelector('.v-cur b').textContent === 'v2'), 'the new version swaps in', 20000);
  },

  async 'a deck: the margin only beside a slide with threads, one scroll'(page) {
    const slug = await fresh('deck');
    await comment(slug, { body: 'Is the second point true?', quote: 'It costs less to run than a boiler.', prefix: '', suffix: '', slide: 's-why' });
    await openViewer(page, slug);
    await sleep(600);
    ok(await page.evaluate(() => document.querySelector('#cm-col').hidden), 'slide 1 has no thread, so the margin takes no room');
    const full = await rect(page, '.v-stage');
    near(full.width, 1440, 1, 'the slide has the whole width');
    const f = pageFrame(page);
    await page.mouse.click(full.left + 400, full.top + 200);
    await page.keyboard.press('ArrowRight');
    await until(() => page.evaluate(() => !document.querySelector('#cm-col').hidden && !!document.querySelector('.cm-rail > .cm-card')), 'slide 2 shows its thread in the margin');
    const slideW = await f.evaluate(() => document.querySelector('.k-frame.k-cur').getBoundingClientRect().width);
    ok(slideW >= 560, `the slide keeps a size that people can read (${slideW} px)`);
    await oneScroller(page);
    await cardsClean(page);
    await shot(page, 'deck');
    await page.keyboard.press('ArrowRight');
    await until(() => page.evaluate(() => document.querySelector('#cm-col').hidden), 'slide 3 has no thread, so the margin goes again');
    // A wide view has room beside the slide: the slide stays where it is when the margin opens.
    await page.setViewportSize({ width: 2400, height: 900 });
    await sleep(400);
    const alone = await docEdges(page);
    await page.keyboard.press('ArrowLeft');
    await until(() => page.evaluate(() => !document.querySelector('#cm-col').hidden && !!document.querySelector('.cm-rail > .cm-card')), 'slide 2 shows its thread at 2400 px');
    await sleep(400);
    const beside = await docEdges(page), dcard = await rect(page, '.cm-rail > .cm-card');
    near(beside.left, alone.left, 0.5, 'the slide keeps its place when the margin opens in a wide view');
    near(beside.right, alone.right, 0.5, 'the slide keeps its size when the margin opens in a wide view');
    ok(dcard.left >= beside.right + 20, 'the card is beside the slide, not over it');
    await page.setViewportSize({ width: 1440, height: 860 });
    await page.keyboard.press('ArrowRight');
    await until(() => page.evaluate(() => document.querySelector('#cm-col').hidden), 'slide 3 again');
    ok(await f.evaluate(() => document.documentElement.dataset.kView === 'slide'), 'the deck stays in the slide view');
    const rail = await f.evaluate(() => document.documentElement.dataset.kRail !== undefined);
    ok(rail, 'the thumbnails show at this width');
  },

  async 'a deck: the slide glides out of the room of the cards, and the cards move with it'(page) {
    const slug = await fresh('deck');
    await openViewer(page, slug);
    await sleep(400);
    const f = pageFrame(page);
    // The place of the slide on each frame in the deck, on the clock that the two documents share.
    const slideLog = () => f.evaluate(() => {
      const log = (window.__slide = []);
      window.__slideStop = false;
      const tick = () => { const r = document.querySelector('.k-frame.k-cur').getBoundingClientRect(); log.push({ e: performance.timeOrigin + performance.now(), l: r.left, r: r.right, w: r.width }); if (!window.__slideStop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const slideEnd = () => f.evaluate(() => { window.__slideStop = true; return window.__slide; });
    const before = await f.evaluate(() => document.querySelector('.k-frame.k-cur').getBoundingClientRect().right);
    for (const [name, act, done] of [
      ['open', () => page.click('#cnew'), () => page.evaluate(() => !!document.querySelector('.cm-card.is-compose')?.isConnected)],
      ['cancel', () => page.keyboard.press('Escape'), () => page.evaluate(() => document.querySelector('#cm-col').hidden)],
    ]) {
      await slideLog();
      const host = await sampled(page, async () => { await act(); await until(done, name + ': the margin changes'); });
      const sl = await slideEnd();
      const rights = sl.map((x) => x.r), steps = rights.slice(1).map((v, i) => v - rights[i]), total = rights[rights.length - 1] - rights[0];
      const moving = steps.map((d, i) => (Math.abs(d) > 0.01 ? i : -1)).filter((i) => i >= 0);
      const ms = moving.length ? sl[moving[moving.length - 1] + 1].e - sl[moving[0]].e : 0;
      const trace = rights.filter((v, i, a) => i === 0 || v !== a[i - 1]).map((v) => v.toFixed(1)).join(' → ');
      ok(Math.abs(total) > 20, `${name}: the slide moves (${trace})`);
      ok(steps.every((d) => Math.abs(d) <= 0.01 || Math.sign(d) === Math.sign(total)), `${name}: the slide moves in one direction (${trace})`);
      ok(ms >= 150 && ms <= 260, `${name}: the slide glides for 150 to 260 ms (${Math.round(ms)} ms: ${trace})`);
      ok(Math.max(...steps.map(Math.abs)) <= 0.4 * Math.abs(total), `${name}: no frame moves the slide more than 40% of the distance (${trace})`);
      const end = await f.evaluate(() => document.querySelector('.k-frame.k-cur').getBoundingClientRect().right);
      near(rights[rights.length - 1], end, 0.5, `${name}: the glide ends at the place of the slide`);
      if (name === 'cancel') near(end, before, 0.5, 'the slide is back at its place');
      // A card that shows is never over the slide: compare it with the place of the slide on the frame of that moment.
      host.forEach((h) => h.cards.filter((c) => c.o > 0.01).forEach((c) => {
        const at = sl.filter((x) => x.e <= h.e + 1).pop() || sl[0];
        ok(c.l >= h.x + at.r + 8, `${name}: a card is over the slide (${c.l.toFixed(1)} < ${(h.x + at.r).toFixed(1)} + 8)`);
      }));
      console.log(`      deck ${name}: ${Math.round(ms)} ms, ${moving.length} frames: ${trace}`);
    }
    await oneScroller(page);
  },

  async 'middle width: markers beside the page, the card floats beside its marker'(page) {
    const slug = await fresh('doc');
    await comment(slug, { body: 'Middle width note.', quote: 'The second paragraph follows it.', prefix: '', suffix: '' });
    await page.setViewportSize({ width: 900, height: 800 });
    await openViewer(page, slug, { cards: 1 });
    const dot = await rect(page, '.cm-rail > .cm-dot'), stage = await rect(page, '.v-stage');
    ok(dot.left >= stage.right - 0.5, 'the marker is beside the page, not over its text');
    near(dot.top, await pageTop(page, '#p-second'), 12, 'the marker is level with its text');
    await page.click('.cm-rail > .cm-dot');
    await until(() => page.isVisible('.cm-rail > .cm-card.is-active'), 'a click on the marker opens the card');
    const card = await rect(page, '.cm-rail > .cm-card.is-active'), bar = await rect(page, '.v-bar');
    ok(card.right <= dot.left && card.left >= 0, 'the card floats beside its marker, inside the window');
    ok(card.top >= bar.bottom, 'the card is under the bar');
    await oneScroller(page);
    await shot(page, 'mid');
  },

  async 'narrow width: markers in a gutter, the card in a sheet'(page) {
    const slug = await fresh('doc');
    await comment(slug, { body: 'Phone note.', quote: 'The second paragraph follows it.', prefix: '', suffix: '' });
    await page.setViewportSize({ width: 390, height: 844 });
    await openViewer(page, slug, { cards: 1 });
    const dot = await rect(page, '.cm-rail > .cm-dot'), stage = await rect(page, '.v-stage');
    ok(dot.left >= stage.right - 0.5, 'the marker is in the gutter, never over the text');
    const textRight = await pageFrame(page).evaluate(() => Math.max(...[...document.querySelectorAll('main p')].map((p) => p.getBoundingClientRect().right)));
    ok(stage.left + textRight <= dot.left, 'no text reaches under a marker');
    await page.click('.cm-rail > .cm-dot');
    await until(() => page.isVisible('#cm-sheet'), 'a tap on the marker opens the sheet');
    await sleep(350); // the sheet slides up
    const sheet = await rect(page, '#cm-sheet');
    near(sheet.bottom, 844, 1, 'the sheet sits at the bottom of the window');
    ok(await page.isVisible('#cm-sheet .cm-card'), 'the sheet holds the card');
    await shot(page, 'narrow-sheet');
    await page.click('#cm-close');
    await until(() => page.evaluate(() => document.querySelector('#cm-sheet').hidden), 'Close closes the sheet');
    await oneScroller(page);
  },

  async 'the assistant status chip: the state on the library and the viewer, the dialog, and a disconnect'(page) {
    await signIns({ claude: true, chatgpt: false });
    const slug = SLUGS.doc || await fresh('doc');
    try {
      for (const path of ['/', '/p/' + slug]) {
        await page.goto(BASE + path);
        const chip = page.getByRole('button', { name: CLAUDE_ONLY, exact: true });
        await until(() => chip.isVisible(), `${path}: the chip says "${CLAUDE_ONLY}"`);
        const seen = await chipSeen(page);
        ok(seen.tip === CLAUDE_ONLY, `${path}: the tooltip has the same text (${seen.tip})`);
        ok(seen.text === 'C\nC' || seen.text.replace(/\s/g, '') === 'CC', `${path}: the chip shows two marks and no long text (${JSON.stringify(seen.text)})`);
        ok(seen.dots.length === 2 && seen.dots[0].bg === 'rgb(59, 155, 84)', `${path}: Claude has a solid green dot (${JSON.stringify(seen.dots)})`);
        ok(seen.dots[1].bg !== 'rgb(59, 155, 84)' && parseFloat(seen.dots[1].border) > 0, `${path}: ChatGPT has a hollow dot (${JSON.stringify(seen.dots)})`);
        await shot(page, 'chip-' + (path === '/' ? 'library' : 'viewer'));
        await chip.click();
        await until(() => page.isVisible('#assist'), `${path}: a click on the chip opens the Assistants dialog`);
        await until(() => page.locator('.a-row.a-claude .a-state').textContent().then((t) => t === 'Connected · Model: Faster'), `${path}: the dialog says that Claude is connected, with its model`);
        ok(await page.locator('.a-row.a-chatgpt .a-state').textContent() === 'Not connected', `${path}: the dialog says that ChatGPT is not connected`);
        await page.click('#assist-x');
        await until(() => page.isHidden('#assist'), `${path}: Close closes the dialog`);
      }
      // A disconnect in the dialog changes the chip: no assistant is connected, so it asks the person to connect one.
      await page.getByRole('button', { name: CLAUDE_ONLY, exact: true }).click();
      const dis = page.getByRole('button', { name: 'Disconnect Claude', exact: true });
      await until(() => dis.isVisible(), 'the dialog shows Disconnect Claude');
      await dis.click(); await dis.click();
      await until(() => page.getByRole('button', { name: 'Connect Claude', exact: true }).isVisible(), 'the dialog shows Connect Claude');
      await page.click('#assist-x');
      const none = page.getByRole('button', { name: NONE, exact: true });
      await until(() => none.isVisible(), `after the disconnect the chip says "${NONE}"`);
      ok((await chipSeen(page)).text === 'Connect an assistant', 'the chip shows the text "Connect an assistant"');
      await shot(page, 'chip-none');
    } finally {
      await signIns({ claude: true, chatgpt: false });
    }
  },

  async 'the assistant status chip: the bar does not wrap or overflow at 1280, 900 and 390 px'(page) {
    const slug = SLUGS.doc || await fresh('doc');
    try {
      for (const want of [{ claude: true, chatgpt: false }, { claude: false, chatgpt: false }]) {
        await signIns(want);
        for (const w of [1280, 900, 390]) {
          await page.setViewportSize({ width: w, height: 800 });
          for (const path of ['/', '/p/' + slug]) {
            await page.goto(BASE + path);
            await until(() => page.evaluate(() => !document.querySelector('#assist-chip').classList.contains('is-wait')), `${path} at ${w} px: the chip gets its state`);
            const m = await page.evaluate(() => {
              const bar = document.querySelector('header'), b = bar.getBoundingClientRect();
              const kids = [...bar.children].filter((e) => e.getClientRects().length && getComputedStyle(e).position !== 'absolute').map((e) => e.getBoundingClientRect());
              const more = document.querySelector('header [data-pop="pop-more"]').getBoundingClientRect(), chip = document.querySelector('#assist-chip').getBoundingClientRect();
              return { h: b.height, overflow: bar.scrollWidth - bar.clientWidth, page: document.documentElement.scrollWidth - innerWidth, out: kids.filter((r) => r.right > b.right + 0.5 || r.left < b.left - 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5).length, chipRight: chip.right, chipLeft: chip.left, chipH: chip.height, moreLeft: more.left };
            });
            const where = `${path} at ${w} px (${want.claude ? 'Claude connected' : 'none connected'})`;
            ok(m.h === 44 && m.out === 0, `${where}: the bar keeps one row of 44 px (${m.h} px, ${m.out} items outside)`);
            ok(m.overflow <= 0 && m.page <= 0, `${where}: nothing overflows (bar ${m.overflow} px, page ${m.page} px)`);
            ok(m.chipH === 32 && m.chipLeft >= 0, `${where}: the chip has the height of the other controls (${m.chipH} px)`);
            ok(path === '/' || m.chipRight <= m.moreLeft, `${where}: the chip is before More`);
            const seen = await chipSeen(page);
            if (w < 1000) ok(seen.width <= 64 && seen.text.replace(/\s/g, '').length <= 2, `${where}: the chip shows marks and dots only (${seen.width} px, ${JSON.stringify(seen.text)})`);
            if (w < 1000 && !want.claude) ok(seen.dots.length === 1 && parseFloat(seen.dots[0].border) > 0, `${where}: one icon with one hollow dot`);
            await shot(page, `chip-bar-${path === '/' ? 'library' : 'viewer'}-${want.claude ? 'claude' : 'none'}-${w}`);
          }
        }
      }
    } finally {
      await signIns({ claude: true, chatgpt: false });
    }
  },

  async 'Connect ChatGPT: the code, the provider page, then Connected'(page, context) {
    const slug = SLUGS.doc || await fresh('doc');
    await openViewer(page, slug);
    const con = await disconnected(page, 'ChatGPT');
    ok(!(await api('/api/assistants')).assistants.chatgpt.connected, 'the host reports ChatGPT as not connected');
    await shot(page, 'assistants');
    await con.click();
    const code = await until(async () => { const t = (await page.textContent('.a-code output').catch(() => '')) || ''; return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(t) && t; }, 'the dialog shows the short code');
    await shot(page, 'connect-chatgpt');
    const [tab] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'Continue to ChatGPT' }).click()]);
    await tab.waitForLoadState();
    await tab.fill('#c', code);
    await tab.click('button');
    await until(() => tab.isVisible('text=You are signed in'), 'the provider page accepts the code');
    await tab.close();
    await until(() => page.isVisible('.a-live.is-on'), 'the dialog says Connected', 8000);
    await until(async () => (await api('/api/assistants')).assistants.chatgpt.connected === true, 'the host reports ChatGPT as connected');
  },

  async 'Connect Claude: the provider page, paste the code, Connected, and pick a model'(page, context) {
    const slug = SLUGS.doc || await fresh('doc');
    await openViewer(page, slug);
    // Claude starts connected in the simulated runner: disconnect it first.
    await (await disconnected(page, 'Claude')).click();
    const [tab] = await Promise.all([context.waitForEvent('page'), until(() => page.getByRole('button', { name: 'Continue to Claude' }).isEnabled(), 'the main button is ready').then(() => page.getByRole('button', { name: 'Continue to Claude' }).click())]);
    await tab.waitForLoadState();
    await tab.click('#ok');
    const code = (await tab.textContent('#code')).trim();
    await tab.close();
    await shot(page, 'connect-claude');
    // The person pastes the code: the dialog sends it at once.
    await page.focus('.a-field input');
    await page.evaluate((c) => { const i = document.querySelector('.a-field input'); i.value = c; i.dispatchEvent(new ClipboardEvent('paste', { bubbles: true })); }, code);
    await until(() => page.isVisible('.a-live.is-on'), 'the dialog says Connected after the paste', 8000);
    await until(() => page.isVisible('text=More careful'), 'the list comes back with the models');
    await page.locator('.a-row.a-claude label', { hasText: 'More careful' }).click();
    await until(async () => (await api('/api/assistants')).assistants.claude.model === 'sim-claude-careful', 'the model is saved for the person');
    await page.locator('.a-row.a-claude label', { hasText: 'Faster' }).click();
    await until(async () => (await api('/api/assistants')).assistants.claude.model === null, 'the default model needs no saved choice');
  },

  async 'the marks on the text: the Highlight API, and boxes where a browser has no such API'(page) {
    const slug = await fresh('doc');
    await comment(slug, { body: 'Mark this.', quote: 'The second paragraph follows it.', prefix: '', suffix: '' });
    await openViewer(page, slug, { cards: 1 });
    const api = await pageFrame(page).evaluate(() => !!(globalThis.Highlight && CSS.highlights) && (CSS.highlights.get('k-cm')?.size || 0));
    const boxesNow = await pageFrame(page).evaluate(() => document.querySelectorAll('.k-cm-hl').length);
    ok(api ? api === 1 && boxesNow === 0 : boxesNow > 0, `the text has one mark (Highlight API: ${api === false ? 'no' : 'yes'})`);
    // The same page with the boxes, as in a browser with no Highlight API.
    await page.goto(BASE + '/p/' + slug + '?hl=boxes');
    await until(() => pageFrame(page)?.evaluate(() => document.querySelectorAll('.k-cm-hl').length > 0), 'the mark is drawn as boxes');
    // The quote is on one line: one box, on the same place as the text of the quote.
    const fit = () => pageFrame(page).evaluate(() => {
      const all = document.querySelectorAll('.k-cm-hl'), p = document.querySelector('#p-second'), r = document.createRange();
      const q = 'The second paragraph follows it.';
      r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, q.length);
      const t = r.getBoundingClientRect(), b = all[0].getBoundingClientRect();
      return { n: all.length, off: Math.max(Math.abs(b.top - t.top), Math.abs(b.left - t.left), Math.abs(b.width - t.width)), at: [b.left, b.top, b.width, t.left, t.top, t.width].map(Math.round).join() };
    });
    // The boxes follow the text when the page and its margin settle, the web fonts load and the page lays out again.
    await pageFrame(page).evaluate(() => document.fonts.ready.then(() => true));
    let f;
    await until(async () => { f = await fit(); return f.n === 1 && f.off <= 3; }, 'one box covers the quote', 3000).catch((e) => { throw new Fail(`${e.message}: ${f.n} boxes, off by ${f.off} px (${f.at})`); });
    // The frame does not scroll, so a scroll of the view does not move a box on its text, not even for one frame.
    await page.evaluate(() => document.querySelector('#scroll').scrollBy(0, 200));
    f = await fit();
    ok(f.off <= 3, `the box stays on its text when the view scrolls (off by ${f.off} px: ${f.at})`);
  },

  async 'an old version shows its comments read-only'(page) {
    const slug = await fresh('doc');
    await publish(slug, docPage().replace('Paragraph 1.', 'Paragraph one.'));
    await comment(slug, { body: 'On the latest.', quote: 'The second paragraph follows it.', prefix: '', suffix: '' });
    await page.goto(BASE + '/p/' + slug + '/v/1');
    await until(() => page.$('.cm-card'), 'the old version shows the thread');
    ok(await page.isHidden('#cnew'), 'the old version has no new comment button');
    ok(!(await page.$('.cm-card .cm-done')), 'a card on an old version has no Resolve');
    ok(await page.isVisible('#cm-ro'), 'the margin says that the comments are read-only');
  },
};

// ─── The run ───
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const results = {};
for (const engine of ENGINES) {
  ENGINE = engine;
  // --slow makes each action wait, so a recording is easy to follow.
  const browser = await pw[engine].launch({ slowMo: Number(opt('slow')) || 0 });
  for (const [name, test] of Object.entries(TESTS)) {
    if (ONLY && !ONLY.some((o) => name.includes(o))) continue;
    const context = await browser.newContext({ viewport: { width: 1440, height: 860 }, colorScheme: DARK ? 'dark' : 'light', ...(VIDEO ? { recordVideo: { dir: join(VIDEO, engine), size: { width: 1440, height: 860 } } } : {}), ...(engine === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const t0 = Date.now();
    let res;
    try {
      await test(page, context);
      ok(!errors.length, 'no script error: ' + errors.join(' | '));
      res = { pass: true };
    } catch (e) {
      res = { pass: false, error: e.message };
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${engine}-FAIL-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {});
    }
    const video = page.video();
    await context.close();
    if (video) renameSync(await video.path(), join(VIDEO, engine, `${engine}${DARK ? '-dark' : ''}-${name.replace(/\W+/g, '-').replace(/^-|-$/g, '')}.webm`));
    (results[name] ||= {})[engine] = res;
    console.log(`${res.pass ? 'pass' : 'FAIL'}  ${engine.padEnd(8)}  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)${res.error ? '\n      ' + res.error : ''}`);
  }
  await browser.close();
}
// Clean up: every page of this run.
const pages = await api('/api/pages');
for (const p of pages.filter((p) => p.slug.startsWith('browser-tests/') && p.slug.includes(RUN))) await api('/api/pages/' + p.slug, { method: 'DELETE' }).catch(() => {});

console.log('\n' + ['test', ...ENGINES].join(' | '));
for (const [name, r] of Object.entries(results)) console.log([name, ...ENGINES.map((e) => (r[e] ? (r[e].pass ? 'pass' : 'FAIL') : '-'))].join(' | '));
process.exit(Object.values(results).every((r) => Object.values(r).every((x) => x.pass)) ? 0 : 1);
