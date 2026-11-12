// The comments of the viewer: the button at a selection, the cards in the margin, and the messages to the page frame.
// views.ts puts this file into the viewer script, after the helpers of the viewer ($, $$, el, api, toast, svg, D, AGENTS,
// nameOf, tone, when, say, reaction, boost) and before the activity code. The first part is pure: margin.test.ts runs it in Node.
// Every text here goes into the document with textContent, so a comment or a text from the page never becomes markup.
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
    const rects = Array.isArray(d.rects) ? d.rects.slice(0, 24).map((r) => (Array.isArray(r) && r.length === 4 ? r.map((v) => num(v, -1e5, 1e5)) : null)) : [];
    if (!quote || !rects.length || rects.some((r) => !r || r.includes(null))) return null;
    return { live: false, quote, prefix: text(d.prefix, 64), suffix: text(d.suffix, 64), anchor: text(d.anchor, 200), slide: text(d.slide, 200), rects, y: num(d.y, 0, 1e7) ?? 0 };
  }

  const STATES = ['exact', 'changed', 'spot', 'lost'];
  /** An 'anchors' message from the page frame, checked: the scroll position, the size, the deck, and the place of each comment. */
  function readAnchors(d) {
    const list = d && Array.isArray(d.list) ? d.list.slice(0, 301) : [];
    const deck = d && d.deck && typeof d.deck === 'object' ? { n: num(d.deck.n, 0, 1e4) ?? 0, cur: num(d.deck.cur, 0, 1e4) ?? 0, paged: d.deck.paged === true } : null;
    return {
      y: num(d && d.y, 0, 1e7) ?? 0, vh: num(d && d.vh, 0, 1e5) ?? 0, dh: num(d && d.dh, 0, 1e7) ?? 0, deck,
      list: list.filter((a) => a && typeof a.id === 'string' && a.id && a.id.length <= 64)
        .map((a) => ({ id: a.id, state: STATES.includes(a.state) ? a.state : 'lost', top: num(a.top, -1e7, 1e7), slide: num(a.slide, 0, 1e4) ?? 0, hidden: a.hidden === true })),
    };
  }

  /** The mention that the person types at the caret: "@" or "@cl". from is the index of the "@". The host reads a mention with the same rule. */
  function mentionAt(value, caret) {
    const m = String(value).slice(0, caret).match(/(?:^|[^\w@.])@([a-z]*)$/i);
    return m ? { from: caret - m[1].length - 1, query: m[1].toLowerCase() } : null;
  }

  /**
   * What the viewer knows about the sign-in of each assistant, from the runs of the page: 'on' after a run that started,
   * 'off' after a run that had no sign-in, 'none' when no runner handles the mention, and '' when no run says it.
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

  const pure = { layoutCards, readSelect, readAnchors, mentionAt, assistantStates };
  if (typeof document === 'undefined') return pure;

  // ─── The viewer part ─────────────────────────────────────
  const DRAFT = '~draft';
  const STATE_TEXT = { on: 'Connected', off: 'Not connected', none: 'Through the connector', '': '' };
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const body = $('#body'), col = $('#cm-col'), pins = $('#cm-pins'), view = $('#cm-view'), rail = $('#cm-rail'), sheet = $('#cm-sheet'), add = $('#cm-add');
  const modeOf = () => (innerWidth >= 1120 ? 'wide' : innerWidth >= 700 ? 'mid' : 'narrow');
  // threads: the open threads. anchors: the place of each one in the page. draft: the comment that the person writes now.
  const S = { threads: [], resolved: [], anchors: new Map(), y: 0, vh: 0, dh: 0, deck: null, ready: false, settled: false, active: '', hover: '', sel: null, draft: null, mode: modeOf(), extra: 0, pinsH: 0, bottom: 0 };
  const cards = new Map(), seen = new Set(), fresh = new Set(), unread = new Set();
  let loaded = '', first = true, draftCard = null, warmedAt = 0, laid = 0, sentList = '';
  const keep = (k, v) => { try { sessionStorage.setItem(k + D.slug, v); } catch {} };
  const kept = (k) => { try { return sessionStorage.getItem(k + D.slug) || ''; } catch { return ''; } };
  const short = (a) => AGENTS[a] || String(a).split('@')[0] || 'Someone';
  const initial = (a) => (short(a).match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
  const oneLine = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  /** "2:41 PM" for today, and "Nov 9" for another day. */
  function stampOf(iso) {
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
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
    S.ready = false;
    tell({ type: 'hello', boxes: new URLSearchParams(location.search).get('hl') === 'boxes' }, f);
  }
  /** A new frame: the first load, a new theme, or a new version of the page. */
  function watch(f) {
    f.addEventListener('load', () => { if (f === frame) hello(f); });
    hello(f);
  }
  // A message from the frame is not trusted: the page in it can send anything. readSelect and readAnchors check each value.
  addEventListener('message', (e) => {
    const d = e.data;
    if (!frame || e.source !== frame.contentWindow || !d || d.ns !== 'k-cm' || d.v !== 1) return;
    if (d.type === 'ready') { S.ready = true; pushThreads(); }
    else if (d.type === 'scroll') { const y = num(d.y, 0, 1e7); if (y != null) { S.y = y; scrolled(); } }
    else if (d.type === 'anchors') {
      const a = readAnchors(d);
      Object.assign(S, { y: a.y, vh: a.vh, dh: a.dh, deck: a.deck, settled: true });
      S.anchors = new Map(a.list.map((x) => [x.id, x]));
      render();
    } else if (d.type === 'select') { S.sel = readSelect(d); drawAdd(); }
    else if (d.type === 'pick') { const id = text(d.id, 64); if (id && cards.has(id)) activate(id, { reveal: false }); else leave(); }
    else if (d.type === 'hover') setHover(cards.has(d.id) ? d.id : '');
    else if (d.type === 'key' && d.key === 'comment') compose(S.sel && !S.sel.live ? S.sel : null);
    else if (d.type === 'key' && d.key === 'esc') leave();
  });
  // A page with no kit never answers. Its comments show at the top of the margin, each with its quote.
  setTimeout(() => { if (!S.settled) { S.settled = true; render(); } }, 1500);

  // ─── The button at the selection ───
  add.querySelector('kbd').textContent = MAC ? '⌘⌥M' : 'Ctrl+Alt+M';
  add.title = 'Comment on the selected text (' + (MAC ? '⌘⌥M' : 'Ctrl+Alt+M') + ')';
  function drawAdd() {
    const s = S.sel;
    if (!s || s.live) { add.hidden = true; return; }
    const was = add.hidden;
    add.hidden = false;
    const w = add.offsetWidth, h = add.offsetHeight, over = add.parentElement, a = s.rects[0], z = s.rects[s.rects.length - 1], dy = s.y - S.y;
    // Above the first line. With no room there, below the last line.
    const above = a[1] + dy - h - 8, top = above >= 6 ? above : z[1] + z[3] + dy + 8;
    const mid = above >= 6 ? a[0] + a[2] / 2 : z[0] + z[2] / 2;
    add.style.transform = 'translate(' + Math.round(Math.max(8, Math.min(over.clientWidth - w - 8, mid - w / 2))) + 'px,' + Math.round(top) + 'px)';
    if (was) { add.style.animation = 'none'; void add.offsetWidth; add.style.animation = ''; }
  }
  // The button never takes the focus, so the selection in the page stays as it is.
  add.addEventListener('mousedown', (e) => e.preventDefault());
  add.addEventListener('click', () => { if (S.sel && !S.sel.live) compose(S.sel); });

  // ─── The warm-up: a sandbox gets ready while the person writes ───
  function warm() {
    if (!D.agents.length || Date.now() - warmedAt < 60000) return;
    warmedAt = Date.now();
    fetch('/api/assistants/warm', { method: 'POST', keepalive: true }).catch(() => {});
  }

  // ─── The mention picker: "@" in a comment box lists the assistants ───
  function mentions(box, holder) {
    let list = null, opts = [], at = 0, m = null;
    const id = 'cm-pick-' + Math.random().toString(36).slice(2, 8);
    box.setAttribute('role', 'combobox'); box.setAttribute('aria-autocomplete', 'list'); box.setAttribute('aria-expanded', 'false'); box.setAttribute('aria-controls', id);
    const close = () => { if (!list) return; list.remove(); list = null; box.setAttribute('aria-expanded', 'false'); box.removeAttribute('aria-activedescendant'); };
    const pick = (a) => { box.setRangeText('@' + a + ' ', m.from, box.selectionStart, 'end'); close(); box.dispatchEvent(new Event('input')); box.focus(); };
    function draw() {
      const states = assistantStates([...S.threads, ...S.resolved], D.agents);
      if (!list) { list = el('div', 'cm-pick'); list.id = id; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Assistants'); box.after(list); box.setAttribute('aria-expanded', 'true'); }
      list.replaceChildren(...opts.map((a, i) => {
        const o = el('div', 'cm-opt ' + tone(a) + (i === at ? ' is-on' : '')), ava = el('span', 'cm-ava', nameOf(a)[0]);
        o.id = id + '-' + a; o.setAttribute('role', 'option'); o.setAttribute('aria-selected', String(i === at));
        ava.setAttribute('aria-hidden', 'true');
        o.append(ava, el('b', '', nameOf(a)), el('span', 'cm-at', '@' + a), el('span', 'cm-state' + (states[a] === 'off' ? ' is-off' : ''), STATE_TEXT[states[a]]));
        // mousedown, so the box keeps the focus.
        o.addEventListener('mousedown', (e) => { e.preventDefault(); pick(a); });
        return o;
      }));
      box.setAttribute('aria-activedescendant', id + '-' + opts[at]);
      // The list opens just under the box, over the buttons below it.
      list.style.top = box.offsetTop + box.offsetHeight + 4 + 'px';
    }
    function update() {
      m = mentionAt(box.value, box.selectionStart);
      opts = m && box.selectionStart === box.selectionEnd ? Object.keys(AGENTS).filter((a) => a.startsWith(m.query) || nameOf(a).toLowerCase().startsWith(m.query)) : [];
      if (!opts.length) return close();
      at = Math.min(at, opts.length - 1);
      draw();
    }
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
    const fit = () => { box.style.height = 'auto'; box.style.height = Math.min(220, box.scrollHeight + 1) + 'px'; };
    box.addEventListener('input', fit);
    return fit;
  }

  // ─── One comment, one card ───
  function bodyOf(value) {
    const p = el('p', 'cm-body');
    String(value).split(/((?<![\w@.])@(?:claude|chatgpt)(?![\w-]|\.\w))/i).forEach((part, i) => p.append(i % 2 ? el('span', 'cm-at', part) : part));
    return p;
  }
  function person(author, name) {
    const agent = AGENTS[author] ? author : '', row = el('div', 'cm-c' + (agent ? ' ' + tone(agent) : '')), ava = el('span', 'cm-ava' + (agent ? ' is-agent' : ''), initial(author)), main = el('div', 'cm-main'), head = el('div', 'cm-head');
    ava.setAttribute('aria-hidden', 'true');
    head.append(el('b', '', name || short(author)));
    main.append(head);
    row.append(ava, main);
    return { row, main, head };
  }
  function commentRow(c, run) {
    const { row, main, head } = person(c.author), time = el('time', '', stampOf(c.created_at));
    time.dateTime = c.created_at; time.title = when(c.created_at);
    head.append(time);
    main.append(bodyOf(c.body), ...reaction(run));
    if (fresh.delete(c.id)) row.classList.add('is-new');
    return row;
  }
  const labelOf = (t) => 'Comment from ' + short(t.author) + ': ' + oneLine(t.body, 80) + (t.replies.length ? '. ' + t.replies.length + (t.replies.length === 1 ? ' reply' : ' replies') : '');
  function makeCard(t) {
    const c = { id: t.id, key: '', y: 0, top: null, el: el('article', 'cm-card is-in'), dot: el('button', 'cm-dot'), list: el('div', 'cm-list'), foot: el('div', 'cm-foot'), box: el('textarea'), done: el('button', 'v-icon cm-done') };
    c.el.tabIndex = 0; c.el.dataset.id = t.id;
    c.dot.type = 'button'; c.dot.dataset.id = t.id;
    c.done.type = 'button'; c.done.innerHTML = svg('check'); c.done.dataset.tip = 'Resolve'; c.done.dataset.tipEnd = ''; c.done.setAttribute('aria-label', 'Resolve thread');
    c.box.rows = 1; c.box.maxLength = 4000; c.box.placeholder = 'Reply, or @ to ask an assistant'; c.box.setAttribute('aria-label', 'Reply');
    const acts = el('div', 'cm-acts'), cancel = el('button', 'v-btn', 'Cancel'), send = el('button', 'v-create', 'Reply');
    cancel.type = send.type = 'button'; send.disabled = true;
    acts.append(cancel, send);
    c.foot.append(c.box, acts);
    c.el.append(c.done, c.list, c.foot);
    const fit = grow(c.box);
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
        c.box.value = ''; c.foot.classList.remove('has-text'); fit();
        render(); boost(); refresh();
      } catch (err) { toast('Could not send the reply: ' + err.message); send.disabled = false; }
    };
    c.box.addEventListener('input', () => { const on = !!c.box.value.trim(); send.disabled = !on; c.foot.classList.toggle('has-text', on); });
    c.box.addEventListener('focus', warm);
    c.box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); reply(); }
      else if (e.key === 'Escape') { e.stopPropagation(); if (c.box.value) { c.box.value = ''; c.box.dispatchEvent(new Event('input')); } else c.el.focus(); }
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
    });
    c.el.addEventListener('click', (e) => { if (!e.target.closest('button, textarea, a, .cm-pick')) activate(t.id); });
    c.el.addEventListener('keydown', (e) => {
      if (e.target !== c.el) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(t.id); c.box.focus(); }
    });
    c.el.addEventListener('pointerenter', () => setHover(t.id));
    c.el.addEventListener('pointerleave', () => setHover(''));
    c.dot.addEventListener('click', () => (S.active === t.id ? leave() : activate(t.id)));
    c.dot.addEventListener('pointerenter', () => setHover(t.id));
    c.dot.addEventListener('pointerleave', () => setHover(''));
    sizes.observe(c.el); sizes.observe(c.dot);
    return c;
  }
  /** Draws the comments of a card again when the thread, its place or its state changed. The reply box stays, with its text. */
  function fill(c, t, a, off) {
    const active = S.active === t.id, changed = !!t.quote && (!a || a.state === 'changed' || a.state === 'lost') && S.ready;
    const key = JSON.stringify([t, active, changed, off, unread.has(t.id)]);
    c.el.classList.toggle('is-active', active);
    c.dot.classList.toggle('is-active', active);
    if (key === c.key) return;
    c.key = key;
    const rows = [], runs = t.runs || {};
    if (t.quote) {
      const q = el('div', 'cm-quote' + (changed ? ' is-changed' : '') + (off ? ' is-off' : ''));
      if (changed) q.append(el('span', 'cm-flag', 'Original text changed'));
      q.append(el('q', '', t.quote));
      rows.push(q);
    }
    rows.push(commentRow(t, runs[t.id]));
    if (active) t.replies.forEach((r) => rows.push(commentRow(r, runs[r.id])));
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
    c.dot.replaceChildren(initial(t.author), ...(t.replies.length ? [el('i', '', String(t.replies.length + 1))] : []));
    c.dot.setAttribute('aria-label', labelOf(t));
    c.dot.setAttribute('aria-expanded', String(active));
  }

  // ─── The new comment ───
  function makeDraft() {
    const c = { id: DRAFT, y: 0, top: null, el: el('article', 'cm-card is-compose is-active is-in'), dot: el('span', 'cm-dot is-active is-draft', '+'), box: el('textarea') };
    const { row, main } = person(D.who), acts = el('div', 'cm-acts'), hint = el('span', 'cm-hint', (MAC ? '⌘' : 'Ctrl') + ' Enter to send'), cancel = el('button', 'v-btn', 'Cancel'), send = el('button', 'v-create', 'Comment');
    c.quote = el('div', 'cm-quote');
    c.el.setAttribute('role', 'group'); c.el.setAttribute('aria-label', 'New comment');
    c.dot.setAttribute('aria-hidden', 'true');
    c.box.rows = 1; c.box.maxLength = 4000; c.box.placeholder = 'Comment, or @ to ask an assistant'; c.box.setAttribute('aria-label', 'Comment');
    cancel.type = send.type = 'button'; send.disabled = true;
    acts.append(hint, cancel, send);
    main.append(c.quote, c.box, acts);
    c.el.append(row);
    c.fit = grow(c.box);
    mentions(c.box);
    c.box.addEventListener('input', () => { S.draft.text = c.box.value; keep('draft:', c.box.value); send.disabled = !c.box.value.trim(); });
    c.box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); }
      else if (e.key === 'Escape') { e.stopPropagation(); cancelDraft(); }
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
        closeDraft();
        S.active = made.id;
        say('Comment added.');
        pushThreads(); render(); boost(); refresh();
        cards.get(made.id)?.el.focus({ preventScroll: true });
      } catch (err) { toast('Could not send the comment: ' + err.message); send.disabled = false; }
    };
    send.addEventListener('click', post);
    cancel.addEventListener('click', () => cancelDraft());
    c.send = send;
    sizes.observe(c.el); sizes.observe(c.dot);
    return c;
  }
  /** Opens the box for a new comment: on the selection, or on the whole page with no selection. A box that is open moves there and keeps its text. */
  function compose(sel) {
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
  function closeDraft() {
    S.draft = null;
    if (S.active === DRAFT) S.active = '';
    if (draftCard) { draftCard.el.remove(); draftCard.dot.remove(); draftCard.el.classList.add('is-in'); }
  }
  function cancelDraft() {
    if (!S.draft) return;
    closeDraft();
    pushThreads(); render();
    if (frame) frame.focus();
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
  /** Opens a thread. The page shows the slide of the thread and scrolls to its text when the text is not in view. */
  function activate(id, { reveal = true } = {}) {
    if (S.draft && !S.draft.text.trim() && id !== DRAFT) closeDraft();
    unread.delete(id);
    const a = S.anchors.get(id), far = reveal && a && (a.hidden || a.top == null || a.top - S.y < 48 || a.top - S.y > S.vh - 96);
    // The page scrolls to text that is far away. Otherwise the open card scrolls into view if it must.
    if (!far) S.ensure = id;
    if (S.active !== id) { S.active = id; pushThreads(); render(); } else schedule();
    if (far) { S.revealAt = Date.now(); tell({ type: 'reveal', id }); }
  }
  /** Closes the open thread. A new comment with no text closes too; one with text stays. */
  function leave() {
    if (S.draft && !S.draft.text.trim()) closeDraft();
    else if (S.draft && S.active === DRAFT) return;
    if (!S.active && !S.draft) { pushThreads(); render(); return; }
    S.active = S.draft ? DRAFT : '';
    pushThreads(); render();
  }
  [col, view, rail, pins].forEach((n) => n.addEventListener('click', (e) => { if (e.target === n) leave(); }));
  $('#cm-close').addEventListener('click', () => (S.draft && S.active === DRAFT ? cancelDraft() : leave()));
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyM') { e.preventDefault(); compose(S.sel && !S.sel.live ? S.sel : null); }
    else if (e.key === 'Escape' && !open && !e.defaultPrevented && !$('dialog[open]') && S.active) {
      const c = cards.get(S.active);
      leave();
      if (c && c.el.isConnected && S.mode === 'wide') c.el.focus();
    }
  });
  $('#cnew').addEventListener('click', () => compose(S.sel && !S.sel.live ? S.sel : null));

  // ─── Where each card goes ───
  const sizes = new ResizeObserver(() => schedule());
  sizes.observe(pins);
  /** Puts the children of a parent in the given order. It moves nothing when the order is right, so no box loses the focus. */
  function order(parent, nodes) {
    const now = [...parent.children];
    if (now.length === nodes.length && now.every((n, i) => n === nodes[i])) return;
    const focus = document.activeElement;
    now.forEach((n) => { if (!nodes.includes(n)) n.remove(); });
    nodes.forEach((n, i) => { if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] || null); });
    if (focus && focus !== document.activeElement && focus.isConnected) focus.focus({ preventScroll: true });
  }
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
      (S.mode === 'narrow' && S.active === t.id ? inSheet : null)?.push(c.el);
      if (here) side.push(c); else top.push(c);
    }
    cards.forEach((c, id) => { if (!S.threads.some((t) => t.id === id)) { sizes.unobserve(c.el); sizes.unobserve(c.dot); c.el.remove(); c.dot.remove(); cards.delete(id); } });
    if (S.draft) {
      const a = S.anchors.get(DRAFT);
      if (S.draft.q && (S.draft.y != null || (a && a.top != null))) { draftCard.y = a && a.top != null ? a.top : S.draft.y; side.push(draftCard); } else top.push(draftCard);
      if (S.mode === 'narrow') inSheet.push(draftCard.el);
    }
    side.sort((x, y) => x.y - y.y);
    const nodes = (list) => list.flatMap((c) => (inSheet.includes(c.el) ? [c.dot] : [c.el, c.dot]));
    order(pins, nodes(top));
    order(rail, nodes(side));
    order($('#cm-slot'), inSheet.slice(0, 1));
    S.side = side;
    // A deck keeps the margin while any slide has a thread, so the slide does not change size from one slide to the next.
    const any = top.length + side.length > 0 || (paged && S.threads.length > 0);
    col.hidden = !any;
    sheet.hidden = !inSheet.length;
    body.dataset.cm = S.mode;
    const n = S.resolved.length, res = $('#cres');
    res.hidden = !n;
    res.lastChild.textContent = n + ' resolved';
    res.setAttribute('aria-label', n + (n === 1 ? ' resolved thread' : ' resolved threads'));
    layout();
    schedule();
  }
  const schedule = () => { if (!laid) laid = requestAnimationFrame(() => { laid = 0; layout(); }); };
  /** Reads the height of each card, then writes the top of each card. The reads come first, so the browser lays out one time. */
  function layout() {
    if (col.hidden) { S.pinsH = 0; return; }
    const dots = S.mode !== 'wide', side = S.side || [];
    const pinsH = pins.offsetHeight;
    const items = side.map((c) => ({ id: c.id, y: c.y - (dots ? 2 : 10), h: (dots ? c.dot : c.el).offsetHeight }));
    const tops = layoutCards(items, { active: dots ? '' : S.active, gap: dots ? 4 : 10, min: pinsH + (dots ? 6 : 8) });
    let bottom = 0;
    side.forEach((c, i) => {
      const y = tops[c.id];
      bottom = Math.max(bottom, y + items[i].h);
      if (c.top !== y) { c.top = y; c.el.style.setProperty('--y', y + 'px'); c.dot.style.setProperty('--y', y + 'px'); }
    });
    S.pinsH = pinsH; S.bottom = bottom;
    scrolled();
    // A card that the person just opened must show in full: the page scrolls by the part that is out of view.
    const want = S.ensure && side.find((c) => c.id === S.ensure);
    if (want && S.mode !== 'narrow') {
      S.ensure = '';
      const top = want.top - S.y - S.extra, h = want.el.offsetHeight, room = col.clientHeight;
      const dy = top + h > room - 16 ? Math.min(top + h - room + 24, top - pinsH - 16) : top < pinsH + 8 ? top - pinsH - 16 : 0;
      if (Math.abs(dy) > 1) tell({ type: 'scroll', dy, smooth: true });
    }
    // A new card takes its place with no movement. After that, a change of place glides.
    requestAnimationFrame(() => side.forEach((c) => c.el.classList.remove('is-in')));
  }
  /** The page scrolled: the cards and the button move by the same distance. One style write, and no read. */
  function scrolled() {
    const dpr = devicePixelRatio || 1;
    S.extra = Math.max(0, Math.min(S.extra, S.bottom + 24 - S.dh));
    rail.style.transform = 'translate3d(0,' + -Math.round((S.y + S.pinsH + S.extra) * dpr) / dpr + 'px,0)';
    if (!add.hidden) drawAdd();
  }
  // The wheel over the margin scrolls the page. Cards below the end of the page come into view with it.
  col.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.target.closest('.cm-pins, textarea')) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY, max = Math.max(0, S.dh - S.vh);
    if ((dy > 0 && S.y >= max - 1) || (dy < 0 && S.extra > 0)) { S.extra = Math.max(0, S.extra + dy); scrolled(); }
    else tell({ type: 'scroll', dy });
  }, { passive: false });
  addEventListener('resize', () => { if (modeOf() !== S.mode) render(); else schedule(); });

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
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await api('/api/comments/' + t.id + '/resolve', { method: 'DELETE' }); }
        catch (err) { toast('Could not reopen the thread: ' + err.message); b.disabled = false; return; }
        closePop();
        say('Thread reopened.');
        await refresh().catch(() => {});
        activate(t.id);
      });
      row.append(main, b);
      return row;
    }));
  });

  watch(frame);
  return {
    ...pure,
    refresh: () => refresh().catch(() => {}),
    /** The viewer swapped in the frame of a new version. */
    frame: () => watch(frame),
    /** A run ended on a thread. Its card opens when the person has no other card open, so the answer shows as it arrives. */
    async answered(thread) {
      await refresh().catch(() => {});
      if (!S.active && S.mode === 'wide' && cards.has(thread)) activate(thread, { reveal: false });
    },
  };
})();
