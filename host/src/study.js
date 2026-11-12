
// ─── The layout study: Rooms and Ledger ─────────────────────────────
// This file joins the library script, so it uses the helpers and the state of that script.
// D.activity lists what happened to the pages, newest first: publishes, requests to an assistant, and notes.
// Rooms: Activity is a place. The list of changes is on the left and the page itself is on the right.
// Ledger: each page row shows its latest change, and one switch turns the list into the log.

const LAYOUT = D.layout;
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
    if (p.list !== 'activity') return p;
    return { list: 'activity', af: folders.some((f) => f.id === af) ? af : '', only: u.get('only') === 'waiting' ? 'waiting' : '', ev: u.get('e') || '' };
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
// A link to a page marks the page as opened. A row in the room does not: it shows the page in the room.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="/p/"]');
  if (!a || (a.closest('.e-row') && roomWide() && plain(e))) return;
  const m = a.getAttribute('href').match(/^\/p\/([a-z0-9-]+\/[a-z0-9-]+)/);
  const p = m && pageOf(m[1]);
  if (p && markOpened(p.slug, p.latest)) setTimeout(render, 0);
}, true);
// The back button can show this document again from the cache. The viewer records what it showed, so read it again.
addEventListener('pageshow', (e) => { if (e.persisted) { loadOpened(); render(); poll(); } });

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
const markOf = (p) => { const n = newsOf(p); return n ? MARKS[n.kind]() : ''; };
/** A folder that is closed shows the strongest mark of the pages in it. */
function folderMark(f) {
  const kinds = new Set(pagesUnder(f.id).map((p) => (newsOf(p) || {}).kind));
  const k = ['work', 'failed', 'question', 'new'].find((x) => kinds.has(x));
  return k ? MARKS[k]() : '';
}
const sidePage = (p, d) => '<a class="l-nav s-page" href="' + pageHref(p, newsOf(p)) + '" style="--d:' + d + '" title="' + h(p.title) + '">' + icn(p.kind === 'deck' ? 'deck' : 'file') + '<span class="s-name">' + h(p.title) + '</span>' + markOf(p) + '</a>';

