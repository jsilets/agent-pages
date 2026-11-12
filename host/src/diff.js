// @ts-check
// The diff of two versions of a page. Activity uses it to show a change in the page itself.
// It reads both versions as text and needs no DOM, so the browser and the tests run the same code.
// library.ts puts this file into the library script. The tests import it as a module.
//
// How it works:
// 1. parse() reads the HTML into a tree. It keeps each tag and each text as written.
// 2. align() pairs the blocks of the two trees: equal blocks, blocks that changed, and blocks that only one version has.
// 3. block() and kids() give the newer version back with marks:
//    <ins data-diff> and <del data-diff> stand around the words of a text block that changed.
//    data-diff="mod" is a block with marks in it.
//    data-diff="add" and data-diff="del" are a new block and a removed block.
//    data-diff="obj" is a part that draws differently: an image, a diagram, or an element with other attributes.
//    data-diff="to" is a block that moved to this place.
//    data-diff-n numbers the changes in the order of the page. The reader steps from number to number.
// With { review: true }, long stretches with no change fold (data-diff-gap is the bar, data-diff-skip is a folded
// block), and a deck shows each slide as a sheet (data-diff-sheet).

/** @typedef {{ t: 'text', s: string }} Txt */
/** @typedef {{ t: 'raw', s: string }} Raw  A comment, a doctype or an end tag with no start. It stays as written. */
/** @typedef {{ parts: Part[], tail: string }} Split  The parts of a block, and what stands after the last part. */
/**
 * @typedef {object} El
 * @property {'el'} t
 * @property {string} tag
 * @property {string} open   The start tag as written.
 * @property {string} close  The end tag as written, or '' when the source has none.
 * @property {Nd[]} kids
 * @property {string} [kind]
 * @property {string} [sig]
 * @property {string} [own]
 * @property {string[]} [cls]
 * @property {Split} [split]
 * @property {Split | null} [cells]
 */
/** @typedef {Txt | Raw | El} Nd */
/**
 * One child of a block, for the alignment: an element, or a run of text and inline elements between two blocks.
 * @typedef {object} Part
 * @property {El | null} el   The element. null for a run.
 * @property {Nd[]} nodes
 * @property {string} tag     The tag, 'h' for each heading, or '#run'.
 * @property {string} lead    What stands before the part in the source: white space, comments and scripts.
 * @property {string} sig
 * @property {string[]} [words]
 */
/**
 * @typedef {{ type: 'same', a: Part, b: Part }
 *   | { type: 'mod', a: Part, b: Part, sub?: Op[] }
 *   | { type: 'add', b: Part, twin?: Op }
 *   | { type: 'del', a: Part, twin?: Op }} Op
 */
/**
 * One change, for the list in the review.
 * @typedef {object} Change
 * @property {number} n        The number of its mark: data-diff-n in the HTML. The cells of one table row share a number.
 * @property {'add' | 'del' | 'mod' | 'obj' | 'move'} kind
 * @property {string} noun     What changed: 'paragraph', 'heading', 'item', 'cell', 'chart', 'slide' and so on.
 * @property {string} heading  The heading of the place: the nearest heading before the change, or the heading of its block.
 * @property {number} level    The level of that heading, 1 to 6, or 0.
 * @property {number} slide    The number of the slide, or 0 for a document. A removed slide has its old number.
 * @property {string} text     The new words. For a block that is new, removed or moved, its text.
 * @property {string} was      The words that the change removed. For a slide that moved, 'Slide 2'.
 */
/**
 * @typedef {object} Ctx
 * @property {boolean} review
 * @property {number} n
 * @property {number} gaps
 * @property {Change[]} changes
 * @property {string} heading
 * @property {number} level
 * @property {number} slide
 * @property {number} group        The number that the blocks of a sheet or of a table row share, or 0.
 * @property {string[] | null} out In the review of a deck: the text of the blocks that the current slide lost.
 * @property {string} lift         The noun of a drawn part that changed and that no mark holds yet.
 */

// ─── 1. Read the HTML ───────────────────────────────────────────────

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** The content of these elements is not markup, or it is a drawing. The parser keeps it as one piece. */
const OPAQUE = new Set(['script', 'style', 'textarea', 'title', 'template', 'noscript', 'svg', 'math']);
const INLINE = new Set('a abbr b bdi bdo big br cite code data del dfn em font i ins kbd label mark output q rp rt ruby s samp small span strike strong sub sup time tt u var wbr'.split(' '));
/** Elements that the diff compares as a whole. It never marks words inside them. */
const ATOM = new Set('audio button canvas embed iframe img input math meter object picture progress select svg textarea video'.split(' '));
const UNSEEN = new Set(['script', 'style', 'template', 'noscript', 'title', 'link', 'meta', 'base', 'head']);
const ENDS_P = new Set('address article aside blockquote details div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul'.split(' '));
/** A <br> and the <small> of the kit start a new line, so the text has a space there. */
const BREAKS = new Set(['br', 'small']);
const TAG = /<(\/?)([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/y;

/**
 * Closes the open elements that a start tag ends, as a browser does: a paragraph before a block,
 * a list item before the next one, a table cell before the next one.
 * @param {El[]} stack
 * @param {string} tag
 */
function implied(stack, tag) {
  /** @param {string[]} names @param {(t: string) => boolean} wall */
  const close = (names, wall) => {
    for (let d = stack.length - 1; d > 0; d--) {
      const t = stack[d].tag;
      if (names.includes(t)) { stack.length = d; return; }
      if (wall(t)) return;
    }
  };
  const soft = (/** @type {string} */ t) => INLINE.has(t) || t === 'p' || t === 'div' || t === 'address';
  if (ENDS_P.has(tag)) close(['p'], (t) => !INLINE.has(t));
  if (tag === 'li') close(['li'], (t) => !soft(t));
  else if (tag === 'dt' || tag === 'dd') close(['dt', 'dd'], (t) => !soft(t));
  else if (tag === 'tr') close(['tr'], (t) => t === 'table');
  else if (tag === 'td' || tag === 'th') close(['td', 'th'], (t) => t === 'tr' || t === 'table');
  else if (tag === 'tbody' || tag === 'thead' || tag === 'tfoot') close(['tbody', 'thead', 'tfoot'], (t) => t === 'table');
  else if (tag === 'option') close(['option'], (t) => t === 'select');
  else if (tag === 'body') close(['head'], () => false);
}

/**
 * The end of an opaque element: where its end tag starts and where it stops. An <svg> can hold an <svg>.
 * @param {string} html
 * @param {string} tag
 * @param {number} from
 * @returns {[number, number]}
 */
function endOf(html, tag, from) {
  const re = new RegExp('<(/?)' + tag + '\\b(?:"[^"]*"|\'[^\']*\'|[^>"\'])*>', 'gi');
  re.lastIndex = from;
  const nests = tag === 'svg' || tag === 'math';
  let depth = 1;
  for (let m; (m = re.exec(html)); ) {
    if (m[1]) { if (--depth === 0) return [m.index, m.index + m[0].length]; }
    else if (nests && !/\/\s*>$/.test(m[0])) depth++;
  }
  return [html.length, html.length];
}

/**
 * Reads HTML into a tree. The tree gives the same text back when no block changed.
 * @param {string} html
 * @returns {El}
 */
function parse(html) {
  /** @type {El} */
  const root = { t: 'el', tag: '#root', open: '', close: '', kids: [] };
  const stack = [root];
  /** @param {Nd} n */
  const push = (n) => {
    const kids = stack[stack.length - 1].kids, last = kids[kids.length - 1];
    if (n.t === 'text' && last && last.t === 'text') last.s += n.s; else kids.push(n);
  };
  for (let i = 0; i < html.length; ) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { push({ t: 'text', s: html.slice(i) }); break; }
    if (lt > i) push({ t: 'text', s: html.slice(i, lt) });
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt + 4), end = e < 0 ? html.length : e + 3;
      push({ t: 'raw', s: html.slice(lt, end) }); i = end; continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const e = html.indexOf('>', lt), end = e < 0 ? html.length : e + 1;
      push({ t: 'raw', s: html.slice(lt, end) }); i = end; continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(html);
    // A "<" that starts no tag is text.
    if (!m) { push({ t: 'text', s: '<' }); i = lt + 1; continue; }
    i = lt + m[0].length;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      let d = stack.length - 1;
      while (d > 0 && stack[d].tag !== tag) d--;
      if (d > 0) { stack[d].close = m[0]; stack.length = d; } else push({ t: 'raw', s: m[0] });
      continue;
    }
    implied(stack, tag);
    /** @type {El} */
    const el = { t: 'el', tag, open: m[0], close: '', kids: [] };
    push(el);
    if (VOID.has(tag)) continue;
    if (OPAQUE.has(tag)) {
      const [at, end] = endOf(html, tag, i);
      if (at > i) el.kids.push({ t: 'raw', s: html.slice(i, at) });
      el.close = html.slice(at, end);
      i = end;
      continue;
    }
    stack.push(el);
  }
  return root;
}

