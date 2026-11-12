// agent-pages: stores HTML pages with versions, shows them in a sandboxed viewer,
// and serves share links. See ../README.md for the routes and the auth model.
import kitCss from '../../kit/explain.css?raw';
import kitJs from '../../kit/explain.js?raw';
import faviconSvg from '../../brand/mark-small.svg?raw';
import faviconIco from '../../brand/favicon.ico?inline';
import touchIcon from '../../brand/apple-touch-icon.png?inline';
import { accessCookie, verifyAccessJwt, type Identity } from './auth';
import { auditFromHtml, auditLines, blobKey, claimId, type DeckAudit, type IconName, ftsQuery, isFolderColor, isFolderId, newFolderId, newToken, pageChunks, pageKind, type PageKind, parseMeta, parseTheme, pdfKey, route, thumbKey, withKit, withTheme, type Theme } from './lib';
import { KIT, READ_REPORTER, messageHtml, sharedHtml, viewerHtml, type PageRow, type VersionRow } from './views';
import { MAX_ACTIVE_MS, cleanLabels, cleanPing, deviceOf, isBot, osOf, referrerHost, summarize, visitorHash, type LinkRow, type PartRow, type ViewRow } from './share-views';
import { viewsHtml } from './views-page';
import { libraryHtml, type FolderRow, type Opens } from './library';
import { deriveActivity, type CommentRow, type Item, type RunRow, type VersionEvent } from './activity';

interface Env {
  DB: D1Database;
  PAGES: R2Bucket;
  BROWSER: BrowserRun;
  ENVIRONMENT: string;
  ACCESS_TEAM: string;
  ACCESS_AUD: string;
}

const MAX_BYTES = 5 * 1024 * 1024;

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

