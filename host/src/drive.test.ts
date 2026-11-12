import { describe, expect, it } from 'vitest';
import { applyView, dateOf, filterPages, isOn, parseView, viewQuery } from './drive.js';

// The reader looks at the library on November 12, 2026 at 9:30, by their own clock.
const now = new Date(2026, 10, 12, 9, 30);
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();
const page = (slug: string, title: string, kind: string, updated: string, created: string, latest: number, shared: number, folder: string | null) =>
  ({ slug, title, kind, updated_at: updated, created_at: created, latest, shared, folder_id: folder });

const folders = [
  { id: 'te', name: 'ThrillEats', parent_id: null },
  { id: 'ph', name: 'ProposalHost', parent_id: null },
  { id: 'le', name: 'Legislative engine', parent_id: null },
  { id: 'drafts', name: 'Drafts', parent_id: 'le' },
  { id: 'gl', name: 'GridLink', parent_id: null },
];
const pages = [
  page('te/deck', 'ThrillEats: November 1 review', 'deck', at(2026, 11, 12, 7), at(2026, 10, 28), 2, 1, 'te'),
  page('ph/leads', 'How we get 1,000 good leads', 'page', at(2026, 11, 11, 23), at(2026, 10, 29), 3, 0, 'ph'),
  page('le/engine', 'How the engine works today', 'page', at(2026, 11, 6, 10), at(2026, 9, 1), 2, 0, 'drafts'),
  page('gl/poc', 'GridLink and First Student', 'page', at(2026, 10, 20), at(2026, 10, 20), 1, 1, 'gl'),
  page('p/lift3', 'Lift 3, run 4: the winter protocol', 'page', at(2026, 3, 3), at(2026, 3, 3), 1, 0, null),
  page('p/lift10', 'Lift 10, run 1', 'page', at(2025, 12, 20), at(2025, 12, 1), 4, 0, null),
  page('le/decks', 'Plan: slideshow decks', 'deck', at(2024, 6, 2), at(2024, 5, 30), 1, 0, 'le'),
];
const ctx = { now, folders, openedAt: { 'gl/poc': at(2026, 11, 12, 8), 'p/lift3': at(2026, 11, 10) } };
/** The slugs that a view shows, in its order. */
const shows = (view: Parameters<typeof applyView>[1]) => applyView(pages, view, ctx).map((p) => p.slug);

describe('the filters of the page list', () => {
  it('shows every page, newest first, when no filter is set', () => {
    expect(shows({})).toEqual(['te/deck', 'ph/leads', 'le/engine', 'gl/poc', 'p/lift3', 'p/lift10', 'le/decks']);
  });

  it('shows the decks or the documents', () => {
    expect(shows({ type: 'deck' })).toEqual(['te/deck', 'le/decks']);
    expect(shows({ type: 'doc' })).toEqual(['ph/leads', 'le/engine', 'gl/poc', 'p/lift3', 'p/lift10']);
  });

  it('shows the pages that changed in a time range', () => {
    expect(shows({ mod: 'today' })).toEqual(['te/deck']);
    expect(shows({ mod: '7d' })).toEqual(['te/deck', 'ph/leads', 'le/engine']);
    expect(shows({ mod: '30d' })).toEqual(['te/deck', 'ph/leads', 'le/engine', 'gl/poc']);
    expect(shows({ mod: 'year' })).toEqual(['te/deck', 'ph/leads', 'le/engine', 'gl/poc', 'p/lift3']);
    expect(shows({ mod: 'lastyear' })).toEqual(['p/lift10']);
  });

  it('counts a page from yesterday evening as not from today, and a page from exactly 7 days ago as in the last 7 days', () => {
    const edge = [page('a/late', 'Late', 'page', at(2026, 11, 11, 23), at(2026, 11, 1), 1, 0, null), page('a/week', 'Week', 'page', new Date(now.getTime() - 7 * 86400000).toISOString(), at(2026, 11, 1), 1, 0, null)];
    expect(filterPages(edge, { mod: 'today' }, ctx).map((p) => p.slug)).toEqual([]);
    expect(filterPages(edge, { mod: '7d' }, ctx).map((p) => p.slug)).toEqual(['a/late', 'a/week']);
  });

  it('shows the pages of a folder and of the folders below it', () => {
    expect(shows({ in: 'le' })).toEqual(['le/engine', 'le/decks']);
    expect(shows({ in: 'drafts' })).toEqual(['le/engine']);
  });

  it('shows the pages that are in no folder', () => {
    expect(shows({ in: 'none' })).toEqual(['p/lift3', 'p/lift10']);
  });

  it('shows the pages with a share link, or the pages with none', () => {
    expect(shows({ acc: 'shared' })).toEqual(['te/deck', 'gl/poc']);
    expect(shows({ acc: 'private' })).toEqual(['ph/leads', 'le/engine', 'p/lift3', 'p/lift10', 'le/decks']);
  });

  it('shows only the pages that pass every filter', () => {
    expect(shows({ type: 'doc', mod: '30d', acc: 'private' })).toEqual(['ph/leads', 'le/engine']);
    expect(shows({ type: 'deck', in: 'le', acc: 'shared' })).toEqual([]);
  });

  it('knows when a filter is set', () => {
    expect(isOn({ sort: 'name', dir: 'asc' })).toBe(false);
    expect(isOn({ mod: '7d' })).toBe(true);
  });
});

