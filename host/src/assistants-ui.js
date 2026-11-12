// The Assistants dialog, with the sign-in and the model of each assistant, and the status chip in the bar that opens it.
// views.ts puts this file into the script of the library and of the viewer, after the helpers ($, $$, el, api, toast,
// say, tone, closePop). In the viewer, it comes before margin.js.

// ─── Assistants: the sign-in and the model of each assistant ───
// The sandbox runner holds each sign-in. The person signs in on the page of the provider, in a new tab, and the work uses
// the person's own plan. Claude shows a code that the person pastes here. ChatGPT shows a page where the person types the
// code that this dialog shows. Every text from the host goes in with textContent.
const Assistants = (() => {
  const dlg = $('#assist'), box = $('#assist-body'), back = $('#assist-back'), title = $('#assist-h');
  const PROVIDER = { claude: { name: 'Claude', site: "Claude's page", plan: 'Claude' }, chatgpt: { name: 'ChatGPT', site: "OpenAI's page", plan: 'ChatGPT' } };
  // failed: the last request for the states got no answer. seq: only the answer of the newest request counts.
  let data = null, loading = null, flow = null, poll = 0, after = null, failed = false, seq = 0, loadedAt = 0;
  const listeners = [];
  const changed = () => listeners.forEach((f) => f());
  function load(force) {
    if (loading && !force) return loading;
    const n = ++seq;
    loadedAt = Date.now();
    loading = api('/api/assistants').then((d) => {
      if (n !== seq) return d;
      data = d; failed = false; changed(); if (dlg.open && !flow) list(); return d;
    }, () => {
      if (n !== seq) return null;
      loading = null; failed = true; changed(); if (dlg.open && !flow && !data) list(); return null;
    });
    return loading;
  }
  const state = (a) => (data && data.assistants && data.assistants[a]) || null;
  /** The label of the model that the assistant uses now, or ''. */
  const modelOf = (s) => (s.models.find((m) => m.id === (s.model || s.default_model)) || {}).label || '';
  /** The state of one assistant in words, for the list of the dialog. */
  const words = (s) => !s.handled ? 'Not set up on this host'
    : s.error ? 'Could not check the sign-in'
    : s.connected === true ? 'Connected' + (modelOf(s) ? ' · Model: ' + modelOf(s) : '')
    : s.connected === false ? 'Not connected' : 'Not available now';
  const stop = () => { clearTimeout(poll); poll = 0; };
  const svgOpen = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>';

  function frameOf(t) { title.textContent = t; }
  /** The list: each assistant with its state, Connect or Disconnect, and its models. */
  function list() {
    stop(); flow = null; back.hidden = true; frameOf('Assistants');
    const lede = el('p', 'a-lede', 'Ask an assistant in a comment with @claude or @chatgpt. Each one works with your own plan.');
    if (!data) { box.replaceChildren(lede, el('p', failed ? 'a-note' : '', failed ? 'Pages could not load the assistants. Try again in a minute.' : 'Loading…')); if (!failed) load(); return; }
    // With no runner, no assistant can work. One line says why, in place of a state on each row.
    const note = data.runner ? null : el('p', 'a-note', data.error === 'no sandbox runner' ? 'Assistants are not set up on this host.' : 'Pages cannot reach the assistants right now. Try again in a minute.');
    const rows = Object.keys(PROVIDER).map((a) => {
      const s = state(a) || { handled: false, connected: null, models: [], default_model: null, model: null };
      const row = el('section', 'a-row ' + tone(a)), top = el('div', 'a-top'), whoEl = el('div', 'a-who');
      const ava = el('span', 'cm-ava is-agent', a === 'chatgpt' ? 'G' : PROVIDER[a].name[0]); ava.setAttribute('aria-hidden', 'true');
      const stEl = el('span', 'a-state' + (s.error ? ' is-warn' : s.connected === true ? ' is-on' : ''), words(s));
      whoEl.append(el('b', '', PROVIDER[a].name), stEl);
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
            try { await api('/api/assistants/' + a, { method: 'PUT', body: JSON.stringify({ model: m.id === s.default_model ? null : m.id }) }); s.model = m.id === s.default_model ? null : m.id; stEl.textContent = words(s); toast(PROVIDER[a].name + ' uses ' + m.label); }
            catch (err) { toast('Could not save the model: ' + err.message); load(true); }
          });
          set.append(lab);
        });
        row.append(set);
      }
      return row;
    });
    box.replaceChildren(lede, ...(note ? [note] : []), ...rows);
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
    // The runner starts a container for the person. That takes 5 to 15 seconds, so the dialog says so.
    const slow = setTimeout(() => { if (go.disabled) setLive('Starting your private workspace. This takes a few seconds.', 'is-wait'); }, 1200);
    const steps = el('ol', 'a-steps'), one = el('li'), two = el('li');
    one.append(el('h3', '', 'Sign in to ' + P.name), go);
    steps.append(one, two);
    box.replaceChildren(intro, steps, live, el('p', 'a-fine', 'You can disconnect at any time in Assistants.'));
    const setLive = (text, cls = '') => { live.className = 'a-live' + (cls ? ' ' + cls : ''); live.textContent = text; };
    let f;
    try { f = await api('/api/assistants/' + a + '/connect', { method: 'POST' }); }
    catch (err) { clearTimeout(slow); setLive('Could not start the sign-in: ' + err.message, 'is-bad'); go.textContent = 'Try again'; go.disabled = false; go.onclick = () => connect(a); return; }
    clearTimeout(slow); setLive('');
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
      const field = el('div', 'a-field');
      input = el('input'); input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 2048; input.setAttribute('aria-label', 'The code from ' + P.name); input.placeholder = 'Code';
      field.append(input);
      two.append(field);
      let sending = false;
      const send = async () => {
        const code = input.value.trim();
        if (sending || !flow || code.length < 8 || /\s/.test(code)) return;
        sending = true; input.disabled = true;
        setLive('Checking the code…', 'is-wait');
        try {
          const s = await api('/api/assistants/connect/' + encodeURIComponent(f.id) + '/code', { method: 'POST', body: JSON.stringify({ code }) });
          if (s.status === 'connected') return done();
          if (s.status === 'pending') setLive('Waiting for ' + P.name + '…', 'is-wait');
          else if (s.status === 'failed') { setLive('That code did not work. Copy the code again from ' + P.site + '.', 'is-bad'); input.value = ''; }
          else return ended(s);
        } catch (err) { setLive('Could not check the code: ' + err.message, 'is-bad'); }
        sending = false; input.disabled = false; input.focus();
      };
      // A pasted code goes at once. A typed code goes with Enter.
      input.addEventListener('paste', () => setTimeout(send));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
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
  // A close loads the states again, so the chip in the bar shows what the person did in the dialog.
  dlg.addEventListener('close', () => { stop(); flow = null; after = null; load(true); });
  $('#assistants')?.addEventListener('click', () => { closePop(); open(); });
  // The states load once with the page, and again when the window gets the focus, at most once each 30 seconds.
  load(true);
  addEventListener('focus', () => { if (!dlg.open && Date.now() - loadedAt >= 30000) load(true); });
  const summary = () => ({ data, failed });
  return { load, state, open, connect, summary, PROVIDER, onChange: (f) => listeners.push(f) };
})();

