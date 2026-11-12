// @ts-check
// The view of a list of pages in the library: which pages show, and in which order.
// It needs no DOM, so the browser and the tests run the same code.
// library.ts puts this file into the library script. The tests import it as a module.
//
// A view has four filters and one order. The address of the library holds them with these names,
// so a view can be shared and it survives a reload:
//   type   'doc' | 'deck'                                  the kind of page
//   mod    'today' | '7d' | '30d' | 'year' | 'lastyear'    when the page last changed
//   in     a folder id | 'none'                            the folder of the page. A folder holds the folders below it too.
//   acc    'shared' | 'private'                            a page with a share link, or a page with none
//   sort   'modified' | 'opened' | 'name' | 'created' | 'folder' | 'versions' | 'access'
//   dir    'asc' | 'desc'
// An empty filter lets every page pass.

/**
 * @typedef {object} Page
 * @property {string} slug
 * @property {string} title
 * @property {string} kind              'deck' for a slide deck. Each other kind is a document.
 * @property {number} latest            The number of versions.
 * @property {string} updated_at
 * @property {string} [created_at]
 * @property {number} shared            The number of share links.
 * @property {string | null} folder_id
 */
/** @typedef {{ id: string, name: string, parent_id: string | null }} Folder */
/**
 * @typedef {object} View
 * @property {string} type
 * @property {string} mod
 * @property {string} in
 * @property {string} acc
 * @property {string} sort
 * @property {'asc' | 'desc'} dir
 */
/**
 * What the list needs to know about the reader and the library.
 * @typedef {object} Ctx
 * @property {Date} now
 * @property {Folder[]} folders
 * @property {Record<string, string>} openedAt  For each page that the reader opened in this browser, the time of the last open.
 */
/**
 * @typedef {object} Sort
 * @property {string} id
 * @property {string} name
 * @property {'asc' | 'desc'} first  The direction that a click on the sort gives first.
 * @property {string} asc            The words for each direction.
 * @property {string} desc
 * @property {boolean} [column]      True for a sort that only a column of the list offers.
 */

export const TYPES = [{ id: 'doc', name: 'Documents' }, { id: 'deck', name: 'Decks' }];
export const RANGES = [{ id: 'today', name: 'Today' }, { id: '7d', name: 'Last 7 days' }, { id: '30d', name: 'Last 30 days' }, { id: 'year', name: 'This year' }, { id: 'lastyear', name: 'Last year' }];
export const ACCESS = [{ id: 'shared', name: 'Shared by link' }, { id: 'private', name: 'Private' }];
/** @type {Sort[]} */
export const SORTS = [
  { id: 'modified', name: 'Last modified', first: 'desc', asc: 'Oldest first', desc: 'Newest first' },
  { id: 'opened', name: 'Last opened by me', first: 'desc', asc: 'Oldest first', desc: 'Newest first' },
  { id: 'name', name: 'Name', first: 'asc', asc: 'A to Z', desc: 'Z to A' },
  { id: 'created', name: 'Created', first: 'desc', asc: 'Oldest first', desc: 'Newest first' },
  { id: 'folder', name: 'Folder', first: 'asc', asc: 'A to Z', desc: 'Z to A', column: true },
  { id: 'versions', name: 'Versions', first: 'desc', asc: 'Fewest first', desc: 'Most first', column: true },
  { id: 'access', name: 'Access', first: 'desc', asc: 'Private first', desc: 'Shared first', column: true },
];
/** @param {string} id */
export const sortOf = (id) => SORTS.find((s) => s.id === id) || SORTS[0];

/**
 * Reads a view from the query of an address. A value that the library does not know counts as not set.
 * @param {{ get(name: string): string | null }} query
 * @param {Folder[]} folders
 * @returns {View}
 */
export function parseView(query, folders) {
  /** @param {string} name @param {(v: string) => boolean} ok */
  const one = (name, ok) => { const v = query.get(name) || ''; return v && ok(v) ? v : ''; };
  /** @param {{ id: string }[]} list */
  const among = (list) => (/** @type {string} */ v) => list.some((x) => x.id === v);
  const sort = sortOf(one('sort', among(SORTS)));
  const dir = query.get('dir');
  return {
    type: one('type', among(TYPES)),
    mod: one('mod', among(RANGES)),
    in: one('in', (v) => v === 'none' || among(folders)(v)),
    acc: one('acc', among(ACCESS)),
    sort: sort.id,
    dir: dir === 'asc' || dir === 'desc' ? dir : sort.first,
  };
}

/**
 * The names and values that an address needs for a view. A filter that is not set, the usual sort
 * and the usual direction of a sort have no entry, so the address of the plain list stays short.
 * @param {Partial<View>} view
 * @returns {[string, string][]}
 */