function studySide() {
  digest();
  const here = place.folder, outline = LAYOUT === 'ledger';
  pathOf(here).forEach((f) => f.id !== here && expanded.add(f.id));
  $('#scroll').classList.toggle('is-room', !hits && place.list === 'activity');
  $('.h-tools .v-seg').style.display = outline || place.list === 'activity' ? 'none' : '';
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
/** The card of the grid. A page that has news says it in the place of its folder and date. The share mark stays. The kind gives its space to the news. */
function sCard(p) {
  const n = newsOf(p);
  const sub = shared(p) + (n ? (n.item ? news(n.item, 'card', n.kind === 'work' ? '' : ', ' + ago(n.item.at)) : newsLine(' is-new', icn('upload'), 'New version', ', ' + ago(p.updated_at)))
    : kind(p) + '<span>' + h(place.folder ? 'Published ' + ago(p.updated_at) : where(p) + ', ' + ago(p.updated_at)) + '</span>');
  return '<article class="h-card' + (n ? ' has-news' : '') + '" data-slug="' + p.slug + '" draggable="true"><a class="h-link" href="' + pageHref(p, n) + '" draggable="false">'
    + thumb(p, Math.min(2, p.latest - 1)) + '<span class="h-title">' + h(p.title) + '</span><span class="h-sub">' + sub + '</span></a>' + menu(p) + '</article>';
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
const pageBlock = (title, list, more) => '<section class="l-block"><div class="l-head"><h2>' + title + '</h2>' + (more || '') + '</div>'
  + (view === 'grid' ? '<div class="h-grid">' + list.map(sCard).join('') + '</div>' : '<div class="g-list">' + list.map(gRow).join('') + '</div>') + '</section>';
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
  const top = childrenOf(null), all = [...pages].sort(byLast);
  const known = feed.filter((x) => pageOf(x.slug));
  if (place.folder) {
    const f = folderOf(place.folder), kids = childrenOf(f.id), here = pages.filter((p) => p.folder_id === f.id), under = pagesUnder(f.id);
    const slugs = new Set(under.map((p) => p.slug)), events = known.filter((x) => slugs.has(x.slug));
    const newest = under.map((p) => p.updated_at).sort().pop();
    document.title = f.name + ' – Pages';
    main.innerHTML = '<div class="l-title"><h1>' + h(f.name) + '</h1><button type="button" class="v-icon" data-edit="' + f.id + '" aria-label="Edit folder" data-tip="Edit folder" aria-expanded="false">' + svg('pencil') + '</button>'
      + '<p>' + under.length + (under.length === 1 ? ' page' : ' pages') + (newest ? ', last published ' + ago(newest) : '') + '</p>'
      + (LAYOUT === 'rooms' && events.length ? '<button type="button" class="l-act" data-room="' + f.id + '">' + icn('activity') + 'Activity in this folder</button>' : '') + '</div>'
      + (kids.length ? folderBlock(kids, 'Folders') : '')
      + (LAYOUT === 'ledger' && under.length ? lensBlock(here, events, 200)
        : here.length ? pageBlock('Pages', here.sort(byLast))
        : kids.length ? '' : '<div class="l-empty"><b>This folder is empty</b><span>Drag a page here, or choose Move to folder from a page’s menu.</span></div>');
    return;
  }
  document.title = 'Pages';
  if (place.list === 'activity') return roomView(main, known);
  if (place.list === 'home') {
    main.innerHTML = (top.length ? folderBlock(top, 'Folders') : '')
      + (LAYOUT === 'ledger' ? lensBlock(pages, known, 24) : pageBlock('Recent', all.slice(0, 12), all.length > 12 ? seeAll(all.length) : ''));
    return;
  }
  const lists = {
    recent: ['Recent', all, ''],
    pinned: ['Pinned', all.filter((p) => p.pinned_at), '<div class="l-empty"><b>No pinned pages</b><span>Pin a page from its menu, or press p.</span></div>'],
    shared: ['Shared by link', all.filter((p) => p.shared), '<div class="l-empty"><b>No shared pages</b><span>A page shows here once it has a share link.</span></div>'],
    unfiled: ['Not in a folder', all.filter((p) => !p.folder_id), '<div class="l-empty"><b>Every page is in a folder</b><span>A page that an agent publishes shows here until you move it.</span></div>'],
  };
  const [title, list, empty] = lists[place.list];
  main.innerHTML = list.length ? (LAYOUT === 'ledger' ? '<section class="l-block"><div class="l-head"><h2>' + title + '</h2></div><div class="g-list">' + list.map(gRow).join('') + '</div></section>' : pageBlock(title, list)) : empty;
}

// ─── The room: Activity in Rooms ───
const roomWide = () => LAYOUT === 'rooms' && place.list === 'activity' && matchMedia('(min-width: 1121px)').matches;
function eRow(x, cur) {
  const p = pageOf(x.slug), l = look(x);
  return '<article class="e-row' + l.cls + (fresh(x) ? ' is-fresh' : '') + (cur && cur.id === x.id ? ' is-cur' : '') + '" data-slug="' + p.slug + '" data-ev="' + h(x.id) + '"><a class="e-link" href="' + itemHref(x) + '">'
    + '<span class="e-g">' + glyph(x) + '</span><span class="e-title">' + h(p.title) + '</span><span class="e-when">' + clock(x.at) + '</span><span class="e-line">' + say(x, 'event') + '</span></a></article>';
}
let roomList = [];
function roomView(main, known) {
  let list = known;
  if (place.af) { const slugs = new Set(pagesUnder(place.af).map((p) => p.slug)); list = list.filter((x) => slugs.has(x.slug)); }
  const mine = list.filter(fresh).length;
  if (place.only) list = list.filter((x) => fresh(x) || x.state === 'working');
  roomList = list;
  if (!$('#room')) { main.innerHTML = '<div class="r" id="room"><section class="r-list" id="rlist" aria-label="Activity"></section><section class="r-view" id="rview" aria-label="The page"></section></div>'; shown = ''; }
  const cur = list.find((x) => x.id === place.ev) || list[0] || null;
  const f = place.af && folderOf(place.af);
  const head = '<div class="r-head"><div class="g-tabs" role="tablist" aria-label="Show">'
    + '<button type="button" role="tab" data-only="" aria-selected="' + !place.only + '">All</button>'
    + '<button type="button" role="tab" data-only="waiting" aria-selected="' + !!place.only + '">For you' + (mine ? '<span class="s-count">' + mine + '</span>' : '') + '</button></div>'
    + (f ? '<button type="button" class="r-scope" data-scope-off aria-label="Show every folder"><span>' + h(f.name) + '</span>' + icn('x') + '</button>' : '') + '</div>';
  $('#rlist').innerHTML = head + (list.length ? byDay(list, (x) => eRow(x, roomWide() ? cur : null), 'r-day') : '<p class="g-none">' + (place.only ? 'Nothing waits for you.' : 'Nothing happened yet.') + '</p>');
  drawPage(cur);
}
// What the right side shows now: the item, its state, its versions and the theme. The same key keeps the frames, so a redraw does not load the page again.
let shown = '', side = 'after', dwell;
const zoom = new ResizeObserver((list) => list.forEach((e) => e.target.style.setProperty('--z', Math.min(1, e.contentRect.width / 860).toFixed(4))));
const pageFrame = (slug, n, anchor, which, title) => '<iframe class="r-frame' + (which === side ? '' : ' is-off') + '" data-side="' + which + '" title="' + h(title) + '" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" src="/raw/' + slug + '/' + n + '?k=' + D.kit + (theme === 'auto' ? '' : '&theme=' + theme) + (anchor ? '#' + encodeURIComponent(anchor) : '') + '"></iframe>';
function talk(x) {
  const rows = [];
  const on = x.quote ? '<small>On “' + h(x.quote) + '”</small>' : '';
  if (x.kind === 'request') {
    rows.push([person(x.author), h(x.ask) + on]);
    const a = actor(x.agent);
    if (x.state === 'working') rows.push([a, 'Working.<small>Started at ' + clock(x.started) + '. The new version shows here when it is ready.</small>']);
    else if (x.state === 'changed') rows.push([a, h(x.reply || 'Changed the page.') + '<small>Version ' + x.version + ', ready after ' + took(x) + '</small>']);
    else if (x.state === 'replied') rows.push([a, h(x.reply || 'Made no change.') + '<small>The page did not change.' + (x.open ? ' Answer in the comments of the page.' : '') + '</small>']);
    else rows.push([a, '<span class="is-warn c-red">' + (x.cause === 'not_connected' ? a + ' is not connected, so the request did not run.' : x.cause === 'timeout' ? 'The run did not finish in time.' : 'The run did not finish.') + '</span><small>'
      + (x.cause === 'not_connected' ? 'Connect ' + a + ', then write the comment again.' : 'Write the comment again to try once more.') + '</small>']);
  } else if (x.kind === 'note') {
    rows.push([person(x.author), h(x.body) + on + (x.replies ? '<small>' + x.replies + (x.replies === 1 ? ' reply' : ' replies') + '</small>' : '')]);
  } else {
    rows.push([x.first ? 'Published' : 'Version ' + x.version, new Date(x.at).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })]);
  }
  return '<dl class="r-talk">' + rows.map((r) => '<dt>' + h(r[0]) + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>';
}
function drawPage(x) {
  const el = $('#rview');
  if (!el) return;
  // A narrow window has no space for the page, so it does not load it.
  if (!roomWide()) { shown = ''; el.innerHTML = ''; return; }
  if (!x) { shown = ''; el.innerHTML = '<p class="r-none">Choose a change to see its page.</p>'; return; }
  const p = pageOf(x.slug);
  // A change has the version before it and the version it made. Each other item shows the page as it is now.
  const after = x.version || p.latest, before = x.version && x.version > 1 ? (x.kind === 'request' ? Math.min(x.from, x.version - 1) : x.version - 1) : 0;
  const key = [x.id, x.state || '', after, before, theme].join('|');
  if (key === shown) return;
  if (shown.split('|')[0] !== x.id) side = 'after';
  shown = key;
  el.innerHTML = '<header class="r-top"><div class="r-id"><h1>' + h(p.title) + '</h1>' + whereChip(p) + '</div><div class="r-acts">'
    + (before ? '<div class="v-seg" role="group" aria-label="Version"><button type="button" data-side="before" aria-pressed="' + (side === 'before') + '" data-tip="Version ' + before + '">Before</button><button type="button" data-side="after" aria-pressed="' + (side === 'after') + '" data-tip="Version ' + after + '">After</button></div>' : '')
    + '<a class="r-open" href="' + itemHref(x) + '">Open page' + icn('arrowUpRight') + '</a></div></header>' + talk(x)
    + '<div class="r-stage" id="rstage" data-slug="' + p.slug + '" data-before="' + before + '" data-anchor="' + h(x.anchor || '') + '">' + pageFrame(p.slug, after, x.anchor, 'after', p.title) + '</div>';
  zoom.disconnect();
  zoom.observe($('#rstage'));
  // A change that shows here for 2 seconds counts as opened, as a message in a mail program counts as read.
  clearTimeout(dwell);
  if (x.version > seenVersion(x.slug)) dwell = setTimeout(() => {
    if (shown === key && $('#rstage') && document.visibilityState === 'visible' && markOpened(x.slug, x.version)) render();
  }, 2000);
}
/** Before and After change the frame that shows. The Before frame loads when the reader first asks for it. */
function setSide(which) {
  const stage = $('#rstage');
  if (!stage || !+stage.dataset.before) return;
  side = which;
  if (which === 'before' && !$('.r-frame[data-side="before"]', stage)) stage.insertAdjacentHTML('beforeend', pageFrame(stage.dataset.slug, stage.dataset.before, stage.dataset.anchor, 'before', 'The version before'));
  $$('.r-frame', stage).forEach((f) => f.classList.toggle('is-off', f.dataset.side !== which));
  $$('#rview [data-side]:not(iframe)').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.side === which)));
}
/** Shows an item in the room. When the reader chose it, the version it made counts as opened. */
function pick(id, byHand) {
  const x = roomList.find((i) => i.id === id);
  if (!x) return;
  place = { ...place, ev: id };
  history.replaceState(null, '', urlOf(place));
  if (byHand && x.version) markOpened(x.slug, x.version);
  render();
}
let pickTimer;
/** The keyboard moved the selection. In the room the page follows, after a short pause. */
function studySelected(el) {
  if (!el || !el.dataset.ev || !roomWide()) return;
  clearTimeout(pickTimer);
  pickTimer = setTimeout(() => pick(el.dataset.ev, true), 140);
}

