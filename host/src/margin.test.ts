// The pure parts of the margin comments: the anchor of a selection and its place after an edit (kit/explain.js),
// and the card layout and the checks of the frame messages (margin.js, which runs in the viewer).
import { describe, expect, it } from 'vitest';
import '../../kit/explain.js';
import marginJs from './margin.js?raw';

type Pos = [number, number];
type Place = { a: Pos; b: Pos; exact: boolean } | null;
type Quote = { quote: string; prefix?: string; suffix?: string };
const { describeSelection, anchorQuote } = (globalThis as unknown as {
  Explain: { describeSelection: (texts: string[], a: Pos, b: Pos, ctx?: number) => { quote: string; prefix: string; suffix: string }; anchorQuote: (texts: string[], q: Quote, from?: number, to?: number) => Place };
}).Explain;
// margin.js is a script for the viewer. With no document, it returns only its pure functions.
const M = new Function(`${marginJs}\nreturn Margin;`)() as {
  layoutCards: (items: { id: string; y: number; h: number }[], opt?: { gap?: number; min?: number; active?: string }) => Record<string, number>;
  readSelect: (d: unknown) => unknown;
  readAnchors: (d: unknown) => { y: number; vh: number; dh: number; deck: unknown; list: { id: string; state: string; top: number | null; slide: number; hidden: boolean }[] };
  mentionAt: (value: string, caret: number) => { from: number; query: string } | null;
  assistantStates: (threads: unknown[], handled: string[]) => Record<string, string>;
};

/** The text nodes of an HTML fragment, in order, as a browser makes them. */
const nodes = (html: string) => html.split(/<[^>]+>/).filter((t) => t !== '');
/** The text that a place covers. */
const cut = (texts: string[], h: NonNullable<Place>) => texts.slice(h.a[0], h.b[0] + 1).map((t, i, all) => t.slice(i === 0 ? h.a[1] : 0, i === all.length - 1 ? h.b[1] : undefined)).join('');
/** The position of the first character of `s` in the text nodes, and the position after its last character. */
function find(texts: string[], s: string, nth = 0): [Pos, Pos] {
  const all = texts.join('');
  let at = -1;
  for (let k = 0; k <= nth; k++) at = all.indexOf(s, at + 1);
  const pos = (i: number, end: boolean): Pos => { for (let n = 0, base = 0; n < texts.length; base += texts[n].length, n++) if (i < base + texts[n].length || (end && i === base + texts[n].length)) return [n, i - base]; return [texts.length - 1, texts[texts.length - 1].length]; };
  return [pos(at, false), pos(at + s.length, true)];
}

const PAGE = `<main><h1>How a heat pump heats a house</h1>
<p>A heat pump moves heat from the outside air. It uses about <b>one third</b> of the energy of a <em>gas boiler</em>.</p>
<p>Insulate the roof first. A grant makes that time shorter.</p>
<p>Seal the gaps. A grant makes that time shorter.</p></main>`;

describe('describeSelection', () => {
  it('takes a quote across inline elements, with up to 32 characters of context on each side', () => {
    const t = nodes(PAGE);
    const [a, b] = find(t, 'about one third of the energy');
    expect(describeSelection(t, a, b)).toEqual({ quote: 'about one third of the energy', prefix: 'at from the outside air. It uses', suffix: 'of a gas boiler. Insulate the ro' });
  });
  it('makes each run of white space one space', () => {
    const t = ['Heat pumps\n   move ', 'heat', '\n  fast.'];
    expect(describeSelection(t, [0, 0], [2, 8])).toEqual({ quote: 'Heat pumps move heat fast.', prefix: '', suffix: '' });
  });
});

describe('anchorQuote', () => {
  const t = nodes(PAGE);
  const q = (s: string, nth = 0) => { const [a, b] = find(t, s, nth); return describeSelection(t, a, b); };

  it('finds an unchanged quote exactly', () => {
    const h = anchorQuote(t, q('one third of the energy'))!;
    expect(h.exact).toBe(true);
    expect(cut(t, h)).toBe('one third of the energy');
  });
  it('finds a quote that moved: new text before it, and the paragraph in another place', () => {
    const quote = q('one third of the energy');
    const moved = nodes(`<main><p>Seal the gaps.</p><h1>New intro.</h1>${PAGE.replace('<main>', '')}`);
    const h = anchorQuote(moved, quote)!;
    expect(h.exact).toBe(true);
    expect(cut(moved, h)).toBe('one third of the energy');
  });
  it('picks the right copy of a repeated quote by its context, and gives up when the context cannot tell them apart', () => {
    const second = q('A grant makes that time shorter.', 1);
    const h = anchorQuote(t, second)!;
    expect(t[h.a[0]]).toBe('Seal the gaps. A grant makes that time shorter.');
    expect(anchorQuote(t, { quote: 'A grant makes that time shorter.' })).toBeNull();
  });
  it('gives no exact place for a short quote whose context changed, so a wrong mark never shows', () => {
    const quote = q('gas boiler');
    const edited = nodes(PAGE.replace('It uses about', 'A gas boiler is cheaper. It uses about').replace('of a <em>gas boiler</em>', 'of an oil furnace'));
    const h = anchorQuote(edited, quote);
    expect(h === null || h.exact === false).toBe(true);
  });
  it('marks a partly changed quote as not exact, at the start that is still there', () => {
    const quote = q('Insulate the roof first. A grant makes that time shorter.');
    const edited = nodes(PAGE.replace('Insulate the roof first. A grant makes that time shorter.', 'Insulate the roof first. A grant pays for half.'));
    const h = anchorQuote(edited, quote)!;
    expect(h.exact).toBe(false);
    expect(edited[h.a[0]].slice(h.a[1])).toMatch(/^Insulate the roof first/);
  });
  it('keeps a deleted quote next to the text that was before it, not exact', () => {
    const quote = q('It uses about one third of the energy of a gas boiler.');
    const edited = nodes(PAGE.replace(' It uses about <b>one third</b> of the energy of a <em>gas boiler</em>.', ' It is quiet.'));
    const h = anchorQuote(edited, quote)!;
    expect(h.exact).toBe(false);
    expect(edited[h.a[0]].slice(0, h.a[1]).trimEnd()).toBe('A heat pump moves heat from the outside air.');
  });
  it('has no place when the quote and its context are all gone', () => {
    const quote = q('one third of the energy');
    expect(anchorQuote(nodes('<p>Something else entirely, with no common words at all.</p>'), quote)).toBeNull();
  });
});

