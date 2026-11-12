import { describe, expect, it } from 'vitest';
import { cleanLabels, cleanPing, completion, deviceOf, isBot, osOf, referrerHost, summarize, visitorHash, type LinkRow, type PartRow, type ViewRow } from './share-views';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ID = 'abcdefghijklmnop';

describe('who counts as a reader', () => {
  it('counts a browser and skips link previews, crawlers and headless browsers', () => {
    expect(isBot(CHROME)).toBe(false);
    expect(isBot(IPHONE)).toBe(false);
    expect(isBot('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)')).toBe(true);
    expect(isBot('facebookexternalhit/1.1;line-poker/1.0')).toBe(true);
    expect(isBot('WhatsApp/2.23.20.0')).toBe(true);
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
    expect(isBot(CHROME.replace('Chrome/', 'HeadlessChrome/'))).toBe(true);
    expect(isBot(null)).toBe(true);
  });

  it('names the device and the operating system', () => {
    expect([deviceOf(CHROME), osOf(CHROME)]).toEqual(['desktop', 'macOS']);
    expect([deviceOf(IPHONE), osOf(IPHONE)]).toEqual(['phone', 'iOS']);
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect([deviceOf('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36'), osOf('Mozilla/5.0 (Linux; Android 14; SM-X710)')]).toEqual(['tablet', 'Android']);
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36')).toBe('phone');
    expect(osOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
    expect(osOf(null)).toBe(null);
  });

  it('keeps only the host of the page that linked here', () => {
    expect(referrerHost('https://www.linkedin.com/feed/update/123?x=1', 'pages.example.com')).toBe('linkedin.com');
    expect(referrerHost('https://pages.example.com/s/abc', 'pages.example.com')).toBe(null);
    expect(referrerHost('', 'pages.example.com')).toBe(null);
    expect(referrerHost('not a url', 'pages.example.com')).toBe(null);
  });

  it('gives one visitor the same hash for one salt and a new hash for a new salt', async () => {
    const a = await visitorHash('salt-1', '203.0.113.9', CHROME);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(await visitorHash('salt-1', '203.0.113.9', CHROME)).toBe(a);
    expect(await visitorHash('salt-2', '203.0.113.9', CHROME)).not.toBe(a);
    expect(await visitorHash('salt-1', '203.0.113.10', CHROME)).not.toBe(a);
  });
});

describe('what the share page sends', () => {
  it('cleans the headings of the parts', () => {
    expect(cleanLabels(['  Why   it matters ', '', 7, 'x'.repeat(100)])).toEqual(['Why it matters', 'Part 2', 'Part 3', 'x'.repeat(80)]);
    expect(cleanLabels('nope')).toEqual([]);
  });

  it('keeps the time on parts that exist, and caps the whole report at the time since the last one', () => {
    const p = cleanPing({ id: ID, parts: { 0: 4000, 2: 5000, 9: 1000, '-1': 5, x: 3 }, download: true }, 3, 12000)!;
    expect([...p.parts]).toEqual([[0, 4000], [2, 5000]]);
    expect(p.download).toBe(true);
    expect([...cleanPing({ id: ID, parts: { 0: 9000, 1: 9000 } }, 2, 12000)!.parts]).toEqual([[0, 9000], [1, 3000]]);
  });

  it('refuses a report with no valid id and drops bad times', () => {
    expect(cleanPing({ id: 'short' }, 3, 12000)).toBe(null);
    expect(cleanPing(null, 3, 12000)).toBe(null);
    expect([...cleanPing({ id: ID, parts: { 0: -5, 1: 'x', 2: NaN } }, 3, 12000)!.parts]).toEqual([]);
  });
});

describe('the views for the owner', () => {
  const view = (v: Partial<ViewRow> & Pick<ViewRow, 'id'>): ViewRow => ({
    token: 't1', visitor: 'a', device: 'desktop', os: 'macOS', country: 'US', referrer: null,
    started_at: '2026-11-12T10:00:00.000Z', last_at: '2026-11-12T10:05:00.000Z', active_ms: 0, parts: 4, downloads: 0, ...v,
  });
  const part = (view_id: string, i: number, ms: number): PartRow => ({ view_id, part: i, label: 'Slide ' + (i + 1), ms });
  const link = (token: string, name: string | null): LinkRow => ({ token, name, version: null, created_at: '2026-11-11T00:00:00.000Z', revoked_at: null });

  it('counts completion as the parts seen for at least a second, out of all the parts', () => {
    expect(completion([part('v', 0, 5000), part('v', 1, 999), part('v', 2, 1000)], 4)).toBe(50);
    expect(completion([], 0)).toBe(0);
  });

  it('gives the totals, the average time on each part, each link and each visit', () => {
    const views = [
      view({ id: 'v1', visitor: 'a', started_at: '2026-11-12T09:00:00.000Z', active_ms: 60_000 }),
      view({ id: 'v2', visitor: 'a', started_at: '2026-11-12T11:00:00.000Z', active_ms: 20_000, os: 'iOS', device: 'phone' }),
      view({ id: 'v3', visitor: 'b', token: 't2', started_at: '2026-11-12T12:00:00.000Z', active_ms: 0 }),
    ];
    const parts = [part('v1', 0, 30_000), part('v1', 1, 30_000), part('v2', 0, 10_000), part('v2', 3, 10_000)];
    const s = summarize([link('t1', 'Dana at Acme'), link('t2', null)], views, parts);
    expect(s.totals).toEqual({ views: 3, visitors: 2, avg_ms: 40_000, avg_completion: 50 });
    expect(s.parts).toEqual([
      { part: 0, label: 'Slide 1', avg_ms: 20_000, visits: 2 },
      { part: 1, label: 'Slide 2', avg_ms: 30_000, visits: 1 },
      { part: 3, label: 'Slide 4', avg_ms: 10_000, visits: 1 },
    ]);
    expect(s.links.map((l) => [l.name, l.views, l.last_at])).toEqual([['Dana at Acme', 2, '2026-11-12T11:00:00.000Z'], [null, 1, '2026-11-12T12:00:00.000Z']]);
    expect(s.visits.map((v) => [v.id, v.completion, v.os, v.parts.length])).toEqual([['v3', 0, 'macOS', 0], ['v2', 50, 'iOS', 2], ['v1', 50, 'macOS', 2]]);
  });
});
