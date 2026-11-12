import { describe, expect, it } from 'vitest';
import { diffHtml, summarize } from './diff.js';
import source from './diff.js?raw';
import { inlineDiff } from './library';

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
