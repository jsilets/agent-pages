import { describe, expect, it } from 'vitest';
import { diffHtml, summarize } from './diff.js';
import source from './diff.js?raw';
import { inlineDiff, libraryHtml } from './library';

// The library page holds a copy of diff.js in its inline script. The copy has no "export" and no text that
// ends or comments out a script element. These tests run the copy, as the browser does.
const copy = inlineDiff(source);
const Diff = new Function(copy + 'return Diff;')() as { diffHtml: typeof diffHtml; summarize: typeof summarize };

const before = '<!doctype html><html><head><title>Plan</title></head><body><main><h1>Plan</h1><!-- note --><p>We find almost no copywriters.</p><ul><li>One</li><li>Two</li></ul></main></body></html>';
const after = '<!doctype html><html><head><title>Plan</title></head><body><main><h1>Plan</h1><!-- note --><p>We find no copywriters.</p><ul><li>One</li><li>Two</li><li>Three</li></ul></main></body></html>';

describe('the copy of the diff in the library page', () => {
  it('has no text that ends the inline script or opens a comment in it', () => {
    expect(source).toContain('<!--');
    expect(copy).not.toContain('<!--');
    expect(copy.toLowerCase()).not.toContain('</script');
  });

  it('marks two versions as the module does', () => {
    const want = diffHtml(before, after, { review: true });
    const got = Diff.diffHtml(before, after, { review: true });
    expect(got.html).toBe(want.html);
    expect(got.html).toContain('We find <del data-diff>almost </del>no copywriters.');
    expect(got.html).toContain('<!-- note -->');
    expect(Diff.summarize(got.changes)).toEqual(summarize(want.changes));
  });
});

describe('the Assistants control of the library', () => {
  const html = libraryHtml({ pages: [], folders: [], activity: [], opens: {}, me: 'ann@example.com' }, 'n0nce');
  it('puts the row at the bottom of the sidebar, the compact chip in the bar, and the dialog in the page', () => {
    const side = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
    expect(side.lastIndexOf('id="assist-side"')).toBeGreaterThan(side.indexOf('id="tree"'));
    expect(side).toContain('<div class="l-foot"><button type="button" class="l-nav a-side is-wait" id="assist-side" aria-label="Assistants: checking"');
    const bar = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(bar).toContain('id="assist-chip"');
    expect(html).toContain('<dialog class="v-dlg a-dlg" id="assist"');
  });
  it('has one script that the browser can parse, with the helpers of the dialog apart from the library', () => {
    const script = html.slice(html.lastIndexOf('<script nonce="n0nce">') + '<script nonce="n0nce">'.length, html.lastIndexOf('</script>'));
    expect(script).toContain('const Assistants = ');
    expect(() => new Function(script)).not.toThrow();
  });
});