/** @param {Nd} n @returns {string} */
const ser = (n) => (n.t === 'el' ? n.open + n.kids.map(ser).join('') + n.close : n.s);
/** @param {El} el */
const innerHtml = (el) => el.kids.map(ser).join('');

/** The <body> of a document. A fragment has none, so the root holds the content. @param {El} root */
function bodyOf(root) {
  for (const c of root.kids) {
    if (c.t !== 'el') continue;
    if (c.tag === 'body') return c;
    if (c.tag === 'html') for (const d of c.kids) if (d.t === 'el' && d.tag === 'body') return d;
  }
  return root;
}

/** The document before and after the content of its body. @param {El} root @param {El} body @returns {[string, string]} */
function shell(root, body) {
  if (root === body) return ['', ''];
  const MARK = '\u0000body\u0000';
  /** @param {Nd} n @returns {string} */
  const walk = (n) => (n === body ? body.open + MARK + body.close : n.t === 'el' ? n.open + n.kids.map(walk).join('') + n.close : n.s);
  const [head, tail] = root.kids.map(walk).join('').split(MARK);
  return [head, tail || ''];
}

// ─── What a node is, and what it holds ──────────────────────────────

/** True for a <script> that holds data, such as the text of a flow diagram. The kit draws from it, so a change in it is a change in the page. @param {El} n */
const isData = (n) => { const m = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(n.open); return !!m && !/^(?:module|importmap|(?:text|application)\/(?:java|ecma)script)$/i.test(m[1]); };

/**
 * 'skip': the diff never compares it. 'space': white space. 'text'. 'atom': compared as a whole.
 * 'inline': a part of a line of text. 'block': everything else.
 * @param {Nd} n
 * @returns {string}
 */
function kindOf(n) {
  if (n.t === 'raw') return 'skip';
  if (n.t === 'text') return /\S/.test(n.s) ? 'text' : 'space';
  if (n.kind) return n.kind;
  let k = 'block';
  if (n.tag === 'script') k = isData(n) ? 'atom' : 'skip';
  else if (UNSEEN.has(n.tag)) k = 'skip';
  else if (ATOM.has(n.tag)) k = 'atom';
  else if (INLINE.has(n.tag) && !n.kids.some((c) => kindOf(c) === 'block')) k = 'inline';
  return (n.kind = k);
}
/** @param {Nd} n */
const isTrivia = (n) => { const k = kindOf(n); return k === 'space' || k === 'skip'; };
/** True for an element that holds a block. Its children align one by one. @param {El} el */
const blocky = (el) => el.kids.some((c) => kindOf(c) === 'block');

/** The attributes of an element as one string, without the id. The id names a place. It does not change the look. @param {El} n */
function ownOf(n) {
  if (n.own !== undefined) return n.own;
  let out = '';
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  re.lastIndex = n.tag.length + 1;
  for (let m; (m = re.exec(n.open)); ) if (m[1].toLowerCase() !== 'id') out += ' ' + m[1].toLowerCase() + '=' + (m[2] ?? m[3] ?? m[4] ?? '');
  return (n.own = out);
}
/** The id that the author gave. The host adds claim-<n> and the kit adds slide-<n> by position, so those name nothing. @param {El} n */
function idOf(n) {
  const m = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(n.open);
  const id = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
  return /^(?:claim|slide)-\d+$/.test(id) ? '' : id;
}
/** @param {El} n @param {string} name */
function hasClass(n, name) {
  if (!n.cls) { const m = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(n.open); n.cls = (m ? (m[1] ?? m[2] ?? m[3] ?? '') : '').split(/\s+/); }
  return n.cls.includes(name);
}

