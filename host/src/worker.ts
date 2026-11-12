// agent-pages: stores HTML pages with versions, shows them in a sandboxed viewer,
// and serves share links. See ../README.md for the routes and the auth model.
import kitCss from '../../kit/explain.css?raw';
import kitJs from '../../kit/explain.js?raw';
import faviconSvg from '../../brand/mark-small.svg?raw';
import faviconIco from '../../brand/favicon.ico?inline';
import touchIcon from '../../brand/apple-touch-icon.png?inline';
import { verifyAccessJwt, type Identity } from './auth';
import { onCommentCreated } from './agents';
import { addComment, listThreads, resolveThread } from './comments';
import { auditFromHtml, auditLines, blobKey, claimId, type DeckAudit, type IconName, ftsQuery, newToken, newTokenId, pageChunks, pageKind, type PageKind, parseMeta, parseTheme, pdfKey, readJson, route, thumbKey, withKit, withTheme, type Theme } from './lib';
import { handleMcp } from './mcp';
import { handleRunResult, withRuns } from './sandbox';
import type { Env, Refusal, Stored } from './types';
import { KIT, libraryHtml, messageHtml, sharedHtml, viewerHtml, type PageRow, type VersionRow } from './views';

const MAX_BYTES = 5 * 1024 * 1024;
/** The limit for the JSON body of a comment or a connector token. */
const MAX_JSON_BYTES = 64 * 1024;

/** Stored pages run with no origin: they cannot read the host's cookies, storage or API. */
const PAGE_CSP = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox';

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};

function hostCsp(nonce: string) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "connect-src 'self'",
    "frame-src 'self'",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' } });

const fail = (status: number, error: string) => json({ error }, status);

function page(html: string, nonce: string, status = 200) {
  return new Response(html, {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': hostCsp(nonce) },
  });
}

/** Gives each claim with no id the id that search links to, so /p/<slug>#claim-2 opens at that claim. */
function withClaimIds(res: Response) {
  let n = 0;
  return new HTMLRewriter()
    .on('section.k-claim', {
      element(el) {
        n++;
        if (!el.getAttribute('id')) el.setAttribute('id', claimId(n));
      },
    })
    .transform(res);
}

async function rawPage(obj: R2ObjectBody, immutable: boolean, theme: Theme | null) {
  const html = withKit(await obj.text(), kitCss, kitJs);
  const body = theme ? withTheme(html, theme) : html;
  return withClaimIds(new Response(body, {
    headers: {
      ...BASE_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': PAGE_CSP,
      'cache-control': immutable ? 'private, max-age=31536000, immutable' : 'no-store',
    },
  }));
}

const now = () => new Date().toISOString();

/** Vite inlines the binary icons as data URLs. */
const fromDataUrl = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));

const ICON_FILES: Record<IconName, { body: string | Uint8Array; type: string }> = {
  'favicon.svg': { body: faviconSvg, type: 'image/svg+xml' },
  'favicon.ico': { body: fromDataUrl(faviconIco), type: 'image/x-icon' },
  'apple-touch-icon.png': { body: fromDataUrl(touchIcon), type: 'image/png' },
};

async function identify(req: Request, env: Env): Promise<Identity | null> {
  // Local development has no Access in front of it.
  if (env.ENVIRONMENT === 'development' && !env.ACCESS_AUD) return { who: 'local', kind: 'person' };
  return verifyAccessJwt(req.headers.get('cf-access-jwt-assertion'), { team: env.ACCESS_TEAM, aud: env.ACCESS_AUD });
}

const PAGE_COLUMNS = 'slug, title, repo, kind, latest, updated_at, pinned_at, thumb, (SELECT COUNT(*) FROM shares WHERE shares.slug = pages.slug) AS shared';

async function getPage(env: Env, slug: string) {
  return env.DB.prepare(`SELECT ${PAGE_COLUMNS} FROM pages WHERE slug = ?`).bind(slug).first<PageRow>();
}

async function listPages(env: Env) {
  const { results } = await env.DB.prepare(`SELECT ${PAGE_COLUMNS} FROM pages ORDER BY updated_at DESC`).all<PageRow>();
  return results;
}