describe('the order of the page list', () => {
  it('sorts by name, with the numbers in a name as numbers', () => {
    expect(shows({ sort: 'name' })).toEqual(['gl/poc', 'le/engine', 'ph/leads', 'p/lift3', 'p/lift10', 'le/decks', 'te/deck']);
    expect(shows({ sort: 'name', dir: 'desc' })).toEqual(['te/deck', 'le/decks', 'p/lift10', 'p/lift3', 'ph/leads', 'le/engine', 'gl/poc']);
  });

  it('sorts by the last change, oldest first when the reader turns it', () => {
    expect(shows({ sort: 'modified', dir: 'asc' })).toEqual(['le/decks', 'p/lift10', 'p/lift3', 'gl/poc', 'le/engine', 'ph/leads', 'te/deck']);
  });

  it('sorts by the first publish', () => {
    expect(shows({ sort: 'created' })).toEqual(['ph/leads', 'te/deck', 'gl/poc', 'le/engine', 'p/lift3', 'p/lift10', 'le/decks']);
  });

  it('sorts by the last open, and puts the pages that the reader never opened last in both directions', () => {
    expect(shows({ sort: 'opened' })).toEqual(['gl/poc', 'p/lift3', 'te/deck', 'ph/leads', 'le/engine', 'p/lift10', 'le/decks']);
    expect(shows({ sort: 'opened', dir: 'asc' })).toEqual(['p/lift3', 'gl/poc', 'te/deck', 'ph/leads', 'le/engine', 'p/lift10', 'le/decks']);
  });

  it('sorts by the number of versions, and puts equal pages newest first', () => {
    expect(shows({ sort: 'versions' })).toEqual(['p/lift10', 'ph/leads', 'te/deck', 'le/engine', 'gl/poc', 'p/lift3', 'le/decks']);
  });

  it('sorts by the name of the folder, and puts the pages in no folder last in both directions', () => {
    expect(shows({ sort: 'folder' })).toEqual(['le/engine', 'gl/poc', 'le/decks', 'ph/leads', 'te/deck', 'p/lift3', 'p/lift10']);
    expect(shows({ sort: 'folder', dir: 'desc' })).toEqual(['te/deck', 'ph/leads', 'le/decks', 'gl/poc', 'le/engine', 'p/lift3', 'p/lift10']);
  });

  it('sorts by access, shared pages first', () => {
    expect(shows({ sort: 'access' })).toEqual(['te/deck', 'gl/poc', 'ph/leads', 'le/engine', 'p/lift3', 'p/lift10', 'le/decks']);
  });

  it('sorts the pages that pass the filters', () => {
    expect(shows({ type: 'doc', mod: 'year', sort: 'name' })).toEqual(['gl/poc', 'le/engine', 'ph/leads', 'p/lift3']);
  });

  it('gives the time that the list shows for a page under each sort', () => {
    expect(dateOf(pages[3], 'modified', ctx.openedAt)).toBe(at(2026, 10, 20));
    expect(dateOf(pages[2], 'created', ctx.openedAt)).toBe(at(2026, 9, 1));
    expect(dateOf(pages[3], 'opened', ctx.openedAt)).toBe(at(2026, 11, 12, 8));
    expect(dateOf(pages[0], 'opened', ctx.openedAt)).toBe('');
    expect(dateOf(pages[0], 'name', ctx.openedAt)).toBe(at(2026, 11, 12, 7));
  });
});

describe('the view in the address', () => {
  const read = (query: string) => parseView(new URLSearchParams(query), folders);
  const write = (view: Parameters<typeof viewQuery>[0]) => new URLSearchParams(viewQuery(view)).toString();

  it('reads the filters and the order', () => {
    expect(read('layout=rooms&type=deck&mod=7d&in=le&acc=shared&sort=name&dir=desc')).toEqual({ type: 'deck', mod: '7d', in: 'le', acc: 'shared', sort: 'name', dir: 'desc' });
  });

  it('reads an address with no view as the plain list, newest first', () => {
    expect(read('layout=rooms')).toEqual({ type: '', mod: '', in: '', acc: '', sort: 'modified', dir: 'desc' });
  });

  it('gives each sort its usual direction when the address names none', () => {
    expect(read('sort=name').dir).toBe('asc');
    expect(read('sort=opened').dir).toBe('desc');
  });

  it('drops a value that it does not know, and a folder that does not exist', () => {
    expect(read('type=sheet&mod=never&in=gone&acc=public&sort=size&dir=up')).toEqual({ type: '', mod: '', in: '', acc: '', sort: 'modified', dir: 'desc' });
    expect(read('in=none').in).toBe('none');
  });

  it('writes only what differs from the plain list', () => {
    expect(write({ type: '', mod: '', in: '', acc: '', sort: 'modified', dir: 'desc' })).toBe('');
    expect(write({ type: 'doc', mod: '30d', in: 'none', acc: 'private', sort: 'modified', dir: 'desc' })).toBe('type=doc&mod=30d&in=none&acc=private');
    expect(write({ sort: 'name', dir: 'asc' })).toBe('sort=name');
    expect(write({ sort: 'name', dir: 'desc' })).toBe('sort=name&dir=desc');
    expect(write({ sort: 'modified', dir: 'asc' })).toBe('dir=asc');
  });

  it('reads back the view that it wrote', () => {
    const view = { type: 'deck', mod: 'lastyear', in: 'drafts', acc: 'shared', sort: 'versions', dir: 'asc' as const };
    expect(read(write(view))).toEqual(view);
  });
});