// ─── The status chip: which assistants are connected, on every screen ───
// One button in the bar. It shows a mark for each assistant that the host offers, with a dot: solid green for connected,
// hollow grey for not connected, amber when the runner could not check the sign-in. With no assistant connected, it says
// "Connect an assistant". With no runner, it says "Assistants" and has no dots. A click opens the Assistants dialog.
// The library also has a second form of the chip, a row at the bottom of its sidebar (#assist-side). The row always has a
// label, and it shows the marks of the assistants also when none is connected. Both forms get the same name and tooltip.
(() => {
  const chips = [$('#assist-chip'), $('#assist-side')].filter(Boolean);
  if (!chips.length) return;
  const P = Assistants.PROVIDER;
  // The shape of the last answer, so the chip keeps its width until the first answer of this page comes.
  const SHAPE = 'assistants-chip';
  let shown = null;
  const mark = (a, dot) => {
    const m = el('span', 'a-mark ' + tone(a), a === 'chatgpt' ? 'G' : P[a].name[0]);
    if (dot) { m.dataset.state = dot; m.append(el('i', 'a-dot is-' + dot)); }
    return m;
  };
  const marksOf = (states) => Object.keys(states).map((a) => {
    const m = mark(a, states[a]);
    // A dot that changes its state fades in.
    if (shown && shown[a] && shown[a] !== states[a]) m.lastChild.classList.add('is-new');
    return m;
  });
  function drawOne(chip, shape, states, tip) {
    const side = chip.id === 'assist-side';
    const marks = $('.a-chip-marks', chip), lbl = $('.a-chip-lbl', chip);
    chip.className = (side ? 'l-nav a-side' : 'v-icon a-chip') + ' is-' + shape;
    if (shape === 'list' || (side && shape === 'none')) {
      marks.replaceChildren(...marksOf(states));
      lbl.textContent = !side ? '' : shape === 'none' ? 'Connect an assistant' : 'Assistants';
    } else if (shape === 'wait') {
      marks.replaceChildren(...Object.keys(P).map((a) => mark(a, '')));
      lbl.textContent = side ? 'Assistants' : '';
    } else if (side) {
      // The row has its own icon. With no runner it has no marks.
      marks.replaceChildren();
      lbl.textContent = shape === 'none' ? 'Connect an assistant' : 'Assistants';
    } else {
      // One icon. With no connection it has one hollow dot, which shows when the label does not.
      const one = el('span', 'a-mark is-icon');
      one.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5Z"/></svg>';
      if (shape === 'none') one.append(el('i', 'a-dot is-off'));
      marks.replaceChildren(one);
      lbl.textContent = shape === 'none' ? 'Connect an assistant' : 'Assistants';
    }
    chip.setAttribute('aria-label', tip);
    chip.dataset.tip = tip;
  }
  const draw = (shape, states, tip) => chips.forEach((c) => drawOne(c, shape, states, tip));
  function update() {
    const { data, failed } = Assistants.summary();
    if (!data && !failed) return;
    const offered = data && data.runner ? Object.keys(P).filter((a) => Assistants.state(a)?.handled) : [];
    if (!offered.length) {
      shown = null;
      draw('off', {}, !data ? 'Assistants: Pages could not load them' : data.error === 'no sandbox runner' ? 'Assistants: not set up on this host' : 'Assistants: off now. Pages cannot reach them');
      try { localStorage.setItem(SHAPE, 'off'); } catch {}
      return;
    }
    const states = {}, parts = [];
    offered.forEach((a) => {
      const s = Assistants.state(a);
      states[a] = s.error ? 'warn' : s.connected ? 'on' : 'off';
      parts.push(P[a].name + (s.error ? ': sign-in check failed' : s.connected ? ' connected' : ' not connected'));
    });
    const any = offered.some((a) => states[a] !== 'off');
    const tip = 'Assistants: ' + parts.join(', ');
    draw(any ? 'list' : 'none', states, any ? tip : 'Connect an assistant. ' + tip);
    shown = states;
    try { localStorage.setItem(SHAPE, any ? 'list' : 'none'); } catch {}
  }
  // Until the first answer: a neutral chip in the shape of the last answer, so nothing in the bar moves.
  let last = 'list';
  try { last = localStorage.getItem(SHAPE) || 'list'; } catch {}
  if (last === 'list') draw('wait', {}, 'Assistants: checking');
  else { draw(last, {}, 'Assistants: checking'); chips.forEach((c) => c.classList.add('is-wait')); }
  Assistants.onChange(update);
  update();
  chips.forEach((c) => c.addEventListener('click', (e) => { e.stopPropagation(); closePop(); Assistants.open(); }));
})();