/** Replaces the page's search rows with the text of this version. The title goes only on the first row, so a title match opens the top of the page. */
async function indexPage(env: Env, slug: string, title: string, html: string) {
  const chunks = pageChunks(html);
  if (chunks[0]?.anchor !== '') chunks.unshift({ anchor: '', heading: '', body: '' });
  const insert = env.DB.prepare('INSERT INTO page_text (slug, anchor, title, heading, body) VALUES (?, ?, ?, ?, ?)');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM page_text WHERE slug = ?').bind(slug),
    ...chunks.map((c, i) => insert.bind(slug, c.anchor, i === 0 ? title : '', c.heading, c.body)),
  ]);
}

/** Takes a light and a dark screenshot of the top of the page, or of a deck's first slide, and stores them in R2. */
async function makeThumbs(env: Env, slug: string, version: number, html: string) {
  const deck = pageKind(html) === 'deck';
  for (const theme of ['light', 'dark'] as const) {
    const res = await env.BROWSER.quickAction('screenshot', {
      // data-k-capture makes the kit show the first slide alone, with no toolbar or sidebar.
      html: withTheme(withKit(deck ? html.replace(/<html\b/i, '<html data-k-capture') : html, kitCss, kitJs), theme),
      viewport: deck ? { width: 960, height: 540 } : { width: 960, height: 600 },
      ...(deck ? { waitForSelector: { selector: 'html[data-k-deck="ready"]', timeout: 20000 } } : {}),
      // The kit fades each block in. Stop that, so the shot shows the finished page.
      addStyleTag: [{ content: "*, *::before, *::after { animation: none !important; transition: none !important; }" }],
      gotoOptions: { waitUntil: 'networkidle0', timeout: 20000 },
      screenshotOptions: { type: 'webp', quality: 72 },
      cacheTTL: 0,
    });
    if (!res.ok) throw new Error(`screenshot failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    await env.PAGES.put(thumbKey(slug, version, theme), await res.arrayBuffer(), { httpMetadata: { contentType: 'image/webp' } });
  }
  await env.DB.prepare('UPDATE pages SET thumb = ? WHERE slug = ? AND COALESCE(thumb, 0) < ?').bind(version, slug, version).run();
}

/** Every deck runs the kit's audit when it loads. Browser Rendering opens the deck and reads the report. */
async function auditDeck(env: Env, html: string): Promise<DeckAudit | { error: string }> {
  try {
    const res = await env.BROWSER.quickAction('content', {
      html: withTheme(withKit(html, kitCss, kitJs), 'light'),
      viewport: { width: 1920, height: 1080 },
      waitForSelector: { selector: 'html[data-k-deck="ready"]', timeout: 20000 },
      gotoOptions: { waitUntil: 'networkidle0', timeout: 20000 },
      cacheTTL: 0,
    });
    if (!res.ok) return { error: `the audit render failed (${res.status})` };
    const body = (await res.json()) as { result?: string };
    return auditFromHtml(body.result || '') ?? { error: 'the deck wrote no audit report' };
  } catch (e) {
    return { error: `the audit did not run: ${String((e as Error).message || e).slice(0, 160)}` };
  }
}

/** Export the requested version using its document or slide print layout. */
async function pagePdf(env: Env, slug: string, version: number, filename: string) {
  const key = pdfKey(slug, version, KIT);
  let pdf: ArrayBuffer | null = null;
  const cached = await env.PAGES.get(key);
  if (cached) pdf = await cached.arrayBuffer();
  else {
    const obj = await env.PAGES.get(blobKey(slug, version));
    if (!obj) return fail(404, 'no such version');
    const html = await obj.text();
    const deck = pageKind(html) === 'deck';
    const res = await env.BROWSER.quickAction('pdf', {
      html: withTheme(withKit(html, kitCss, kitJs), 'light'),
      viewport: deck ? { width: 1920, height: 1080 } : { width: 816, height: 1056 },
      emulateMediaType: 'print',
      ...(deck ? { waitForSelector: { selector: 'html[data-k-deck="ready"]', timeout: 20000 } } : {}),
      addStyleTag: [{ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' }],
      gotoOptions: { waitUntil: 'networkidle0', timeout: 20000 },
      pdfOptions: { preferCSSPageSize: true, printBackground: true },
      cacheTTL: 0,
    });
    if (!res.ok) return fail(502, `the PDF render failed (${res.status})`);
    pdf = await res.arrayBuffer();
    await env.PAGES.put(key, pdf, { httpMetadata: { contentType: 'application/pdf' } });
  }
  return new Response(pdf, {
    headers: { ...BASE_HEADERS, 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${filename}.pdf"`, 'cache-control': 'private, max-age=300' },
  });
}

