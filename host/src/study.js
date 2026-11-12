
// ─── The layout study: Rooms and Ledger ─────────────────────────────
// This file joins the library script, so it uses the helpers and the state of that script.
// D.activity lists what happened to the pages, newest first: publishes, requests to an assistant, and notes.
// Rooms: Activity is a place. The list of changes is on the left and the page itself is on the right.
// Ledger: each page row shows its latest change, and one switch turns the list into the log.

const LAYOUT = D.layout;
const ROOMS = LAYOUT === 'rooms';
let feed = D.activity;
const AGENTS = { claude: 'Claude', chatgpt: 'ChatGPT' };
const actor = (name) => AGENTS[name] || name;
const person = (name) => (name === D.me ? 'You' : String(name).split('@')[0]);
const icn = (name, cls) => '<svg' + (cls ? ' class="' + cls + '"' : '') + ' viewBox="0 0 24 24" aria-hidden="true">' + D.icons[name] + '</svg>';
const plain = (e) => !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** Adds the lens, the filters and the open item of a study layout to a place. The base script calls it before this file runs, so it reads D only. */
function studyPlace(p, u) {
  const af = u.get('af') || '';
  if (D.layout === 'rooms') {
    if (p.list === 'activity') return { list: 'activity', af: folders.some((f) => f.id === af) ? af : '', only: u.get('only') === 'waiting' ? 'waiting' : '', ev: u.get('e') || '' };
    // Each other place of Rooms is a list of pages. The address holds its view: the filters, the sort and the layout.
    const v = Drive.parseView(u, folders), lay = u.get('view');
    order = { sort: v.sort, dir: v.dir };
    if (lay === 'list' || lay === 'grid') view = lay;
    return { ...(p.list === 'recent' ? { list: 'home' } : p), type: v.type, mod: v.mod, in: v.in, acc: v.acc };
  }
  // Ledger has no Activity place. The Activity lens of Home is that list.
  if (p.list === 'activity') return { list: 'home', lens: 'activity' };
  return p.folder || p.list === 'home' ? { ...p, lens: u.get('lens') === 'activity' ? 'activity' : '' } : p;
}

// ─── What the reader has opened. The browser keeps it, so a new version shows as news until the reader opens the page. ───
const OPENED_KEY = 'pages-opened';
let opened = {};
function loadOpened() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(OPENED_KEY) || 'null'); } catch {}
  // The first visit: every page counts as opened, so the library does not start with a wall of news.
  if (!o || typeof o !== 'object') { o = {}; pages.forEach((p) => { o[p.slug] = p.latest; }); try { localStorage.setItem(OPENED_KEY, JSON.stringify(o)); } catch {} }
  opened = o;
}
loadOpened();
function markOpened(slug, version) {
  if (!slug || (opened[slug] || 0) >= version) return false;
  opened[slug] = version;
  try { localStorage.setItem(OPENED_KEY, JSON.stringify(opened)); } catch {}
  return true;
}
// The time of the last open of each page, in this browser. The page list can sort by it. The viewer writes it too.
const OPENED_AT_KEY = 'pages-opened-at';
let openedAt = {};
function loadOpenedAt() {
  try { const o = JSON.parse(localStorage.getItem(OPENED_AT_KEY) || '{}'); openedAt = o && typeof o === 'object' ? o : {}; } catch { openedAt = {}; }
}
loadOpenedAt();
function markTime(slug) {
  openedAt[slug] = new Date().toISOString();
  try { localStorage.setItem(OPENED_AT_KEY, JSON.stringify(openedAt)); } catch {}
}
// A link to a page marks the page as opened. A row in the room does not: it shows the change in the room.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="/p/"]');
  if (!a || (a.closest('.e-row') && inRoom() && plain(e))) return;
  const m = a.getAttribute('href').match(/^\/p\/([a-z0-9-]+\/[a-z0-9-]+)/);
  const p = m && pageOf(m[1]);
  if (!p) return;
  const news = markOpened(p.slug, p.latest);
  markTime(p.slug);
  if (news || order.sort === 'opened') setTimeout(render, 0);
}, true);
// The back button can show this document again from the cache. The viewer records what it showed, so read it again.
addEventListener('pageshow', (e) => { if (e.persisted) { loadOpened(); loadOpenedAt(); render(); poll(); } });

// ─── News: what a page or an item has for the reader ───
const seenVersion = (slug) => opened[slug] || 0;
/** True when an item waits for the reader: a version the reader did not open, a question, or a request that did not run. */
function fresh(x) {
  if (x.kind === 'note') return false;
  if (x.kind === 'publish') return x.version > seenVersion(x.slug);
  if (x.state === 'working') return false;
  if (x.state === 'changed') return x.version > seenVersion(x.slug);
  return x.open;
}
let newsBy = new Map(), bySlug = new Map(), waiting = 0, working = 0;
/** Reads the list again: the news of each page, and the two numbers for the sidebar. */
function digest() {
  newsBy = new Map(); bySlug = new Map();
  for (const x of feed) { if (!bySlug.has(x.slug)) bySlug.set(x.slug, []); bySlug.get(x.slug).push(x); }
  for (const p of pages) {
    const mine = bySlug.get(p.slug) || [];
    const req = (state) => mine.find((x) => x.kind === 'request' && x.state === state && (state === 'working' || x.open));
    // One page, one mark. Work in flight comes first, then what the reader must act on, then a version not opened yet.
    const work = req('working'), failed = !work && req('failed'), question = !work && !failed && req('replied');
    const n = work ? { kind: 'work', item: work } : failed ? { kind: 'failed', item: failed } : question ? { kind: 'question', item: question }
      : p.latest > seenVersion(p.slug) ? { kind: 'new', item: mine.find((x) => x.version === p.latest) || null } : null;
    if (n) newsBy.set(p.slug, n);
  }
  working = feed.filter((x) => x.kind === 'request' && x.state === 'working').length;
  waiting = feed.filter(fresh).length;
}
const newsOf = (p) => newsBy.get(p.slug) || null;
/** The newest thing that happened to a page, or its last publish time. */
const lastItem = (p) => (bySlug.get(p.slug) || [])[0] || null;
const lastTime = (p) => { const x = lastItem(p); return x && x.at > p.updated_at ? x.at : p.updated_at; };
const byLast = (a, b) => lastTime(b).localeCompare(lastTime(a));
const byTitle = (a, b) => a.title.localeCompare(b.title);

/**
 * The sentence for an item, in one of three forms.
 * card: the state of the page in a few words, with no name. A file card is about the file.
 * row: the change itself, as the latest change of a page in a list of pages.
 * event: who did what, for a list of events. An assistant has its name only here, where it is the one that acts.
 */