describe('layoutCards', () => {
  const cards = [{ id: 'a', y: 100, h: 80 }, { id: 'b', y: 120, h: 60 }, { id: 'c', y: 400, h: 50 }, { id: 'd', y: 420, h: 50 }];
  it('keeps each card at its anchor or below the card before it, with the gap, and never overlaps', () => {
    expect(M.layoutCards(cards, { gap: 10 })).toEqual({ a: 100, b: 190, c: 400, d: 460 });
  });
  it('keeps the active card on its anchor and pushes the cards before it up', () => {
    expect(M.layoutCards(cards, { gap: 10, active: 'b' })).toEqual({ a: 30, b: 120, c: 400, d: 460 });
    expect(M.layoutCards(cards, { gap: 10, active: 'd' })).toEqual({ a: 100, b: 190, c: 360, d: 420 });
  });
  it('keeps the active card on its anchor even when the cards above it go above min, and keeps every other card at min or lower', () => {
    expect(M.layoutCards(cards, { gap: 10, min: 50, active: 'b' })).toEqual({ a: 30, b: 120, c: 400, d: 460 });
    expect(M.layoutCards([{ id: 'a', y: 20, h: 40 }, { id: 'b', y: 30, h: 40 }], { gap: 10, min: 50 })).toEqual({ a: 50, b: 100 });
    expect(M.layoutCards([{ id: 'a', y: 20, h: 40 }], { gap: 10, min: 50, active: 'a' })).toEqual({ a: 50 });
  });
  it('keeps the order of the anchors, also for input in another order', () => {
    const tops = M.layoutCards([...cards].reverse(), { gap: 10 });
    expect(Object.keys(tops).sort((x, y) => tops[x] - tops[y])).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('messages from the frame', () => {
  it('readSelect takes a valid selection and cuts each text to its limit', () => {
    expect(M.readSelect({ on: true, live: false, quote: '  q  ', prefix: 'p'.repeat(100), suffix: 's', anchor: 'a', slide: '', rects: [[1, 2, 3, 4]], y: 10 }))
      .toEqual({ live: false, quote: 'q', prefix: 'p'.repeat(64), suffix: 's', anchor: 'a', slide: '', rects: [[1, 2, 3, 4]], y: 10 });
    expect(M.readSelect({ on: true, live: true })).toEqual({ live: true });
  });
  it('readSelect refuses no selection, a bad box, a number that is not finite, and a quote that is not text', () => {
    expect(M.readSelect({ on: false })).toBeNull();
    expect(M.readSelect({ on: true, quote: 'q', rects: [[1, 2, 3]] })).toBeNull();
    expect(M.readSelect({ on: true, quote: 'q', rects: [[1, 2, 3, Infinity]] })).toBeNull();
    expect(M.readSelect({ on: true, quote: { toString: () => 'x' }, rects: [[1, 2, 3, 4]] })).toBeNull();
    expect(M.readSelect({ on: true, quote: 'q', rects: [] })).toBeNull();
  });
  it('readAnchors keeps only valid entries and turns an unknown state into lost', () => {
    const a = M.readAnchors({ y: 5, vh: 700, dh: 3000, deck: null, list: [{ id: 'x', state: 'exact', top: 10, slide: 0 }, { id: 'y', state: '<b>', top: 'no' }, { id: 7 }, { id: 'z'.repeat(65) }] });
    expect(a).toEqual({ y: 5, vh: 700, dh: 3000, deck: null, list: [{ id: 'x', state: 'exact', top: 10, slide: 0, hidden: false }, { id: 'y', state: 'lost', top: null, slide: 0, hidden: false }] });
  });
});

describe('mentions', () => {
  it('mentionAt finds "@" and the letters after it at the caret, and not in an email address', () => {
    expect(M.mentionAt('Hi @cl', 6)).toEqual({ from: 3, query: 'cl' });
    expect(M.mentionAt('@', 1)).toEqual({ from: 0, query: '' });
    expect(M.mentionAt('ann@claude', 10)).toBeNull();
    expect(M.mentionAt('Hi @cl there', 12)).toBeNull();
  });
  it('assistantStates reads the sign-in state from the latest run of each assistant', () => {
    const threads = [{ runs: { a: { agent: 'claude', status: 'done', started_at: '1' }, b: { agent: 'claude', status: 'failed', detail: 'not_signed_in: no', started_at: '2' } } }, { runs: { c: { agent: 'chatgpt', status: 'running', started_at: '1' } } }];
    expect(M.assistantStates(threads, ['claude', 'chatgpt'])).toEqual({ claude: 'off', chatgpt: 'on' });
    expect(M.assistantStates([], ['claude'])).toEqual({ claude: '', chatgpt: 'none' });
  });
});
