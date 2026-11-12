import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditFromHtml, auditLines, blobKey, ftsQuery, isFolderColor, isFolderId, isSlug, isToken, newFolderId, newToken, overflowFix, pageChunks, pageKind, parseMeta, parseTheme, pdfKey, plainText, route, thumbKey, withKit, withTheme } from './lib';

describe('isSlug', () => {
  it('takes <group>/<name>', () => {
    expect(isSlug('billing-service/engine-overview')).toBe(true);
    expect(isSlug('a/b')).toBe(true);
  });
  it('refuses other shapes', () => {
    for (const s of ['a', 'a/b/c', 'A/b', 'a/-b', 'a/b-', '../x', 'a/b c', '/a/b', 'a//b', '']) expect(isSlug(s)).toBe(false);
  });
});

describe('parseMeta', () => {
  const page = (stamp: string) => `<html><title>How &amp; why</title><p class="k-stamp">${stamp}</p></html>`;
  it('reads the title, repo and sha from the stamp', () => {
    expect(parseMeta(page('billing-service · 0880549 · 2026-10-10 · snapshot'), 'x/y')).toEqual({
      title: 'How & why',
      repo: 'billing-service',
      sha: '0880549',
    });
  });
  it('keeps no-git as the sha and drops a sha that is not hex', () => {
    expect(parseMeta(page('scratch · no-git · 2026-10-10 · snapshot'), 'x/y').sha).toBe('no-git');
    expect(parseMeta(page('scratch · <b>hi</b> · 2026-10-10'), 'x/y').sha).toBe(null);
  });
  it('prefers the SNAPSHOT comment for the repo and commit', () => {
    const html = '<!-- SNAPSHOT: billing-service at 0880549 (main) on 2026-10-10. Do not plan from it. --><title>T</title><p class="k-stamp">billing-service · snapshot · Oct 10, 2026</p>';
    expect(parseMeta(html, 'x/y')).toEqual({ title: 'T', repo: 'billing-service', sha: '0880549' });
  });
  it('falls back to the slug name when there is no title or stamp', () => {
    expect(parseMeta('<html><body>hi</body></html>', 'group/my-page')).toEqual({ title: 'my-page', repo: null, sha: null });
  });
});

describe('tokens', () => {
  it('makes 43-character base64url tokens from 32 bytes, each one new', () => {
    const a = newToken(), b = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isToken(a)).toBe(true);
    expect(a).not.toBe(b);
  });
  it('refuses tokens of the wrong shape', () => {
    expect(isToken('short')).toBe(false);
    expect(isToken('a'.repeat(42) + '=')).toBe(false);
  });
});

describe('route', () => {
  const t = 'A'.repeat(43);
  it('maps every v1 route', () => {
    expect(route('/')).toEqual({ kind: 'library' });
    expect(route('/p/g/n')).toEqual({ kind: 'view', slug: 'g/n', version: null });
    expect(route('/p/g/n/v/3')).toEqual({ kind: 'view', slug: 'g/n', version: 3 });
    expect(route('/raw/g/n/12')).toEqual({ kind: 'raw', slug: 'g/n', version: 12 });
    expect(route('/api/pages')).toEqual({ kind: 'api-list' });
    expect(route('/api/activity')).toEqual({ kind: 'api-activity' });
    expect(route('/api/activity/x')).toEqual({ kind: 'not-found' });
    expect(route('/api/pages/g/n')).toEqual({ kind: 'api-page', slug: 'g/n' });
    expect(route('/api/pages/g/n/shares')).toEqual({ kind: 'api-shares', slug: 'g/n' });
    expect(route(`/api/shares/${t}`)).toEqual({ kind: 'api-share', token: t });
    expect(route(`/s/${t}`)).toEqual({ kind: 'share-view', token: t });
    expect(route(`/s/${t}/raw`)).toEqual({ kind: 'share-raw', token: t });
    expect(route('/_/explain.css')).toEqual({ kind: 'kit-css' });
    expect(route('/s/_/explain.css')).toEqual({ kind: 'share-css' });
  });
  it('refuses bad slugs, versions and tokens', () => {
    for (const p of ['/p/g', '/p/G/n', '/p/g/n/v/0', '/p/g/n/v/x', '/raw/g/n', '/raw/g/n/01', '/s/short', '/s/' + t + '/x', '/api/pages/g/n/x'])
      expect(route(p).kind).toBe('not-found');
  });
});

it('blobKey puts each version under the slug', () => {
  expect(blobKey('g/n', 2)).toBe('pages/g/n/2.html');
});

