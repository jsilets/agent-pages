import { describe, expect, it } from 'vitest';
import { addParts, cleanPing, deviceOf, isBot, MAX_PARTS, reach, referrerHost, summarize, visitorHash, type ShareViewRow } from './share-views';

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

  it('puts a device in one of three classes', () => {
    expect(deviceOf(CHROME)).toBe('desktop');
    expect(deviceOf(IPHONE)).toBe('phone');
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36')).toBe('tablet');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36')).toBe('phone');
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

describe('a report from the share page', () => {
  it('keeps checked values and caps each time at the limit', () => {
    expect(cleanPing({ id: ID, active: 9000, depth: 64.4, slides: 0, parts: { ' Why  it matters ': 4000, Costs: 5000 } }, 12000)).toEqual({
      id: ID, active: 9000, depth: 64, slides: 0, download: false, parts: { 'Why it matters': 4000, Costs: 5000 },
    });
    expect(cleanPing({ id: ID, active: 999999, parts: { A: 999999 } }, 12000)).toMatchObject({ active: 12000, parts: { A: 12000 } });
  });

  it('turns bad values into zero and refuses a report with no valid id', () => {
    expect(cleanPing({ id: ID, active: -5, depth: 'far', slides: NaN, download: 'yes', parts: { A: 'x', '': 10 } }, 12000)).toEqual({
      id: ID, active: 0, depth: 0, slides: 0, download: false, parts: {},
    });
    expect(cleanPing({ id: 'short', active: 1 }, 12000)).toBe(null);
    expect(cleanPing(null, 12000)).toBe(null);
  });

  it('adds the time of a report to the parts of a view, and stops adding new parts at the limit', () => {
    expect(JSON.parse(addParts('{"A":1000}', { A: 500, B: 200 }))).toEqual({ A: 1500, B: 200 });
    expect(JSON.parse(addParts('not json', { A: 5 }))).toEqual({ A: 5 });
    const full = JSON.stringify(Object.fromEntries(Array.from({ length: MAX_PARTS }, (_, i) => ['p' + i, 1])));
    const after = JSON.parse(addParts(full, { p0: 1, extra: 9 }));
    expect(after.p0).toBe(2);
    expect('extra' in after).toBe(false);
  });
});

describe('the summary for the owner', () => {
  const row = (r: Partial<ShareViewRow>): ShareViewRow => ({
    id: 'v', token: 't1', visitor: 'a', device: 'desktop', country: null, referrer: null, started_at: '2026-11-12T10:00:00.000Z', last_at: '2026-11-12T10:05:00.000Z',
    active_ms: 0, depth: 0, slides: 0, downloads: 0, parts: '{}', ...r,
  });

  it('counts views and people for each link, with the median time of the views that had time', () => {
    const rows = [
      row({ id: '1', visitor: 'a', active_ms: 60_000, last_at: '2026-11-12T10:01:00.000Z' }),
      row({ id: '2', visitor: 'a', active_ms: 120_000, last_at: '2026-11-12T11:00:00.000Z', downloads: 1 }),
      row({ id: '3', visitor: 'b', active_ms: 0 }),
      row({ id: '4', visitor: 'c', active_ms: 300_000 }),
      row({ id: '5', token: 't2', visitor: 'a', active_ms: 10_000 }),
    ];
    const { links } = summarize(['t1', 't2', 't3'], rows);
    expect(links).toEqual([
      { token: 't1', views: 4, people: 3, median_ms: 120_000, total_ms: 480_000, last_at: '2026-11-12T11:00:00.000Z', downloads: 1 },
      { token: 't2', views: 1, people: 1, median_ms: 10_000, total_ms: 10_000, last_at: '2026-11-12T10:05:00.000Z', downloads: 0 },
      { token: 't3', views: 0, people: 0, median_ms: 0, total_ms: 0, last_at: null, downloads: 0 },
    ]);
  });

  it('adds the time on each part across views, in the order of the oldest view', () => {
    const rows = [
      row({ id: '2', started_at: '2026-11-12T12:00:00.000Z', parts: '{"Costs":3000,"Intro":1000}' }),
      row({ id: '1', started_at: '2026-11-12T09:00:00.000Z', parts: '{"Intro":2000,"Plan":4000}' }),
    ];
    expect(summarize(['t1'], rows).parts).toEqual([
      { key: 'Intro', ms: 3000, views: 2 },
      { key: 'Plan', ms: 4000, views: 1 },
      { key: 'Costs', ms: 3000, views: 1 },
    ]);
  });

  it('lists the newest views first, with how far each got', () => {
    const rows = [
      row({ id: '1', started_at: '2026-11-12T09:00:00.000Z', depth: 40 }),
      row({ id: '2', started_at: '2026-11-12T12:00:00.000Z', depth: 6, slides: 8, device: 'phone', country: 'US', referrer: 'slack.com' }),
    ];
    const { recent } = summarize(['t1'], rows);
    expect(recent.map((v) => [v.started_at.slice(11, 16), v.reach, v.device, v.country, v.referrer])).toEqual([
      ['12:00', 75, 'phone', 'US', 'slack.com'],
      ['09:00', 40, 'desktop', null, null],
    ]);
    expect(reach({ depth: 140, slides: 0 })).toBe(100);
  });
});