function say(x, form) {
  const card = form === 'card', event = form === 'event';
  if (x.kind === 'publish') return x.first ? (card ? 'New page' : 'Published') : card ? 'New version' : 'Version ' + x.version + ' published';
  if (x.kind === 'note') return '<b>' + h(person(x.author)) + '</b>' + (card ? ' wrote a comment' : ' wrote: ' + h(x.body));
  const a = '<b>' + h(actor(x.agent)) + '</b>';
  if (x.state === 'working') return card ? 'Change in progress' : (event ? a + ' is working: ' : 'In progress: ') + h(x.ask);
  if (x.state === 'changed') return card ? 'Changed' : (event ? a + ': ' : '') + h(x.reply || 'Changed the page for “' + x.ask + '”');
  if (x.state === 'replied') {
    const asks = x.reply && /\?\s*$/.test(x.reply);
    if (card) return asks ? 'Question for you' : 'No change';
    if (event) return x.reply ? a + (asks ? ' asks: ' : ': ') + h(x.reply) : a + ' made no change for “' + h(x.ask) + '”';
    return (asks ? 'Question: ' : 'No change: ') + h(x.reply || x.ask);
  }
  if (card) return x.cause === 'not_connected' ? 'Request did not run' : 'Request did not finish';
  const off = x.cause === 'not_connected';
  if (event) return a + (off ? ' is not connected' : x.cause === 'timeout' ? ' did not finish in time' : ' did not finish') + '. ' + (x.author === D.me ? 'Your request: ' : 'The request: ') + h(x.ask);
  return (off ? 'Did not run, ' + h(actor(x.agent)) + ' is not connected: ' : x.cause === 'timeout' ? 'Did not finish in time: ' : 'Did not finish: ') + h(x.ask);
}
/** The glyph and the tone of an item. Blue is news or work in flight. A ramp colour needs the reader. */
function look(x) {
  const tone = fresh(x) && (x.kind === 'publish' || x.state === 'changed') ? ' is-new' : '';
  if (x.kind === 'publish') return { icon: 'upload', cls: tone };
  if (x.kind === 'note') return { icon: 'message', cls: '' };
  if (x.state === 'working') return { icon: 'loader', cls: ' is-work' };
  if (x.state === 'changed') return { icon: 'pencilLine', cls: tone };
  if (x.state === 'replied') return { icon: 'question', cls: x.open ? ' is-warn c-amber' : '' };
  return { icon: x.cause === 'not_connected' ? 'unplug' : 'alert', cls: x.open ? ' is-warn c-red' : '' };
}
const glyph = (x) => icn(look(x).icon, x.kind === 'request' && x.state === 'working' ? 'is-spin' : '');
/** One line of news: a glyph and a sentence. The tail is the age, and it goes away first when the line has no space for it. */
const newsLine = (cls, g, text, tail) => '<span class="n' + cls + '"><span class="n-m"><span class="n-g">' + g + '</span><span class="n-t">' + text + '</span></span>' + (tail ? '<span class="n-w">' + tail + '</span>' : '') + '</span>';
const news = (x, form, tail, quiet) => newsLine(quiet ? ' is-quiet' : look(x).cls, glyph(x), say(x, form), tail);
/** The address of the page of an item: the version of an old publish, and the place in the page that the comment is about. */
const itemHref = (x) => { const p = pageOf(x.slug); return '/p/' + x.slug + (x.kind === 'publish' && p && x.version !== p.latest ? '/v/' + x.version : '') + (x.anchor ? '#' + encodeURIComponent(x.anchor) : ''); };
const pageHref = (p, n) => '/p/' + p.slug + (n && n.item && n.item.anchor ? '#' + encodeURIComponent(n.item.anchor) : '');

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function dayOf(iso) {
  const d = new Date(iso), now = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, days < 7 ? { weekday: 'long', month: 'long', day: 'numeric' } : { month: 'long', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
function took(x) {
  const s = Math.max(1, Math.round((Date.parse(x.at) - Date.parse(x.started)) / 1000));
  return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min' + (s % 60 ? ' ' + (s % 60) + ' s' : '');
}

// ─── The sidebar ───
const dot = (cls) => '<span class="s-mark ' + (cls || '') + '"><i></i></span>';
const MARKS = { work: () => '<span class="s-mark">' + icn('loader', 'is-spin') + '</span>', failed: () => dot('c-red'), question: () => dot('c-amber'), new: () => dot() };
/** True when the page has a version that the reader did not open. */
const isNew = (p) => p.latest > seenVersion(p.slug);
// In Rooms a page has one mark: the dot of a version that the reader did not open. What an assistant did is in Activity.
const markOf = (p) => { if (ROOMS) return isNew(p) ? '<span class="s-mark" title="New version"><i></i></span>' : ''; const n = newsOf(p); return n ? MARKS[n.kind]() : ''; };
/** A folder that is closed shows the strongest mark of the pages in it. */
function folderMark(f) {
  const kinds = new Set(pagesUnder(f.id).map((p) => (newsOf(p) || {}).kind));
  const k = ['work', 'failed', 'question', 'new'].find((x) => kinds.has(x));
  return k ? MARKS[k]() : '';
}
const sidePage = (p, d) => '<a class="l-nav s-page" href="' + (ROOMS ? '/p/' + p.slug : pageHref(p, newsOf(p))) + '" style="--d:' + d + '" title="' + h(p.title) + '">' + icn(p.kind === 'deck' ? 'deck' : 'file') + '<span class="s-name">' + h(p.title) + '</span>' + markOf(p) + '</a>';

function studySide() {
  digest();
  const here = place.folder, outline = LAYOUT === 'ledger';
  pathOf(here).forEach((f) => f.id !== here && expanded.add(f.id));
  $('#scroll').classList.toggle('is-room', !hits && place.list === 'activity');
  // The layout switch of the bar is for the classic library. Ledger has one layout, and Rooms has the switch in the head of its list.
  $('.h-tools .v-seg').style.display = 'none';
  $$('[data-nav]').forEach((a) => { if (!here && a.dataset.nav === place.list) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const act = $('#n-activity');
  if (act) act.innerHTML = (working ? icn('loader', 'is-spin') : '') + (waiting ? '<span>' + waiting + '</span>' : '');
  if (act) act.title = (working ? working + (working === 1 ? ' request is in progress. ' : ' requests are in progress. ') : '') + (waiting ? waiting + (waiting === 1 ? ' change is for you.' : ' changes are for you.') : '');
  // On a phone the sidebar is a drawer, so its button shows that there is news inside.
  $('#app').classList.toggle('has-news', waiting > 0);
  $('#n-shared').textContent = pages.filter((p) => p.shared).length || '';
  const pinned = pages.filter((p) => p.pinned_at).sort((a, b) => b.pinned_at.localeCompare(a.pinned_at));
  $('#pins').innerHTML = pinned.length ? '<div class="l-sec">Pinned</div><nav class="l-tree" aria-label="Pinned pages">' + pinned.map((p) => sidePage(p, 0)).join('') + '</nav>' : '';
  const row = (f, d) => {
    const kids = childrenOf(f.id), own = outline ? pages.filter((p) => p.folder_id === f.id).sort(byTitle) : [];
    const open = expanded.has(f.id), any = kids.length || own.length;
    return '<a class="l-nav ' + ramp(f) + '" href="' + urlOf({ folder: f.id }) + '" data-go-folder="' + f.id + '" style="--d:' + d + '"' + (here === f.id ? ' aria-current="page"' : '') + '>'
      + '<span class="l-caret' + (any ? (open ? ' is-open' : '') : ' is-none') + '" data-caret="' + f.id + '">' + svg('right') + '</span>'
      + '<svg class="l-glyph fo" viewBox="0 0 24 24" aria-hidden="true">' + D.icons.folder + '</svg><span class="s-name">' + h(f.name) + '</span>'
      + '<span class="l-n">' + pagesUnder(f.id).length + '</span>' + (outline && !open ? folderMark(f) : '') + '</a>'
      + (open ? kids.map((k) => row(k, d + 1)).join('') + own.map((p) => sidePage(p, d + 1)).join('') : '');
  };
  const top = childrenOf(null), loose = pages.filter((p) => !p.folder_id).length;
  $('#tree').innerHTML = (top.length ? top.map((f) => row(f, 0)).join('') : '<p class="l-empty-tree">No folders yet.</p>')
    + (loose ? '<a class="l-nav" href="' + urlOf({ list: 'unfiled' }) + '" data-loose' + (!here && place.list === 'unfiled' ? ' aria-current="page"' : '') + '><span class="l-caret is-none"></span>' + icn('file') + '<span class="s-name">Not in a folder</span><span class="s-count">' + loose + '</span></a>' : '');
}
$('#tree').addEventListener('click', (e) => {
  const a = e.target.closest('[data-loose]');
  if (a && plain(e)) { e.preventDefault(); go({ list: 'unfiled' }); }
});

// ─── A page as a card and as a ledger row ───
const shared = (p) => (p.shared ? '<span class="h-acc" title="Shared by link">' + svg('globe') + '</span>' : '');
function whereChip(p) {
  const f = folderOf(p.folder_id);
  if (place.folder && p.folder_id === place.folder) return '<span class="g-where"></span>';
  return f ? '<span class="h-where g-where ' + ramp(f) + '"><svg class="l-glyph fo" viewBox="0 0 24 24" aria-hidden="true">' + D.icons.folder + '</svg><span>' + h(f.name) + '</span></span>' : '<span class="h-where g-where is-none"><span>Not in a folder</span></span>';
}
/** The ledger row: the page, its latest change, its folder, the time of the change. */
function gRow(p) {
  const n = newsOf(p), last = lastItem(p);
  const what = n && n.item ? news(n.item, 'row') : n ? newsLine(' is-new', icn('upload'), 'New version') : last ? news(last, 'row', '', true) : '';
  return '<article class="g-row' + (n ? ' has-news' : '') + '" data-slug="' + p.slug + '" draggable="true"><a class="g-link" href="' + pageHref(p, n) + '" draggable="false">'
    + thumb(p, 0) + '<span class="g-title"><span class="g-name">' + h(p.title) + '</span>' + kind(p) + (p.pinned_at ? '<span class="g-pin" title="Pinned">' + svg('pin') + '</span>' : '') + '</span>'
    + '<span class="g-what">' + what + '</span>' + whereChip(p) + '<span class="g-when">' + ago(lastTime(p)) + '</span>' + shared(p) + '</a>' + menu(p) + '</article>';
}
/** One event as a ledger row: the same columns, with the hour in the place of the age. */
function gEvent(x) {
  const p = pageOf(x.slug);
  return '<article class="g-row' + (fresh(x) ? ' has-news' : '') + '" data-slug="' + p.slug + '"><a class="g-link" href="' + itemHref(x) + '">'
    + thumb(p, 0) + '<span class="g-title"><span class="g-name">' + h(p.title) + '</span>' + kind(p) + '</span>'
    + '<span class="g-what">' + news(x, 'event', '', !fresh(x) && x.state !== 'working') + '</span>' + whereChip(p) + '<span class="g-when">' + clock(x.at) + '</span>' + shared(p) + '</a></article>';
}
function byDay(list, row, cls) {
  let day = '';
  return list.map((x) => { const d = dayOf(x.at), head = d === day ? '' : '<h3 class="' + cls + '">' + h(d) + '</h3>'; day = d; return head + row(x); }).join('');
}
const seeAll = (n) => '<button type="button" class="l-more" data-see="recent">See all ' + n + '</button>';
/** The Ledger list: Pages or Activity, for the pages and the events of one place. */
function lensBlock(list, events, cap) {
  const act = place.lens === 'activity';
  const count = events.filter(fresh).length;
  const tabs = '<div class="g-tabs" role="tablist" aria-label="List">'
    + '<button type="button" role="tab" data-lens="" aria-selected="' + !act + '">Pages</button>'
    + '<button type="button" role="tab" data-lens="activity" aria-selected="' + act + '">Activity' + (count ? '<span class="s-count">' + count + '</span>' : '') + '</button></div>';
  const sorted = [...list].sort(byLast);
  const body = act
    ? (events.length ? byDay(events, gEvent, 'g-day') : '<p class="g-none">Nothing happened here yet.</p>')
    : (sorted.length ? sorted.slice(0, cap).map(gRow).join('') : '<p class="g-none">This folder has no pages of its own.</p>');
  return '<section class="l-block"><div class="l-head">' + tabs + (!act && sorted.length > cap ? seeAll(sorted.length) : '') + '</div><div class="g-list">' + body + '</div></section>';
}

// ─── The views ───
function studyMain(main) {
  const known = feed.filter((x) => pageOf(x.slug));
  if (ROOMS) {
    document.title = 'Pages';
    if (hits) return driveHits(main);
    return place.list === 'activity' ? roomView(main, known) : driveMain(main);
  }
  // Ledger: each place is one list with two lenses.
  const top = childrenOf(null), all = [...pages].sort(byLast);
  if (place.folder) {
    const f = folderOf(place.folder), kids = childrenOf(f.id), here = pages.filter((p) => p.folder_id === f.id), under = pagesUnder(f.id);
    const slugs = new Set(under.map((p) => p.slug)), events = known.filter((x) => slugs.has(x.slug));
    const newest = under.map((p) => p.updated_at).sort().pop();
    document.title = f.name + ' – Pages';
    main.innerHTML = '<div class="l-title"><h1>' + h(f.name) + '</h1><button type="button" class="v-icon" data-edit="' + f.id + '" aria-label="Edit folder" data-tip="Edit folder" aria-expanded="false">' + svg('pencil') + '</button>'
      + '<p>' + under.length + (under.length === 1 ? ' page' : ' pages') + (newest ? ', last published ' + ago(newest) : '') + '</p></div>'
      + (kids.length ? folderBlock(kids, 'Folders') : '')
      + (under.length ? lensBlock(here, events, 200) : kids.length ? '' : '<div class="l-empty"><b>This folder is empty</b><span>Drag a page here, or choose Move to folder from a page’s menu.</span></div>');
    return;
  }
  document.title = 'Pages';
  if (place.list === 'home') { main.innerHTML = (top.length ? folderBlock(top, 'Folders') : '') + lensBlock(pages, known, 24); return; }
  const lists = {
    recent: ['Recent', all, ''],
    pinned: ['Pinned', all.filter((p) => p.pinned_at), '<div class="l-empty"><b>No pinned pages</b><span>Pin a page from its menu, or press p.</span></div>'],
    shared: ['Shared by link', all.filter((p) => p.shared), '<div class="l-empty"><b>No shared pages</b><span>A page shows here once it has a share link.</span></div>'],
    unfiled: ['Not in a folder', all.filter((p) => !p.folder_id), '<div class="l-empty"><b>Every page is in a folder</b><span>A page that an agent publishes shows here until you move it.</span></div>'],
  };
  const [title, list, empty] = lists[place.list];
  main.innerHTML = list.length ? '<section class="l-block"><div class="l-head"><h2>' + title + '</h2></div><div class="g-list">' + list.map(gRow).join('') + '</div></section>' : empty;
}

// ─── Home in Rooms: the pages as a drive ───────────────────────────
// A place of Rooms that is not Activity is a list of pages: Home, a folder, the shared pages, the pages in no folder.
// drive.js holds the rules: which pages pass the filters, and their order. This part draws the controls and the list.
// The address holds the filters, the sort and the layout, so a view can be shared and it survives a reload.
// A page has one mark of its own here: a dot for a version that the reader did not open. What an assistant did is in Activity.
const NEW_DOT = '<span class="d-new" role="img" aria-label="New version" title="A new version since you last opened this page"></span>';
/** The filters that this place offers. A folder is its own location, and the shared pages are their own access. A search looks in every folder. */
function filtersHere() {
  const keys = ['type', 'mod'];
  if (hits || (!place.folder && place.list !== 'unfiled')) keys.push('in');
  if (hits || place.list !== 'shared') keys.push('acc');
  return keys;
}
/** The view of this place: the filters that it offers, and the sort. */
function viewHere() {
  const v = { type: '', mod: '', in: '', acc: '', sort: order.sort, dir: order.dir };
  for (const k of filtersHere()) v[k] = place[k] || '';
  return v;
}
/** The folders as the choices of the Folder filter: the tree, then the pages in no folder. */
function folderChoices() {
  const out = [];
  const walk = (parent, d) => childrenOf(parent).forEach((f) => { out.push({ id: f.id, name: f.name, depth: d, folder: f }); walk(f.id, d + 1); });
  walk(null, 0);
  out.push({ id: 'none', name: 'Not in a folder', depth: 0, folder: null, rule: out.length > 0 });
  return out;
}
const FILTERS = {
  type: { name: 'Type', any: 'Any type', choices: () => Drive.TYPES },
  mod: { name: 'Modified', any: 'Any time', choices: () => Drive.RANGES },
  in: { name: 'Folder', any: 'Any folder', choices: folderChoices },
  acc: { name: 'Access', any: 'Any access', choices: () => Drive.ACCESS },
};
const folderGlyph = '<svg class="l-glyph fo" viewBox="0 0 24 24" aria-hidden="true">' + D.icons.folder + '</svg>';
/** A filter in the head of the list. It has no fill until it is set. Then it shows its value. */
function chip(key, v) {
  const f = FILTERS[key], cur = v[key] ? f.choices().find((c) => c.id === v[key]) : null;
  return '<button type="button" class="d-chip' + (cur ? ' is-on' : '') + (cur && cur.folder ? ' ' + ramp(cur.folder) : '') + '" data-filter="' + key + '" aria-haspopup="menu" aria-expanded="false"'
    + (cur ? ' aria-label="' + h(f.name + ': ' + cur.name) + '"' : '') + '>' + (cur && cur.folder ? folderGlyph : '') + '<span>' + h(cur ? cur.name : f.name) + '</span>' + icn('down') + '</button>';
}
/** The head of a page list: its name or its count, the filters, then the sort and the layout. */
function driveHead(title, v) {
  const s = Drive.sortOf(v.sort);
  const lay = (name, label, end) => '<button type="button" data-layout-of="' + name + '" aria-label="' + label + '" data-tip="' + label + '"' + (end ? ' data-tip-end' : '') + ' aria-pressed="' + (view === name) + '">' + icn(name) + '</button>';
  return '<div class="l-head d-head"><h2>' + title + '</h2>'
    + '<div class="d-chips" role="group" aria-label="Filters">' + filtersHere().map((k) => chip(k, v)).join('') + (Drive.isOn(v) ? '<button type="button" class="d-clear" data-clear>Clear</button>' : '') + '</div>'
    + (hits ? '' : '<div class="d-tools"><button type="button" class="d-chip d-sort" data-sort-menu aria-haspopup="menu" aria-expanded="false" aria-label="' + h('Sort: ' + s.name + ', ' + s[v.dir].toLowerCase()) + '"><span>' + h(s.name) + '</span>' + icn(v.dir === 'asc' ? 'arrowUp' : 'arrowDown') + '</button>'
      + '<div class="v-seg d-lay" role="group" aria-label="Layout">' + lay('grid', 'Grid') + lay('list', 'List', true) + '</div></div>') + '</div>';
}

/** A time for a card or a row: the age of a new time, the day of an older one, with the year when it is not this year. */
function dWhen(iso) {
  const d = new Date(iso);
  return Date.now() - d.getTime() < 604800000 || d.getFullYear() === new Date().getFullYear() ? ago(iso) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
/** The small line of a page: its folder, and the time that the sort uses. The sort names that time, and the full time shows on hover.
    A page that the reader did not open has no time under the sort by the last open, so its line is the folder only.
    In a folder the line has no folder name, so a word says which time it is: "Created Oct 13", "Not opened".
    The line has two parts. When the line is too long, the name of the folder gets shorter and the time stays whole. */
function subLine(p, v) {
  const at = Drive.dateOf(p, v.sort, openedAt), here = place.folder && p.folder_id === place.folder;
  const verb = v.sort === 'opened' ? 'Opened' : v.sort === 'created' ? 'Created' : 'Modified';
  const when = at ? (here ? verb + ' ' : '') + dWhen(at) : here ? 'Not opened' : '';
  const full = at ? verb + ' ' + new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  return (here ? '' : '<span class="d-in">' + h(where(p)) + (when ? ',' : '') + '</span>')
    + (when ? '<span class="d-at"' + (full ? ' title="' + h(full) + '"' : '') + '>' + h(when) + '</span>' : '');
}
function dCard(p, v) {
  const fresh = isNew(p);
  return '<article class="h-card' + (fresh ? ' is-new' : '') + '" data-slug="' + p.slug + '" draggable="true"><a class="h-link" href="/p/' + p.slug + '" draggable="false">'
    + thumb(p, Math.min(2, p.latest - 1)) + '<span class="h-title">' + (fresh ? NEW_DOT : '') + h(p.title) + '</span>'
    + '<span class="h-sub">' + shared(p) + kind(p) + '<span class="d-line">' + subLine(p, v) + '</span></span></a>' + menu(p) + '</article>';
}
/** The time column shows the time that the sort uses: the last open, the first publish, or the last change. */
const dateKey = (v) => (v.sort === 'opened' || v.sort === 'created' ? v.sort : 'modified');
/** The names of the columns. A click sorts the list by that column, and a second click turns the order. */
function dCols(v) {
  const col = (key, name, cell) => {
    const on = v.sort === key, s = Drive.sortOf(key);
    return '<span class="d-cell ' + cell + '"><button type="button" class="d-col' + (on ? ' is-on' : '') + '" data-sort="' + key + '" aria-label="' + h(on ? name + ', sorted, ' + s[v.dir].toLowerCase() : 'Sort by ' + name.toLowerCase()) + '">'
      + '<span>' + name + '</span>' + (on ? icn(v.dir === 'asc' ? 'arrowUp' : 'arrowDown') : '') + '</button></span>';
  };
  const key = dateKey(v);
  return '<div class="d-cols">' + col('name', 'Name', 'is-name') + col('folder', 'Folder', 'is-where') + col(key, { modified: 'Modified', opened: 'Opened', created: 'Created' }[key], 'is-when')
    + col('versions', 'Versions', 'is-vers') + col('access', 'Access', 'is-acc') + '</div>';
}
function dRow(p, v) {
  const fresh = isNew(p), at = Drive.dateOf(p, v.sort, openedAt);
  return '<article class="g-row d-row' + (fresh ? ' is-new' : '') + '" data-slug="' + p.slug + '" draggable="true"><a class="d-link" href="/p/' + p.slug + '" draggable="false">' + thumb(p, 0)
    + '<span class="d-cell is-name"><span class="g-title">' + (fresh ? NEW_DOT : '') + '<span class="g-name">' + h(p.title) + '</span>' + kind(p) + (p.pinned_at ? '<span class="g-pin" title="Pinned">' + svg('pin') + '</span>' : '') + '</span>'
    + '<span class="d-sub d-line">' + subLine(p, v) + '</span></span>'
    + '<span class="d-cell is-where">' + whereChip(p) + '</span>'
    + '<span class="d-cell is-when"' + (at ? ' title="' + h(new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })) + '"' : '') + '>' + (at ? dWhen(at) : 'Not opened') + '</span>'
    + '<span class="d-cell is-vers">' + p.latest + '</span>'
    + '<span class="d-cell is-acc' + (p.shared ? ' is-shared' : '') + '">' + svg(p.shared ? 'globe' : 'lock') + '<span>' + (p.shared ? 'Shared by link' : 'Private') + '</span></span>'
    + '</a>' + menu(p) + '</article>';
}

// A long list shows its first pages, and one button shows the rest. The choice holds for the view that the reader made it in.
let cap = 120, allOf = '';
const viewKey = () => JSON.stringify([place.folder || place.list, viewHere(), view]);
const pagesWord = (n) => (n ? n + (n === 1 ? ' page' : ' pages') : 'No pages');
const noMatch = (text) => '<p class="d-none">' + text + '. <button type="button" class="d-clear" data-clear>Clear filters</button></p>';
function driveMain(main) {
  const v = viewHere(), on = Drive.isOn(v), f = place.folder ? folderOf(place.folder) : null;
  // The bar names the place, so the head of the list says only what the list holds.
  let top = '', scope = pages, none = '<div class="l-empty"><b>No pages yet</b><span>Publish one with <code>agent-pages publish &lt;page&gt;</code>.</span></div>';
  if (f) {
    const kids = childrenOf(f.id), under = pagesUnder(f.id), slugs = new Set(under.map((p) => p.slug));
    const newest = under.map((p) => p.updated_at).sort().pop();
    document.title = f.name + ' – Pages';
    top = '<div class="l-title"><h1>' + h(f.name) + '</h1><button type="button" class="v-icon" data-edit="' + f.id + '" aria-label="Edit folder" data-tip="Edit folder" aria-expanded="false">' + svg('pencil') + '</button>'
      + '<p>' + under.length + (under.length === 1 ? ' page' : ' pages') + (newest ? ', last modified ' + ago(newest) : '') + '</p>'
      + (feed.some((x) => slugs.has(x.slug)) ? '<button type="button" class="l-act" data-room="' + f.id + '">' + icn('activity') + 'Activity in this folder</button>' : '') + '</div>'
      + (kids.length && !on ? folderBlock(kids, 'Folders') : '');
    if (!under.length) { main.innerHTML = top + (kids.length ? '' : '<div class="l-empty"><b>This folder is empty</b><span>Drag a page here, or choose Move to folder from a page’s menu.</span></div>'); return; }
    // With no filter, a folder shows its own pages. A filter looks in the folders below it too.
    scope = on ? under : pages.filter((p) => p.folder_id === f.id);
    none = '<p class="g-none">This folder has no pages of its own. A filter looks in its folders too.</p>';
  } else if (place.list === 'pinned') {
    scope = pages.filter((p) => p.pinned_at);
    none = '<div class="l-empty"><b>No pinned pages</b><span>Pin a page from its menu, or press p.</span></div>';
  } else if (place.list === 'shared') {
    scope = pages.filter((p) => p.shared);
    none = '<div class="l-empty"><b>No shared pages</b><span>A page shows here once it has a share link.</span></div>';
  } else if (place.list === 'unfiled') {
    scope = pages.filter((p) => !p.folder_id);
    none = '<div class="l-empty"><b>Every page is in a folder</b><span>A page that an agent publishes shows here until you move it.</span></div>';
  } else {
    const shelf = childrenOf(null);
    top = shelf.length && !on ? folderBlock(shelf, 'Folders') : '';
  }
  // A place with no pages has nothing to filter, so it shows only what the reader can do next.
  if (!f && !scope.length) { main.innerHTML = top + none; return; }
  const list = Drive.applyView(scope, v, { now: new Date(), folders, openedAt });
  const shown = allOf === viewKey() ? list : list.slice(0, cap);
  // The folder column has no use when each page of the list is in the folder of the place.
  const noWhere = (f && !on) || place.list === 'unfiled';
  const body = !list.length ? (on ? noMatch('No page matches these filters') : none)
    : (view === 'grid' ? '<div class="h-grid">' + shown.map((p) => dCard(p, v)).join('') + '</div>'
      : '<div class="g-list d-list' + (noWhere ? ' no-where' : '') + '">' + dCols(v) + shown.map((p) => dRow(p, v)).join('') + '</div>')
      + (list.length > shown.length ? '<button type="button" class="d-more" data-all-pages>Show all ' + list.length + ' pages</button>' : '');
  main.innerHTML = top + '<section class="l-block">' + driveHead(on ? pagesWord(list.length) : 'Pages', v) + body + '</section>';
}
/** The results of a search, with the filters above them. A search looks in every folder, and the best match comes first. */
function driveHits(main) {
  const v = viewHere(), on = Drive.isOn(v), text = h($('#q').value.trim());
  if (!hits.length && !on) { main.innerHTML = '<p class="h-none">No page has text that matches “' + text + '”.</p>'; return; }
  const keep = on ? new Set(Drive.filterPages(pages, v, { now: new Date(), folders, openedAt }).map((p) => p.slug)) : null;
  const list = keep ? hits.filter((x) => keep.has(x.slug)) : hits;
  main.innerHTML = '<section class="l-block">' + driveHead(list.length ? list.length + (list.length === 1 ? ' page matches' : ' pages match') : 'No matches', v)
    + (list.length ? '<div class="h-hits">' + list.map(hit).join('') + '</div>'
      : hits.length ? noMatch('No page with these filters has text that matches “' + text + '”') : '<p class="h-none">No page has text that matches “' + text + '”.</p>') + '</section>';
}

/** Changes the filters of this place. The address gets a new entry, so Back shows the list as it was. */
function setFilters(next) {
  place = { ...place, ...next };
  history.pushState(null, '', urlOf(place, true));
  sel = -1;
  render();
}
/** Changes the sort. The address follows, with no new entry. */
function setOrder(next) {
  order = next;
  history.replaceState(history.state, '', urlOf(place, true));
  render();
}
/** Changes the layout of the list: a grid of cards, or rows with columns. The browser keeps the choice. */
function setLayout(name) {
  view = name;
  try { localStorage.setItem('library-view', view); } catch {}
  history.replaceState(history.state, '', urlOf(place, true));
  render();
}

// The menu of a filter and the menu of the sort share one element. Each choice is a radio item with a check mark.
const option = (set, id, name, on, more) => '<button type="button" class="v-item d-opt' + ((more && more.cls) || '') + '" role="menuitemradio" aria-checked="' + !!on + '" data-set="' + set + '" data-value="' + h(id) + '"' + ((more && more.attr) || '') + '>'
  + '<span class="d-tick">' + svg('check') + '</span>' + ((more && more.lead) || '') + '<span>' + h(name) + '</span></button>';
const RULE = '<div class="v-hr" role="separator"></div>';
function openMenu(btn, html, label, viaKey, fromLeft) {
  const pop = $('#pop-filter');
  pop.innerHTML = html;
  pop.setAttribute('aria-label', label);
  openPop(btn, pop, viaKey);
  if (!open) return;
  // The filters stand at the left side of the list, so their menu opens in line with the left side of its filter.
  if (fromLeft) pop.style.right = Math.max(8, innerWidth - btn.getBoundingClientRect().left - pop.offsetWidth) + 'px';
  const on = viaKey && $('[aria-checked="true"]', pop);
  if (on) on.focus();
}
function openFilter(btn, viaKey) {
  const key = btn.dataset.filter, f = FILTERS[key], cur = viewHere()[key];
  openMenu(btn, option(key, '', f.any, !cur) + RULE + f.choices().map((c) => (c.rule ? RULE : '')
    + option(key, c.id, c.name, cur === c.id, c.folder ? { cls: ' ' + ramp(c.folder), attr: ' style="padding-left:' + (8 + c.depth * 14) + 'px"', lead: folderGlyph } : null)).join(''), f.name, viaKey, true);
}
function openSort(btn, viaKey) {
  const v = viewHere(), s = Drive.sortOf(v.sort);
  // A sort that only a column offers shows in the menu while the list uses it.
  openMenu(btn, '<div class="v-label">Sort by</div>' + Drive.SORTS.filter((x) => !x.column || x.id === s.id).map((x) => option('sort', x.id, x.name, x.id === s.id)).join('')
    + RULE + [s.first, s.first === 'asc' ? 'desc' : 'asc'].map((d) => option('dir', d, s[d], v.dir === d)).join(''), 'Sort', viaKey, false);
}
if ($('#pop-filter')) $('#pop-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-set]');
  if (!b) return;
  const key = b.dataset.set, value = b.dataset.value, viaKey = e.detail === 0;
  closePop();
  if (key === 'sort') setOrder({ sort: value, dir: Drive.sortOf(value).first });
  else if (key === 'dir') setOrder({ sort: order.sort, dir: value });
  else setFilters({ [key]: value });
  // The list is new, so its controls are new too. For a reader who uses the keys, the focus goes back to the control.
  const again = viaKey && (key === 'sort' || key === 'dir' ? $('#main [data-sort-menu]') : $('#main [data-filter="' + key + '"]'));
  if (again) again.focus();
});
// The keys of the page list: f goes to the filters, and v changes the layout.
document.addEventListener('keydown', (e) => {
  if (!ROOMS || e.metaKey || e.ctrlKey || e.altKey || open || e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === 'f') { const c = $('#main .d-chip'); if (c) { e.preventDefault(); c.focus(); } }
  else if (e.key === 'v' && $('#main .d-lay')) { e.preventDefault(); setLayout(view === 'grid' ? 'list' : 'grid'); }
});
// Back and Forward can change the search text of the address. The field and the results follow.
addEventListener('popstate', () => {
  if (!ROOMS) return;
  const text = new URLSearchParams(location.search).get('q') || '';
  if (!text && !$('#q').value) return;
  $('#q').value = text;
  runSearch();
});

// ─── The room: Activity in Rooms ───
const inRoom = () => LAYOUT === 'rooms' && place.list === 'activity' && !hits;
const roomWide = () => inRoom() && matchMedia('(min-width: 1121px)').matches;
function eRow(x, cur) {
  const p = pageOf(x.slug), l = look(x);
  return '<article class="e-row' + l.cls + (fresh(x) ? ' is-fresh' : '') + (cur && cur.id === x.id ? ' is-cur' : '') + '" data-slug="' + p.slug + '" data-ev="' + h(x.id) + '"><a class="e-link" href="' + itemHref(x) + '">'
    + '<span class="e-g">' + glyph(x) + '</span><span class="e-title">' + h(p.title) + '</span><span class="e-when">' + clock(x.at) + '</span><span class="e-line">' + say(x, 'event') + '</span></a></article>';
}
let roomList = [], listTop = 0;
function roomView(main, known) {
  let list = known;
  if (place.af) { const slugs = new Set(pagesUnder(place.af).map((p) => p.slug)); list = list.filter((x) => slugs.has(x.slug)); }
  const mine = list.filter(fresh).length;
  if (place.only) list = list.filter((x) => fresh(x) || x.state === 'working');
  roomList = list;
  if (!$('#room')) { main.innerHTML = '<div class="r" id="room"><section class="r-list" id="rlist" aria-label="Activity"></section><section class="r-view" id="rview" aria-label="Review"></section></div>'; shown = ''; }
  const wide = roomWide();
  // A wide window shows the newest item when the address names none. A narrow window shows the list, and a row opens its item.
  const cur = known.find((x) => x.id === place.ev) || (wide ? list[0] : null) || null;
  const room = $('#room'), was = room.classList.contains('is-open');
  room.classList.toggle('is-open', !wide && !!cur);
  const f = place.af && folderOf(place.af);
  const head = '<div class="r-head"><div class="g-tabs" role="tablist" aria-label="Show">'
    + '<button type="button" role="tab" data-only="" aria-selected="' + !place.only + '">All</button>'
    + '<button type="button" role="tab" data-only="waiting" aria-selected="' + !!place.only + '">For you' + (mine ? '<span class="s-count">' + mine + '</span>' : '') + '</button></div>'
    + (f ? '<button type="button" class="r-scope" data-scope-off aria-label="Show every folder"><span>' + h(f.name) + '</span>' + icn('x') + '</button>' : '') + '</div>';
  $('#rlist').innerHTML = head + (list.length ? byDay(list, (x) => eRow(x, wide ? cur : null), 'r-day') : '<p class="g-none">' + (place.only ? 'Nothing waits for you.' : 'Nothing happened yet.') + '</p>');
  if (was && !room.classList.contains('is-open')) $('#rlist').scrollTop = listTop;
  drawReview(cur);
}

// ─── The review: what one version changed, marked in the page itself ───
// diff.js compares two versions in the browser. The newer version shows in a frame, with the marks in it.
// The frame has the height of its page, so the review scrolls as one column: the record, then the page.
// review-frame.js runs in the frame: it puts the box around a change, and it tells this script where the reader is.
const NONCE = document.currentScript ? document.currentScript.nonce : '';
const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
const rawUrl = (slug, n) => '/raw/' + slug + '/' + n + '?k=' + D.kit + (theme === 'auto' ? '' : '&theme=' + theme);
/** The item that stored version v of a page: a publish, or the request that an assistant ran. */
const makerOf = (slug, v) => feed.find((i) => i.slug === slug && i.version === v && (i.kind === 'publish' || i.state === 'changed')) || null;
/** A time for a small line: the hour, and the day too when it is not today. */
function stamp(iso) {
  const d = new Date(iso), day = dayOf(iso);
  const date = day === 'Yesterday' ? day : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  return (day === 'Today' ? '' : date + ', ') + clock(iso);
}

/** The HTML of the versions that the reader looked at. A version never changes, so the copy stays good. */
const texts = new Map();
function versionHtml(slug, n) {
  const url = rawUrl(slug, n);
  let t = texts.get(url);
  if (!t) {
    t = fetch(url).then((r) => { if (!r.ok) throw new Error('version ' + n + ' did not load'); return r.text(); });
    t.catch(() => texts.delete(url));
    texts.set(url, t);
    if (texts.size > 16) texts.delete(texts.keys().next().value);
  }
  return t;
}
/**
 * The document of the frame: the newer version with the marks, the rules for the marks, and the script that steps through them.
 * The frame has the content rules of this page, so a script runs in it only with the nonce of this page.
 * The kit and the script of the review get the nonce. A script that the page brought does not run in a review.
 */
function frameDoc(d) {
  const doc = d.head + '<style>' + D.frame.css + '</style>' + d.body + '<script nonce="' + NONCE + '">' + D.frame.js + '<\/script>' + d.tail;
  return doc.replace('<script>\n/* explain.js', '<script nonce="' + NONCE + '">\n/* explain.js');
}
const reviews = new Map();
/** What version `after` changed: the document for the frame, the number of changes, and the list of places. */
async function reviewOf(slug, before, after) {
  const key = rawUrl(slug, before) + '>' + after;
  let r = reviews.get(key);
  if (!r) {
    const [a, b] = await Promise.all([versionHtml(slug, before), versionHtml(slug, after)]);
    const d = Diff.diffHtml(a, b, { review: true });
    r = { doc: frameDoc(d), stops: d.stops, deck: d.deck, list: Diff.summarize(d.changes) };
    reviews.set(key, r);
    if (reviews.size > 8) reviews.delete(reviews.keys().next().value);
  }
  return r;
}

/** What was asked and what came of it, as the fields of a record. A name stands only in the small line, next to the time. */
function record(x) {
  const rows = [], on = x.quote ? ', on “' + h(x.quote) + '”' : '';
  if (x.kind === 'request') {
    const a = h(actor(x.agent));
    rows.push(['Request', h(x.ask), h(person(x.author)) + ', ' + stamp(x.started) + on]);
    if (x.state === 'working') rows.push(['Result', 'In progress', a + ' started at ' + clock(x.started) + '. The new version shows here when it is ready.']);
    else if (x.state === 'changed') rows.push(['Result', h(x.reply || 'The page changed.'), a + ', version ' + x.version + ', after ' + took(x)]);
    else if (x.state === 'replied') rows.push(['Result', h(x.reply || 'No change'), a + ' made no change to the page.' + (x.open ? ' Answer in the comments of the page.' : '')]);
    else rows.push(['Result', '<span class="is-warn c-red">' + (x.cause === 'not_connected' ? 'The request did not run, because ' + a + ' is not connected.' : x.cause === 'timeout' ? 'The run did not finish in time.' : 'The run did not finish.') + '</span>',
      x.cause === 'not_connected' ? 'Connect ' + a + ', then write the comment again.' : 'Write the comment again to try once more.']);
  } else if (x.kind === 'note') {
    rows.push(['Comment', h(x.body), h(person(x.author)) + ', ' + stamp(x.at) + on + (x.replies ? ', ' + x.replies + (x.replies === 1 ? ' reply' : ' replies') : '')]);
  } else {
    rows.push(['Published', x.first ? 'The first version' : 'Version ' + x.version, new Date(x.at).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })]);
  }
  return '<dl class="r-what">' + rows.map((r) => '<dt>' + r[0] + '</dt><dd>' + r[1] + '<small>' + r[2] + '</small></dd>').join('') + '</dl>';
}
/** The version in the review. Its arrows show what the version before and the version after changed, and its name lists every version. */
function verPill(p, n, made) {
  const step = (v, name) => {
    const i = made ? makerOf(p.slug, v) : null;
    return '<button type="button" class="v-step"' + (i ? ' data-ev-go="' + h(i.id) + '" data-tip="Version ' + v + '" aria-label="Show what version ' + v + ' changed"' : ' disabled aria-label="' + (v < n ? 'No version before this one' : 'No version after this one') + '"') + '>' + svg(name) + '</button>';
  };
  return '<div class="v-ver r-ver">' + (made ? step(n - 1, 'left') : '')
    + '<button type="button" class="v-cur" data-vers aria-haspopup="true" aria-expanded="false" aria-label="Version ' + n + ' of ' + p.latest + '. Show every version"><b>Version ' + n + '</b><span class="v-of">of ' + p.latest + '</span>' + svg('down') + '</button>'
    + (made ? step(n + 1, 'right') : '') + '</div>';
}
const plainFrame = (p, n, anchor) => '<iframe class="r-frame" title="' + h(p.title) + '" sandbox="' + SANDBOX + '" src="' + rawUrl(p.slug, n) + (anchor ? '#' + encodeURIComponent(anchor) : '') + '"></iframe>';

