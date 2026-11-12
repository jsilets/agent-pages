// The comments of the viewer: the button at a selection, the cards in the margin, and the messages to the page frame.
// views.ts puts this file into the viewer script, after the helpers of the viewer ($, $$, el, api, toast, svg, D, AGENTS,
// nameOf, tone, when, say, reaction, boost, Assistants) and before the activity code. The first part is pure: margin.test.ts runs it in Node.
// Every text here goes into the document with textContent, so a comment or a text from the page never becomes markup.
//
// The layout: the viewer has one scroller under the bar. In it, the frame of a page is as tall as the page, and the margin
// with the cards is beside it. So the page and the cards scroll together, natively, with no message between them.
// A deck keeps a frame as tall as the view: its slide does not scroll.
const Margin = (() => {
  // ─── The pure part ───────────────────────────────────────

  /**
   * The top of each card. items is [{ id, y, h }]: the wanted top and the height. No two cards overlap, and each pair keeps
   * `gap` between them. The cards keep the order of their wanted tops. With no active card, each card sits at its wanted top
   * or below the card before it. The active card sits at its wanted top, the cards before it move up, and the cards after it
   * move down, like in Google Docs. Those cards may go above `min`, out of view under the cards at the top. No other card
   * goes above `min`.
   * Returns { id: top }.
   */
  function layoutCards(items, opt = {}) {
    const gap = opt.gap ?? 8, min = opt.min ?? 0;
    const list = items.map((it, i) => ({ id: it.id, h: it.h, i, want: Math.max(min, it.y) })).sort((a, b) => a.want - b.want || a.i - b.i);
    const tops = list.map((it) => it.want);
    const k = list.findIndex((it) => it.id === opt.active);
    // The cards before the active card: first stacked down as with no active card, then moved up as far as the active card needs.
    for (let i = 1; i < k; i++) tops[i] = Math.max(tops[i], tops[i - 1] + list[i - 1].h + gap);
    for (let i = k - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - gap - list[i].h);
    let floor = k > 0 ? -Infinity : min;
    for (let i = 0; i < list.length; i++) {
      if (i === k) floor = Math.max(floor, min);
      tops[i] = Math.max(tops[i], floor);
      floor = tops[i] + list[i].h + gap;
    }
    return Object.fromEntries(list.map((it, i) => [it.id, tops[i]]));
  }

  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

  /**
   * A 'select' message from the page frame, checked. The frame is not trusted: each text has a limit, and each number must be
   * a finite number. Returns null for no selection, { live: true } while the pointer is down, or the selection.
   */
  function readSelect(d) {
    if (!d || d.on !== true) return null;
    if (d.live === true) return { live: true };
    const quote = text(d.quote, 1000).trim();
    const rects = Array.isArray(d.rects) ? d.rects.slice(0, 24).map((r) => (Array.isArray(r) && r.length === 4 ? r.map((v) => num(v, -1e5, 1e7)) : null)) : [];
    if (!quote || !rects.length || rects.some((r) => !r || r.includes(null))) return null;
    return { live: false, quote, prefix: text(d.prefix, 64), suffix: text(d.suffix, 64), anchor: text(d.anchor, 200), slide: text(d.slide, 200), rects, y: num(d.y, 0, 1e7) ?? 0 };
  }

  const STATES = ['exact', 'changed', 'spot', 'lost'];
  /** An 'anchors' message from the page frame, checked: the deck, and the place of each comment. */
  function readAnchors(d) {
    const list = d && Array.isArray(d.list) ? d.list.slice(0, 301) : [];
    const deck = d && d.deck && typeof d.deck === 'object' ? { n: num(d.deck.n, 0, 1e4) ?? 0, cur: num(d.deck.cur, 0, 1e4) ?? 0, paged: d.deck.paged === true } : null;
    return {
      deck,
      list: list.filter((a) => a && typeof a.id === 'string' && a.id && a.id.length <= 64)
        .map((a) => ({ id: a.id, state: STATES.includes(a.state) ? a.state : 'lost', top: num(a.top, -1e7, 1e7), slide: num(a.slide, 0, 1e4) ?? 0, hidden: a.hidden === true })),
    };
  }

  /**
   * The height that the frame of a page gets from a 'size' message: at least the view, and at most 200,000 px. A page whose
   * height follows the height of its frame (100vh and more) would grow with each answer. After 6 growths in 2 seconds the
   * height stops growing. Returns { h, grows }; keep `grows` for the next call.
   */
  function frameHeight(v, view, now, grows = []) {
    const h = num(v.h, 0, 2e5);
    if (h == null) return { h: null, grows };
    const recent = grows.filter((t) => now - t < 2000);
    const want = Math.max(view, Math.ceil(h));
    if (want > v.was + 1 && recent.length >= 6) return { h: null, grows: recent };
    return { h: want, grows: want > v.was + 1 ? [...recent, now] : recent };
  }

  /** The mention that the person types at the caret: "@" or "@cl". from is the index of the "@". The host reads a mention with the same rule. */
  function mentionAt(value, caret) {
    const m = String(value).slice(0, caret).match(/(?:^|[^\w@.])@([a-z]*)$/i);
    return m ? { from: caret - m[1].length - 1, query: m[1].toLowerCase() } : null;
  }

  /**
   * What the viewer knows about the sign-in of each assistant, from the runs of the page: 'on' after a run that started,
   * 'off' after a run that had no sign-in, 'none' when no runner handles the mention, and '' when no run says it.
   * The viewer uses it until GET /api/assistants answers.
   */
  function assistantStates(threads, handled) {
    const last = {};
    for (const t of threads) for (const r of Object.values(t.runs || {})) if (r && (!last[r.agent] || r.started_at > last[r.agent].started_at)) last[r.agent] = r;
    const out = {};
    for (const a of ['claude', 'chatgpt']) {
      const r = last[a];
      out[a] = !handled.includes(a) ? 'none' : !r ? '' : r.status === 'failed' && String(r.detail || '').startsWith('not_signed_in') ? 'off' : r.status === 'failed' ? '' : 'on';
    }
    return out;
  }

  /**
   * The name and the initials of an author: an assistant, an email address from Access ("ann.lee@example.com" gives
   * "Ann Lee" and "AL"), or another label as it is.
   */
  function person(author, agents = {}) {
    const a = String(author || '');
    if (agents[a]) return { name: agents[a], initials: agents[a][0] };
    const local = a.includes('@') ? a.slice(0, a.indexOf('@')) : a;
    const words = (a.includes('@') ? local.split(/[._+-]+/) : local.split(/\s+/)).filter(Boolean);
    const name = a.includes('@') ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : a.trim();
    const letters = words.map((w) => (w.match(/[\p{L}\p{N}]/u) || [''])[0].toUpperCase()).filter(Boolean);
    return { name: name || 'Someone', initials: (letters.length > 1 ? letters[0] + letters[letters.length - 1] : letters[0] || '?') };
  }

  const pure = { layoutCards, readSelect, readAnchors, frameHeight, mentionAt, assistantStates, person };
  if (typeof document === 'undefined') return pure;

  // ─── The viewer part ─────────────────────────────────────
  const DRAFT = '~draft';
  const STATE_TEXT = { on: 'Connected', off: 'Not connected', none: 'Not set up', '': '' };
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const deck = D.kind === 'deck';
  const readOnly = !D.followsLatest && D.version < D.latest;
  const scroller = $('#scroll'), body = $('#body'), stage = $('.v-stage'), col = $('#cm-col'), pins = $('#cm-pins'), rail = $('#cm-rail'), sheet = $('#cm-sheet'), add = $('#cm-add');
  const modeOf = () => (innerWidth >= 1000 ? 'wide' : innerWidth >= 700 ? 'mid' : 'narrow');
  // threads: the open threads. anchors: the place of each one in the page. draft: the comment that the person writes now.
  const S = { threads: [], resolved: [], anchors: new Map(), deck: null, ready: false, settled: false, kit: false, active: '', hover: '', sel: null, draft: null, mode: modeOf(), pinsH: 0, side: [], ensure: '', back: null };
  const cards = new Map(), seen = new Set(), fresh = new Set(), unread = new Set();
  let loaded = '', first = true, draftCard = null, warmedAt = 0, laid = 0, sentList = '', autoAt = 0, viewTick = 0;
  const keep = (k, v) => { try { sessionStorage.setItem(k + D.slug, v); } catch {} };
  const kept = (k) => { try { return sessionStorage.getItem(k + D.slug) || ''; } catch { return ''; } };
  const who = (a) => person(a, AGENTS);
  const short = (a) => who(a).name;
  const oneLine = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const mine = (c) => !readOnly && c.author === D.who;
  /** "2:41 PM" for today, and "Nov 9" for another day. */
  function stampOf(iso) {
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  if (readOnly) body.classList.add('is-ro');

  // ─── The frame: its height, and the part of it that shows ───
  // The top of the frame in the scroller. A page frame is at the top; a deck frame sticks to the top of the view.
  const frameTop = () => (deck ? scroller.scrollTop : 0);
  const sizes = new WeakMap();
  /** The frame of a page is as tall as the page. A deck, and a page with no kit, gets the height of the view. */
  function fit(f = frame) {
    const view = scroller.clientHeight, s = sizes.get(f);
    const h = deck || !s || !s.kit ? view : Math.max(view, s.h);
    if (f.style.height !== h + 'px') f.style.height = h + 'px';
    f.classList.toggle('is-self', !deck && !!s && s.self);
  }
  function setSize(f, h, w) {
    const s = sizes.get(f) || { h: 0, kit: true, grows: [] };
    s.w = num(w, 0, 4000) || 0;
    const out = frameHeight({ h, was: s.h || scroller.clientHeight }, scroller.clientHeight, Date.now(), s.grows);
    s.grows = out.grows;
    if (out.h == null) return;
    // A slow page can answer after the viewer gave up on it (self): from now on, the page has the kit.
    s.h = out.h; s.kit = true; s.self = false;
    sizes.set(f, s);
    fit(f);
    s.wait?.(); s.wait = null;
  }
  /**
   * With cards beside it, the page keeps the width that it reads best at, and the page and the margin sit together in the
   * middle of the window, like a document and its comments in Google Docs. With no card, the page has the whole width.
   */
  function group() {
    const w = !col.hidden && S.mode === 'wide' && sizes.get(frame)?.w;
    const v = w ? w + 'px' : '';
    if (stage.style.maxWidth !== v) { stage.style.maxWidth = v; schedule(); }
  }
  /** The part of the page that shows, for the cursor of an assistant and the scroll to a comment. */
  function sendView(user = false) {
    tell({ type: 'view', top: Math.max(0, scroller.scrollTop - frameTop()), h: scroller.clientHeight, user });
  }
  scroller.addEventListener('scroll', () => {
    if (!add.hidden && deck) drawAdd();
    if (viewTick) return;
    viewTick = requestAnimationFrame(() => { viewTick = 0; sendView(Date.now() > autoAt); });
  }, { passive: true });
  /** Scrolls the view. The page learns that the reader did not do it, so its cursor may scroll the view later. */
  function scrollView(top, smooth) {
    autoAt = Date.now() + (smooth ? 700 : 100);
    scroller.scrollTo({ top: Math.max(0, top), behavior: smooth && !still.matches ? 'smooth' : 'instant' });
  }
  const KEYS = { ArrowDown: 40, ArrowUp: -40 };
  function keyScroll(key, shift) {
    const page = scroller.clientHeight * 0.85;
    const dy = key in KEYS ? KEYS[key] : key === 'PageDown' || (key === ' ' && !shift) ? page : key === 'PageUp' || key === ' ' ? -page : null;
    if (key === 'Home') return scrollView(0, true);
    if (key === 'End') return scrollView(scroller.scrollHeight, true);
    if (dy != null) scroller.scrollBy({ top: dy, behavior: still.matches ? 'instant' : 'smooth' });
  }

  // ─── Messages to and from the page frame ───
  // The frame has no origin, so the target origin is '*'. The page gets the quote of each comment, and it only searches for it.
  const tell = (msg, f = frame) => { if (f && f.contentWindow) f.contentWindow.postMessage({ ns: 'k-cm', v: 1, ...msg }, '*'); };
  const quoteOf = (t) => ({ quote: t.quote || '', prefix: t.prefix || '', suffix: t.suffix || '', anchor: t.anchor || '', slide: t.slide || '' });
  const placed = (t) => !!(t.quote || t.anchor || t.slide);
  function pushThreads() {
    const list = S.threads.filter(placed).map((t) => ({ id: t.id, ...quoteOf(t) }));
    if (S.draft && S.draft.q) list.push({ id: DRAFT, ...S.draft.q });
    sentList = JSON.stringify(list);
    tell({ type: 'threads', list, active: S.active, hover: S.hover });
  }
  const mark = () => tell({ type: 'mark', active: S.active, hover: S.hover });
  function hello(f) {
    if (f === frame) S.ready = false;
    tell({ type: 'hello', boxes: new URLSearchParams(location.search).get('hl') === 'boxes', host: true }, f);
  }
  /** A new frame: the first load, a new theme, or a new version of the page. */
  function watch(f) {
    f.addEventListener('load', () => {
      hello(f);
      // A page with no kit never answers: it keeps the height of the view and scrolls itself.
      setTimeout(() => { if (!sizes.get(f)) { sizes.set(f, { h: 0, kit: false, self: true, grows: [] }); fit(f); sizes.get(f).wait?.(); } }, 1500);
    });
    hello(f);
    fit(f);
  }
  // A message from the frame is not trusted: the page in it can send anything. readSelect and readAnchors check each value.
  addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.ns !== 'k-cm' || d.v !== 1) return;
    // The next version of the page reports its height before it shows. Nothing else from it counts until then.
    const next = $$('iframe', stage).find((x) => x !== frame && x.contentWindow === e.source);
    if (next) { if (d.type === 'size') setSize(next, d.h, d.w); return; }
    if (!frame || e.source !== frame.contentWindow) return;
    if (d.type === 'ready') { S.ready = true; S.kit = true; pushThreads(); sendView(); }
    else if (d.type === 'size') { setSize(frame, d.h, d.w); group(); }
    else if (d.type === 'goto') { const y = num(d.y, 0, 2e5); if (y != null) scrollView(frameTop() + y, d.smooth === true); }
    else if (d.type === 'keyscroll' && typeof d.key === 'string') keyScroll(d.key, d.shift === true);
    else if (d.type === 'anchors') {
      const a = readAnchors(d);
      Object.assign(S, { deck: a.deck, settled: true });
      S.anchors = new Map(a.list.map((x) => [x.id, x]));
      render();
    } else if (d.type === 'select') { S.sel = readOnly ? null : readSelect(d); drawAdd(); }
    else if (d.type === 'pick') { const id = text(d.id, 64); if (id && cards.has(id)) activate(id, { reveal: false }); else leave(); }
    else if (d.type === 'hover') setHover(cards.has(d.id) ? d.id : '');
    else if (d.type === 'key' && d.key === 'comment') { S.back = frame; compose(S.sel && !S.sel.live ? S.sel : null); }
    else if (d.type === 'key' && d.key === 'esc') leave();
  });
  // A page with no kit never answers. Its comments show at the top of the margin, each with its quote.
  setTimeout(() => { if (!S.settled) { S.settled = true; render(); } }, 1500);

  // ─── The button at the selection ───
  add.querySelector('kbd').textContent = MAC ? '⌘⌥M' : 'Ctrl+Alt+M';
  add.title = 'Comment on the selected text (' + (MAC ? '⌘⌥M' : 'Ctrl+Alt+M') + ')';
  function drawAdd() {
    const s = S.sel;
    if (!s || s.live || readOnly) { add.hidden = true; return; }
    const was = add.hidden;
    add.hidden = false;
    const w = add.offsetWidth, h = add.offsetHeight, a = s.rects[0], z = s.rects[s.rects.length - 1], dy = s.y + frameTop();
    // Above the first line. With no room there, below the last line.
    const above = a[1] + dy - h - 8, top = above >= scroller.scrollTop + 6 ? above : z[1] + z[3] + dy + 8;
    const mid = top === above ? a[0] + a[2] / 2 : z[0] + z[2] / 2;
    add.style.transform = 'translate(' + Math.round(Math.max(8, Math.min(stage.clientWidth - w - 8, mid - w / 2))) + 'px,' + Math.round(top) + 'px)';
    if (was) { add.style.animation = 'none'; void add.offsetWidth; add.style.animation = ''; }
  }
  // The button never takes the focus, so the selection in the page stays as it is.
  add.addEventListener('mousedown', (e) => e.preventDefault());
  add.addEventListener('click', () => { if (S.sel && !S.sel.live) { S.back = frame; compose(S.sel); } });

  // ─── The warm-up: a sandbox gets ready while the person writes ───
  function warm() {
    Assistants.load();
    if (!D.agents.length || Date.now() - warmedAt < 60000) return;
    warmedAt = Date.now();
    fetch('/api/assistants/warm', { method: 'POST', keepalive: true }).catch(() => {});
  }

  // ─── The mention picker: "@" in a comment box lists the assistants ───
  function mentions(box) {
    let list = null, opts = [], at = 0, m = null;
    const id = 'cm-pick-' + Math.random().toString(36).slice(2, 8);
    box.setAttribute('role', 'combobox'); box.setAttribute('aria-autocomplete', 'list'); box.setAttribute('aria-expanded', 'false'); box.setAttribute('aria-controls', id);
    const close = () => { if (!list) return; list.remove(); list = null; box.setAttribute('aria-expanded', 'false'); box.removeAttribute('aria-activedescendant'); };
    const pick = (a) => {
      close();
      if (a === '~settings') { Assistants.open(); return; }
      box.setRangeText('@' + a + ' ', m.from, box.selectionStart, 'end'); box.dispatchEvent(new Event('input')); box.focus();
    };
    function stateOf(a) {
      const s = Assistants.state(a);
      if (s) return !s.handled ? 'none' : s.connected === true ? 'on' : s.connected === false ? 'off' : '';
      return assistantStates([...S.threads, ...S.resolved], D.agents)[a];
    }
    function draw() {
      if (!list) { list = el('div', 'cm-pick'); list.id = id; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Assistants'); box.after(list); box.setAttribute('aria-expanded', 'true'); }
      list.replaceChildren(...opts.map((a, i) => {
        const o = el('div', 'cm-opt' + (a === '~settings' ? ' is-settings' : ' ' + tone(a)) + (i === at ? ' is-on' : ''));
        o.id = id + '-' + i; o.setAttribute('role', 'option'); o.setAttribute('aria-selected', String(i === at));
        if (a === '~settings') o.append(el('span', 'cm-gear'), el('b', '', 'Assistant settings'));
        else {
          const ava = el('span', 'cm-ava', nameOf(a)[0]), st = stateOf(a);
          ava.setAttribute('aria-hidden', 'true');
          o.append(ava, el('b', '', nameOf(a)), el('span', 'cm-at', '@' + a), el('span', 'cm-state' + (st === 'off' ? ' is-off' : ''), STATE_TEXT[st]));
        }
        // mousedown, so the box keeps the focus.
        o.addEventListener('mousedown', (e) => { e.preventDefault(); pick(a); });
        return o;
      }));
      box.setAttribute('aria-activedescendant', id + '-' + at);
      // The list opens just under the box, over the buttons below it.
      list.style.top = box.offsetTop + box.offsetHeight + 4 + 'px';
    }
    function update() {
      m = mentionAt(box.value, box.selectionStart);
      opts = m && box.selectionStart === box.selectionEnd ? Object.keys(AGENTS).filter((a) => a.startsWith(m.query) || nameOf(a).toLowerCase().startsWith(m.query)) : [];
      if (!opts.length) return close();
      opts.push('~settings');
      at = Math.min(at, opts.length - 1);
      draw();
    }
    Assistants.onChange(() => { if (list) draw(); });
    box.addEventListener('input', update);
    box.addEventListener('click', update);
    box.addEventListener('blur', close);
    box.addEventListener('keydown', (e) => {
      if (!list) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { at = (at + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length; draw(); }
      else if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') pick(opts[at]);
      else if (e.key === 'Escape') close();
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
    });
  }
  /** A comment box grows with its text. */
  function grow(box) {
    const fitBox = () => { box.style.height = 'auto'; box.style.height = Math.min(220, box.scrollHeight + 1) + 'px'; };
    box.addEventListener('input', fitBox);
    return fitBox;
  }
  /** Cancel and the main button under a box. */
  function actions(label, hint) {
    const acts = el('div', 'cm-acts'), cancel = el('button', 'v-btn cm-cancel', 'Cancel'), send = el('button', 'v-create', label);
    cancel.type = send.type = 'button'; send.disabled = true;
    if (hint) acts.append(el('span', 'cm-hint', (MAC ? '⌘' : 'Ctrl') + ' Enter'));
    acts.append(cancel, send);
    return { acts, cancel, send };
  }

  // ─── One comment, one card ───
  function bodyOf(value) {
    const p = el('p', 'cm-body');
    String(value).split(/((?<![\w@.])@(?:claude|chatgpt)(?![\w-]|\.\w))/i).forEach((part, i) => p.append(i % 2 ? el('span', 'cm-at', part) : part));
    return p;
  }
  function avatar(author, cls = '') {
    const agent = AGENTS[author] ? author : '', a = el('span', 'cm-ava' + (agent ? ' is-agent ' + tone(agent) : '') + cls, who(author).initials);
    a.setAttribute('aria-hidden', 'true');
    return a;
  }
  /** The ⋯ menu of a comment of the person: Edit and Delete. */
  function menuOf(c, t, card) {
    const b = el('button', 'v-icon cm-menu');
    b.type = 'button'; b.innerHTML = svg('more'); b.setAttribute('aria-label', 'More for this comment'); b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      Menu.open(b, [
        { label: 'Edit', run: () => editRow(c, card) },
        { label: c.id === t.id ? 'Delete thread' : 'Delete', danger: true, run: () => removeComment(c, t, b) },
      ]);
    });
    return b;
  }
  function commentRow(c, t, run, card) {
    const agent = AGENTS[c.author] ? c.author : '', row = el('div', 'cm-c' + (agent ? ' ' + tone(agent) : '')), main = el('div', 'cm-main'), head = el('div', 'cm-head'), names = el('div', 'cm-names');
    const time = el('time', '', stampOf(c.created_at) + (c.edited_at ? ' · Edited' : ''));
    time.dateTime = c.created_at; time.title = when(c.created_at) + (c.edited_at ? '. Edited ' + when(c.edited_at) : '');
    const name = el('b', '', short(c.author));
    if (String(c.author).includes('@')) name.title = c.author;
    names.append(name, time);
    head.append(names);
    if (mine(c) && card) head.append(menuOf(c, t, card));
    main.append(head, bodyOf(c.body), ...reaction(run));
    row.dataset.comment = c.id;
    row.append(avatar(c.author), main);
    if (fresh.delete(c.id)) row.classList.add('is-new');
    return row;
  }
  /** Changes the body of a comment in place: the text becomes a box with Save and Cancel. */
  function editRow(c, card) {
    const row = $('[data-comment="' + c.id + '"]', card.el), p = row && $('.cm-body', row);
    if (!p || $('.cm-edit', row)) return;
    const box = el('textarea', 'cm-edit'), { acts, cancel, send } = actions('Save');
    box.value = c.body; box.maxLength = 4000; box.rows = 1; box.setAttribute('aria-label', 'Change the comment');
    send.disabled = false;
    const fitBox = grow(box);
    p.replaceWith(box); box.after(acts);
    card.editing = true;
    fitBox(); box.focus(); box.setSelectionRange(box.value.length, box.value.length);
    const done = () => { card.editing = false; card.key = ''; render(); card.el.focus({ preventScroll: true }); };
    const save = async () => {
      const value = box.value.trim();
      if (!value || send.disabled) return;
      if (value === c.body) return done();
      send.disabled = true;
      try { Object.assign(c, await api('/api/comments/' + c.id, { method: 'PATCH', body: JSON.stringify({ body: value }) })); say('Comment changed.'); done(); refresh(); }
      catch (err) { toast('Could not change the comment: ' + err.message); send.disabled = false; }
    };
    box.addEventListener('input', () => { send.disabled = !box.value.trim(); });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
    });
    send.addEventListener('click', save);
    cancel.addEventListener('click', done);
    schedule();
  }
  /** Deletes a comment after the person confirms. The first comment of a thread takes the thread with it. */
  async function removeComment(c, t, from) {
    const root = c.id === t.id, n = root ? t.replies.length : 0;
    const ok = await confirmBox({
      title: root ? 'Delete this thread?' : 'Delete this comment?',
      text: root ? (n ? 'This deletes the comment and its ' + (n === 1 ? 'reply' : n + ' replies') + '. You cannot undo this.' : 'This deletes the comment. You cannot undo this.') : 'This deletes your reply. You cannot undo this.',
      ok: 'Delete',
    });
    if (!ok) { from.focus(); return; }
    try { await api('/api/comments/' + c.id, { method: 'DELETE' }); }
    catch (err) { toast('Could not delete the comment: ' + err.message); return; }
    if (root) { S.threads = S.threads.filter((x) => x.id !== t.id); if (S.active === t.id) S.active = ''; say('Thread deleted.'); }
    else { t.replies = t.replies.filter((x) => x.id !== c.id); const card = cards.get(t.id); if (card) card.key = ''; say('Comment deleted.'); cards.get(t.id)?.el.focus({ preventScroll: true }); }
    pushThreads(); render(); refresh();
  }
  const labelOf = (t) => 'Comment from ' + short(t.author) + ': ' + oneLine(t.body, 80) + (t.replies.length ? '. ' + t.replies.length + (t.replies.length === 1 ? ' reply' : ' replies') : '');
  function makeCard(t) {
    const c = { id: t.id, key: '', y: 0, top: null, el: el('article', 'cm-card'), dot: el('button', 'cm-dot'), list: el('div', 'cm-list'), foot: el('div', 'cm-foot'), box: el('textarea'), done: el('button', 'v-icon cm-done'), editing: false };
    c.el.tabIndex = 0; c.el.dataset.id = t.id;
    c.dot.type = 'button'; c.dot.dataset.id = t.id;
    c.done.type = 'button'; c.done.innerHTML = svg('check'); c.done.dataset.tip = 'Resolve'; c.done.dataset.tipEnd = ''; c.done.setAttribute('aria-label', 'Resolve thread');
    c.box.rows = 1; c.box.maxLength = 4000; c.box.placeholder = 'Reply, or @ to ask an assistant'; c.box.setAttribute('aria-label', 'Reply');
    const { acts, cancel, send } = actions('Reply');
    c.foot.append(c.box, acts);
    c.el.append(...(readOnly ? [] : [c.done]), c.list, ...(readOnly ? [] : [c.foot]));
    const fitBox = grow(c.box);
    mentions(c.box);
    const reply = async () => {
      const value = c.box.value.trim();
      if (!value || send.disabled) return;
      send.disabled = true;
      try {
        const made = await api('/api/pages/' + D.slug + '/comments', { method: 'POST', body: JSON.stringify({ body: value, parent_id: t.id }) });
        seen.add(made.id);
        const th = S.threads.find((x) => x.id === t.id);
        if (th) th.replies.push(made);
        c.box.value = ''; c.foot.classList.remove('has-text'); fitBox();
        render(); boost(); refresh();
        c.box.focus({ preventScroll: true });
      } catch (err) { toast('Could not send the reply: ' + err.message); send.disabled = false; }
    };
    c.box.addEventListener('input', () => { const on = !!c.box.value.trim(); send.disabled = !on; c.foot.classList.toggle('has-text', on); });
    c.box.addEventListener('focus', () => { warm(); c.foot.classList.add('has-focus'); });
    c.box.addEventListener('blur', () => c.foot.classList.remove('has-focus'));
    c.box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); reply(); }
      else if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (c.box.value) { c.box.value = ''; c.box.dispatchEvent(new Event('input')); } else c.el.focus(); }
    });
    send.addEventListener('click', reply);
    cancel.addEventListener('click', () => { c.box.value = ''; c.box.dispatchEvent(new Event('input')); c.el.focus(); });
    c.done.addEventListener('click', async (e) => {
      e.stopPropagation();
      c.done.disabled = true;
      try { await api('/api/comments/' + t.id + '/resolve', { method: 'PUT' }); }
      catch (err) { toast('Could not resolve the thread: ' + err.message); c.done.disabled = false; return; }
      const i = S.threads.findIndex((x) => x.id === t.id);
      if (i >= 0) S.resolved.push({ ...S.threads.splice(i, 1)[0], status: 'resolved' });
      if (S.active === t.id) S.active = '';
      say('Thread resolved.');
      pushThreads(); render(); refresh();
      // The focus goes to the button that lists the resolved threads, so the keyboard does not lose its place.
      $('#cres').focus({ preventScroll: true });
    });
    c.el.addEventListener('click', (e) => { if (!e.target.closest('button, textarea, a, .cm-pick')) activate(t.id); });
    c.el.addEventListener('keydown', (e) => {
      if (e.target !== c.el) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(t.id); if (!readOnly) c.box.focus({ preventScroll: true }); }
    });
    c.el.addEventListener('pointerenter', () => setHover(t.id));
    c.el.addEventListener('pointerleave', () => setHover(''));
    c.dot.addEventListener('click', () => (S.active === t.id ? leave() : activate(t.id)));
    c.dot.addEventListener('pointerenter', () => setHover(t.id));
    c.dot.addEventListener('pointerleave', () => setHover(''));
    seenSize.observe(c.el); seenSize.observe(c.dot);
    return c;
  }
  /** Draws the comments of a card again when the thread, its place or its state changed. The reply box stays, with its text. */
  function fill(c, t, a, off) {
    const active = S.active === t.id, changed = !!t.quote && (!a || a.state === 'changed' || a.state === 'lost') && S.ready;
    c.el.classList.toggle('is-active', active);
    c.dot.classList.toggle('is-active', active);
    if (c.editing) return;
    const key = JSON.stringify([t, active, changed, off, unread.has(t.id)]);
    if (key === c.key) return;
    c.key = key;
    const rows = [], runs = t.runs || {};
    if (t.quote) {
      const q = el('div', 'cm-quote' + (changed ? ' is-changed' : '') + (off ? ' is-off' : ''));
      if (changed) q.append(el('span', 'cm-flag', 'Original text changed'));
      q.append(el('q', '', t.quote));
      rows.push(q);
    }
    rows.push(commentRow(t, t, runs[t.id], c));
    if (active) t.replies.forEach((r) => rows.push(commentRow(r, t, runs[r.id], c)));
    else if (t.replies.length) {
      const last = t.replies[t.replies.length - 1], more = el('div', 'cm-more' + (fresh.delete(last.id) ? ' is-new' : ''));
      more.append(el('span', 'cm-n', t.replies.length + (t.replies.length === 1 ? ' reply' : ' replies')), el('span', 'cm-last', short(last.author) + ': ' + oneLine(last.body, 120)));
      rows.push(more);
      // A run that a reply started shows on the closed card too, while it goes on or after it failed.
      t.replies.forEach((r) => { const run = runs[r.id]; if (run && run.status !== 'done') rows.push(...reaction(run)); });
    }
    c.list.replaceChildren(...rows);
    c.el.classList.toggle('has-new', unread.has(t.id));
    c.el.setAttribute('aria-label', labelOf(t) + (changed ? '. The original text changed.' : ''));
    c.el.setAttribute('aria-expanded', String(active));
    const agent = AGENTS[t.author] ? t.author : '';
    c.dot.className = 'cm-dot' + (agent ? ' is-agent ' + tone(agent) : '') + (active ? ' is-active' : '') + (unread.has(t.id) ? ' has-new' : '');
    c.dot.replaceChildren(who(t.author).initials.slice(0, 1), ...(t.replies.length ? [el('i', '', String(t.replies.length + 1))] : []));
    c.dot.setAttribute('aria-label', labelOf(t));
    c.dot.setAttribute('aria-expanded', String(active));
  }

  // ─── The new comment ───
  function makeDraft() {
    const c = { id: DRAFT, y: 0, top: null, el: el('article', 'cm-card is-compose is-active'), dot: el('span', 'cm-dot is-active is-draft', '+'), box: el('textarea') };
    const row = el('div', 'cm-c'), main = el('div', 'cm-main'), head = el('div', 'cm-head'), names = el('div', 'cm-names'), { acts, cancel, send } = actions('Comment', true);
    names.append(el('b', '', short(D.who)));
    head.append(names);
    row.append(avatar(D.who), main);
    c.quote = el('div', 'cm-quote');
    c.el.setAttribute('role', 'group'); c.el.setAttribute('aria-label', 'New comment');
    c.dot.setAttribute('aria-hidden', 'true');
    c.box.rows = 1; c.box.maxLength = 4000; c.box.placeholder = 'Comment, or @ to ask an assistant'; c.box.setAttribute('aria-label', 'Comment');
    main.append(head, c.quote, c.box, acts);
    c.el.append(row);
    c.fit = grow(c.box);
    mentions(c.box);
    c.box.addEventListener('input', () => { S.draft.text = c.box.value; keep('draft:', c.box.value); send.disabled = !c.box.value.trim(); });
    c.box.addEventListener('focus', warm);
    c.box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); }
      else if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); cancelDraft(); }
    });
    const post = async () => {
      const d = S.draft, value = c.box.value.trim();
      if (!d || !value || send.disabled) return;
      send.disabled = true;
      try {
        const made = await api('/api/pages/' + D.slug + '/comments', { method: 'POST', body: JSON.stringify({ body: value, ...(d.q ? { quote: d.q.quote, prefix: d.q.prefix, suffix: d.q.suffix, anchor: d.q.anchor, slide: d.q.slide } : {}) }) });
        seen.add(made.id);
        S.threads.push({ ...made, replies: [], run: null, runs: {} });
        // The card takes the place of the box at once. The page sends the exact place a moment later.
        const at = S.anchors.get(DRAFT);
        if (at) S.anchors.set(made.id, { ...at, id: made.id });
        keep('draft:', '');
        // The person can press Esc or go on while the comment is on its way. Then the card does not open, and the focus stays where the person put it.
        const still = S.draft === d, inBox = c.el.contains(document.activeElement) || document.activeElement === document.body;
        if (still) { closeDraft(); S.active = made.id; S.back = null; }
        say('Comment added.');
        pushThreads(); render(); boost(); refresh();
        // The focus goes to the new card, so Tab reaches its reply box and Esc closes it.
        if (still && inBox) cards.get(made.id)?.el.focus({ preventScroll: true });
      } catch (err) { toast('Could not send the comment: ' + err.message); send.disabled = false; }
    };
    send.addEventListener('click', post);
    cancel.addEventListener('click', () => cancelDraft());
    c.send = send;
    seenSize.observe(c.el); seenSize.observe(c.dot);
    return c;
  }
  /** Opens the box for a new comment: on the selection, or on the whole page with no selection. A box that is open moves there and keeps its text. */
  function compose(sel) {
    if (readOnly) return;
    if (!S.back) S.back = document.activeElement && document.activeElement !== document.body ? document.activeElement : frame;
    const value = S.draft ? S.draft.text : kept('draft:');
    S.draft = { q: sel ? { quote: sel.quote, prefix: sel.prefix, suffix: sel.suffix, anchor: sel.anchor, slide: sel.slide } : null, y: sel ? sel.rects[0][1] + sel.y : null, text: value };
    S.active = DRAFT; S.sel = null; S.ensure = DRAFT;
    add.hidden = true;
    if (!draftCard) draftCard = makeDraft();
    draftCard.box.value = value;
    draftCard.send.disabled = !value.trim();
    draftCard.quote.replaceChildren(...(sel ? [el('q', '', sel.quote)] : []));
    warm();
    // The page marks the text of the new comment in place of the selection.
    pushThreads();
    tell({ type: 'unselect' });
    render();
    draftCard.fit();
    draftCard.box.focus({ preventScroll: true });
  }
  /**
   * Gives the focus back. Firefox does not move the focus to a frame while the key event that removed the focused box
   * runs, so the frame gets it again in the next task too.
   */
  function focusBack(n) {
    if (!n) return;
    n.focus({ preventScroll: true });
    if (n.tagName === 'IFRAME') setTimeout(() => { if (document.activeElement === document.body) n.focus({ preventScroll: true }); });
  }
  function closeDraft() {
    S.draft = null;
    if (S.active === DRAFT) S.active = '';
    if (draftCard) { draftCard.el.remove(); draftCard.dot.remove(); draftCard.top = null; }
  }
  /** Closes the new comment. The focus goes back to where it was before the box opened: the page, or the button in the bar. */
  function cancelDraft() {
    if (!S.draft) return;
    closeDraft();
    pushThreads(); render();
    const back = S.back; S.back = null;
    focusBack(back && back.isConnected ? back : frame);
  }

  // ─── Which card is open ───
  function setHover(id) {
    if (S.hover === id) return;
    cards.get(S.hover)?.el.classList.remove('is-hover');
    cards.get(S.hover)?.dot.classList.remove('is-hover');
    S.hover = id;
    cards.get(id)?.el.classList.add('is-hover');
    cards.get(id)?.dot.classList.add('is-hover');
    mark();
  }
  /** Opens a thread. The view scrolls to its text when the text is not in view. A deck shows the slide of the thread. */
  function activate(id, { reveal = true } = {}) {
    if (S.draft && !S.draft.text.trim() && id !== DRAFT) closeDraft();
    unread.delete(id);
    const a = S.anchors.get(id);
    if (S.active !== id) { S.active = id; pushThreads(); render(); } else schedule();
    if (!reveal || !a) { S.ensure = id; return; }
    if (a.hidden || a.top == null) { S.revealAt = Date.now(); tell({ type: 'reveal', id }); return; }
    const top = frameTop() + a.top - scroller.scrollTop, room = scroller.clientHeight - (S.mode === 'narrow' ? sheetRoom() : 0);
    if (!deck && (top < 48 || top > room - 96)) scrollView(frameTop() + a.top - Math.min(room * 0.3, 160), true);
    else S.ensure = id;
  }
  /** Closes the open thread. A new comment with no text closes too; one with text stays. */
  function leave() {
    if (S.draft && !S.draft.text.trim()) closeDraft();
    else if (S.draft && S.active === DRAFT) return;
    if (!S.active && !S.draft) { pushThreads(); render(); return; }
    S.active = S.draft ? DRAFT : '';
    pushThreads(); render();
  }
  [col, rail, pins].forEach((n) => n.addEventListener('click', (e) => { if (e.target === n) leave(); }));
  $('#cm-close').addEventListener('click', () => (S.draft && S.active === DRAFT ? cancelDraft() : leave()));
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyM') { e.preventDefault(); if (!S.back) S.back = document.activeElement; compose(S.sel && !S.sel.live ? S.sel : null); }
    else if (e.key === 'Escape' && !open && !Menu.isOpen() && !e.defaultPrevented && !$('dialog[open]') && S.active) {
      const c = cards.get(S.active);
      leave();
      if (c && c.el.isConnected && S.mode === 'wide') c.el.focus({ preventScroll: true });
    }
  });
  $('#cnew').addEventListener('click', () => { S.back = $('#cnew'); compose(S.sel && !S.sel.live ? S.sel : null); });

  // ─── Where each card goes ───
  const seenSize = new ResizeObserver(() => schedule());
  seenSize.observe(pins);
  /** Puts the children of a parent in the given order. It moves nothing when the order is right, so no box loses the focus. */
  function order(parent, nodes) {
    const now = [...parent.children];
    if (now.length === nodes.length && now.every((n, i) => n === nodes[i])) return;
    const focus = document.activeElement;
    now.forEach((n) => { if (!nodes.includes(n)) n.remove(); });
    nodes.forEach((n, i) => { if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] || null); });
    if (focus && focus !== document.activeElement && focus.isConnected) focus.focus({ preventScroll: true });
  }
  /** The height of the sheet at the bottom of a phone, which covers the page under it. */
  const sheetRoom = () => (sheet.hidden ? 0 : sheet.offsetHeight);
  function render() {
    S.mode = modeOf();
    const top = [], side = [], inSheet = [];
    // A deck that shows one slide at a time shows the threads of that slide. The other threads count on their slides.
    const paged = !!(S.deck && S.deck.paged);
    for (const t of S.threads) {
      const a = S.anchors.get(t.id), anchored = placed(t);
      if (anchored && !S.settled) continue;
      let c = cards.get(t.id);
      if (!c) { c = makeCard(t); cards.set(t.id, c); }
      const off = anchored && S.ready && a && a.hidden && !paged;
      if (anchored && S.ready && a && a.hidden && paged) {
        // The person went to another slide: the open thread of the slide before closes. A thread that the viewer is about to show stays open.
        if (S.active === t.id && Date.now() - (S.revealAt || 0) > 1500) S.active = '';
        if (S.active !== t.id) { c.el.remove(); c.dot.remove(); continue; }
      }
      fill(c, t, a, off);
      const here = anchored && S.ready && a && a.top != null;
      if (here) c.y = a.top;
      if (S.mode === 'narrow' && S.active === t.id) inSheet.push(c.el);
      if (here) side.push(c); else top.push(c);
    }
    cards.forEach((c, id) => { if (!S.threads.some((t) => t.id === id)) { seenSize.unobserve(c.el); seenSize.unobserve(c.dot); c.el.remove(); c.dot.remove(); cards.delete(id); } });
    if (S.draft) {
      const a = S.anchors.get(DRAFT);
      if (S.draft.q && (S.draft.y != null || (a && a.top != null))) { draftCard.y = a && a.top != null ? a.top : S.draft.y; side.push(draftCard); } else top.push(draftCard);
      if (S.mode === 'narrow') inSheet.push(draftCard.el);
    }
    side.sort((x, y) => x.y - y.y);
    const nodes = (list) => list.flatMap((c) => (inSheet.includes(c.el) ? [c.dot] : [c.el, c.dot]));
    // A card can move from one list to another, for example when the page finds the place of a new comment. It keeps the focus.
    const focus = document.activeElement;
    order(pins, nodes(top));
    order(rail, nodes(side));
    order($('#cm-slot'), inSheet.slice(0, 1));
    if (focus && focus !== document.activeElement && focus.isConnected) focus.focus({ preventScroll: true });
    S.side = side;
    // The margin takes room only when it has a card: on a deck, when the slide that shows has a thread.
    const any = top.length + side.length > 0 || (readOnly && !!$('#cm-ro') && S.threads.length > 0);
    const was = col.hidden;
    col.hidden = !any;
    const sheetWas = sheet.hidden;
    sheet.hidden = !inSheet.length;
    $('#cm-sheet-h').textContent = S.draft && S.active === DRAFT ? 'New comment' : 'Comment';
    body.dataset.cm = S.mode;
    const n = S.resolved.length, res = $('#cres');
    res.hidden = !n;
    res.lastChild.textContent = n + ' resolved';
    res.setAttribute('aria-label', n + (n === 1 ? ' resolved thread' : ' resolved threads'));
    group();
    if (was !== col.hidden) fit();
    layout();
    schedule();
    // On a phone, the sheet covers the bottom of the page. The text of the open comment moves up above it.
    if (sheetWas && !sheet.hidden) requestAnimationFrame(() => { const a = S.anchors.get(S.active); if (a && a.top != null) { const y = frameTop() + a.top - scroller.scrollTop; if (y > scroller.clientHeight - sheetRoom() - 40) scrollView(frameTop() + a.top - 72, true); } });
  }
  const schedule = () => { if (!laid) laid = requestAnimationFrame(() => { laid = 0; layout(); }); };
  /** Reads the height of each card, then writes the top of each card. The reads come first, so the browser lays out one time. */
  function layout() {
    if (col.hidden) { S.pinsH = 0; col.style.minHeight = ''; return; }
    const dots = S.mode !== 'wide', side = S.side || [];
    // The rail starts at the top of the margin. The cards on it go under the read-only note and the cards of the whole page.
    const pinsH = pins.offsetTop + pins.offsetHeight;
    const items = side.map((c) => ({ id: c.id, y: c.y - (dots ? 3 : 12), h: (dots ? c.dot : c.el).offsetHeight }));
    const tops = layoutCards(items, { active: dots ? '' : S.active, gap: dots ? 4 : 8, min: pinsH + (dots ? 6 : 8) });
    let bottom = pinsH;
    side.forEach((c, i) => {
      const y = Math.round(tops[c.id]);
      bottom = Math.max(bottom, y + items[i].h);
      // A new card takes its place with no movement. After that, a change of place glides.
      if (c.top == null) { c.el.classList.add('is-in'); c.dot.classList.add('is-in'); }
      if (c.top !== y) { c.top = y; c.el.style.setProperty('--y', y + 'px'); c.dot.style.setProperty('--y', y + 'px'); }
    });
    // The open card in the middle layout floats beside its dot, and it must fit too.
    const act = dots && S.mode === 'mid' && side.find((c) => c.id === S.active);
    if (act) bottom = Math.max(bottom, act.top + act.el.offsetHeight);
    S.pinsH = pinsH;
    // The margin is at least as tall as its lowest card, so the view can scroll to it.
    col.style.minHeight = Math.ceil(bottom + 24) + 'px';
    requestAnimationFrame(() => side.forEach((c) => { c.el.classList.remove('is-in'); c.dot.classList.remove('is-in'); }));
    // A card that the person just opened must show in full: the view scrolls by the part that is out of view.
    const want = S.ensure && (side.find((c) => c.id === S.ensure) || (S.ensure === DRAFT && draftCard && draftCard.el.isConnected && { el: draftCard.el, top: null }));
    if (want && S.mode !== 'narrow') {
      S.ensure = '';
      const r = want.el.getBoundingClientRect(), v = scroller.getBoundingClientRect();
      const dy = r.bottom > v.bottom - 16 ? Math.min(r.bottom - v.bottom + 24, r.top - v.top - 16) : r.top < v.top + 8 ? r.top - v.top - 16 : 0;
      if (Math.abs(dy) > 1) scrollView(scroller.scrollTop + dy, true);
    }
  }
  addEventListener('resize', () => { fit(); sendView(); if (modeOf() !== S.mode) render(); else schedule(); });

  // ─── The threads of the page ───
  async function refresh() {
    const all = await api('/api/pages/' + D.slug + '/comments');
    const key = JSON.stringify(all);
    if (key === loaded) return;
    loaded = key;
    S.threads = all.filter((t) => t.status === 'open');
    S.resolved = all.filter((t) => t.status === 'resolved');
    for (const t of all) for (const c of [t, ...t.replies]) {
      // A comment from another person or from an assistant that arrives while the page is open comes in with a short animation.
      if (!seen.has(c.id) && !first) { fresh.add(c.id); if (S.active !== t.id) unread.add(t.id); }
      seen.add(c.id);
    }
    first = false;
    if (S.active && S.active !== DRAFT && !S.threads.some((t) => t.id === S.active)) S.active = '';
    const list = JSON.stringify(S.threads.filter(placed).map((t) => ({ id: t.id, ...quoteOf(t) })).concat(S.draft && S.draft.q ? [{ id: DRAFT, ...S.draft.q }] : []));
    if (list !== sentList) pushThreads();
    render();
  }
  // Other people write comments too, so the viewer loads the threads every 5 seconds.
  setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 5000);
  refresh().catch((err) => toast('Could not load the comments: ' + err.message));

  // The resolved threads: a list under the bar, each with a button that opens the thread again.
  $('#pop-res').addEventListener('open', () => {
    $('#res-list').replaceChildren(...S.resolved.map((t) => {
      const row = el('div', 'v-resrow'), main = el('div', 'v-resmain'), b = el('button', 'v-link', 'Reopen');
      main.append(el('b', '', short(t.author)), el('span', '', oneLine(t.body, 140)));
      if (t.quote) main.append(el('q', '', oneLine(t.quote, 90)));
      b.type = 'button'; b.setAttribute('aria-label', 'Reopen the thread from ' + short(t.author));
      if (readOnly) b.hidden = true;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await api('/api/comments/' + t.id + '/resolve', { method: 'DELETE' }); }
        catch (err) { toast('Could not reopen the thread: ' + err.message); b.disabled = false; return; }
        closePop();
        say('Thread reopened.');
        await refresh().catch(() => {});
        activate(t.id);
        cards.get(t.id)?.el.focus({ preventScroll: true });
      });
      row.append(main, b);
      return row;
    }));
  });

  watch(frame);
  return {
    ...pure,
    refresh: () => refresh().catch(() => {}),
    /** The next version loads in a second frame. It gets the hello and reports its height, before it shows. Resolves when it has. */
    prepare(f) {
      return new Promise((ok) => {
        const s = { h: 0, kit: false, grows: [], wait: ok };
        sizes.set(f, s);
        f.addEventListener('load', () => { tell({ type: 'hello', boxes: new URLSearchParams(location.search).get('hl') === 'boxes', host: true }, f); setTimeout(ok, 1500); }, { once: true });
        f.style.height = frame.style.height;
      });
    },
    /** The viewer swapped in the frame of a new version. */
    frame: () => { f2(frame); },
    /** The top of the frame in the view and the height of the view, for the cursor of an assistant. */
    sendView,
    /** A run ended on a thread. Its card opens when the person has no other card open, so the answer shows as it arrives. */
    async answered(thread) {
      await refresh().catch(() => {});
      if (!S.active && S.mode === 'wide' && cards.has(thread)) activate(thread, { reveal: false });
    },
  };
  /** The frame that the viewer swapped in already has its height. It gets the hello again, then the threads. */
  function f2(f) {
    f.addEventListener('load', () => { if (f === frame) hello(f); });
    hello(f);
    fit(f);
  }
})();