/** A short hash of a string: two 32-bit hashes in base 36. @param {string} s */
function hash(s) {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b) + 0x1b873593 | 0;
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/** The content of a list of nodes as one string. White space counts as one space. @param {Nd[]} nodes @param {boolean} blocks */
function inner(nodes, blocks) {
  let s = '';
  for (const c of nodes) {
    if (c.t === 'text') s += blocks && kindOf(c) === 'space' ? '' : c.s;
    else if (c.t === 'el') s += '\u0002' + sigOf(c) + '\u0003';
  }
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * The signature of a node. Two nodes with the same signature show the same thing.
 * @param {Nd} n
 * @returns {string}
 */
function sigOf(n) {
  if (n.t !== 'el') return '';
  if (n.sig !== undefined) return n.sig;
  let s = '';
  if (kindOf(n) !== 'skip') {
    const body = OPAQUE.has(n.tag) ? n.kids.map((c) => (c.t === 'raw' ? c.s : '')).join('').replace(/\s+/g, ' ').trim() : inner(n.kids, blocky(n));
    s = hash(n.tag + ownOf(n) + '\u0001' + body);
  }
  return (n.sig = s);
}

const WORDS = /[\p{L}\p{N}]+(?:[.,'’:/_-][\p{L}\p{N}]+)*/gu;
/** The words of a list of nodes, for the measure of how alike two blocks are. A drawn part counts as one word. @param {Nd[]} nodes @param {string[]} out */
function gather(nodes, out) {
  for (const n of nodes) {
    if (n.t === 'text') { const m = n.s.match(WORDS); if (m) for (const w of m) out.push(w); }
    else if (n.t === 'el') { const k = kindOf(n); if (k === 'atom') out.push('\u0000' + sigOf(n)); else if (k !== 'skip') gather(n.kids, out); }
  }
  return out;
}
/** @param {Part} p */
const wordsOf = (p) => (p.words ??= gather(p.nodes, []));

const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi;
/** @type {Record<string, string>} */
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Text as a reader sees it, on one line. @param {string} s */
const plain = (s) => s.replace(ENTITY, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : NAMED[e.toLowerCase()] ?? m)).replace(/\s+/g, ' ').trim();
/** The text of a list of nodes as a reader sees it, on one line. @param {Nd[]} nodes */
function textOf(nodes) {
  let s = '';
  /** @param {Nd[]} list */
  const walk = (list) => {
    for (const n of list) {
      if (n.t === 'text') s += n.s;
      else if (n.t === 'el') {
        const k = kindOf(n);
        if (k === 'atom' || k === 'skip') continue;
        const gap = k === 'block' || BREAKS.has(n.tag);
        if (gap) s += ' ';
        walk(n.kids);
        if (gap) s += ' ';
      }
    }
  };
  walk(nodes);
  return plain(s);
}
/** @param {string} s */
const esc = (s) => s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
/** Adds attributes at the end of a start tag. @param {string} open @param {string} attr */
const withAttr = (open, attr) => open.replace(/(\s*\/)?>$/, ' ' + attr + '$1>');

/** @type {Record<string, string>} */
const NOUN = { p: 'paragraph', li: 'item', td: 'cell', th: 'cell', tr: 'row', table: 'table', figure: 'figure', figcaption: 'caption', section: 'section', article: 'section', blockquote: 'quote', pre: 'code block', ul: 'list', ol: 'list', summary: 'label' };
/** The word for a block in the list of changes. @param {El | null} el */
function nounOf(el) {
  if (!el) return 'text';
  if (hasClass(el, 'k-slide')) return 'slide';
  if (/^h[1-6]$/.test(el.tag)) return 'heading';
  if (hasClass(el, 'k-flow') || hasClass(el, 'k-diagram') || hasClass(el, 'mermaid')) return 'diagram';
  if (hasClass(el, 'k-bars') || hasClass(el, 'k-stats') || hasClass(el, 'k-scale') || hasClass(el, 'k-model')) return 'chart';
  if (hasClass(el, 'k-card')) return 'card';
  return NOUN[el.tag] || 'part';
}
/** The word for a drawn part that changed. A data script draws its parent, so the parent names it. @param {string} tag */
const atomNoun = (tag) => (tag === 'img' || tag === 'picture' ? 'image' : tag === 'svg' || tag === 'canvas' || tag === 'math' ? 'diagram' : tag === 'script' ? '' : tag === 'video' || tag === 'audio' ? 'recording' : 'control');
/** @param {string} noun @param {number} n */
const count = (noun, n) => n + ' ' + (n === 1 ? noun : noun + 's');

/**
 * The parts of a block: its block children, and the runs of text between them.
 * @param {El} el
 * @returns {Split}
 */
function partsOf(el) {
  if (el.split) return el.split;
  /** @type {Part[]} */
  const parts = [];
  let lead = '';
  /** @type {Nd[]} */
  let run = [];
  const flush = () => {
    // White space and comments at the end of a run stand before the next part.
    let end = run.length;
    while (end > 0 && isTrivia(run[end - 1])) end--;
    const rest = run.slice(end).map(ser).join('');
    if (end) { const nodes = run.slice(0, end); parts.push({ el: null, nodes, tag: '#run', lead, sig: hash('#run\u0001' + inner(nodes, false)) }); lead = ''; }
    lead += rest;
    run = [];
  };
  for (const c of el.kids) {
    if (c.t === 'el' && kindOf(c) === 'block') { flush(); parts.push({ el: c, nodes: [c], tag: /^h[1-6]$/.test(c.tag) ? 'h' : c.tag, lead, sig: sigOf(c) }); lead = ''; }
    else if (isTrivia(c) && !run.length) lead += ser(c);
    else run.push(c);
  }
  flush();
  return (el.split = { parts, tail: lead });
}

/**
 * The cells of a block that holds two or more elements and no text of its own: the label, the bar and the value
 * of each row of a chart. null for each other block.
 * @param {El} el
 * @returns {Split | null}
 */
function cellsOf(el) {
  if (el.cells !== undefined) return el.cells;
  /** @type {Part[]} */
  const parts = [];
  let lead = '';
  for (const c of el.kids) {
    if (isTrivia(c)) { lead += ser(c); continue; }
    if (c.t !== 'el') return (el.cells = null);
    parts.push({ el: c, nodes: [c], tag: c.tag, lead, sig: sigOf(c) });
    lead = '';
  }
  return (el.cells = parts.length > 1 ? { parts, tail: lead } : null);
}

// ─── 2. Align the blocks ────────────────────────────────────────────

/**
 * How alike two parts are, from 0 to 1: the share of words that both have. Two blocks with the same id are the same block.
 * @param {Part} x
 * @param {Part} y
 */
function alike(x, y) {
  if (x.tag !== y.tag) return 0;
  if (x.el && y.el) { const id = idOf(x.el); if (id && id === idOf(y.el)) return 1; }
  const wx = wordsOf(x), wy = wordsOf(y);
  if (!wx.length && !wy.length) return 0.6;
  /** @type {Map<string, number>} */
  const bag = new Map();
  for (const w of wx) bag.set(w, (bag.get(w) || 0) + 1);
  let both = 0;
  for (const w of wy) { const c = bag.get(w); if (c) { bag.set(w, c - 1); both++; } }
  return (2 * both) / (wx.length + wy.length);
}

const SMALL = new Set(['tr', 'td', 'th', 'li', 'dt', 'dd', 'figcaption', 'summary', 'caption', 'h']);
/** A small part can take the place of another one. A large one that is not alike shows as removed and added. @param {Part} p */
const small = (p) => !p.el || !blocky(p.el) || SMALL.has(p.tag) || wordsOf(p).length <= 60;

/**
 * Pairs two lists of parts in order. The best pairing has the most equal parts, then the most parts that are alike.
 * @param {Part[]} X
 * @param {Part[]} Y
 * @returns {Op[]}
 */
function pair(X, Y) {
  const n = X.length, m = Y.length;
  /** @type {Op[]} */
  const ops = [];
  if (n && m && n * m <= 60000) {
    const W = m + 1, S = new Float64Array(n * m), T = new Float64Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        const like = X[i].sig === Y[j].sig && X[i].tag === Y[j].tag ? 2 : alike(X[i], Y[j]);
        // Two long blocks pair when half of their words are the same. Two short ones need less:
        // "Spend two dollars" and "Spend thirty cents" are one item that changed.
        const pairs = like >= 0.5 || (like >= 0.3 && wordsOf(X[i]).length + wordsOf(Y[j]).length <= 16);
        const s = like >= 2 ? 3 : pairs ? 1 + like : 0;
        S[i * m + j] = s;
        T[i * W + j] = Math.max(T[(i + 1) * W + j], T[i * W + j + 1], s ? s + T[(i + 1) * W + j + 1] : 0);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      const s = S[i * m + j];
      if (s && T[i * W + j] === s + T[(i + 1) * W + j + 1]) { ops.push({ type: s === 3 ? 'same' : 'mod', a: X[i], b: Y[j] }); i++; j++; }
      else if (T[(i + 1) * W + j] >= T[i * W + j + 1]) ops.push({ type: 'del', a: X[i++] });
      else ops.push({ type: 'add', b: Y[j++] });
    }
    for (; i < n; i++) ops.push({ type: 'del', a: X[i] });
    for (; j < m; j++) ops.push({ type: 'add', b: Y[j] });
  } else {
    // Two long lists: pair only the equal parts, each with the next equal part after the last pair.
    let j = 0;
    for (const x of X) {
      let k = j;
      while (k < m && !(Y[k].sig === x.sig && Y[k].tag === x.tag)) k++;
      if (k < m) { for (; j < k; j++) ops.push({ type: 'add', b: Y[j] }); ops.push({ type: 'same', a: x, b: Y[j++] }); }
      else ops.push({ type: 'del', a: x });
    }
    for (; j < m; j++) ops.push({ type: 'add', b: Y[j] });
  }
  // Between two pairs, the removed parts stand before the new ones. The same number of small parts with the
  // same tags pair in order: a table cell with other words is that cell, changed. It is not a new cell.
  /** @type {Op[]} */
  const out = [];
  for (let i = 0; i < ops.length; ) {
    const op = ops[i];
    if (op.type === 'same' || op.type === 'mod') { out.push(op); i++; continue; }
    /** @type {Part[]} */
    const dels = [];
    /** @type {Part[]} */
    const adds = [];
    for (; i < ops.length; i++) { const o = ops[i]; if (o.type === 'del') dels.push(o.a); else if (o.type === 'add') adds.push(o.b); else break; }
    if (dels.length === adds.length && dels.every((d, k) => d.tag === adds[k].tag && small(d) && small(adds[k]))) dels.forEach((d, k) => out.push({ type: 'mod', a: d, b: adds[k] }));
    else { for (const d of dels) out.push({ type: 'del', a: d }); for (const b of adds) out.push({ type: 'add', b }); }
  }
  return out;
}

/**
 * The plan for the children of two blocks. The equal parts at the start and at the end need no search.
 * @param {Part[]} A
 * @param {Part[]} B
 * @returns {Op[]}
 */
function align(A, B) {
  /** @param {Part} x @param {Part} y */
  const same = (x, y) => x.sig === y.sig && x.tag === y.tag;
  let s = 0;
  while (s < A.length && s < B.length && same(A[s], B[s])) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && same(A[ea - 1], B[eb - 1])) { ea--; eb--; }
  /** @type {Op[]} */
  const ops = [];
  for (let i = 0; i < s; i++) ops.push({ type: 'same', a: A[i], b: B[i] });
  for (const op of pair(A.slice(s, ea), B.slice(s, eb))) ops.push(op);
  for (let i = ea, j = eb; i < A.length; i++, j++) ops.push({ type: 'same', a: A[i], b: B[j] });
  // A pair of blocks that changed has a plan of its own, unless both hold only text.
  for (const op of ops) if (op.type === 'mod' && op.a.el && op.b.el && (blocky(op.a.el) || blocky(op.b.el))) op.sub = align(partsOf(op.a.el).parts, partsOf(op.b.el).parts);
  return ops;
}