describe('withKit', () => {
  const page = (css: string) => `<html><head><style>\n${css}\n</style><style>.x{}</style></head><body>`;
  it('swaps the packed kit for the current kit', () => {
    expect(withKit(page('/* explain.css: old */ :root{--bg:#fff}'), '/* explain.css: new */')).toBe(page('/* explain.css: new */'));
  });
  it('keeps a page without the packed kit', () => {
    const html = '<html><head><style>.x{}</style></head>';
    expect(withKit(html, '/* explain.css: new */')).toBe(html);
  });
  it('keeps dollar signs in the CSS', () => {
    expect(withKit(page('/* explain.css */'), '/* explain.css */ a::after{content:"$"}')).toContain('"$"');
  });
  const packed = (js: string) => page('/* explain.css: old */') + `<p>x</p><script>\n${js}\n</script>\n</body>`;
  it('swaps the packed JS for the current JS', () => {
    expect(withKit(packed('/* explain.js: old */ a("<\\/script>")'), '/* explain.css: new */', '/* explain.js: new */ b("</script>")'))
      .toBe(page('/* explain.css: new */') + '<p>x</p><script>\n/* explain.js: new */ b("<\\/script>")\n</script>\n</body>');
  });
  it('keeps a page script that is not the kit', () => {
    const html = page('/* explain.css */') + '<script>\nlet x = 1;\n</script>';
    expect(withKit(html, '/* explain.css */', '/* explain.js: new */')).toBe(html);
  });
});

describe('withTheme', () => {
  it('adds data-theme to the html tag', () => {
    expect(withTheme('<!doctype html>\n<html lang="en" class="no-js"><body>', 'dark')).toBe('<!doctype html>\n<html lang="en" class="no-js" data-theme="dark"><body>');
  });
  it('replaces a data-theme that the page already has', () => {
    expect(withTheme('<html data-theme="dark" data-host="inline">', 'light')).toBe('<html data-host="inline" data-theme="light">');
  });
  it('accepts only light and dark', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('auto')).toBe(null);
    expect(parseTheme(null)).toBe(null);
  });
});

describe('new routes', () => {
  it('maps the pin, refresh, search and thumbnail routes', () => {
    expect(route('/api/pages/a/b/pin')).toEqual({ kind: 'api-pin', slug: 'a/b' });
    expect(route('/api/pages/a/b/refresh')).toEqual({ kind: 'api-refresh', slug: 'a/b' });
    expect(route('/api/search')).toEqual({ kind: 'api-search' });
    expect(route('/t/a/b/3/dark.webp')).toEqual({ kind: 'thumb', slug: 'a/b', version: 3, theme: 'dark' });
    expect(route('/t/a/b/3/auto.webp')).toEqual({ kind: 'not-found' });
    expect(thumbKey('a/b', 3, 'light')).toBe('pages/a/b/3.light.webp');
  });
});

describe('icon routes', () => {
  it('serves the icons under /s/_/ and /favicon.ico', () => {
    expect(route('/s/_/favicon.svg')).toEqual({ kind: 'icon', name: 'favicon.svg' });
    expect(route('/s/_/apple-touch-icon.png')).toEqual({ kind: 'icon', name: 'apple-touch-icon.png' });
    expect(route('/favicon.ico')).toEqual({ kind: 'icon', name: 'favicon.ico' });
    expect(route('/s/_/other.png')).toEqual({ kind: 'not-found' });
  });
});

describe('ftsQuery', () => {
  it('quotes each word and matches its prefix', () => {
    expect(ftsQuery('Legis engine')).toBe('"legis"* "engine"*');
  });
  it('drops FTS syntax that the reader typed', () => {
    expect(ftsQuery('"a" OR b* -c (d)')).toBe('"a"* "or"* "b"* "c"* "d"*');
    expect(ftsQuery(' ** ')).toBe(null);
  });
});

describe('pageChunks', () => {
  const html = `<html><head><title>T</title><style>.x{}</style></head><body>
<h1>How it works</h1><p>Intro &amp; scope.</p>
<section class="k-claim"><h2>Bills arrive <em>hourly</em></h2><p>The poller reads the feed.</p></section>
<section id="votes" class="k-claim c-blue"><h2>Votes</h2><p>Roll calls.</p><script>var no = 1;</script></section>
</body></html>`;
  it('splits the page at each claim and keeps or adds ids', () => {
    expect(pageChunks(html)).toEqual([
      { anchor: '', heading: '', body: 'How it works Intro & scope.' },
      { anchor: 'claim-1', heading: 'Bills arrive hourly', body: 'The poller reads the feed.' },
      { anchor: 'votes', heading: 'Votes', body: 'Roll calls.' },
    ]);
  });
  it('decodes entities', () => {
    expect(plainText('a&nbsp;&rarr;&#x42;&#67;')).toBe('a →BC');
  });
});

