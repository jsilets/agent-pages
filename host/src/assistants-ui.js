// The parts of the viewer around the comments: a small menu for one comment, a dialog that asks the person to confirm,
// and the Assistants dialog with the sign-in and the model of each assistant. views.ts puts this file into the viewer
// script after the helpers ($, $$, el, api, toast, say, tone, closePop) and before margin.js.

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

// ─── Assistants: the sign-in and the model of each assistant ───
// The sandbox runner holds each sign-in. The person signs in on the page of the provider, in a new tab, and the work uses
// the person's own plan. Claude shows a code that the person pastes here. ChatGPT shows a page where the person types the
// code that this dialog shows. Every text from the host goes in with textContent.
const Assistants = (() => {
  const dlg = $('#assist'), box = $('#assist-body'), back = $('#assist-back'), title = $('#assist-h');
  const PROVIDER = { claude: { name: 'Claude', site: "Claude's page", plan: 'Claude' }, chatgpt: { name: 'ChatGPT', site: "OpenAI's page", plan: 'ChatGPT' } };
  let data = null, loading = null, flow = null, poll = 0, after = null;
  const listeners = [];
  const changed = () => listeners.forEach((f) => f());
  function load(force) {
    if (loading && !force) return loading;
    loading = api('/api/assistants').then((d) => { data = d; changed(); if (dlg.open && !flow) list(); return d; }, () => { loading = null; return null; });
    return loading;
  }
  const state = (a) => (data && data.assistants && data.assistants[a]) || null;
  const stop = () => { clearTimeout(poll); poll = 0; };
  const svgOpen = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>';

  function frameOf(t) { title.textContent = t; }
  /** The list: each assistant with its state, Connect or Disconnect, and its models. */
  function list() {
    stop(); flow = null; back.hidden = true; frameOf('Assistants');
    const lede = el('p', 'a-lede', 'Ask an assistant in a comment with @claude or @chatgpt. Each one works with your own plan.');
    if (!data) { box.replaceChildren(lede, el('p', '', 'Loading…')); load(); return; }
    const rows = Object.keys(PROVIDER).map((a) => {
      const s = state(a) || { handled: false, connected: null, models: [], default_model: null, model: null };
      const row = el('section', 'a-row ' + tone(a)), top = el('div', 'a-top'), whoEl = el('div', 'a-who');
      const ava = el('span', 'cm-ava is-agent', PROVIDER[a].name[0]); ava.setAttribute('aria-hidden', 'true');
      const st = !s.handled ? 'Not set up on this host' : s.connected === true ? 'Connected' : s.connected === false ? 'Not connected' : 'The sandbox runner did not answer';
      whoEl.append(el('b', '', PROVIDER[a].name), el('span', 'a-state' + (s.connected === true ? ' is-on' : ''), st));
      top.append(ava, whoEl);
      if (s.handled && s.connected === false) {
        const b = el('button', 'v-create', 'Connect'); b.type = 'button';
        b.setAttribute('aria-label', 'Connect ' + PROVIDER[a].name);
        b.addEventListener('click', () => connect(a));
        top.append(b);
      } else if (s.handled && s.connected === true) {
        const b = el('button', 'v-btn', 'Disconnect'); b.type = 'button';
        b.setAttribute('aria-label', 'Disconnect ' + PROVIDER[a].name);
        let armed = 0;
        b.addEventListener('click', async () => {
          if (!armed) { b.classList.add('is-armed'); b.textContent = 'Disconnect ' + PROVIDER[a].name + '?'; armed = setTimeout(() => { armed = 0; b.classList.remove('is-armed'); b.textContent = 'Disconnect'; }, 4000); return; }
          clearTimeout(armed); b.disabled = true;
          try { await api('/api/assistants/' + a + '/connection', { method: 'DELETE' }); toast(PROVIDER[a].name + ' is disconnected'); }
          catch (err) { toast('Could not disconnect: ' + err.message); }
          await load(true); list();
        });
        top.append(b);
      }
      row.append(top);
      if (s.models.length) {
        const set = el('fieldset', 'a-models'), chosen = s.model || s.default_model;
        set.append(el('legend', '', 'Model'));
        s.models.forEach((m) => {
          const lab = el('label', 'a-model'), r = el('input'), b = el('b', '', m.label);
          r.type = 'radio'; r.name = 'model-' + a; r.value = m.id; r.checked = m.id === chosen;
          if (m.id === s.default_model) b.append(el('span', 'v-tag', 'Default'));
          lab.append(r, b, ...(m.note ? [el('span', '', m.note)] : []));
          r.addEventListener('change', async () => {
            try { await api('/api/assistants/' + a, { method: 'PUT', body: JSON.stringify({ model: m.id === s.default_model ? null : m.id }) }); s.model = m.id === s.default_model ? null : m.id; toast(PROVIDER[a].name + ' uses ' + m.label); }
            catch (err) { toast('Could not save the model: ' + err.message); load(true); }
          });
          set.append(lab);
        });
        row.append(set);
      }
      return row;
    });
    box.replaceChildren(lede, ...rows);
  }
  /** One sign-in. The main button opens the page of the provider in a new tab. */
  async function connect(a, then) {
    after = then || after;
    stop();
    const P = PROVIDER[a];
    if (!dlg.open) dlg.showModal();
    back.hidden = false; frameOf('Connect ' + P.name);
    const intro = el('p', 'a-lede', 'You sign in on ' + P.site + ', in a new tab. Pages never sees your password. ' + P.name + ' then works on your comments with your own ' + P.plan + ' plan.');
    const live = el('div', 'a-live'); live.setAttribute('role', 'status');
    const go = el('button', 'a-go'); go.type = 'button'; go.disabled = true; go.textContent = 'Getting ready…';
    const steps = el('ol', 'a-steps'), one = el('li'), two = el('li');
    one.append(el('h3', '', 'Sign in to ' + P.name), go);
    steps.append(one, two);
    box.replaceChildren(intro, steps, live, el('p', 'a-fine', 'You can disconnect at any time in Assistants.'));
    const setLive = (text, cls = '') => { live.className = 'a-live' + (cls ? ' ' + cls : ''); live.textContent = text; };
    let f;
    try { f = await api('/api/assistants/' + a + '/connect', { method: 'POST' }); }
    catch (err) { setLive('Could not start the sign-in: ' + err.message, 'is-bad'); go.textContent = 'Try again'; go.disabled = false; go.onclick = () => connect(a); return; }
    if (!/^https?:\/\//.test(f.url)) { setLive('The sign-in page is not valid.', 'is-bad'); return; }
    flow = { a, id: f.id };
    go.disabled = false;
    go.innerHTML = svgOpen; go.append('Continue to ' + P.name);
    go.onclick = () => { window.open(f.url, '_blank', 'noopener,noreferrer'); one.classList.add('is-done'); if (f.needs_code) input.focus(); else setLive('Waiting for ' + P.name + '…', 'is-wait'); };
    const done = async () => {
      // The dialog shows "connected" for a moment before the list comes back. Until then, a load does not draw the list.
      stop();
      const shown = flow = { a, done: true };
      one.classList.add('is-done'); two.classList.add('is-done');
      setLive(P.name + ' is connected', 'is-on');
      say(P.name + ' is connected.');
      await load(true);
      const then2 = after; after = null;
      setTimeout(() => { if (dlg.open && flow === shown) list(); else if (flow === shown) flow = null; then2?.(); }, 1400);
    };
    const ended = (s) => {
      stop(); flow = null;
      setLive(s.status === 'expired' ? 'The sign-in ran out of time.' : 'The sign-in did not finish' + (s.detail ? ': ' + s.detail : '.'), 'is-bad');
      go.onclick = () => connect(a); go.replaceChildren('Start again');
    };
    let input = null;
    if (f.needs_code) {
      two.append(el('h3', '', 'Paste the code from ' + P.name), el('p', '', 'After you approve, ' + P.name + ' shows a code. Copy it and paste it here.'));
      const field = el('div', 'a-field'), paste = el('button', 'v-btn', 'Paste');
      input = el('input'); input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 2048; input.setAttribute('aria-label', 'The code from ' + P.name); input.placeholder = 'Code';
      paste.type = 'button';
      field.append(input, paste);
      two.append(field);
      let sending = false;
      const send = async () => {
        const code = input.value.trim();
        if (sending || !flow || code.length < 8 || /\s/.test(code)) return;
        sending = true; input.disabled = paste.disabled = true;
        setLive('Checking the code…', 'is-wait');
        try {
          const s = await api('/api/assistants/connect/' + encodeURIComponent(f.id) + '/code', { method: 'POST', body: JSON.stringify({ code }) });
          if (s.status === 'connected') return done();
          if (s.status === 'pending') setLive('Waiting for ' + P.name + '…', 'is-wait');
          else if (s.status === 'failed') { setLive('That code did not work. Copy the code again from ' + P.site + '.', 'is-bad'); input.value = ''; }
          else return ended(s);
        } catch (err) { setLive('Could not check the code: ' + err.message, 'is-bad'); }
        sending = false; input.disabled = paste.disabled = false; input.focus();
      };
      // A pasted code goes at once. A typed code goes with Enter.
      input.addEventListener('paste', () => setTimeout(send));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
      paste.addEventListener('click', async () => {
        try { input.value = (await navigator.clipboard.readText()).trim(); send(); }
        catch { input.focus(); setLive('Press ' + (/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘V' : 'Ctrl+V') + ' to paste the code.'); }
      });
    } else {
      two.append(el('h3', '', 'Type this code on the ' + P.name + ' page'));
      const code = el('div', 'a-code'), out = el('output', '', f.user_code || ''), copy = el('button', 'v-btn', 'Copy');
      out.setAttribute('aria-label', 'Your code: ' + String(f.user_code || '').split('').join(' '));
      copy.type = 'button';
      copy.addEventListener('click', () => navigator.clipboard.writeText(f.user_code || '').then(() => { copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1400); }, () => toast('Could not copy the code')));
      code.append(out, copy);
      two.prepend(code);
      steps.prepend(two);
      one.querySelector('h3').textContent = 'Continue to ' + P.name + ' and type the code';
      setLive('');
    }
    // The state of the sign-in, every 2 seconds, until it ends.
    const tick = async () => {
      if (!flow || flow.id !== f.id || !dlg.open) return;
      try {
        const s = await api('/api/assistants/connect/' + encodeURIComponent(f.id));
        if (s.status === 'connected') return done();
        if (s.status !== 'pending') return ended(s);
      } catch {}
      poll = setTimeout(tick, 2000);
    };
    poll = setTimeout(tick, 2000);
    (input || go).focus();
  }
  function open() { load(true); list(); if (!dlg.open) dlg.showModal(); }
  back.addEventListener('click', () => { load(true); list(); });
  $('#assist-x').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { stop(); flow = null; after = null; });
  $('#assistants')?.addEventListener('click', () => { closePop(); open(); });
  return { load, state, open, connect, onChange: (f) => listeners.push(f) };
})();