const pdfName = (title: string, version: number) => (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'deck') + '-v' + version;

/** Builds the search rows and the thumbnails for the latest version again. */
async function refresh(env: Env, slug: string) {
  const p = await getPage(env, slug);
  if (!p) return fail(404, 'no such page');
  const obj = await env.PAGES.get(blobKey(slug, p.latest));
  if (!obj) return fail(404, 'no such version');
  const html = await obj.text();
  await env.DB.prepare('UPDATE pages SET kind = ? WHERE slug = ?').bind(pageKind(html), slug).run();
  await indexPage(env, slug, p.title, html);
  await makeThumbs(env, slug, p.latest, html);
  return json({ slug, version: p.latest, indexed: true, thumb: true });
}

/** The best match on each page, best page first. The snippet marks matches with \u0002 and \u0003. */
async function search(env: Env, q: string, origin: string) {
  const match = ftsQuery(q);
  if (!match) return json([]);
  const { results } = await env.DB.prepare(
    `SELECT page_text.slug AS slug, anchor, heading, snippet(page_text, -1, char(2), char(3), '…', 16) AS snippet, pages.title AS title, pages.repo AS repo
     FROM page_text JOIN pages ON pages.slug = page_text.slug
     WHERE page_text MATCH ? ORDER BY bm25(page_text, 0, 0, 10, 4, 1) LIMIT 200`,
  )
    .bind(match)
    .all<{ slug: string; anchor: string; heading: string; snippet: string; title: string; repo: string | null }>();
  const seen = new Set<string>();
  const hits = results.filter((r) => !seen.has(r.slug) && seen.add(r.slug)).slice(0, 30);
  return json(hits.map((h) => ({ ...h, url: `${origin}/p/${h.slug}${h.anchor ? `#${h.anchor}` : ''}` })));
}

async function getVersion(env: Env, slug: string, version: number) {
  return env.DB.prepare('SELECT version, sha, created_at FROM versions WHERE slug = ? AND version = ?').bind(slug, version).first<VersionRow>();
}

async function publish(req: Request, env: Env, ctx: ExecutionContext, slug: string, origin: string) {
  if (!(req.headers.get('content-type') || '').startsWith('text/html')) return fail(415, 'send the page as text/html');
  if (+(req.headers.get('content-length') || 0) > MAX_BYTES) return fail(413, 'the page is over 5 MB');
  const out = await storeVersion(env, ctx, slug, await req.text(), origin);
  return 'error' in out ? fail(out.status, out.error) : json(out, 201);
}

/** Stores the HTML as a new version of the page. A publish and the edit_page tool of the MCP connector both use it. */
async function storeVersion(env: Env, ctx: ExecutionContext, slug: string, html: string, origin: string): Promise<Stored | Refusal> {
  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > MAX_BYTES) return { status: 413, error: 'the page is over 5 MB' };
  if (!/<html[\s>]/i.test(html)) return { status: 400, error: 'the body is not an HTML document' };
  const meta = parseMeta(html, slug);
  const kind: PageKind = pageKind(html);
  const at = now();
  // One statement picks the next number, so two publishes of one slug never share a version.
  await env.DB.prepare('INSERT INTO pages (slug, title, repo, latest, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT (slug) DO NOTHING')
    .bind(slug, meta.title, meta.repo, at, at)
    .run();
  const row = await env.DB.prepare(
    'INSERT INTO versions (slug, version, sha, bytes, created_at) SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ? FROM versions WHERE slug = ? RETURNING version',
  )
    .bind(slug, meta.sha, bytes, at, slug)
    .first<{ version: number }>();
  const version = row!.version;
  try {
    await env.PAGES.put(blobKey(slug, version), html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  } catch (e) {
    await env.DB.prepare('DELETE FROM versions WHERE slug = ? AND version = ?').bind(slug, version).run();
    throw e;
  }
  await env.DB.prepare('UPDATE pages SET latest = MAX(latest, ?), title = ?, repo = ?, kind = ?, updated_at = ? WHERE slug = ?')
    .bind(version, meta.title, meta.repo, kind, at, slug)
    .run();
  await indexPage(env, slug, meta.title, html);
  // A thumbnail takes a few seconds. The library shows a placeholder until it exists.
  ctx.waitUntil(makeThumbs(env, slug, version, html).catch((e) => console.error('thumbnail', slug, version, e)));
  // A deck waits for its audit, so the agent that published it sees the slides that overflow.
  const audit = kind === 'deck' ? await auditDeck(env, html) : undefined;
  const auditOut = audit && ('error' in audit ? audit : { pass: audit.pass, problems: auditLines(audit) });
  return { slug, version, kind, title: meta.title, url: `${origin}/p/${slug}`, versionUrl: `${origin}/p/${slug}/v/${version}`, ...(auditOut ? { audit: auditOut } : {}) };
}

async function deletePage(env: Env, slug: string) {
  if (!(await getPage(env, slug))) return fail(404, 'no such page');
  let cursor: string | undefined;
  do {
    const list = await env.PAGES.list({ prefix: `pages/${slug}/`, cursor });
    if (list.objects.length) await env.PAGES.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shares WHERE slug = ?').bind(slug),
    // The runs go first, because a run finds its page through its comment.
    env.DB.prepare('DELETE FROM agent_runs WHERE comment_id IN (SELECT id FROM comments WHERE slug = ?)').bind(slug),
    env.DB.prepare('DELETE FROM connector_tokens WHERE slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM comments WHERE slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM page_text WHERE slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM versions WHERE slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM pages WHERE slug = ?').bind(slug),
  ]);
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

async function createShare(req: Request, env: Env, slug: string, origin: string) {
  const p = await getPage(env, slug);
  if (!p) return fail(404, 'no such page');
  const body = (await req.json().catch(() => ({}))) as { version?: number | 'latest' };
  const v = body.version ?? 'latest';
  let version: number | null = null;
  if (v !== 'latest') {
    if (!Number.isInteger(v) || !(await getVersion(env, slug, v))) return fail(400, 'no such version');
    version = v;
  }
  const token = newToken();
  await env.DB.prepare('INSERT INTO shares (token, slug, version, created_at) VALUES (?, ?, ?, ?)').bind(token, slug, version, now()).run();
  return json({ token, slug, version, url: `${origin}/s/${token}` }, 201);
}

async function listShares(env: Env, slug: string, origin: string) {
  const { results } = await env.DB.prepare('SELECT token, version, created_at FROM shares WHERE slug = ? ORDER BY created_at DESC').bind(slug).all<{ token: string; version: number | null; created_at: string }>();
  return json(results.map((s) => ({ ...s, url: `${origin}/s/${s.token}` })));
}

/** Resolves a share token to its page and version, or null when the page or version is gone. */
async function resolveShare(env: Env, token: string) {
  const s = await env.DB.prepare('SELECT slug, version FROM shares WHERE token = ?').bind(token).first<{ slug: string; version: number | null }>();
  if (!s) return null;
  const p = await getPage(env, s.slug);
  if (!p) return null;
  const v = await getVersion(env, s.slug, s.version ?? p.latest);
  return v ? { page: p, version: v } : null;
}

async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const r = route(url.pathname);
  const nonce = newToken();
  const method = req.method;
  // The viewer asks for ?theme=light or ?theme=dark when the reader picks a theme.
  const theme = parseTheme(url.searchParams.get('theme'));

  const css = () => new Response(kitCss, { headers: { ...BASE_HEADERS, 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' } });
  // The kit CSS is public, so a share link can load it with no login.
  if (r.kind === 'share-css') return css();
  if (r.kind === 'icon') {
    const f = ICON_FILES[r.name];
    return new Response(f.body, { headers: { ...BASE_HEADERS, 'content-type': f.type, 'cache-control': 'public, max-age=86400' } });
  }

  // Share links: Access lets /s/* through with no login, so the token is the only check.
  if (r.kind === 'share-view' || r.kind === 'share-raw' || r.kind === 'share-pdf') {
    if (method !== 'GET') return fail(405, 'method not allowed');
    const hit = await resolveShare(env, r.token);
    if (!hit) return page(messageHtml('Link not found', 'This share link does not exist or was revoked.', nonce, '/s/_/explain.css'), nonce, 404);
    if (r.kind === 'share-view') return page(sharedHtml({ token: r.token, title: hit.page.title, repo: hit.page.repo, kind: hit.page.kind, version: hit.version }, nonce), nonce);
    if (r.kind === 'share-pdf') return pagePdf(env, hit.page.slug, hit.version.version, pdfName(hit.page.title, hit.version.version));
    const obj = await env.PAGES.get(blobKey(hit.page.slug, hit.version.version));
    return obj ? rawPage(obj, false, theme) : fail(404, 'no such version');
  }

  // The MCP connector sits under /s/ too, so Access lets it through. The connector token is the only check.
  if (r.kind === 'mcp') return handleMcp(req, env, ctx, r.token, url.origin, storeVersion);
  // The sandbox runner reports a run here. The secret run id is the only check.
  if (r.kind === 'run-result') return handleRunResult(req, env, r.id);

  const who = await identify(req, env);
  if (!who) return fail(403, 'Cloudflare Access did not sign this request');

  // A page runs with an opaque origin, so its requests carry "Origin: null". Writes must come
  // from the host itself or from a client that sends no Origin (the CLI).
  if (method !== 'GET' && method !== 'HEAD') {
    const o = req.headers.get('origin');
    if (o && o !== url.origin) return fail(403, 'cross-origin write refused');
  }

  switch (r.kind) {
    case 'kit-css':
      return css();
    case 'library':
      return page(libraryHtml(await listPages(env), nonce), nonce);
    case 'view': {
      const p = await getPage(env, r.slug);
      if (!p) return page(messageHtml('Page not found', `No page has the slug ${r.slug}.`, nonce), nonce, 404);
      const { results: versions } = await env.DB.prepare('SELECT version, sha, created_at FROM versions WHERE slug = ? ORDER BY version DESC').bind(r.slug).all<VersionRow>();
      const version = versions.find((v) => v.version === (r.version ?? p.latest));
      if (!version) return page(messageHtml('Version not found', `${r.slug} has no version ${r.version}.`, nonce), nonce, 404);
      return page(viewerHtml({ slug: p.slug, title: p.title, repo: p.repo, kind: p.kind, version, versions, latest: p.latest, followsLatest: r.version === null }, nonce), nonce);
    }
    case 'raw': {
      const obj = await env.PAGES.get(blobKey(r.slug, r.version));
      return obj ? rawPage(obj, true, theme) : fail(404, 'no such version');
    }
    case 'pdf': {
      const p = await getPage(env, r.slug);
      if (!p) return fail(404, 'no such page');
      if (!(await getVersion(env, r.slug, r.version))) return fail(404, 'no such version');
      return pagePdf(env, r.slug, r.version, pdfName(p.title, r.version));
    }
    case 'api-list':
      if (method !== 'GET') return fail(405, 'method not allowed');
      return json((await listPages(env)).map((p) => ({ ...p, url: `${url.origin}/p/${p.slug}` })));
    case 'api-search':
      if (method !== 'GET') return fail(405, 'method not allowed');
      return search(env, url.searchParams.get('q') || '', url.origin);
    case 'api-pin': {
      if (method !== 'PUT' && method !== 'DELETE') return fail(405, 'method not allowed');
      const res = await env.DB.prepare('UPDATE pages SET pinned_at = ? WHERE slug = ?').bind(method === 'PUT' ? now() : null, r.slug).run();
      return res.meta.changes ? new Response(null, { status: 204, headers: BASE_HEADERS }) : fail(404, 'no such page');
    }
    case 'api-refresh':
      if (method !== 'POST') return fail(405, 'method not allowed');
      return refresh(env, r.slug);
    case 'thumb': {
      const obj = await env.PAGES.get(thumbKey(r.slug, r.version, r.theme));
      if (!obj) return fail(404, 'no such thumbnail');
      return new Response(obj.body, { headers: { ...BASE_HEADERS, 'content-type': 'image/webp', 'cache-control': 'private, max-age=31536000, immutable' } });
    }
    case 'api-page':
      if (method === 'PUT') return publish(req, env, ctx, r.slug, url.origin);
      if (method === 'DELETE') return deletePage(env, r.slug);
      if (method === 'GET') {
        const p = await getPage(env, r.slug);
        return p ? json({ ...p, url: `${url.origin}/p/${p.slug}` }) : fail(404, 'no such page');
      }
      return fail(405, 'method not allowed');
    case 'api-shares':
      if (method === 'POST') return createShare(req, env, r.slug, url.origin);
      if (method === 'GET') return listShares(env, r.slug, url.origin);
      return fail(405, 'method not allowed');
    case 'api-share': {
      if (method !== 'DELETE') return fail(405, 'method not allowed');
      const res = await env.DB.prepare('DELETE FROM shares WHERE token = ?').bind(r.token).run();
      return res.meta.changes ? new Response(null, { status: 204, headers: BASE_HEADERS }) : fail(404, 'no such share');
    }
    case 'api-comments': {
      if (method === 'GET') {
        if (!(await getPage(env, r.slug))) return fail(404, 'no such page');
        const status = url.searchParams.get('status');
        return json(await withRuns(env, r.slug, await listThreads(env, { slug: r.slug, status: status === 'open' || status === 'resolved' ? status : undefined })));
      }
      if (method !== 'POST') return fail(405, 'method not allowed');
      const body = (await readJson(req, MAX_JSON_BYTES)) as { body?: unknown; anchor?: unknown; quote?: unknown; parent_id?: unknown } | null | undefined;
      if (!body || typeof body !== 'object') return fail(400, 'send the comment as JSON of at most 64 KB');
      const c = await addComment(env, { slug: r.slug, body: body.body, anchor: body.anchor, quote: body.quote, parent_id: body.parent_id, author: who.who });
      if ('error' in c) return fail(c.status, c.error);
      // The agent triggers run after the response, so a slow assistant never holds the comment back.
      ctx.waitUntil(onCommentCreated(env, ctx, c, url.origin).catch((e) => console.error('comment hook', c.id, e)));
      return json(c, 201);
    }
    case 'api-comment-resolve':
      if (method !== 'PUT') return fail(405, 'method not allowed');
      return (await resolveThread(env, r.id)) ? new Response(null, { status: 204, headers: BASE_HEADERS }) : fail(404, 'no such thread');
    case 'api-connector-tokens': {
      if (method === 'GET') {
        const at = now();
        await env.DB.prepare('DELETE FROM connector_tokens WHERE expires_at <= ?').bind(at).run();
        const { results } = await env.DB.prepare('SELECT id, substr(token, -4) AS last4, label, slug, expires_at, created_at FROM connector_tokens ORDER BY created_at DESC').all();
        return json(results);
      }
      if (method !== 'POST') return fail(405, 'method not allowed');
      const body = (await readJson(req, MAX_JSON_BYTES)) as { label?: unknown } | null | undefined;
      const label = body && typeof body.label === 'string' ? body.label.trim() : '';
      if (!label || label.length > 80) return fail(400, 'send a label of 1 to 80 characters as JSON');
      const token = newToken();
      const id = newTokenId();
      await env.DB.prepare('INSERT INTO connector_tokens (token, id, label, created_at) VALUES (?, ?, ?, ?)').bind(token, id, label, now()).run();
      // The response is the one place that shows the whole token. The id is for the DELETE route.
      return json({ id, token, label, mcp_url: `${url.origin}/s/_mcp/${token}` }, 201);
    }
    case 'api-connector-token': {
      if (method !== 'DELETE') return fail(405, 'method not allowed');
      const res = await env.DB.prepare('DELETE FROM connector_tokens WHERE id = ?1 OR token = ?1').bind(r.token).run();
      return res.meta.changes ? new Response(null, { status: 204, headers: BASE_HEADERS }) : fail(404, 'no such connector token');
    }
    default:
      return url.pathname.startsWith('/api/') ? fail(404, 'no such route') : page(messageHtml('Not found', 'No page is at this address.', nonce), nonce, 404);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handle(req, env, ctx);
    } catch (e) {
      console.error(e);
      return fail(500, 'internal error');
    }
  },
} satisfies ExportedHandler<Env>;