/** Finds the blocks that moved: a removed block and a new block that are equal. @param {Op[]} ops */
function twins(ops) {
  /** @type {Extract<Op, { type: 'del' }>[]} */
  const dels = [];
  /** @type {Map<string, Extract<Op, { type: 'add' }>[]>} */
  const adds = new Map();
  /** @param {Op[]} list */
  const walk = (list) => {
    for (const op of list) {
      if (op.type === 'del') dels.push(op);
      else if (op.type === 'add') { const k = op.b.tag + op.b.sig, l = adds.get(k); if (l) l.push(op); else adds.set(k, [op]); }
      else if (op.type === 'mod' && op.sub) walk(op.sub);
    }
  };
  walk(ops);
  for (const d of dels) {
    if (!d.a.el || wordsOf(d.a).length < 4) continue;
    const t = adds.get(d.a.tag + d.a.sig)?.shift();
    if (t) { d.twin = t; t.twin = d; }
  }
}

// ─── Words: the marks inside one text block ─────────────────────────

/**
 * A word, white space, something that the diff does not read, a tag, or a drawn part.
 * head is the length of the start tag of a drawn part, or 0 when the part can hold no mark.
 * @typedef {{ k: 'w' | 's' | 'x', s: string }
 *   | { k: 'tag', s: string, open: boolean, sig: string, gap: boolean, obj?: boolean }
 *   | { k: 'a', s: string, sig: string, noun: string, head: number }} Tok
 */