/** A version as a page. `extra` is a script for the end of the body: the reader report of a share link. */
async function rawPage(obj: R2ObjectBody, immutable: boolean, theme: Theme | null, extra = '') {
  let html = withKit(await obj.text(), kitCss, kitJs);
  if (extra) {
    const tag = `<script>${extra}</script>`;
    const end = html.search(/<\/body>/i);
    html = end < 0 ? html + tag : html.slice(0, end) + tag + html.slice(end);
  }
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

const PAGE_COLUMNS = 'slug, title, repo, kind, latest, created_at, updated_at, pinned_at, thumb, folder_id, (SELECT COUNT(*) FROM shares WHERE shares.slug = pages.slug AND shares.revoked_at IS NULL) AS shared';

async function getPage(env: Env, slug: string) {
  return env.DB.prepare(`SELECT ${PAGE_COLUMNS} FROM pages WHERE slug = ?`).bind(slug).first<PageRow>();
}

async function listPages(env: Env) {
  const { results } = await env.DB.prepare(`SELECT ${PAGE_COLUMNS} FROM pages ORDER BY updated_at DESC`).all<PageRow>();
  return results;
}

// ─── Opens ───────────────────────────────────────────────

/**
 * The first record of a reader. Every page counts as seen at its latest version, with no open time,
 * so the library does not start with a wall of news. The statement does nothing for a reader with rows.
 */
const seedOpens = (env: Env, reader: string) =>
  env.DB.prepare('INSERT OR IGNORE INTO page_opens (reader, slug, version, opened_at) SELECT ?1, slug, latest, NULL FROM pages WHERE NOT EXISTS (SELECT 1 FROM page_opens WHERE reader = ?1)').bind(reader);

/** Reads what the reader opened. */
async function listOpens(env: Env, reader: string): Promise<Opens> {
  await seedOpens(env, reader).run();
  const { results } = await env.DB.prepare('SELECT slug, version, opened_at FROM page_opens WHERE reader = ?').bind(reader).all<{ slug: string; version: number; opened_at: string | null }>();
  return Object.fromEntries(results.map((r) => [r.slug, { version: r.version, at: r.opened_at }]));
}

/**
 * Records that the reader saw a version in Activity, with no open of the page. The time of the last open stays.
 * The body is { version }. The seen version never goes down.
 */
async function markSeen(req: Request, env: Env, reader: string, slug: string) {
  const p = await getPage(env, slug);
  if (!p) return fail(404, 'no such page');
  const { version } = (await req.json().catch(() => ({}))) as { version?: unknown };
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > p.latest) return fail(400, 'version must be a version of the page');
  await env.DB.batch([
    seedOpens(env, reader),
    env.DB.prepare(
      'INSERT INTO page_opens (reader, slug, version, opened_at) VALUES (?, ?, ?, NULL) ON CONFLICT (reader, slug) DO UPDATE SET version = max(version, excluded.version)',
    ).bind(reader, slug, version),
  ]);
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

/** Records that the reader opened a version of a page. The seen version never goes down when the reader opens an older one. */
function recordOpen(env: Env, reader: string, slug: string, version: number) {
  return env.DB.batch([
    seedOpens(env, reader),
    env.DB.prepare(
      'INSERT INTO page_opens (reader, slug, version, opened_at) VALUES (?, ?, ?, ?) ON CONFLICT (reader, slug) DO UPDATE SET version = max(version, excluded.version), opened_at = excluded.opened_at',
    ).bind(reader, slug, version, now()),
  ]);
}

// ─── Activity ────────────────────────────────────────────

/**
 * The newest versions, comments and assistant runs, joined into one list. The comments and agent_runs
 * tables come from the comment branch. A database without them has versions only.
 * The query does not read the id of a run, because that id is a secret.
 */
async function listActivity(env: Env): Promise<Item[]> {
  const { results: versions } = await env.DB.prepare('SELECT slug, version, created_at FROM versions ORDER BY created_at DESC LIMIT 400').all<VersionEvent>();
  let comments: CommentRow[] = [];
  let runs: RunRow[] = [];
  try {
    comments = (await env.DB.prepare('SELECT id, slug, version, anchor, quote, body, author, mention, parent_id, status, created_at FROM comments ORDER BY created_at DESC LIMIT 600').all<CommentRow>()).results;
    runs = (await env.DB.prepare('SELECT comment_id, agent, status, started_at, finished_at, detail FROM agent_runs ORDER BY started_at DESC LIMIT 300').all<RunRow>()).results;
  } catch {
    // This database has no comments table or no agent_runs table.
  }
  return deriveActivity(versions, comments, runs, Date.now());
}

// ─── Folders ─────────────────────────────────────────────

const FOLDER_COLUMNS = 'id, name, parent_id, color, created_at, updated_at';

async function listFolders(env: Env) {
  const { results } = await env.DB.prepare(`SELECT ${FOLDER_COLUMNS} FROM folders ORDER BY name COLLATE NOCASE`).all<FolderRow>();
  return results;
}

const getFolder = (env: Env, id: string) => env.DB.prepare(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE id = ?`).bind(id).first<FolderRow>();

/** A folder name: trimmed, 1 to 80 characters, no slash. */
function folderName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim().replace(/\s+/g, ' ');
  return name && name.length <= 80 && !name.includes('/') ? name : null;
}

/** True when `id` is `ancestor` or sits anywhere below it. Moving a folder under itself would make a loop. */
async function isWithin(env: Env, id: string | null, ancestor: string) {
  for (let at = id, hops = 0; at && hops < 64; hops++) {
    if (at === ancestor) return true;
    at = (await env.DB.prepare('SELECT parent_id FROM folders WHERE id = ?').bind(at).first<{ parent_id: string | null }>())?.parent_id ?? null;
  }
  return false;
}

async function createFolder(req: Request, env: Env) {
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; parent_id?: unknown; color?: unknown };
  const name = folderName(body.name);
  if (!name) return fail(400, 'name must be 1 to 80 characters with no slash');
  const parent = body.parent_id ?? null;
  if (parent !== null && (typeof parent !== 'string' || !(await getFolder(env, parent)))) return fail(400, 'no such parent folder');
  const color = body.color ?? null;
  if (color !== null && !isFolderColor(color)) return fail(400, 'unknown color');
  const id = newFolderId(), at = now();
  await env.DB.prepare('INSERT INTO folders (id, name, parent_id, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, name, parent, color, at, at).run();
  return json(await getFolder(env, id), 201);
}

async function updateFolder(req: Request, env: Env, id: string) {
  const f = await getFolder(env, id);
  if (!f) return fail(404, 'no such folder');
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; parent_id?: unknown; color?: unknown };
  const name = body.name === undefined ? f.name : folderName(body.name);
  if (!name) return fail(400, 'name must be 1 to 80 characters with no slash');
  const parent = body.parent_id === undefined ? f.parent_id : body.parent_id;
  if (parent !== null) {
    if (typeof parent !== 'string' || !(await getFolder(env, parent))) return fail(400, 'no such parent folder');
    if (await isWithin(env, parent, id)) return fail(400, 'a folder cannot move into itself');
  }
  const color = body.color === undefined ? f.color : body.color;
  if (color !== null && !isFolderColor(color)) return fail(400, 'unknown color');
  await env.DB.prepare('UPDATE folders SET name = ?, parent_id = ?, color = ?, updated_at = ? WHERE id = ?').bind(name, parent, color, now(), id).run();
  return json(await getFolder(env, id));
}

/** Deletes the folder only. Its pages and folders move up to its parent, so nothing is lost. */
async function deleteFolder(env: Env, id: string) {
  const f = await getFolder(env, id);
  if (!f) return fail(404, 'no such folder');
  await env.DB.batch([
    env.DB.prepare('UPDATE pages SET folder_id = ? WHERE folder_id = ?').bind(f.parent_id, id),
    env.DB.prepare('UPDATE folders SET parent_id = ? WHERE parent_id = ?').bind(f.parent_id, id),
    env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(id),
  ]);
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

async function movePage(req: Request, env: Env, slug: string) {
  const body = (await req.json().catch(() => ({}))) as { folder_id?: unknown };
  const target = body.folder_id ?? null;
  if (target !== null && (typeof target !== 'string' || !isFolderId(target) || !(await getFolder(env, target)))) return fail(400, 'no such folder');
  const res = await env.DB.prepare('UPDATE pages SET folder_id = ? WHERE slug = ?').bind(target, slug).run();
  return res.meta.changes ? new Response(null, { status: 204, headers: BASE_HEADERS }) : fail(404, 'no such page');
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
  const html = await req.text();
  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > MAX_BYTES) return fail(413, 'the page is over 5 MB');
  if (!/<html[\s>]/i.test(html)) return fail(400, 'the body is not an HTML document');
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
  return json({ slug, version, kind, title: meta.title, url: `${origin}/p/${slug}`, versionUrl: `${origin}/p/${slug}/v/${version}`, ...(auditOut ? { audit: auditOut } : {}) }, 201);
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
    env.DB.prepare('DELETE FROM share_view_parts WHERE view_id IN (SELECT id FROM share_views WHERE slug = ?)').bind(slug),
    env.DB.prepare('DELETE FROM share_views WHERE slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM page_opens WHERE slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM page_text WHERE slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM versions WHERE slug = ?').bind(slug),
    env.DB.prepare('DELETE FROM pages WHERE slug = ?').bind(slug),
  ]);
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

async function createShare(req: Request, env: Env, slug: string, origin: string) {
  const p = await getPage(env, slug);
  if (!p) return fail(404, 'no such page');
  const body = (await req.json().catch(() => ({}))) as { version?: number | 'latest'; name?: unknown };
  const v = body.version ?? 'latest';
  // A name says who the link is for, as in DocSend and Papermark. One link for each reader tells the readers apart.
  const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim().slice(0, 80) || null : null;
  let version: number | null = null;
  if (v !== 'latest') {
    if (!Number.isInteger(v) || !(await getVersion(env, slug, v))) return fail(400, 'no such version');
    version = v;
  }
  const token = newToken();
  await env.DB.prepare('INSERT INTO shares (token, slug, version, name, created_at) VALUES (?, ?, ?, ?, ?)').bind(token, slug, version, name, now()).run();
  return json({ token, slug, version, name, url: `${origin}/s/${token}` }, 201);
}

async function listShares(env: Env, slug: string, origin: string) {
  const { results } = await env.DB.prepare('SELECT token, name, version, created_at FROM shares WHERE slug = ? AND revoked_at IS NULL ORDER BY created_at DESC').bind(slug).all<{ token: string; name: string | null; version: number | null; created_at: string }>();
  return json(results.map((s) => ({ ...s, url: `${origin}/s/${s.token}` })));
}

// ─── Views of share links ────────────────────────────────

/** The salt of today for the visitor hash. The first view of a day makes it and deletes the salts of two days ago and older. */
async function daySalt(env: Env) {
  const day = now().slice(0, 10);
  const get = () => env.DB.prepare('SELECT salt FROM share_salts WHERE day = ?').bind(day).first<{ salt: string }>();
  const row = await get();
  if (row) return row.salt;
  const old = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO share_salts (day, salt) VALUES (?, ?)').bind(day, newToken()),
    env.DB.prepare('DELETE FROM share_salts WHERE day <= ?').bind(old),
  ]);
  return (await get())!.salt;
}

/**
 * Starts a visit of a share link. The share page calls it from a script once the page in its frame has loaded,
 * so a link preview that runs no script makes no visit. The body has the referrer and the headings of the parts.
 * Each load is a new visit, as in Papermark and DocSend.
 */
async function startShareView(req: Request, env: Env, token: string) {
  const hit = await resolveShare(env, token);
  if (!hit) return fail(404, 'no such link');
  const ua = req.headers.get('user-agent');
  if (isBot(ua)) return json({ id: null });
  // The owner and anyone else who signed in to the host is not a reader of the link. Their visit does not count.
  if (env.ACCESS_AUD && (await verifyAccessJwt(accessCookie(req.headers.get('cookie')), { team: env.ACCESS_TEAM, aud: env.ACCESS_AUD }))?.kind === 'person') return json({ id: null });
  const body = (await req.json().catch(() => ({}))) as { referrer?: unknown; parts?: unknown };
  const labels = cleanLabels(body.parts);
  const visitor = await visitorHash(await daySalt(env), req.headers.get('cf-connecting-ip') || '', ua || '');
  const id = newToken().slice(0, 24), at = now();
  const country = typeof req.cf?.country === 'string' ? req.cf.country : null;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO share_views (id, token, slug, version, visitor, device, os, country, referrer, started_at, last_at, parts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, token, hit.page.slug, hit.version.version, visitor, deviceOf(ua), osOf(ua), country, referrerHost(body.referrer, new URL(req.url).hostname), at, at, labels.length),
    ...labels.map((label, i) => env.DB.prepare('INSERT INTO share_view_parts (view_id, part, label) VALUES (?, ?, ?)').bind(id, i, label)),
  ]);
  return json({ id }, 201);
}

/** Adds a report of the share page to its visit: the active time on each part since the last report, and a download. */
async function pingShareView(req: Request, env: Env, token: string) {
  const body = await req.json().catch(() => null);
  const id = body && typeof body === 'object' && typeof (body as { id?: unknown }).id === 'string' ? (body as { id: string }).id : '';
  const row = await env.DB.prepare('SELECT last_at, active_ms, parts FROM share_views WHERE id = ? AND token = ?').bind(id, token).first<{ last_at: string; active_ms: number; parts: number }>();
  if (!row) return fail(404, 'no such view');
  // A report can add at most the time since the visit last reported, and a little more for a slow network.
  const room = Math.min(Math.max(0, Date.now() - Date.parse(row.last_at)) + 15_000, MAX_ACTIVE_MS - row.active_ms);
  const p = cleanPing(body, row.parts, room);
  if (!p) return fail(400, 'bad report');
  let added = 0;
  const writes = [...p.parts].map(([part, ms]) => {
    added += ms;
    // A page with no headings has one part, which the visit did not list when it started.
    return env.DB.prepare('INSERT INTO share_view_parts (view_id, part, label, ms) VALUES (?, ?, ?, ?) ON CONFLICT (view_id, part) DO UPDATE SET ms = ms + excluded.ms')
      .bind(id, part, 'The page', ms);
  });
  await env.DB.batch([
    ...writes,
    env.DB.prepare('UPDATE share_views SET active_ms = active_ms + ?, downloads = downloads + ?, last_at = ? WHERE id = ?').bind(added, p.download ? 1 : 0, now(), id),
  ]);
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

/** The views of a page for its owner: the totals, the time on each part, the links, and each visit. Revoked links keep their visits. */
async function listViews(env: Env, slug: string) {
  const { results: links } = await env.DB.prepare('SELECT token, name, version, created_at, revoked_at FROM shares WHERE slug = ? ORDER BY created_at DESC').bind(slug).all<LinkRow>();
  const { results: views } = await env.DB.prepare('SELECT id, token, visitor, device, os, country, referrer, started_at, last_at, active_ms, parts, downloads FROM share_views WHERE slug = ? ORDER BY started_at DESC LIMIT 1000')
    .bind(slug).all<ViewRow>();
  const { results: parts } = await env.DB.prepare('SELECT p.view_id, p.part, p.label, p.ms FROM share_view_parts p JOIN share_views v ON v.id = p.view_id WHERE v.slug = ?')
    .bind(slug).all<PartRow>();
  return summarize(links, views, parts);
}

/** Resolves a share token to its page and version, or null when the page or version is gone. */
async function resolveShare(env: Env, token: string) {
  const s = await env.DB.prepare('SELECT slug, version FROM shares WHERE token = ? AND revoked_at IS NULL').bind(token).first<{ slug: string; version: number | null }>();
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
  // The share page reports its views with two writes. Only the share page itself may send them.
  if (r.kind === 'share-start' || r.kind === 'share-ping') {
    if (method !== 'POST') return fail(405, 'method not allowed');
    if (req.headers.get('origin') !== url.origin) return fail(403, 'cross-origin write refused');
    return r.kind === 'share-start' ? startShareView(req, env, r.token) : pingShareView(req, env, r.token);
  }
  if (r.kind === 'share-view' || r.kind === 'share-raw' || r.kind === 'share-pdf') {
    if (method !== 'GET') return fail(405, 'method not allowed');
    const hit = await resolveShare(env, r.token);
    if (!hit) return page(messageHtml('Link not found', 'This share link does not exist or was revoked.', nonce, '/s/_/explain.css'), nonce, 404);
    if (r.kind === 'share-view') return page(sharedHtml({ token: r.token, title: hit.page.title, repo: hit.page.repo, kind: hit.page.kind, version: hit.version }, nonce), nonce);
    if (r.kind === 'share-pdf') return pagePdf(env, hit.page.slug, hit.version.version, pdfName(hit.page.title, hit.version.version));
    const obj = await env.PAGES.get(blobKey(hit.page.slug, hit.version.version));
    return obj ? rawPage(obj, false, theme, READ_REPORTER) : fail(404, 'no such version');
  }

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
    case 'library': {
      return page(libraryHtml({ pages: await listPages(env), folders: await listFolders(env), activity: await listActivity(env), opens: await listOpens(env, who.who), me: who.who }, nonce), nonce);
    }
    case 'api-activity':
      if (method !== 'GET') return fail(405, 'method not allowed');
      return json({ pages: await listPages(env), activity: await listActivity(env), opens: await listOpens(env, who.who) });
    case 'view': {
      const p = await getPage(env, r.slug);
      if (!p) return page(messageHtml('Page not found', `No page has the slug ${r.slug}.`, nonce), nonce, 404);
      const { results: versions } = await env.DB.prepare('SELECT version, sha, created_at FROM versions WHERE slug = ? ORDER BY version DESC').bind(r.slug).all<VersionRow>();
      const version = versions.find((v) => v.version === (r.version ?? p.latest));
      if (!version) return page(messageHtml('Version not found', `${r.slug} has no version ${r.version}.`, nonce), nonce, 404);
      // A person who opens a page has seen that version. An agent that reads a page with a service token has not.
      if (who.kind === 'person') ctx.waitUntil(recordOpen(env, who.who, p.slug, version.version));
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
    case 'api-folders':
      if (method === 'GET') return json(await listFolders(env));
      if (method === 'POST') return createFolder(req, env);
      return fail(405, 'method not allowed');
    case 'api-folder':
      if (method === 'PATCH') return updateFolder(req, env, r.id);
      if (method === 'DELETE') return deleteFolder(env, r.id);
      return fail(405, 'method not allowed');
    case 'api-page-folder':
      if (method !== 'PUT') return fail(405, 'method not allowed');
      return movePage(req, env, r.slug);
    case 'views-page': {
      const p = await getPage(env, r.slug);
      if (!p) return page(messageHtml('Page not found', `No page has the slug ${r.slug}.`, nonce), nonce, 404);
      return page(viewsHtml({ slug: p.slug, title: p.title, repo: p.repo, kind: p.kind, views: await listViews(env, p.slug) }, nonce), nonce);
    }
    case 'api-views':
      if (method !== 'GET') return fail(405, 'method not allowed');
      if (!(await getPage(env, r.slug))) return fail(404, 'no such page');
      return json(await listViews(env, r.slug));
    case 'api-seen':
      if (method !== 'PUT') return fail(405, 'method not allowed');
      return markSeen(req, env, who.who, r.slug);
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
      // A revoked link stops at once. Its row stays, so its visits keep the name of the link.
      const res = await env.DB.prepare('UPDATE shares SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL').bind(now(), r.token).run();
      return res.meta.changes ? new Response(null, { status: 204, headers: BASE_HEADERS }) : fail(404, 'no such share');
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