$('#main').addEventListener('click', (e) => {
  const row = e.target.closest('.e-row');
  if (row && roomWide() && plain(e)) { e.preventDefault(); sel = entries().indexOf(row); pick(row.dataset.ev, true); return; }
  const lens = e.target.closest('[data-lens]');
  if (lens) { place = { ...place, lens: lens.dataset.lens }; history.replaceState(null, '', urlOf(place)); sel = -1; render(); return; }
  const only = e.target.closest('[data-only]');
  if (only) { place = { ...place, only: only.dataset.only, ev: '' }; history.replaceState(null, '', urlOf(place)); sel = -1; render(); return; }
  if (e.target.closest('[data-scope-off]')) { go({ list: 'activity', only: place.only }); return; }
  const room = e.target.closest('[data-room]');
  if (room) { go({ list: 'activity', af: room.dataset.room }); return; }
  const s = e.target.closest('button[data-side]');
  if (s) setSide(s.dataset.side);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'b' || !plain(e) || open || !roomWide() || e.target.closest('input, textarea, select, [contenteditable]')) return;
  setSide(side === 'after' ? 'before' : 'after');
});
// A new theme draws the page in the room again.
$$('[data-theme-set]').forEach((b) => b.addEventListener('click', () => { if ($('#rview')) render(); }));
addEventListener('resize', () => { if (place.list === 'activity' && !hits) render(); });

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
