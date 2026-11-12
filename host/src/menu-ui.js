// The parts of the viewer around the comments: a small menu for one comment, and a dialog that asks the person to confirm.
// views.ts puts this file into the viewer script after the helpers ($, $$, el, closePop) and before margin.js.

// ─── A small menu for one comment, and a dialog that asks the person to confirm ───
const Menu = (() => {
  let pop = null, from = null;
  function close(focus) {
    if (!pop) return;
    pop.remove(); pop = null;
    from.setAttribute('aria-expanded', 'false');
    if (focus) from.focus();
    from = null;
  }
  function open(btn, list) {
    if (from === btn) return close();
    close();
    from = btn;
    pop = el('div', 'cm-mpop'); pop.setAttribute('role', 'menu');
    list.forEach((it) => {
      const b = el('button', 'v-item' + (it.danger ? ' is-danger c-red' : ''), it.label);
      b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.addEventListener('click', (e) => { e.stopPropagation(); close(); it.run(); });
      pop.append(b);
    });
    pop.addEventListener('keydown', (e) => {
      const all = $$('button', pop), i = all.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') close();
    });
    document.body.append(pop);
    place();
    btn.setAttribute('aria-expanded', 'true');
    $('button', pop).focus();
  }
  /** The menu sits under its button. It follows the button when the view scrolls, and it closes when the button leaves the view. */
  function place() {
    const r = from.getBoundingClientRect(), v = $('#scroll').getBoundingClientRect();
    if (!from.isConnected || r.bottom < v.top || r.top > v.bottom) return close();
    pop.style.top = Math.min(innerHeight - pop.offsetHeight - 8, r.bottom + 4) + 'px';
    pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth)) + 'px';
  }
  document.addEventListener('click', () => close());
  $('#scroll').addEventListener('scroll', () => { if (pop) place(); }, { passive: true });
  addEventListener('blur', () => close());
  return { open, close, isOpen: () => !!pop };
})();
/** Asks the person to confirm. Resolves true for the main button, false for Cancel and Esc. */
function confirmBox({ title, text, ok }) {
  const d = $('#cm-confirm');
  $('#cm-confirm-h').textContent = title; $('#cm-confirm-p').textContent = text; $('#cm-confirm-ok').textContent = ok;
  return new Promise((done) => {
    d.returnValue = '';
    d.addEventListener('close', () => done(d.returnValue === 'ok'), { once: true });
    d.showModal();
    $('#cm-confirm-no').focus();
  });
}
$$('#cm-confirm button').forEach((b) => b.addEventListener('click', () => $('#cm-confirm').close(b.value)));
