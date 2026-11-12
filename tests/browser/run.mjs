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
async function cardAndMark(page, id) {
  const card = await rect(page, `.cm-card[data-id="${id}"]`);
  const t = await threads(SLUGS.doc);
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
      await oneScroller(page);
      await cardsClean(page);
      const col = await rect(page, '#cm-col'), stage = await rect(page, '.v-stage');
      ok(col.left >= stage.right - 0.5, `the margin is beside the page at ${w} px, not over it`);
      await shot(page, `wide-${w}`);
    }
  },

  async 'drag across inline elements, Comment button, post, card aligned'(page) {
    const slug = await fresh('doc');
    await openViewer(page, slug);
    await drag(page, await textPoint(page, '#p-first', 'bold words'), await textPoint(page, '#p-first', 'inline code', true));
    await until(() => page.isVisible('#cm-add'), 'the Comment button shows at the selection');
    const btn = await rect(page, '#cm-add'), line = await pageTop(page, '#p-first');
    ok(btn.bottom <= line + 2 && btn.bottom > line - 60, 'the Comment button sits just above the selection');
    await clickAdd(page);
    await until(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Comment'), 'the comment box has the focus');
    await page.keyboard.type('Three inline elements in one quote.');
    await page.keyboard.press(`${MOD}+Enter`);
    const t = await until(async () => (await threads(slug))[0], 'the comment is stored');
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
    await page.click('#cres');
    await page.click('#res-list .v-link');
    await until(async () => (await threads(slug))[0].status === 'open', 'the thread is open again');
    await until(() => page.$(`.cm-card[data-id="${root.id}"]`), 'the card is back');
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
    ok(await f.evaluate(() => document.documentElement.dataset.kView === 'slide'), 'the deck stays in the slide view');
    const rail = await f.evaluate(() => document.documentElement.dataset.kRail !== undefined);
    ok(rail, 'the thumbnails show at this width');
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