export function viewQuery(view) {
  /** @type {[string, string][]} */
  const out = [];
  for (const k of /** @type {const} */ (['type', 'mod', 'in', 'acc'])) { const v = view[k]; if (v) out.push([k, v]); }
  const sort = sortOf(view.sort || '');
  if (sort.id !== SORTS[0].id) out.push(['sort', sort.id]);
  if (view.dir && view.dir !== sort.first) out.push(['dir', view.dir]);
  return out;
}

/** True when a filter is set. @param {Partial<View>} view */
export const isOn = (view) => !!(view.type || view.mod || view.in || view.acc);

/**
 * The start and the end of a time range, in milliseconds. The days and the years are those of the reader's clock.
 * @param {string} mod
 * @param {Date} now
 * @returns {[number, number]}
 */
function rangeOf(mod, now) {
  const t = now.getTime(), y = now.getFullYear(), day = 86400000;
  if (mod === 'today') return [new Date(y, now.getMonth(), now.getDate()).getTime(), Infinity];
  if (mod === '7d') return [t - 7 * day, Infinity];
  if (mod === '30d') return [t - 30 * day, Infinity];
  if (mod === 'year') return [new Date(y, 0, 1).getTime(), Infinity];
  if (mod === 'lastyear') return [new Date(y - 1, 0, 1).getTime(), new Date(y, 0, 1).getTime()];
  return [-Infinity, Infinity];
}

/** A folder and each folder below it. @param {Folder[]} folders @param {string} id */
function under(folders, id) {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
  }
  return ids;
}

/**
 * The pages that pass the filters of a view, in the order they came.
 * @template {Page} T
 * @param {T[]} pages
 * @param {Partial<View>} view
 * @param {Ctx} ctx
 * @returns {T[]}
 */
export function filterPages(pages, view, ctx) {
  const [from, to] = rangeOf(view.mod || '', ctx.now);
  const inside = view.in && view.in !== 'none' ? under(ctx.folders, view.in) : null;
  return pages.filter((p) => {
    if (view.type && (p.kind === 'deck') !== (view.type === 'deck')) return false;
    if (view.mod) { const t = Date.parse(p.updated_at); if (!(t >= from && t < to)) return false; }
    if (view.in === 'none' ? p.folder_id : inside && !(p.folder_id && inside.has(p.folder_id))) return false;
    if (view.acc && (p.shared > 0) !== (view.acc === 'shared')) return false;
    return true;
  });
}

/**
 * The time that the list shows for a page under a sort: the last open, the first publish, or the last change.
 * It is '' for a page that the reader did not open in this browser.
 * @param {Page} p
 * @param {string} sort
 * @param {Record<string, string>} openedAt
 */
export const dateOf = (p, sort, openedAt) => (sort === 'opened' ? openedAt[p.slug] || '' : sort === 'created' ? p.created_at || p.updated_at : p.updated_at);

/**
 * The pages in the order of a view. Pages that are equal in the sort go newest first.
 * A page with no value for the sort goes last in both directions: a page never opened, a page in no folder.
 * @template {Page} T
 * @param {T[]} pages
 * @param {Partial<View>} view
 * @param {Ctx} ctx
 * @returns {T[]}
 */
export function sortPages(pages, view, ctx) {
  const sort = sortOf(view.sort || ''), sign = (view.dir || sort.first) === 'asc' ? 1 : -1;
  const text = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const names = new Map(ctx.folders.map((f) => [f.id, f.name]));
  /** @param {Page} p @returns {string | number | null} */
  const key = (p) => {
    if (sort.id === 'name') return p.title;
    if (sort.id === 'folder') return (p.folder_id && names.get(p.folder_id)) || null;
    if (sort.id === 'versions') return p.latest;
    if (sort.id === 'access') return p.shared > 0 ? 1 : 0;
    return dateOf(p, sort.id, ctx.openedAt) || null;
  };
  /** @param {Page} a @param {Page} b */
  const newest = (a, b) => b.updated_at.localeCompare(a.updated_at) || a.slug.localeCompare(b.slug);
  return [...pages].sort((a, b) => {
    const x = key(a), y = key(b);
    if (x === null || y === null) return x === y ? newest(a, b) : x === null ? 1 : -1;
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : sort.id === 'name' || sort.id === 'folder' ? text.compare(String(x), String(y)) : String(x).localeCompare(String(y));
    return c ? sign * c : sort.id === 'folder' ? text.compare(a.title, b.title) || newest(a, b) : newest(a, b);
  });
}

/**
 * The pages of a view: those that pass its filters, in its order.
 * @template {Page} T
 * @param {T[]} pages
 * @param {Partial<View>} view
 * @param {Ctx} ctx
 * @returns {T[]}
 */
export const applyView = (pages, view, ctx) => sortPages(filterPages(pages, view, ctx), view, ctx);
