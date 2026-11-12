// The script of a review frame. It runs inside the page that diff.js marked, in a sandbox with no access to the host.
// The frame has the height of its page, so it does not scroll: the review of the host scrolls, with the frame in it.
// The host sends "go" (show change n), "show" (marks on or off) and "view" (the part of the frame that shows).
// The frame sends "ready", "at" (the change that the reader is at), "size" (the height of the page),
// "shift" (the page moved below the reader) and "key" (a key that the host handles).
(() => {
  const NS = 'ap-diff';
  const root = document.documentElement;
  const send = (m) => parent.postMessage({ ns: NS, ...m }, '*');
  const numOf = (el) => +el.getAttribute('data-diff-n');
  const stops = () => [...document.querySelectorAll('[data-diff-n]')];
  /** The element of change n. When the page has no element with that number, the next change stands in. */
  const stop = (n) => document.querySelector('[data-diff-n="' + n + '"]') || stops().find((el) => numOf(el) > n) || null;

  // A deck: the sheets have the width of the frame, as in the scroll view of the kit.
  const deck = document.querySelector('main.k-deck-review');
  function fit() {
    if (!deck) return;
    root.style.setProperty('--k-s', String(Math.min(root.clientWidth - 40, 1100) / 1920));
    // A slide that removed words make too long hides them. The sheet lists them below the slide.
    deck.querySelectorAll('[data-diff-sheet="mod"]:not([data-diff-tight])').forEach((sheet) => {
      const slide = sheet.querySelector('.k-slide');
      if (!slide || slide.scrollHeight <= slide.clientHeight + 1) return;
      const lost = [...slide.querySelectorAll('del[data-diff]')].map((d) => d.textContent.trim()).filter(Boolean);
      if (!lost.length) return;
      sheet.setAttribute('data-diff-tight', '');
      let out = sheet.querySelector('[data-diff-out]');
      if (!out) { out = document.createElement('p'); out.setAttribute('data-diff-out', ''); out.innerHTML = '<b>Removed from this slide</b> '; sheet.append(out); }
      for (const t of lost) { const d = document.createElement('del'); d.setAttribute('data-diff', ''); d.textContent = t; out.append(d, ' '); }
    });
  }

  // The part of the frame that shows in the review, in the pixels of the frame. The host sends it when the reader scrolls.
  let win = { top: 0, height: innerHeight };
  // The change that the reader is at. The box shows around it after a step, and it goes away when the reader scrolls on.
  const ring = document.createElement('div');
  ring.setAttribute('data-diff-ring', '');
  ring.hidden = true;
  let cur = 0, lit = false, held = false;
  function place() {
    const el = cur && lit ? stop(cur) : null;
    if (!el || root.hasAttribute('data-diff-off')) { ring.hidden = true; return; }
    const r = el.getBoundingClientRect(), pad = 9;
    const left = Math.max(2, r.left - pad);
    ring.hidden = false;
    ring.style.left = left + 'px';
    ring.style.top = r.top - pad + 'px';
    ring.style.width = Math.min(root.clientWidth - 2 - left, r.right + pad - left) + 'px';
    ring.style.height = r.height + 2 * pad + 'px';
  }
  /** Shows change n: the box goes around it, and the host scrolls to the place that "at" names. */
  function go(n, smooth) {
    const el = stop(n);
    if (!el) return;
    cur = numOf(el); lit = true; held = true;
    place();
    const r = el.getBoundingClientRect();
    send({ type: 'at', n: cur, top: r.top, height: r.height, smooth });
  }
  /**
   * The reader scrolled. They stay at their change while a part of it shows.
   * When it is out of view, the change nearest to a line in the upper part of the view is the one they are at.
   */
  function follow() {
    if (held || root.hasAttribute('data-diff-off')) return;
    const shows = (r) => (r.width || r.height) && r.bottom > win.top && r.top < win.top + win.height;
    const at = cur ? stop(cur) : null;
    if (at && numOf(at) === cur && shows(at.getBoundingClientRect())) return;
    const line = win.top + Math.min(win.height * 0.25, 240);
    let best = 0, gap = Infinity;
    for (const el of stops()) {
      const r = el.getBoundingClientRect();
      if (!shows(r)) continue;
      const g = r.top <= line && r.bottom >= line ? 0 : Math.min(Math.abs(r.top - line), Math.abs(r.bottom - line));
      if (g < gap) { gap = g; best = numOf(el); }
    }
    if (best && best !== cur) { cur = best; lit = false; place(); send({ type: 'at', n: best }); }
  }
  // A wheel, a touch or a key means that the reader scrolls. After a step, the frame keeps its change until then.
  for (const type of ['wheel', 'touchmove', 'pointerdown']) addEventListener(type, () => { held = false; }, { passive: true, capture: true });

  /** Runs a change of the page, then tells the host how far the block below the eye of the reader moved. */
  function steady(change) {
    const el = document.elementFromPoint(root.clientWidth / 2, Math.max(0, win.top) + Math.min(win.height * 0.3, 200));
    const y = el ? el.getBoundingClientRect() : null;
    change();
    const to = el && el.isConnected ? el.getBoundingClientRect() : null;
    if (y && to && (to.width || to.height) && to.top !== y.top) send({ type: 'shift', by: to.top - y.top });
  }

  addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== parent || !d || d.ns !== NS) return;
    if (d.type === 'go') go(+d.n, !!d.smooth);
    else if (d.type === 'show') { steady(() => root.toggleAttribute('data-diff-off', !d.on)); place(); size(); }
    else if (d.type === 'view') { win = { top: +d.top || 0, height: +d.height || innerHeight }; if (d.free) held = false; follow(); }
  });

  addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const gap = t && t.closest('[data-diff-gap]');
    if (gap) {
      // Open the fold: show its blocks and take the line away.
      document.querySelectorAll('[data-diff-skip="' + gap.getAttribute('data-diff-gap') + '"]').forEach((el) => el.setAttribute('data-diff-open', ''));
      gap.remove();
      place();
      size();
      return;
    }
    const a = t && t.closest('a[href]');
    if (!a) return;
    // The frame is not a browser tab. A link to a place in the page scrolls to it, and each other link opens a new tab.
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (href[0] === '#') { const to = document.getElementById(decodeURIComponent(href.slice(1))); if (to) { const r = to.getBoundingClientRect(); send({ type: 'at', n: cur, top: r.top, height: r.height, smooth: true }); } }
    else if (/^https?:/i.test(a.href)) window.open(a.href, '_blank', 'noopener');
  });

  // The frame cannot scroll and it does not hold the keys of the review. The host handles both, wherever the focus is.
  const KEYS = ['n', 'N', 's', 'j', 'k', '/', 'Escape', ' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !KEYS.includes(e.key)) return;
    if (e.target instanceof Element && e.target.closest('button, a[href], summary, input, textarea, select, [contenteditable]') && [' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    held = false;
    send({ type: 'key', key: e.key, shift: e.shiftKey });
  });

  // The height of the page, from its lowest block. The height of the window does not count, so the frame can get smaller too.
  // The box of the current change does not count: it can stand below the last block.
  let last = 0;
  function size() {
    const body = document.body, style = getComputedStyle(body);
    let low = body.getBoundingClientRect().bottom - (parseFloat(style.paddingBottom) || 0);
    for (const el of body.children) {
      if (el === ring) continue;
      const r = el.getBoundingClientRect();
      if (r.height) low = Math.max(low, r.bottom);
    }
    const h = Math.ceil(low + scrollY + (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.marginBottom) || 0)) + 2;
    if (h !== last) { last = h; send({ type: 'size', height: h }); }
  }
  function start() {
    document.body.append(ring);
    fit();
    new ResizeObserver(() => { fit(); place(); size(); }).observe(document.body);
    addEventListener('resize', () => { fit(); place(); size(); });
    send({ type: 'ready', stops: stops().length });
    size();
  }
  // The kit draws its diagrams when the page is ready. This script starts after it, so the sizes are final.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