describe('decks', () => {
  it('knows a deck by <main class="k-deck">', () => {
    expect(pageKind('<html><body><main class="k-deck"><section class="k-claim k-slide">')).toBe('deck');
    expect(pageKind('<html><body><main class="k-page">')).toBe('page');
    expect(pageKind('<p>k-deck is a word here</p>')).toBe('page');
  });
  it('ignores the deck example inside the real bundled kit', () => {
    const kit = readFileSync(new URL('../../kit/explain.js', import.meta.url), 'utf8');
    const html = `<html><body><main class="k-page"><h1>POC</h1></main><script>${kit}</script></body></html>`;
    expect(pageKind(html)).toBe('page');
    expect(pageKind(html.replace('class="k-page"', 'class="k-deck"'))).toBe('deck');
  });
  it('ignores inert examples and matches an exact class token', () => {
    expect(pageKind(`<style>/* <main class="k-deck"> */</style><!-- <main class="k-deck"> --><main data-class="k-deck" class="k-deck-notes">`)).toBe('page');
    expect(pageKind(`<template><main class="k-deck"></main></template><main class="k-page">`)).toBe('page');
    expect(pageKind(`<main title="not > the end" class='wide k-deck'>`)).toBe('deck');
  });
  it('routes deck PDFs', () => {
    expect(route('/pdf/a/b/3')).toEqual({ kind: 'pdf', slug: 'a/b', version: 3 });
    const t = newToken();
    expect(route(`/s/${t}/pdf`)).toEqual({ kind: 'share-pdf', token: t });
    expect(route('/pdf/a/b/x').kind).toBe('not-found');
    expect(pdfKey('a/b', 3, 'k1')).toBe('pages/a/b/3.k1.pdf');
  });
  it('reads the audit report from the rendered HTML', () => {
    const report = { v: 1, pass: false, slides: [{ id: 'too-much', n: 7, layout: 'bullets', y: 283, x: 0, clip: [], tiny: [], fail: true }] };
    const a = auditFromHtml(`<html data-k-deck="ready"><body><main class="k-deck"></main><script type="application/json" id="k-deck-report">${JSON.stringify(report)}</script></body></html>`)!;
    expect(a.pass).toBe(false);
    expect(auditLines(a)).toEqual(['slide 7 (#too-much): the content is 283px taller than the slide. Fix: change the layout or split the slide']);
    expect(auditFromHtml('<html><body>no report</body></html>')).toBe(null);
    expect(auditFromHtml('<script id="k-deck-report">not json</script>')).toBe(null);
  });
  it('picks a fix by the size of the overflow', () => {
    expect([12, 60, 120, 400].map(overflowFix)).toEqual(['move elements a little', 'make the gaps smaller', 'make a title or paragraph smaller', 'change the layout or split the slide']);
  });
});

describe('auditFromHtml with an inlined kit', () => {
  it('skips a script that only mentions the report id', () => {
    const report = { pass: true, slides: [] };
    const html = `<script>/* writes <script type="application/json" id="k-deck-report"> */ const x = 1;</script><body><script type="application/json" id="k-deck-report">${JSON.stringify(report)}</script>`;
    expect(auditFromHtml(html)).toEqual({ pass: true, slides: [] });
  });
});

describe('folders', () => {
  it('routes the folder API', () => {
    const id = newFolderId();
    expect(route('/api/folders')).toEqual({ kind: 'api-folders' });
    expect(route(`/api/folders/${id}`)).toEqual({ kind: 'api-folder', id });
    expect(route('/api/pages/g/n/folder')).toEqual({ kind: 'api-page-folder', slug: 'g/n' });
    expect(route('/api/folders/short')).toEqual({ kind: 'not-found' });
    expect(route(`/api/folders/${id}/x`)).toEqual({ kind: 'not-found' });
  });
  it('makes ids that it accepts, and refuses other shapes', () => {
    for (let i = 0; i < 20; i++) expect(isFolderId(newFolderId())).toBe(true);
    for (const s of ['', 'abc', 'A'.repeat(15), 'A'.repeat(17), 'AAAAAAAAAAAAAAA/', '../AAAAAAAAAAAAA']) expect(isFolderId(s)).toBe(false);
  });
  it('takes only the kit ramps as colors', () => {
    expect(isFolderColor('blue')).toBe(true);
    expect(isFolderColor('chartreuse')).toBe(false);
    expect(isFolderColor(null)).toBe(false);
  });
});