const TOKEN = /\s+|&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);|[\p{L}\p{N}]+(?:[.,'’:/_-][\p{L}\p{N}]+)*|[^\s]/giu;

/** A run as a flat list. @param {Nd[]} nodes @param {Tok[]} out */
function flat(nodes, out) {
  for (const n of nodes) {
    if (n.t === 'raw') out.push({ k: 'x', s: n.s });
    else if (n.t === 'text') { for (const m of n.s.match(TOKEN) || []) out.push({ k: /^\s/.test(m) ? 's' : 'w', s: m }); }
    else {
      const k = kindOf(n);
      if (k === 'skip') out.push({ k: 'x', s: ser(n) });
      else if (k === 'atom') out.push({ k: 'a', s: ser(n), sig: sigOf(n), noun: atomNoun(n.tag), head: n.tag === 'script' ? 0 : n.open.length });
      else {
        const gap = BREAKS.has(n.tag);
        out.push({ k: 'tag', s: n.open, open: true, sig: n.tag + ownOf(n), gap });
        flat(n.kids, out);
        if (n.close) out.push({ k: 'tag', s: n.close, open: false, sig: '', gap });
      }
    }
  }
  return out;
}

/**
 * The text of a run from one word to another, with the white space between them.
 * @param {Tok[]} T
 * @param {number[]} at  The position of each word in T.
 * @param {number} from
 * @param {number} to
 */
function span(T, at, from, to) {
  let s = '';
  for (let i = at[from]; i <= at[to - 1]; i++) {
    const t = T[i];
    if (t.k === 'w' || t.k === 's') s += t.s;
    else if (t.k === 'tag' && t.gap && s && !/\s$/.test(s)) s += ' ';
  }
  return s;
}

/**
 * The longest list of items that two lists share, in order, as pairs of indexes.
 * @param {string[]} A
 * @param {string[]} B
 * @returns {[number, number][]}
 */
function lcs(A, B) {
  const n = A.length, m = B.length;
  let s = 0;
  while (s < n && s < m && A[s] === B[s]) s++;
  let e = 0;
  while (e < n - s && e < m - s && A[n - 1 - e] === B[m - 1 - e]) e++;
  /** @type {[number, number][]} */
  const out = [];
  for (let i = 0; i < s; i++) out.push([i, i]);
  const an = n - s - e, bn = m - s - e;
  // Two long texts with a large middle that differs: the middle shows as replaced.
  if (an && bn && an * bn <= 4e6) {
    /** @type {Map<string, number>} */
    const ids = new Map();
    /** @param {string} w */
    const id = (w) => { let v = ids.get(w); if (v === undefined) ids.set(w, (v = ids.size)); return v; };
    const a = new Int32Array(an), b = new Int32Array(bn);
    for (let i = 0; i < an; i++) a[i] = id(A[s + i]);
    for (let j = 0; j < bn; j++) b[j] = id(B[s + j]);
    const W = bn + 1, T = new Uint16Array((an + 1) * W);
    for (let i = an - 1; i >= 0; i--) for (let j = bn - 1; j >= 0; j--) T[i * W + j] = a[i] === b[j] ? T[(i + 1) * W + j + 1] + 1 : Math.max(T[(i + 1) * W + j], T[i * W + j + 1]);
    for (let i = 0, j = 0; i < an && j < bn; ) {
      if (a[i] === b[j]) { out.push([s + i, s + j]); i++; j++; }
      else if (T[(i + 1) * W + j] >= T[i * W + j + 1]) i++;
      else j++;
    }
  }
  for (let k = 0; k < e; k++) out.push([n - e + k, m - e + k]);
  return out;
}

/** @typedef {{ eq: boolean, a0: number, a1: number, b0: number, b1: number }} Seg  A stretch of both lists: equal, or an edit. */

/** How good a place is for an edit to start or to end: the end of the block, the end of a sentence, a comma. @param {string | undefined} prev @param {string | undefined} next */
const edge = (prev, next) => (prev === undefined || next === undefined ? 3 : /^[.!?]$/.test(prev) ? 2 : /^[,;:)\]”"]$/.test(prev) ? 1 : 0);

/**
 * The equal stretches and the edits between them, in a form that reads well.
 * @param {[number, number][]} pairs
 * @param {string[]} A
 * @param {string[]} B
 * @param {(b0: number, b1: number) => boolean} split  True when a tag stands between two words of the newer list.
 * @returns {Seg[]}
 */
function edits(pairs, A, B, split) {
  /** @type {Seg[]} */
  const segs = [];
  let i = 0, j = 0;
  for (const [pi, pj] of pairs) {
    if (pi > i || pj > j) segs.push({ eq: false, a0: i, a1: pi, b0: j, b1: pj });
    const last = segs[segs.length - 1];
    if (last && last.eq && last.a1 === pi && last.b1 === pj) { last.a1++; last.b1++; } else segs.push({ eq: true, a0: pi, a1: pi + 1, b0: pj, b1: pj + 1 });
    i = pi + 1; j = pj + 1;
  }
  if (i < A.length || j < B.length) segs.push({ eq: false, a0: i, a1: A.length, b0: j, b1: B.length });
  /** The number of characters in a stretch. @param {string[]} T @param {number} from @param {number} to */
  const len = (T, from, to) => { let c = 0; for (let k = from; k < to; k++) c += T[k].length; return c; };
  /** @param {Seg} x */
  const size = (x) => Math.max(len(A, x.a0, x.a1), len(B, x.b0, x.b1));
  // One short equal word between two larger edits is chance: "this" or a comma in a sentence that changed.
  // It joins them, and the reader sees one replacement. An edit never joins another one across a tag or a drawn part.
  for (let k = 1; k < segs.length - 1; k++) {
    const s = segs[k], p = segs[k - 1], q = segs[k + 1];
    if (!s.eq || p.eq || q.eq || s.a1 - s.a0 > 1) continue;
    if (A[s.a0][0] === '\u0000' || A[s.a0].length > Math.min(size(p), size(q)) || split(p.b0, q.b1)) continue;
    segs.splice(k - 1, 3, { eq: false, a0: p.a0, a1: q.a1, b0: p.b0, b1: q.b1 });
    k = Math.max(0, k - 2);
  }
  // An edit that only adds or only removes can often move left or right over equal words.
  // It moves to the place where it starts and ends at the end of a sentence.
  for (let k = 1; k < segs.length - 1; k++) {
    const s = segs[k], p = segs[k - 1], q = segs[k + 1];
    if (s.eq || !p.eq || !q.eq) continue;
    const del = s.b0 === s.b1, add = s.a0 === s.a1;
    if (del === add) continue;
    const T = del ? A : B, lo = del ? s.a0 : s.b0, hi = del ? s.a1 : s.b1;
    let L = 0, R = 0;
    while (L < p.a1 - p.a0 && T[lo - 1 - L] === T[hi - 1 - L]) L++;
    while (R < q.a1 - q.a0 && T[lo + R] === T[hi + R]) R++;
    let best = 0, top = -1;
    for (let d = -L; d <= R; d++) {
      const score = edge(T[lo + d - 1], T[lo + d]) + edge(T[hi + d - 1], T[hi + d]);
      if (score > top || (score === top && Math.abs(d) < Math.abs(best))) { top = score; best = d; }
    }
    if (!best) continue;
    p.a1 += best; p.b1 += best; q.a0 += best; q.b0 += best;
    if (del) { s.a0 += best; s.a1 += best; s.b0 = s.b1 = p.b1; } else { s.b0 += best; s.b1 += best; s.a0 = s.a1 = p.a1; }
  }
  /** @type {Seg[]} */
  const out = [];
  for (const s of segs) {
    if (s.eq && s.a0 === s.a1) continue;
    const last = out[out.length - 1];
    if (last && !last.eq && !s.eq) { last.a1 = s.a1; last.b1 = s.b1; } else out.push(s);
  }
  return out;
}

/**
 * @typedef {object} Marked
 * @property {string} html     The newer content with its marks.
 * @property {boolean} text    True when words changed.
 * @property {boolean} located True when a part inside holds a data-diff="obj" mark.
 * @property {string} noun     The word for the first drawn part that holds such a mark, or ''.
 * @property {string} lift     The noun of a drawn part that changed and that no mark can hold, or ''.
 * @property {string} added    The new words.
 * @property {string} removed  The words that the change removed.
 */

/**
 * Marks the words that differ between two runs of text. The result is the newer run, with <ins data-diff> around
 * new words, and <del data-diff> with the removed words at the place they left.
 * @param {Nd[]} was
 * @param {Nd[]} now
 * @param {string} first  Attributes for the first mark, such as its number.
 * @returns {Marked}
 */
function words(was, now, first) {
  const O = flat(was, []), N = flat(now, []);
  // The positions of the words in each run, and the number of tags before each position of the newer run.
  /** @type {number[]} */
  const os = [];
  /** @type {number[]} */
  const ns = [];
  /** @type {number[]} */
  const tags = [];
  O.forEach((t, i) => { if (t.k === 'w' || t.k === 'a') os.push(i); });
  let seen = 0;
  N.forEach((t, i) => { tags.push(seen); if (t.k === 'tag') seen++; else if (t.k === 'w' || t.k === 'a') ns.push(i); });
  /** @param {Tok} t */
  const key = (t) => (t.k === 'a' ? '\u0000' + t.sig : t.s);
  const A = os.map((i) => key(O[i])), B = ns.map((i) => key(N[i]));
  const segs = edits(lcs(A, B), A, B, (b0, b1) => b1 > b0 && tags[ns[b0]] !== tags[ns[b1 - 1]]);

  const fresh = new Uint8Array(ns.length);
  // The removed words that stand before a word of the newer run, and those that stand after one.
  /** @type {Map<number, string>} */
  const before = new Map();
  /** @type {Map<number, string>} */
  const after = new Map();
  let start = '', lift = '', noun = '', located = false;
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const removed = [];
  /** The white space of the older run between two positions. @param {number} from @param {number} to */
  const space = (from, to) => { let s = ''; for (let i = from; i < to; i++) if (O[i].k === 's') s += O[i].s; return s; };
  /** True when the newer run has white space before a word. @param {number} j */
  const spaced = (j) => { for (let i = ns[j - 1] + 1; i < ns[j]; i++) if (N[i].k === 's') return true; return false; };
  for (const g of segs) {
    if (g.eq) continue;
    let drawn = false;
    for (let j = g.b0; j < g.b1; j++) { fresh[j] = 1; const t = N[ns[j]]; if (t.k === 'a' && t.head) drawn = true; }
    // A drawn part that the newer run does not have leaves no place for a mark. The block shows the change.
    for (let i = g.a0; i < g.a1; i++) { const t = O[os[i]]; if (t.k === 'a' && !drawn) lift ||= t.noun || 'part'; }
    if (g.b1 > g.b0) { const s = span(N, ns, g.b0, g.b1); if (s.trim()) added.push(s); }
    if (g.a1 === g.a0) continue;
    const gone = span(O, os, g.a0, g.a1);
    if (!gone.trim()) continue;
    removed.push(gone);
    const lead = space(g.a0 ? os[g.a0 - 1] + 1 : 0, os[g.a0]), trail = space(os[g.a1 - 1] + 1, g.a1 < os.length ? os[g.a1] : O.length);
    // Where the removed words stand: before the words that replace them. With no such words, before the next word
    // with the space that followed them. Where the newer run has no space at that place, they stand at the word
    // before, with their own spaces.
    if (g.b1 > g.b0) before.set(g.b0, (g.b0 && !spaced(g.b0) ? lead : '') + gone);
    else if (!ns.length) start = gone;
    else if (g.b0 === 0) before.set(0, gone + trail);
    else if (g.b0 === ns.length) after.set(g.b0 - 1, lead + gone);
    else if (spaced(g.b0)) before.set(g.b0, gone + trail);
    else after.set(g.b0 - 1, lead + gone + trail);
  }
  // An inline element with other attributes draws differently: a chip with a new colour.
  const ot = O.filter((t) => t.k === 'tag' && t.open), nt = N.filter((t) => t.k === 'tag' && t.open);
  if (ot.length === nt.length) nt.forEach((t, q) => { const o = ot[q]; if (t.k === 'tag' && o.k === 'tag' && t.sig !== o.sig) { t.obj = true; located = true; } });

  let carried = !first, html = '', open = false, j = 0;
  const attr = () => { if (carried) return ''; carried = true; return first; };
  const shut = () => { if (open) { html += '</ins>'; open = false; } };
  /** @param {string} s */
  const del = (s) => { shut(); html += '<del data-diff' + attr() + '>' + s + '</del>'; };
  /** @param {number} at */
  const gone = (at) => { const s = before.get(at); if (s !== undefined) { before.delete(at); del(s); } };
  /** @param {number} at */
  const left = (at) => { const s = after.get(at); if (s !== undefined) del(s); };
  if (start) del(start);
  for (const t of N) {
    if (t.k === 'w') {
      gone(j);
      if (!fresh[j]) shut(); else if (!open) { html += '<ins data-diff' + attr() + '>'; open = true; }
      html += t.s;
      left(j++);
    } else if (t.k === 'a') {
      gone(j);
      shut();
      // A drawn part holds its own mark. A mark around it can break it. A data script can hold none.
      if (fresh[j] && t.head) { html += withAttr(t.s.slice(0, t.head), 'data-diff="obj"' + attr()) + t.s.slice(t.head); located = true; noun ||= t.noun; }
      else { if (fresh[j]) lift ||= 'part'; html += t.s; }
      left(j++);
    } else if (t.k === 's') {
      if (!(j < ns.length && fresh[j] && N[ns[j]].k === 'w')) shut();
      html += t.s;
    } else {
      shut();
      // Removed words stand before a start tag, so they do not take the look of the element that follows.
      if (t.k === 'tag' && t.open) gone(j);
      html += t.k === 'tag' && t.obj ? withAttr(t.s, 'data-diff="obj"' + attr()) : t.s;
    }
  }
  shut();
  return { html, text: added.length > 0 || removed.length > 0, located, noun, lift, added: plain(added.join(' ')), removed: plain(removed.join(' ')) };
}

/**
 * Marks the cells that differ between two blocks of cells. A new cell and a removed cell hold the mark themselves.
 * @param {Split} was
 * @param {Split} now
 * @param {Ctx} ctx
 * @returns {Marked}
 */
function cells(was, now, ctx) {
  let html = '', text = false, located = false, noun = '';
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const removed = [];
  for (const op of align(was.parts, now.parts)) {
    if (op.type === 'del') {
      const a = op.a.el, t = textOf(op.a.nodes);
      if (!a) continue;
      text = true;
      if (t) removed.push(t);
      // A slide has no room for what it lost. The sheet lists it below the slide.
      if (ctx.out) { if (t) ctx.out.push(t); } else html += blank(op.a.lead) + withAttr(noId(a.open), 'data-diff="del"') + innerHtml(a) + a.close;
      continue;
    }
    const b = op.b.el;
    if (!b) continue;
    html += op.b.lead;
    if (op.type === 'same') html += ser(b);
    else if (op.type === 'add') { text = true; const t = textOf(op.b.nodes); if (t) added.push(t); html += withAttr(b.open, 'data-diff="add"') + innerHtml(b) + b.close; }
    else {
      const a = op.a.el;
      if (!a || kindOf(b) === 'atom') { located = true; noun ||= atomNoun(b.tag); html += withAttr(b.open, 'data-diff="obj"') + innerHtml(b) + b.close; continue; }
      const r = words(a.kids, b.kids, '');
      if (r.text) { text = true; if (r.added) added.push(r.added); if (r.removed) removed.push(r.removed); }
      // A cell with other attributes draws differently: a bar with another length. So does a cell with no words that changed.
      const drawn = ownOf(a) !== ownOf(b) || (!r.text && !r.located);
      if (drawn || r.located) located = true;
      noun ||= r.noun;
      html += (drawn ? withAttr(b.open, 'data-diff="obj"') : b.open) + r.html + b.close;
    }
  }
  return { html: html + now.tail, text, located, noun, lift: '', added: added.join(' '), removed: removed.join(' ') };
}

// ─── 3. Write the newer version with the marks ──────────────────────

/** The headings in a block, in order. @param {El} el @returns {{ text: string, level: number }[]} */
function headings(el) {
  /** @type {{ text: string, level: number }[]} */
  const out = [];
  /** @param {El} n */
  const walk = (n) => {
    if (/^h[1-6]$/.test(n.tag)) { out.push({ text: textOf(n.kids), level: +n.tag[1] }); return; }
    for (const c of n.kids) if (c.t === 'el' && kindOf(c) !== 'skip' && kindOf(c) !== 'atom') walk(c);
  };
  walk(el);
  return out;
}
/**
 * Moves the place to a heading that the writer passed. The blocks that follow it in the same parent belong to it.
 * A heading deep in a block names only that block: the title of a card does not name the text after the cards.
 * @param {Ctx} ctx
 * @param {Part} p
 */
function pass(ctx, p) {
  if (p.tag === 'h' && p.el) { ctx.heading = textOf(p.el.kids); ctx.level = +p.el.tag[1]; }
}
/** Records one change. @param {Ctx} ctx @param {number} n @param {Change['kind']} kind @param {Part} p @param {string} text @param {string} was @param {string} [noun] */
function note(ctx, n, kind, p, text, was, noun) {
  const own = p.el ? headings(p.el)[0] : undefined;
  const cut = (/** @type {string} */ s) => (s.length > 200 ? s.slice(0, 199) + '…' : s);
  ctx.changes.push({ n, kind, noun: noun || nounOf(p.el), heading: own ? own.text : ctx.heading, level: own ? own.level : ctx.level, slide: ctx.slide, text: cut(text), was: cut(was) });
}
/** The number of the next change. The blocks of a sheet and the cells of a table row share one number. @param {Ctx} ctx */
const next = (ctx) => ctx.group || ++ctx.n;
/** A number as the HTML holds it until the end. Then the numbers follow the order of the page. @param {number} n */
const slot = (n) => ' data-diff-n="\u0000#' + n + '\u0000"';
/** @param {Ctx} ctx @param {number} n */
const num = (ctx, n) => (ctx.group ? '' : slot(n));
/** The white space at the start of what stands before a part. A removed block does not bring its comments and scripts back. @param {string} lead */
const blank = (lead) => (/^\s*/.exec(lead) || [''])[0];
/** @param {string} open */
const noId = (open) => open.replace(/\sid\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '');
/** A row that fits the parent: a table takes rows, a list takes items. @param {El | null} parent @param {string} attr @param {string} body */
function row(parent, attr, body) {
  const t = parent ? parent.tag : '';
  return t === 'table' || t === 'tbody' || t === 'thead' || t === 'tfoot' ? '<tr ' + attr + '><td colspan="99">' + body + '</td></tr>' : t === 'ul' || t === 'ol' ? '<li ' + attr + '>' + body + '</li>' : '<div ' + attr + '>' + body + '</div>';
}

/**
 * One part of the newer version with its marks, without what stands before it.
 * @param {Op} op
 * @param {Ctx} ctx
 * @returns {string}
 */
function block(op, ctx) {
  if (op.type === 'same') { pass(ctx, op.b); return op.b.nodes.map(ser).join(''); }
  if (op.type === 'add') {
    const b = op.b;
    if (!b.el) {
      // A new run of text with a data script in it cannot stand in <ins>: the kit reads the script from its parent.
      if (b.nodes.some((c) => c.t === 'el' && c.tag === 'script')) { ctx.lift ||= 'part'; return b.nodes.map(ser).join(''); }
      const n = next(ctx);
      note(ctx, n, 'add', b, textOf(b.nodes), '');
      return '<ins data-diff' + num(ctx, n) + '>' + b.nodes.map(ser).join('') + '</ins>';
    }
    const n = next(ctx);
    note(ctx, n, op.twin ? 'move' : 'add', b, textOf(b.nodes), '');
    pass(ctx, b);
    return withAttr(b.el.open, 'data-diff="' + (op.twin ? 'to' : 'add') + '"' + num(ctx, n)) + innerHtml(b.el) + b.el.close;
  }
  if (op.type === 'del') {
    const a = op.a;
    // A block that moved shows at its new place only.
    if (op.twin) return '';
    const n = next(ctx);
    note(ctx, n, 'del', a, textOf(a.nodes), '');
    // A slide has no room for what it lost. The sheet lists it below the slide.
    if (ctx.out) { ctx.out.push(textOf(a.nodes)); return ''; }
    if (!a.el) return '<del data-diff' + num(ctx, n) + '>' + a.nodes.filter((c) => !(c.t === 'el' && c.tag === 'script')).map(ser).join('') + '</del>';
    return withAttr(noId(a.el.open), 'data-diff="del"' + num(ctx, n)) + innerHtml(a.el) + a.el.close;
  }
  const a = op.a, b = op.b;
  if (!a.el || !b.el) {
    // A run of text between blocks. It has no element of its own, so its first mark holds the number.
    const n = next(ctx), r = words(a.nodes, b.nodes, num(ctx, n));
    if (r.text || r.located) note(ctx, n, r.text ? 'mod' : 'obj', b, r.added, r.removed, r.text ? 'text' : r.noun || 'part');
    else ctx.lift ||= r.lift || 'part';
    return r.html;
  }
  let open = b.el.open;
  if (!op.sub) {
    // Two blocks of text, or two blocks of cells. The block holds the number, and the marks inside hold the detail.
    const ca = cellsOf(a.el), cb = cellsOf(b.el);
    const r = ca && cb ? cells(ca, cb, ctx) : words(a.el.kids, b.el.kids, '');
    const n = next(ctx);
    // With no mark inside, the block as a whole draws differently: its attributes changed, or a diagram that the kit draws from text.
    const whole = !r.text && !r.located;
    // An image that changed in a paragraph is "image changed". A diagram that the kit draws from text has the name of its block.
    const drawn = r.text ? '' : whole ? (r.lift === 'part' ? '' : r.lift) : r.noun;
    note(ctx, n, r.text ? 'mod' : 'obj', b, r.text ? r.added : textOf(b.nodes), r.removed, drawn || undefined);
    pass(ctx, b);
    return withAttr(open, 'data-diff="' + (whole ? 'obj' : 'mod') + '"' + num(ctx, n)) + r.html + b.el.close;
  }
  const at = ctx.changes.length, lift = ctx.lift, heading = ctx.heading, level = ctx.level;
  ctx.lift = '';
  // A change before the heading of its own block belongs to that heading: the chip above the title of a card.
  const title = partsOf(b.el).parts.find((p) => p.tag === 'h');
  if (title) pass(ctx, title);
  // A row of a table is one change, although more than one cell in it can differ.
  const shared = !ctx.group && b.el.tag === 'tr' ? (ctx.group = ++ctx.n) : 0;
  const body = kids(op.sub, partsOf(b.el).tail, b.el, ctx);
  // The block itself draws differently when its own attributes changed and no child shows a change,
  // or when a drawn part in it changed and no mark could hold that.
  if (ctx.lift || ((a.el.tag !== b.el.tag || ownOf(a.el) !== ownOf(b.el)) && ctx.changes.length === at)) {
    const n = next(ctx);
    note(ctx, n, 'obj', b, textOf(b.nodes), '', ctx.lift && ctx.lift !== 'part' ? ctx.lift : hasClass(b.el, 'k-slide') ? 'layout' : undefined);
    open = withAttr(open, 'data-diff="obj"' + num(ctx, n));
  }
  ctx.lift = lift; ctx.heading = heading; ctx.level = level;
  if (shared) { ctx.group = 0; if (ctx.changes.length > at) open = withAttr(open, slot(shared).slice(1)); }
  if (ctx.review && ctx.changes.length > at) {
    // A closed <details> hides its changes.
    if (b.el.tag === 'details' && !/\sopen[\s=>]/i.test(open)) open = withAttr(open, 'open');
    // The deck runtime of the kit shows one slide at a time. Without the class, it does not start, and the sheets show.
    if (hasClass(b.el, 'k-deck')) open = open.replace(/(\sclass\s*=\s*["']?(?:[^"'>]*\s)?)k-deck(?=[\s"'>])/i, '$1k-deck-review');
  }
  return open + body + b.el.close;
}

const FOLDS = new Set(['#root', 'body', 'main', 'article', 'section', 'ul', 'table', 'tbody']);
/** A light block gives context next to a change: a paragraph or a heading. A table or a figure does not. @param {Part} p */
const light = (p) => !!p.el && !blocky(p.el) && !['figure', 'table', 'pre'].includes(p.tag) && wordsOf(p).length <= 80;

/**
 * Which parts with no change fold. Next to each change, one light block stays as context.
 * The first heading of the block stays, and the head row of a table stays.
 * @param {Op[]} ops
 * @param {El} parent
 * @param {Ctx} ctx
 * @returns {number[] | null}  For each part, the number of its fold, or 0.
 */
function folds(ops, parent, ctx) {
  if (!FOLDS.has(parent.tag) || ops.every((op) => op.type === 'same')) return null;
  // The items of a numbered list do not fold: the bar would take a number.
  const rows = parent.tag === 'table' || parent.tag === 'tbody' || parent.tag === 'ul';
  const can = ops.map((op) => {
    if (op.type !== 'same' || !op.b.el) return false;
    const el = op.b.el;
    if (rows) return (el.tag === 'tr' && !el.kids.some((c) => c.t === 'el' && c.tag === 'th')) || el.tag === 'li';
    return true;
  });
  ops.forEach((op, i) => {
    if (op.type === 'same') return;
    for (const j of [i - 1, i + 1]) { const o = ops[j]; if (o && can[j] && o.type === 'same' && (rows || light(o.b))) can[j] = false; }
  });
  if (!rows) {
    const h = ops.findIndex((op) => op.type === 'same' && op.b.tag === 'h');
    if (h >= 0 && h < ops.findIndex((op) => op.type !== 'same')) can[h] = false;
  }
  const out = ops.map(() => 0);
  for (let i = 0; i < ops.length; ) {
    if (!can[i]) { i++; continue; }
    let j = i;
    while (j < ops.length && can[j]) j++;
    const heavy = ops.slice(i, j).some((op) => op.type === 'same' && !light(op.b));
    if (j - i >= (rows ? 4 : 3) || (!rows && heavy)) { const g = ++ctx.gaps; for (let k = i; k < j; k++) out[k] = g; }
    i = j;
  }
  return out;
}

/**
 * The children of a block of the newer version, with the marks.
 * @param {Op[]} ops
 * @param {string} tail
 * @param {El} parent
 * @param {Ctx} ctx
 * @returns {string}
 */
function kids(ops, tail, parent, ctx) {
  if (ctx.review && hasClass(parent, 'k-deck')) return deck(ops, tail, ctx);
  const fold = ctx.review ? folds(ops, parent, ctx) : null;
  let out = '';
  ops.forEach((op, i) => {
    const lead = op.type === 'del' ? blank(op.a.lead) : op.b.lead;
    const g = fold ? fold[i] : 0;
    if (!fold || !g || op.type !== 'same' || !op.b.el) { out += lead + block(op, ctx); return; }
    if (fold[i - 1] !== g) {
      /** @type {El[]} */
      const hidden = [];
      for (let k = i; fold[k] === g; k++) { const o = ops[k]; if (o.type === 'same' && o.b.el) hidden.push(o.b.el); }
      const nouns = hidden.map(nounOf), noun = nouns.every((x) => x === nouns[0]) ? nouns[0] : 'part';
      out += lead + row(parent, 'data-diff-gap="' + g + '"', '<button type="button">' + count(noun, hidden.length) + ' with no changes</button>');
    }
    pass(ctx, op.b);
    out += lead + withAttr(op.b.el.open, 'data-diff-skip="' + g + '"') + innerHtml(op.b.el) + op.b.el.close;
  });
  return out + tail;
}

/**
 * The slides of a deck for the review: each slide is a sheet with a caption, and the slides with no change fold.
 * A sheet is one change, so the reader steps from slide to slide.
 * @param {Op[]} ops
 * @param {string} tail
 * @param {Ctx} ctx
 * @returns {string}
 */
function deck(ops, tail, ctx) {
  /** @param {Part} p */
  const slide = (p) => !!p.el && hasClass(p.el, 'k-slide');
  /** @param {string} state @param {string} attr @param {string} cap @param {string} say @param {string} html @param {string} [more] */
  const sheet = (state, attr, cap, say, html, more) => '<div data-diff-sheet="' + state + '"' + attr + '><p data-diff-cap><b>' + cap + '</b>' + (say ? ' <span>' + say + '</span>' : '') + '</p><div class="k-frame">' + html + '</div>' + (more || '') + '</div>';
  // The number of each slide in its own version.
  let ia = 0, ib = 0;
  const at = ops.map((op) => ({ a: op.type !== 'add' && slide(op.a) ? ++ia : 0, b: op.type !== 'del' && slide(op.b) ? ++ib : 0 }));
  /** @type {Map<Op, number>} */
  const where = new Map();
  ops.forEach((op, i) => where.set(op, at[i].a || at[i].b));
  let out = '', gap = 0;
  ops.forEach((op, i) => {
    const lead = op.type === 'del' ? blank(op.a.lead) : op.b.lead;
    const p = op.type === 'del' ? op.a : op.b;
    if (!slide(p) || !p.el) { gap = 0; out += lead + block(op, ctx); return; }
    if (op.type === 'same') {
      if (!gap) {
        gap = ++ctx.gaps;
        let k = i;
        while (ops[k + 1] && ops[k + 1].type === 'same' && at[k + 1].b) k++;
        const say = k === i ? 'Slide ' + at[i].b + ' has no changes' : 'Slides ' + at[i].b + (k === i + 1 ? ' and ' : ' to ') + at[k].b + ' have no changes';
        out += lead + '<div data-diff-gap="' + gap + '"><button type="button">' + say + '</button></div>';
      }
      out += lead + sheet('same', ' data-diff-skip="' + gap + '"', 'Slide ' + at[i].b, '', ser(p.el));
      return;
    }
    gap = 0;
    if (op.type === 'del' && op.twin) return;
    const n = ++ctx.n;
    ctx.slide = at[i].b || at[i].a;
    if (op.type === 'mod') {
      ctx.group = n; ctx.out = [];
      const html = block(op, ctx), lost = ctx.out;
      ctx.group = 0; ctx.out = null;
      out += lead + sheet('mod', slot(n), 'Slide ' + at[i].b, 'Changed', html, lost.length ? '<p data-diff-out><b>Removed from this slide</b> ' + lost.map((t) => '<del data-diff>' + esc(t) + '</del>').join(' ') + '</p>' : '');
    } else if (op.type === 'add') {
      const from = op.twin ? where.get(op.twin) || 0 : 0;
      note(ctx, n, from ? 'move' : 'add', p, textOf(p.nodes), from ? 'Slide ' + from : '');
      out += lead + sheet(from ? 'to' : 'add', slot(n), 'Slide ' + at[i].b, from ? 'Moved from slide ' + from : 'New', ser(p.el));
    } else {
      note(ctx, n, 'del', p, textOf(p.nodes), '');
      out += lead + sheet('del', slot(n), 'Slide ' + at[i].a + ' of the version before', 'Removed', noId(p.el.open) + innerHtml(p.el) + p.el.close);
    }
    ctx.slide = 0;
  });
  return out + tail;
}

/**
 * Compares two versions of a page.
 * @param {string} before  The HTML of the older version.
 * @param {string} after   The HTML of the newer version.
 * @param {{ review?: boolean }} [opts]  review: fold the long stretches with no change, and show a deck as sheets.
 * @returns {{ html: string, head: string, body: string, tail: string, changes: Change[], stops: number, deck: boolean }}
 *   html is the newer version with the marks. head, body and tail are its three parts: the document up to <body>,
 *   the content of the body, and the rest. changes lists each change. stops is the number of marks that have a number.
 */
export function diffHtml(before, after, opts = {}) {
  const A = parse(before), B = parse(after);
  const from = bodyOf(A), to = bodyOf(B);
  const [head, tail] = shell(B, to);
  const isDeck = to.kids.some((c) => c.t === 'el' && c.tag === 'main' && hasClass(c, 'k-deck'));
  const ops = align(partsOf(from).parts, partsOf(to).parts);
  if (ops.every((op) => op.type === 'same')) return { html: after, head, body: innerHtml(to), tail, changes: [], stops: 0, deck: isDeck };
  twins(ops);
  /** @type {Ctx} */
  const ctx = { review: !!opts.review, n: 0, gaps: 0, changes: [], heading: '', level: 0, slide: 0, group: 0, out: null, lift: '' };
  let body = kids(ops, partsOf(to).tail, to, ctx);
  // The numbers of the changes and of the folds follow the order of the page.
  /** @type {Map<string, number>} */
  const order = new Map();
  /** @type {Map<string, number>} */
  const gaps = new Map();
  /** @param {Map<string, number>} map @param {string} k */
  const rank = (map, k) => { let v = map.get(k); if (!v) map.set(k, (v = map.size + 1)); return v; };
  body = body.replace(/\u0000#(\d+)\u0000/g, (m, d) => String(rank(order, d)));
  body = body.replace(/ data-diff-(gap|skip)="(\d+)"/g, (m, kind, d) => ' data-diff-' + kind + '="' + rank(gaps, d) + '"');
  const changes = ctx.changes.filter((c) => order.has(String(c.n)));
  for (const c of changes) c.n = order.get(String(c.n)) || 0;
  changes.sort((x, y) => x.n - y.n);
  return { html: head + body + tail, head, body, tail, changes, stops: order.size, deck: isDeck };
}

/** @type {Record<Change['kind'], string>} */
const VERB = { add: 'added', del: 'removed', mod: 'changed', obj: 'changed', move: 'moved' };

/**
 * The short list for the review: one line for each place, with what changed there.
 * A place is a slide, or the heading that stands before the change.
 * @param {Change[]} changes
 * @returns {{ n: number, slide: number, gone: boolean, heading: string, level: number, what: string }[]}
 *   n is the first change of the place. gone is true for a slide that the newer version does not have.
 *   what is a phrase such as 'Heading and 4 items changed, item removed'.
 */
export function summarize(changes) {
  /** @type {Map<string, { n: number, slide: number, gone: boolean, heading: string, level: number, whole: string, verbs: Map<string, Map<string, number>> }>} */
  const places = new Map();
  for (const c of changes) {
    const whole = c.noun === 'slide' && c.kind !== 'obj' && c.kind !== 'mod';
    const key = c.slide ? 's' + c.slide + (whole && c.kind === 'del' ? 'x' : '') : 'h' + c.heading;
    let p = places.get(key);
    if (!p) places.set(key, (p = { n: c.n, slide: c.slide, gone: whole && c.kind === 'del', heading: c.heading, level: c.level, whole: '', verbs: new Map() }));
    if (whole) { p.whole = c.kind === 'add' ? 'New slide' : c.kind === 'del' ? 'Slide removed' : 'Moved' + (c.was ? ' from ' + c.was.toLowerCase() : ''); continue; }
    const verb = VERB[c.kind];
    let nouns = p.verbs.get(verb);
    if (!nouns) p.verbs.set(verb, (nouns = new Map()));
    nouns.set(c.noun, (nouns.get(c.noun) || 0) + 1);
  }
  return [...places.values()].map(({ whole, verbs, ...p }) => {
    const said = [...verbs].map(([verb, nouns]) => {
      // "Text" has no number: two changes in the text of one place read as "text changed".
      const list = [...nouns].map(([noun, n]) => (n === 1 || noun === 'text' ? noun : n + ' ' + noun + 's'));
      return (list.length > 1 ? list.slice(0, -1).join(', ') + ' and ' : '') + list[list.length - 1] + ' ' + verb;
    }).join(', ');
    return { ...p, what: whole || said.charAt(0).toUpperCase() + said.slice(1) };
  });
}