// What the right side shows now: the item, its state, its versions, the theme and the width. The same key keeps the frame, so a redraw does not load the page again.
let shown = '', rev = null, dwell;
// The page has the width of a desk window, and the frame scales it down. On a phone the page has its own layout for that width.
const zoom = new ResizeObserver((list) => list.forEach((e) => {
  const w = e.contentRect.width;
  e.target.style.setProperty('--z', (w >= 560 ? Math.min(1, w / 860) : 1).toFixed(4));
  if (rev && rev.height) fitFrame(rev.height);
}));
const zOf = (page) => parseFloat(page.style.getPropertyValue('--z')) || 1;
function drawReview(x) {
  const el = $('#rview');
  if (!el) return;
  const wide = roomWide();
  if (!x) { shown = ''; rev = null; el.innerHTML = wide ? '<p class="r-none">Choose a change to see it in its page.</p>' : ''; return; }
  const p = pageOf(x.slug);
  // An item that stored a version shows what that version changed. Each other item shows the page as it is now.
  const made = x.kind === 'publish' || x.state === 'changed' ? x.version : 0;
  const after = made || p.latest, before = made > 1 ? made - 1 : 0;
  const key = [x.id, x.state || '', after, before, p.latest, theme, wide ? 'wide' : 'flow'].join('|');
  if (key === shown) return;
  shown = key;
  rev = { key, slug: p.slug, made, before, after, anchor: x.anchor || '', stops: 0, at: 0, on: true, deck: false, list: [], all: false, height: 0 };
  el.scrollTop = 0;
  byHand = true;
  el.innerHTML = '<header class="r-top"><button type="button" class="r-back" data-back>' + svg('left') + 'Activity</button>'
    + '<div class="r-id"><h1>' + h(p.title) + '</h1>' + whereChip(p) + '</div><div class="r-acts">' + verPill(p, after, made)
    + '<a class="r-open" href="' + itemHref(x) + '">Open page' + icn('arrowUpRight') + '</a></div></header>'
    + '<div class="r-rec" id="rrec">' + record(x) + '</div><div class="r-stage' + (before ? ' is-flow' : '') + '" id="rstage"><div class="r-page" id="rpage"></div></div>';
  zoom.disconnect();
  zoom.observe($('#rpage'));
  if (before) compare(key, p); else $('#rpage').innerHTML = plainFrame(p, after, rev.anchor);
  // A change that shows here for 2 seconds counts as opened, as a message in a mail program counts as read.
  clearTimeout(dwell);
  if (x.version > seenVersion(x.slug)) dwell = setTimeout(() => {
    if (shown === key && $('#rstage') && document.visibilityState === 'visible' && markOpened(x.slug, x.version)) render();
  }, 2000);
}
/** Loads the two versions, compares them, and shows the newer one with the marks. */
async function compare(key, p) {
  $('#rpage').innerHTML = '<p class="r-wait">Comparing version ' + rev.before + ' with version ' + rev.after + '</p>';
  let r = null;
  try { r = await reviewOf(p.slug, rev.before, rev.after); } catch {}
  if (shown !== key || !rev || !$('#rpage')) return;
  if (!r) {
    // Without the two versions there is nothing to mark, so the page shows as it is, in a frame that scrolls.
    $('#rstage').classList.remove('is-flow');
    $('#rpage').innerHTML = plainFrame(p, rev.after, rev.anchor);
    $('#rstage').insertAdjacentHTML('afterbegin', '<div class="r-strip" id="rstrip"><span class="r-count">Version ' + rev.before + ' did not load, so the page shows with no marks.</span></div>');
    return;
  }
  Object.assign(rev, { stops: r.stops, deck: r.deck, list: r.list });
  drawChanges();
  $('#rstage').insertAdjacentHTML('afterbegin', '<div class="r-strip" id="rstrip">' + (r.stops
    ? '<div class="r-steps" role="group" aria-label="Changes"><button type="button" class="v-icon" data-step="-1" aria-label="Previous change" data-tip="Previous change" data-tip-start>' + svg('up') + '</button>'
      + '<button type="button" class="v-icon" data-step="1" aria-label="Next change" data-tip="Next change" data-tip-start>' + svg('down') + '</button><span class="r-count" id="rcount" aria-live="polite"></span></div>'
      + '<button type="button" class="r-switch" role="switch" aria-checked="true" data-show><span>Show changes</span><i aria-hidden="true"></i></button>'
    : '<span class="r-count">Version ' + rev.after + ' shows the same content as version ' + rev.before + '.</span>') + '</div>');
  drawCount();
  const f = document.createElement('iframe');
  f.className = 'r-frame';
  f.title = p.title + ', with the changes of version ' + rev.after;
  f.setAttribute('sandbox', SANDBOX);
  f.dataset.rev = '';
  // The frame has the height of its page, so it never scrolls. The review scrolls.
  f.setAttribute('scrolling', 'no');
  f.srcdoc = r.doc;
  $('#rpage').replaceChildren(f);
}
/** The list of places that changed, as the last field of the record. Each line goes to its place in the page. */
function drawChanges() {
  const dl = $('#rrec .r-what');
  if (!dl || !rev || !rev.list.length) return;
  $$('.r-chg-k, .r-chg-v', dl).forEach((n) => n.remove());
  const list = rev.all || rev.list.length <= 5 ? rev.list : rev.list.slice(0, 4), more = rev.list.length - list.length;
  const where = (l) => (l.slide ? '<b>Slide ' + l.slide + (l.gone ? ' of the version before' : '') + '</b>' : '') + h(l.heading || (l.slide ? '' : 'Start of the page'));
  dl.insertAdjacentHTML('beforeend', '<dt class="r-chg-k">Changes</dt><dd class="r-chg-v"><ol class="r-chg">'
    + list.map((l) => '<li><button type="button" data-go="' + l.n + '"><span class="c-where">' + where(l) + '</span><span class="c-what">' + h(l.what) + '</span></button></li>').join('')
    + '</ol>' + (more ? '<button type="button" class="r-all" data-all>Show ' + more + ' more</button>' : '') + '</dd>');
}
/** The place of the reader in the changes: the count, the two arrows, and the line of the list. */
function drawCount() {
  if (!rev) return;
  const c = $('#rcount'), n = rev.stops;
  if (c) c.textContent = !rev.on ? 'Version ' + rev.after + ' with no marks' : rev.at ? (rev.deck ? 'Changed slide ' : 'Change ') + rev.at + ' of ' + n : n + (rev.deck ? ' changed slide' : ' change') + (n === 1 ? '' : 's');
  $$('#rstrip [data-step]').forEach((b) => { b.disabled = !rev.on || (b.dataset.step === '-1' ? rev.at <= 1 : rev.at >= n); });
  const here = rev.on && rev.at ? rev.list.filter((l) => l.n <= rev.at).pop() : null;
  $$('#rrec [data-go]').forEach((b) => { if (here && +b.dataset.go === here.n) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
}
const post = (msg) => { const f = $('#rpage iframe[data-rev]'); if (f && f.contentWindow) f.contentWindow.postMessage({ ns: 'ap-diff', ...msg }, '*'); };
/** Goes to change n. From here to the next move of the reader, the scroll is not theirs. */
function goChange(n) {
  byHand = false;
  post({ type: 'go', n, smooth: true });
}
function stepChange(d) {
  if (!rev || !rev.stops || !rev.on) return;
  const n = Math.max(1, Math.min(rev.stops, (rev.at || (d > 0 ? 0 : rev.stops + 1)) + d));
  if (n !== rev.at) goChange(n);
}
function showChanges(on) {
  if (!rev || !rev.stops) return;
  rev.on = on;
  post({ type: 'show', on });
  const b = $('#rstrip [data-show]');
  if (b) b.setAttribute('aria-checked', String(on));
  drawCount();
}
/** The frame cannot scroll, so the review scrolls to the change. The change stops below the tool bar, which stays at the top. */
function reveal(top, height, smooth) {
  const view = $('#rview'), page = $('#rpage');
  if (!view || !page) return;
  const z = zOf(page), y = page.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop + top * z;
  byHand = false;
  view.scrollTo({ top: y - Math.max(64, Math.min(view.clientHeight * 0.25, (view.clientHeight - height * z) / 2)), behavior: smooth && !reduce ? 'smooth' : 'auto' });
}
/** The frame gets the height of its page. */
function fitFrame(height) {
  const page = $('#rpage');
  if (!page || !rev) return;
  rev.height = height;
  page.style.height = Math.ceil(height * zOf(page)) + 'px';
  sendView();
}
// The frame does not see the scroll of the review. This tells it which part of it shows, so it knows the change that the reader is at.
// byHand is false while the review scrolls to a change by itself, so that scroll does not move the reader to another change.
let byHand = true, viewTick = 0;
function sendView() {
  viewTick = 0;
  const view = $('#rview'), page = $('#rpage');
  if (!view || !page || !rev || !rev.stops) return;
  const z = zOf(page);
  post({ type: 'view', top: (view.getBoundingClientRect().top - page.getBoundingClientRect().top) / z, height: view.clientHeight / z, free: byHand });
}
document.addEventListener('scroll', (e) => { if (e.target.id === 'rview' && !viewTick) viewTick = requestAnimationFrame(sendView); }, { passive: true, capture: true });
for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) document.addEventListener(type, (e) => { if (e.target.closest && e.target.closest('#rview')) byHand = true; }, { passive: true, capture: true });
// The frame of the review reports the change that the reader is at, its own height, and the keys that the reader pressed in it.
addEventListener('message', (e) => {
  const f = $('#rpage iframe[data-rev]'), d = e.data, view = $('#rview');
  if (!f || e.source !== f.contentWindow || !d || d.ns !== 'ap-diff' || !rev || !view) return;
  if (d.type === 'ready') sendView();
  else if (d.type === 'at') { rev.at = +d.n || 0; drawCount(); if (typeof d.top === 'number') reveal(d.top, +d.height || 0, !!d.smooth); }
  else if (d.type === 'size') fitFrame(+d.height || 0);
  else if (d.type === 'shift') view.scrollTop += (+d.by || 0) * zOf($('#rpage'));
  else if (d.type === 'key') {
    if (reviewKey(d.key)) return;
    const page = view.clientHeight * 0.85, by = { ' ': d.shift ? -page : page, PageDown: page, PageUp: -page, ArrowDown: 56, ArrowUp: -56 }[d.key];
    byHand = true;
    if (by) view.scrollBy({ top: by, behavior: reduce ? 'auto' : 'smooth' });
    else if (d.key === 'Home' || d.key === 'End') view.scrollTo({ top: d.key === 'Home' ? 0 : view.scrollHeight });
    else if (d.key === 'j' || d.key === 'k') move(d.key === 'j' ? 1 : -1);
    else if (d.key === '/') { $('#q').focus(); $('#q').select(); }
  }
});

/** The versions of the page in the review, newest first, with what made each one. A version that the feed does not hold has its number only. */
function openVersions(btn, viaKey) {
  const pop = $('#pop-ver'), p = rev && pageOf(rev.slug);
  if (!pop || !p) return;
  const rows = [];
  for (let v = p.latest; v >= 1 && rows.length < 80; v--) {
    const i = makerOf(p.slug, v);
    const what = !i ? '' : i.kind === 'request' ? 'Changed by ' + h(actor(i.agent)) : v === 1 ? 'First version' : 'Published';
    rows.push('<button type="button" class="v-item v-vitem"' + (i ? ' data-ev-go="' + h(i.id) + '"' : ' disabled') + (rev.made === v ? ' aria-current="true"' : '') + '><span class="v-num">v' + v + '</span>'
      + '<span class="v-vwhat">' + what + (v === p.latest ? '<span class="v-tag">Latest</span>' : '') + '</span><span class="v-meta">' + (i ? stamp(i.at) : '') + '</span></button>');
  }
  // Restore undoes the change in the review: it stores the version before that change again, as a new version.
  const back = rev.made > 1 ? rev.made - 1 : 0;
  pop.innerHTML = '<div class="v-label">Versions</div><div class="r-verlist">' + rows.join('') + '</div>'
    + (back ? '<div class="v-hr"></div><button type="button" class="v-item c-amber" data-restore="' + back + '" data-next="' + (p.latest + 1) + '">' + svg('undo') + '<span>Restore version ' + back + '</span></button>' : '');
  openPop(btn, pop, viaKey);
}
/**
 * Stores version n again as the newest version. The host has no call for a restore, so this reads the version
 * as the host serves it and publishes that. The host gives each claim with no id an id by its position,
 * and those ids go, so the host can give them again.
 */
async function restoreVersion(slug, n) {
  toast('Restoring version ' + n + '…', 0);
  try {
    const got = await fetch('/raw/' + slug + '/' + n + '?k=' + D.kit);
    if (!got.ok) throw new Error('version ' + n + ' did not load');
    let k = 0;
    const html = (await got.text()).replace(/<section\b[^>]*>/gi, (tag) => (/\sclass\s*=\s*["'][^"']*\bk-claim\b/i.test(tag) ? tag.replace(' id="claim-' + ++k + '"', '') : tag));
    const res = await fetch('/api/pages/' + slug, { method: 'PUT', headers: { 'content-type': 'text/html; charset=utf-8' }, body: html });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || res.statusText);
    toast('Version ' + n + ' is the page again, as version ' + d.version, 3200);
    await poll();
    const made = makerOf(slug, d.version);
    if (made) { place = { ...place, ev: made.id }; history.replaceState(history.state, '', urlOf(place)); markOpened(slug, d.version); }
    render();
  } catch (err) { toast('Could not restore version ' + n + ': ' + err.message, 4200); }
}
if ($('#pop-ver')) $('#pop-ver').addEventListener('click', (e) => {
  const to = e.target.closest('[data-ev-go]');
  if (to) { closePop(); pick(to.dataset.evGo, true); return; }
  const b = e.target.closest('[data-restore]');
  if (!b || !rev) return;
  // The first click says what the restore does. The second click does it.
  if (!b.classList.contains('is-armed')) { b.classList.add('is-armed'); b.querySelector('span').textContent = 'Click again to store version ' + b.dataset.restore + ' as version ' + b.dataset.next; return; }
  closePop();
  restoreVersion(rev.slug, +b.dataset.restore);
});

/** Shows an item in the review. When the reader chose it, the version it made counts as opened. */
function pick(id, byHand) {
  const x = feed.find((i) => i.id === id);
  if (!x) return;
  place = { ...place, ev: id };
  history.replaceState(history.state, '', urlOf(place));
  if (byHand && x.version) markOpened(x.slug, x.version);
  render();
}
/** A narrow window shows one thing at a time: a row opens its item in the place of the list, and Back shows the list again. */
function openItem(id) {
  const x = feed.find((i) => i.id === id);
  if (!x) return;
  listTop = $('#rlist') ? $('#rlist').scrollTop : 0;
  place = { ...place, ev: id };
  history.pushState({ fromList: true }, '', urlOf(place));
  if (x.version) markOpened(x.slug, x.version);
  render();
}
function closeItem() {
  if (history.state && history.state.fromList) { history.back(); return; }
  place = { ...place, ev: '' };
  history.replaceState(null, '', urlOf(place));
  render();
}
let pickTimer;
/** The keyboard moved the selection. The review follows, after a short pause. */
function studySelected(el) {
  if (!el || !el.dataset.ev || !inRoom() || !(roomWide() || place.ev)) return;
  clearTimeout(pickTimer);
  pickTimer = setTimeout(() => pick(el.dataset.ev, true), 140);
}

// A folder in Rooms is narrow. A name that does not fit shows in full when the pointer is on it.
$('#main').addEventListener('mouseover', (e) => {
  const name = ROOMS && e.target.closest('.fo-name');
  if (name) name.title = name.scrollWidth > name.clientWidth ? name.textContent : '';
});

$('#main').addEventListener('click', (e) => {
  const row = e.target.closest('.e-row');
  if (row && inRoom() && plain(e)) { e.preventDefault(); sel = entries().indexOf(row); if (roomWide()) pick(row.dataset.ev, true); else openItem(row.dataset.ev); return; }
  const fil = e.target.closest('[data-filter]');
  if (fil) { e.stopPropagation(); openFilter(fil, e.detail === 0); return; }
  const srt = e.target.closest('[data-sort-menu]');
  if (srt) { e.stopPropagation(); openSort(srt, e.detail === 0); return; }
  if (e.target.closest('[data-clear]')) { setFilters({ type: '', mod: '', in: '', acc: '' }); const c = e.detail === 0 && $('#main .d-chip'); if (c) c.focus(); return; }
  const col = e.target.closest('[data-sort]');
  if (col) {
    const k = col.dataset.sort;
    setOrder(k === order.sort ? { sort: k, dir: order.dir === 'asc' ? 'desc' : 'asc' } : { sort: k, dir: Drive.sortOf(k).first });
    const again = e.detail === 0 && $('#main [data-sort="' + k + '"]');
    if (again) again.focus();
    return;
  }
  const lay = e.target.closest('[data-layout-of]');
  if (lay) { setLayout(lay.dataset.layoutOf); const again = e.detail === 0 && $('#main [data-layout-of="' + view + '"]'); if (again) again.focus(); return; }
  if (e.target.closest('[data-all-pages]')) { allOf = viewKey(); render(); return; }
  const lens = e.target.closest('[data-lens]');
  if (lens) { place = { ...place, lens: lens.dataset.lens }; history.replaceState(null, '', urlOf(place)); sel = -1; render(); return; }
  const only = e.target.closest('[data-only]');
  if (only) { place = { ...place, only: only.dataset.only, ev: '' }; history.replaceState(null, '', urlOf(place)); sel = -1; render(); return; }
  if (e.target.closest('[data-scope-off]')) { go({ list: 'activity', only: place.only }); return; }
  const room = e.target.closest('[data-room]');
  if (room) { go({ list: 'activity', af: room.dataset.room }); return; }
  if (e.target.closest('[data-back]')) { closeItem(); return; }
  const to = e.target.closest('[data-go]');
  if (to && rev) { if (!rev.on) showChanges(true); goChange(+to.dataset.go); return; }
  const st = e.target.closest('[data-step]');
  if (st) { stepChange(+st.dataset.step); return; }
  if (e.target.closest('[data-show]')) { showChanges(!(rev && rev.on)); return; }
  if (e.target.closest('[data-all]') && rev) { rev.all = true; drawChanges(); drawCount(); return; }
  const ev = e.target.closest('[data-ev-go]');
  if (ev) { pick(ev.dataset.evGo, true); return; }
  const vers = e.target.closest('[data-vers]');
  if (vers) { e.stopPropagation(); openVersions(vers, e.detail === 0); }
});
/** The keys of the review. The frame sends its keys here too, so they work wherever the focus is. */
function reviewKey(key) {
  if (key === 'n') stepChange(1);
  else if (key === 'N') stepChange(-1);
  else if (key === 's') showChanges(!(rev && rev.on));
  else if (key === 'Escape' && !roomWide() && place.ev) closeItem();
  else return false;
  return true;
}
// This listener runs before the keys of the library, so that Enter can open a row in the place of the list.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || open || !inRoom() || e.target.closest('input, textarea, select, [contenteditable]')) return;
  if ((e.key === 'Enter' || e.key === 'o') && !roomWide() && !place.ev && !e.target.closest('button')) {
    const el = e.target.closest('.e-row') || entries()[sel];
    if (el && el.dataset.ev) { e.preventDefault(); e.stopPropagation(); openItem(el.dataset.ev); }
    return;
  }
  if (reviewKey(e.key)) e.preventDefault();
}, true);
// A new theme and a new width draw the review again.
$$('[data-theme-set]').forEach((b) => b.addEventListener('click', () => { if ($('#rview')) render(); }));
addEventListener('resize', () => { if (inRoom()) render(); });

// ─── Keep the list true. While a run is in work, ask the host every 4 seconds. ───
let pollTimer, lastPoll = 0;
async function poll() {
  clearTimeout(pollTimer);
  lastPoll = Date.now();
  try {
    const r = await fetch('/api/activity');
    if (r.ok) {
      const d = await r.json();
      const sig = () => JSON.stringify([feed, pages.map((p) => [p.slug, p.latest, p.thumb, p.updated_at, p.title])]);
      const was = sig();
      feed = d.activity;
      for (const n of d.pages) { const p = pageOf(n.slug); if (p) Object.assign(p, { latest: n.latest, thumb: n.thumb, updated_at: n.updated_at, title: n.title, kind: n.kind, shared: n.shared }); else pages.push(n); }
      for (let i = pages.length - 1; i >= 0; i--) if (!d.pages.some((n) => n.slug === pages[i].slug)) pages.splice(i, 1);
      // A popover or a drag holds on to elements of the list, so the redraw waits for the next round.
      if (sig() !== was && !open && !dragSlug && !hits) render();
    }
  } catch {}
  if (feed.some((x) => x.kind === 'request' && x.state === 'working')) pollTimer = setTimeout(poll, 4000);
}
if (feed.some((x) => x.kind === 'request' && x.state === 'working')) pollTimer = setTimeout(poll, 4000);
addEventListener('focus', () => { if (Date.now() - lastPoll > 10000) poll(); });
// An address with a search text shows that search again.
if (ROOMS) { const text = new URLSearchParams(location.search).get('q'); if (text) { $('#q').value = text; runSearch(); } }
