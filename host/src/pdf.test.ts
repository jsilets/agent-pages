import { describe, it, expect, vi } from 'vitest';
import worker from './worker';
import { blobKey, pdfKey } from './lib';
import { KIT } from './views';

vi.mock('../../brand/favicon.ico?inline', () => ({ default: 'data:image/x-icon;base64,AA==' }));
vi.mock('../../brand/apple-touch-icon.png?inline', () => ({ default: 'data:image/png;base64,AA==' }));

// Exercise the HTTP download with local storage and the Browser Run boundary.
function fixture(html: string, kind = 'page', failRender = false) {
  const files = new Map<string, string | ArrayBuffer>([[blobKey('test/brief', 1), html]]);
  const renderRequests: { action: string; options: BrowserRunPDFOptions }[] = [];
  const env = {
    ENVIRONMENT: 'development', ACCESS_AUD: '', ACCESS_TEAM: '',
    DB: { prepare: (sql: string) => ({ bind: () => ({
      first: async () => sql.startsWith('SELECT slug, version FROM shares') ? { slug: 'test/brief', version: 1 } : sql.includes('FROM versions') ? { version: 1 } : { slug: 'test/brief', title: 'Test Brief', kind, latest: 1 },
    }) }) },
    PAGES: {
      get: async (key: string) => files.has(key) ? {
        text: async () => files.get(key) as string,
        arrayBuffer: async () => files.get(key) as ArrayBuffer,
      } : null,
      put: async (key: string, value: ArrayBuffer) => { files.set(key, value); },
    },
    BROWSER: { quickAction: async (action: string, options: BrowserRunPDFOptions) => {
      renderRequests.push({ action, options });
      return failRender ? new Response('render failed', { status: 422 }) : new Response('%PDF-1.7\nrendered brief');
    } },
  };
  // The fixture supplies only the binding methods used by these HTTP routes.
  const request = (path = '/pdf/test/brief/1') => worker.fetch(new Request('https://pages.test' + path), env as unknown as Parameters<typeof worker.fetch>[1], {} as ExecutionContext);
  return { request, renderRequests, files };
}

describe('PDF download', () => {
  it('exports a document without waiting for slide readiness, even with stale deck metadata', async () => {
    const f = fixture('<main class="k-page">Brief</main><script>/* <main class="k-deck"> */</script>', 'deck');
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="test-brief-v1.pdf"');
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(await response.text()).toBe('%PDF-1.7\nrendered brief');
    expect(f.renderRequests.map(r => ({ action: r.action, wait: r.options.waitForSelector ?? null, viewport: r.options.viewport }))).toEqual([
      { action: 'pdf', wait: null, viewport: { width: 816, height: 1056 } },
    ]);
    const cached = await f.request();
    expect(await cached.text()).toBe('%PDF-1.7\nrendered brief');
    expect(f.renderRequests.length).toBe(1);
  });
  it('keeps slide readiness and slide dimensions for a deck', async () => {
    const f = fixture('<main class="k-deck"><section class="k-slide">Slide</section></main>');
    expect((await f.request()).status).toBe(200);
    expect(f.renderRequests[0].options.waitForSelector).toEqual({ selector: 'html[data-k-deck="ready"]', timeout: 20000 });
    expect(f.renderRequests[0].options.viewport).toEqual({ width: 1920, height: 1080 });
  });
  it('supports a shared document download', async () => {
    const f = fixture('<main class="k-page">Shared brief</main>');
    const response = await f.request('/s/' + 'a'.repeat(43) + '/pdf');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('%PDF-1.7\nrendered brief');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="test-brief-v1.pdf"');
  });
  it('returns an error instead of caching a failed render', async () => {
    const f = fixture('<main class="k-page">Brief</main>', 'page', true);
    const response = await f.request();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'the PDF render failed (422)' });
    expect([...f.files.keys()]).toEqual([blobKey('test/brief', 1)]);
    expect(f.files.has(pdfKey('test/brief', 1, KIT))).toBe(false);
  });
});
