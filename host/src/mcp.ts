// The MCP connector at POST /s/_mcp/<token>: MCP Streamable HTTP with no session and no SSE.
// Each POST carries one JSON-RPC 2.0 message, and the answer is one JSON body.
// The connector token is the only check for a tool. The tools reach pages and comments, and nothing else.
import { editEvents, noteActivity, recordActivity } from './activity';
import { addComment, getComment, listThreads, MAX_COMMENT, resolveThread } from './comments';
import { applyEdits, blobKey, isSlug, isToken, readJson, withoutKit, type Edit } from './lib';
import { RpcError, type Comment, type Env, type Handler, type McpContext, type StoreVersion, type Thread } from './types';

/** The protocol versions that start with `initialize`. The first one answers a client that asks for another version. */
export const LEGACY = ['2025-06-18', '2025-03-26'];
/** The protocol version with no `initialize`: each request carries its version in `_meta` and in headers. */
export const MODERN = '2026-07-28';
/** The protocol versions the connector speaks. */
export const PROTOCOLS = [...LEGACY, MODERN];

const SERVER_INFO = { name: 'agent-pages', title: 'Agent Pages', version: '0.1.0' };
const INSTRUCTIONS =
  'Pages are HTML documents with versions. People write comments on them. Read a page with get_page. To change it for a comment, call edit_page with comment_id and reply: one call stores the edit and the answer. Use reply_to_comment for a question, and for a comment that needs no edit.';
/** How long a client may keep the tool list and the answer of server/discover. Both change only with a deploy. */
const CACHE = { ttlMs: 5 * 60_000, cacheScope: 'public' };
const META = 'io.modelcontextprotocol/';
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

/**
 * The path /s/_mcp/discover is not a connector token. The sandbox runner sends its shared secret there and gets the
 * answers that are the same for each token: initialize, server/discover and tools/list. So a program in the sandbox can
 * connect before its run has a token. No tool runs there.
 */
export const DISCOVER = 'discover';
const DISCOVER_METHODS = ['initialize', 'ping', 'server/discover', 'tools/list'];

/** An edit_page call carries new page text, so the limit is well over a comment and under a whole page. */
const MAX_RPC_BYTES = 1024 * 1024;

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store', ...(body === null ? {} : { 'content-type': 'application/json' }), ...headers },
  });

const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });

// ─── Tools ──────────────────────────────────────────────────────────

/** A tool throws this to return a tool error (isError: true) that the assistant reads and can fix. */
class ToolError extends Error {}

const text = { type: 'string' } as const;
/** Tool annotations. A client can run a read-only tool with no approval from the person. */
const READS = { readOnlyHint: true };
/** An edit makes a new version and a reply adds a comment, so neither one destroys data. Both stay inside this host. */
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export const TOOLS = [
  {
    name: 'list_pages',
    title: 'List pages',
    annotations: { title: 'List pages', ...READS },
    description: 'List every page: slug, title, kind (page or deck), latest version, and the number of open comment threads.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_page',
    title: 'Get page',
    annotations: { title: 'Get page', ...READS },
    description: 'Get one page: title, kind, latest version, and the stored HTML of the latest version. A short comment stands in for the kit CSS and for the kit JS.',
    inputSchema: { type: 'object', properties: { slug: { ...text, description: 'The page slug, <group>/<name>.' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'list_comments',
    title: 'List comments',
    annotations: { title: 'List comments', ...READS },
    description: 'List comment threads with their replies. The default is the open threads on every page.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { ...text, description: 'Only the threads on this page.' },
        mention: { ...text, enum: ['claude', 'chatgpt'], description: 'Only the threads that mention this assistant.' },
        status: { ...text, enum: ['open', 'resolved', 'all'], description: 'Default: open.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'edit_page',
    title: 'Edit page',
    annotations: { title: 'Edit page', ...WRITES },
    description:
      'Edit the latest version of a page by exact text replacement in its stored HTML, and store the result as a new version. Each old_text must occur exactly once. When an edit fails, the tool stores nothing: no version and no reply. To answer the comment that asked for the edit, give comment_id and reply in this call, and do not call reply_to_comment after it.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { ...text, description: 'The page slug, <group>/<name>.' },
        edits: {
          type: 'array',
          minItems: 1,
          description: 'The edits, applied in order.',
          items: { type: 'object', properties: { old_text: { ...text, description: 'Text that occurs exactly once in the HTML.' }, new_text: { ...text, description: 'The text that replaces it.' } }, required: ['old_text', 'new_text'], additionalProperties: false },
        },
        comment_id: { ...text, description: 'The comment that asked for the edit, if one did.' },
        reply: {
          type: 'object',
          description: 'The answer to the thread of comment_id. The tool stores it after the new version, and only when each edit succeeds. It needs comment_id.',
          properties: { body: { ...text, description: 'The reply text: what the edit changed.' }, resolve: { type: 'boolean', description: 'True resolves the thread too. Default: false.' } },
          required: ['body'],
          additionalProperties: false,
        },
      },
      required: ['slug', 'edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'reply_to_comment',
    title: 'Reply to comment',
    annotations: { title: 'Reply to comment', ...WRITES },
    description: 'Add a reply to a comment thread: a question, or the answer to a comment that needs no edit. Set resolve to true to resolve the thread too. With an edit, use the reply of edit_page in place of this tool.',
    inputSchema: {
      type: 'object',
      properties: { comment_id: { ...text, description: 'The id of a comment in the thread.' }, body: { ...text, description: 'The reply text.' }, resolve: { type: 'boolean', description: 'Default: false.' } },
      required: ['comment_id', 'body'],
      additionalProperties: false,
    },
  },
];

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v) throw new ToolError(`${name} must be a string`);
  return v;
};
/** Refuses a page that is outside the scope of the connector token. */
const inScope = (slug: string, ctx: McpContext): string => {
  if (ctx.slug && slug !== ctx.slug) throw new ToolError(`this connector token reaches only the page ${ctx.slug}, not ${slug}`);
  return slug;
};
const slugOf = (v: unknown, ctx: McpContext): string => {
  if (!isSlug(str(v, 'slug'))) throw new ToolError('slug must be <group>/<name>');
  return inScope(v as string, ctx);
};

interface PageInfo {
  slug: string;
  title: string;
  kind: string;
  latest: number;
}

async function pageOf(env: Env, slug: string) {
  const p = await env.DB.prepare('SELECT slug, title, kind, latest FROM pages WHERE slug = ?').bind(slug).first<PageInfo>();
  if (!p) throw new ToolError(`no page has the slug ${slug}`);
  return p;
}

async function pageHtml(env: Env, p: PageInfo) {
  const obj = await env.PAGES.get(blobKey(p.slug, p.latest));
  if (!obj) throw new ToolError(`version ${p.latest} of ${p.slug} has no stored HTML`);
  return obj.text();
}

const replyOut = (c: Comment) => ({ id: c.id, body: c.body, author: c.author, mention: c.mention, created_at: c.created_at });
const threadOut = (t: Thread) => ({ id: t.id, slug: t.slug, version: t.version, anchor: t.anchor, quote: t.quote, body: t.body, author: t.author, mention: t.mention, status: t.status, created_at: t.created_at, replies: t.replies.map(replyOut) });

type Args = Record<string, unknown>;
/** A tool returns an object. The connector sends it as JSON text and as structuredContent. A `content` member replaces both. */
type Tool = (env: Env, args: Args, ctx: McpContext, x: ExecutionContext, store: StoreVersion) => Promise<Record<string, unknown>>;

const tools: Record<string, Tool> = {
  async list_pages(env, _args, ctx) {
    const { results } = await env.DB.prepare(
      "SELECT slug, title, kind, latest, (SELECT COUNT(*) FROM comments WHERE comments.slug = pages.slug AND parent_id IS NULL AND status = 'open') AS open_comments FROM pages WHERE (?1 IS NULL OR slug = ?1) ORDER BY updated_at DESC",
    )
      .bind(ctx.slug ?? null)
      .all<PageInfo & { open_comments: number }>();
    return { pages: results.map((p) => ({ ...p, url: `${ctx.origin}/p/${p.slug}` })) };
  },
  async get_page(env, args, ctx) {
    const p = await pageOf(env, slugOf(args.slug, ctx));
    // The kit CSS and JS are the same on every page, so the assistant does not get them. edit_page edits the full HTML.
    const html = withoutKit(await pageHtml(env, p));
    // The HTML goes out as its own text block, not inside JSON, so the assistant can copy old_text from it exactly.
    const meta = { slug: p.slug, title: p.title, kind: p.kind, version: p.latest, url: `${ctx.origin}/p/${p.slug}` };
    return { content: [{ type: 'text', text: JSON.stringify(meta) }, { type: 'text', text: html }] };
  },
  async list_comments(env, args, ctx) {
    const status = args.status ?? 'open';
    if (status !== 'open' && status !== 'resolved' && status !== 'all') throw new ToolError('status must be open, resolved or all');
    if (args.mention != null && args.mention !== 'claude' && args.mention !== 'chatgpt') throw new ToolError('mention must be claude or chatgpt');
    const threads = await listThreads(env, { slug: args.slug == null ? ctx.slug : slugOf(args.slug, ctx), status: status === 'all' ? undefined : status, mention: args.mention ?? undefined });
    return { threads: threads.map(threadOut) };
  },
  async edit_page(env, args, ctx, x, store) {
    const p = await pageOf(env, slugOf(args.slug, ctx));
    const edits = args.edits;
    if (!Array.isArray(edits) || !edits.length) throw new ToolError('edits must be a list with one edit or more');
    if (!edits.every((e): e is Edit => !!e && typeof e.old_text === 'string' && typeof e.new_text === 'string')) throw new ToolError('each edit needs old_text and new_text as strings');
    let comment: Comment | null = null;
    if (args.comment_id != null) {
      comment = await getComment(env, str(args.comment_id, 'comment_id'));
      if (!comment || comment.slug !== p.slug) throw new ToolError(`no comment on ${p.slug} has the id ${args.comment_id}`);
    }
    // The reply is checked before the edit, so a bad reply stores nothing, and a good edit never loses its reply to a check.
    let reply: { body: string; resolve: boolean } | null = null;
    if (args.reply != null) {
      const r = args.reply as { body?: unknown; resolve?: unknown };
      if (typeof r !== 'object' || Array.isArray(r)) throw new ToolError('reply must be an object with body');
      if (!comment) throw new ToolError('reply needs comment_id: the comment that the reply answers. The tool stored nothing.');
      const body = typeof r.body === 'string' ? r.body.trim() : '';
      if (!body) throw new ToolError('reply.body must be a string with text. The tool stored nothing.');
      if (body.length > MAX_COMMENT) throw new ToolError(`reply.body is over ${MAX_COMMENT} characters. The tool stored nothing.`);
      if (r.resolve != null && typeof r.resolve !== 'boolean') throw new ToolError('reply.resolve must be true or false. The tool stored nothing.');
      reply = { body, resolve: r.resolve === true };
    }
    const before = await pageHtml(env, p);
    const out = applyEdits(before, edits);
    if ('failed' in out) throw new ToolError(`Edit ${out.failed} of ${edits.length} failed: its old_text has ${out.matches} ${out.matches === 1 ? 'match' : 'matches'} in the HTML, and it must have exactly 1. The tool stored nothing.`);
    // The viewer shows the cursor at each edit while the host stores the version. These events need no support from the runner.
    if (ctx.run) for (const e of editEvents(before, edits, new Date().toISOString())) await recordActivity(env, ctx.run, e).catch((err) => console.error('activity edit', err));
    const stored = await store(env, x, p.slug, out.html, ctx.origin);
    if ('error' in stored) throw new ToolError(`The tool stored nothing: ${stored.error}`);
    await noteActivity(env, ctx.run, 'version', { version: stored.version });
    const result: Record<string, unknown> = { slug: stored.slug, version: stored.version, previous_version: p.latest, url: stored.url, version_url: stored.versionUrl, ...(comment ? { comment_id: comment.id } : {}), ...(stored.audit ? { audit: stored.audit } : {}) };
    if (!reply || !comment) return result;
    // The viewer gets the same events as from two calls: tool edit_page, edit, version, and then tool reply_to_comment.
    await noteActivity(env, ctx.run, 'tool', { tool: 'reply_to_comment' });
    try {
      const c = await addComment(env, { parent_id: comment.id, body: reply.body, author: ctx.label });
      if ('error' in c) throw new ToolError(c.error);
      const resolved = reply.resolve && (await resolveThread(env, c.parent_id!));
      return { ...result, reply: { id: c.id, thread_id: c.parent_id, body: c.body, author: c.author, resolved } };
    } catch (e) {
      // The version is stored, so this call is not an error. The assistant must know that the thread has no answer yet.
      if (!(e instanceof ToolError)) console.error('edit_page reply', e);
      return { ...result, reply_error: `The edit is stored as version ${stored.version}. The reply is not stored: ${e instanceof ToolError ? e.message : 'internal error'}. Call reply_to_comment with comment_id ${comment.id}.` };
    }
  },
  async reply_to_comment(env, args, ctx) {
    const parent = ctx.slug ? await getComment(env, str(args.comment_id, 'comment_id')) : null;
    if (parent) inScope(parent.slug, ctx);
    const c = await addComment(env, { parent_id: str(args.comment_id, 'comment_id'), body: args.body, author: ctx.label });
    if ('error' in c) throw new ToolError(c.error);
    const resolved = args.resolve === true && (await resolveThread(env, c.parent_id!));
    return { id: c.id, thread_id: c.parent_id, slug: c.slug, body: c.body, author: c.author, resolved };
  },
};

// ─── JSON-RPC ───────────────────────────────────────────────────────

/**
 * The JSON-RPC methods.
 * A method with no handler gets the error -32601. See Handler in types.ts for the signature.
 */
export function methods(x: ExecutionContext, store: StoreVersion): Record<string, Handler> {
  return {
    async initialize(_env, params) {
      const asked = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
      return { protocolVersion: LEGACY.includes(asked as string) ? asked : LEGACY[0], capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
    },
    async ping() {
      return {};
    },
    /** MCP 2026-07-28: what `initialize` told a client before. A client may call it first, and it does not have to. */
    async 'server/discover'() {
      return { supportedVersions: PROTOCOLS, capabilities: CAPABILITIES, instructions: INSTRUCTIONS, ...CACHE };
    },
    async 'tools/list'() {
      return { tools: TOOLS, ...CACHE };
    },
    async 'tools/call'(env, params, ctx) {
      const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
      const tool = typeof name === 'string' && Object.hasOwn(tools, name) ? tools[name] : null;
      if (!tool) throw new RpcError(-32602, `no such tool: ${String(name)}`);
      await noteActivity(env, ctx.run, 'tool', { tool: name as string });
      try {
        const out = await tool(env, args && typeof args === 'object' ? (args as Args) : {}, ctx, x, store);
        return 'content' in out ? out : { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    },
  };
}

const CAPABILITIES = { tools: {} };

/** Runs one JSON-RPC message. Returns the response object, or null for a notification or a response, which get no answer. */
export async function rpc(handlers: Record<string, Handler>, env: Env, msg: unknown, ctx: McpContext): Promise<object | null> {
  if (Array.isArray(msg)) return rpcError(null, -32600, 'the connector takes one message in each request, not a batch');
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } | null;
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return rpcError(null, -32600, 'the body is not a JSON-RPC 2.0 message');
  const note = m.id === undefined || m.id === null;
  if (typeof m.method !== 'string') return note || 'result' in m || 'error' in m ? null : rpcError(m.id, -32600, 'the message has no method');
  const handler = Object.hasOwn(handlers, m.method) ? handlers[m.method] : null;
  if (!handler) return note ? null : rpcError(m.id, -32601, `no such method: ${m.method}`);
  try {
    const result = await handler(env, m.params, ctx);
    return note ? null : { jsonrpc: '2.0', id: m.id, result };
  } catch (e) {
    if (e instanceof RpcError) return note ? null : rpcError(m.id, e.code, e.message);
    console.error('mcp', m.method, e);
    return note ? null : rpcError(m.id, -32603, 'internal error');
  }
}

/**
 * True when the header has the shared secret of the runner. The function compares the SHA-256 of both values, in a time
 * that does not depend on where they differ. A host with no secret accepts nothing.
 */
async function sameSecret(got: string | null, want: string | undefined): Promise<boolean> {
  if (!got || !want) return false;
  const hash = async (v: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
  const [a, b] = await Promise.all([hash(got), hash(want)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** The value of an Mcp-Name header. A client writes a value that is not plain ASCII as =?base64?<base64>?=. */
function headerValue(v: string | null): string | null {
  const m = v?.match(/^=\?base64\?(.*)\?=$/);
  if (!m) return v;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

interface Request2026 {
  id: unknown;
  method: string;
  params?: { name?: unknown; _meta?: Record<string, unknown> } | null;
}

/**
 * The checks of MCP 2026-07-28 for one request: `_meta` carries the version and the client capabilities, and the
 * headers MCP-Protocol-Version, Mcp-Method and Mcp-Name repeat the body. Returns the JSON-RPC error, or null.
 */
function modernError(req: Request, m: Request2026): object | null {
  const meta = m.params?._meta ?? {};
  const asked = meta[`${META}protocolVersion`];
  const caps = meta[`${META}clientCapabilities`];
  if (typeof asked !== 'string' || !caps || typeof caps !== 'object') return rpcError(m.id, -32602, `params._meta must have ${META}protocolVersion and ${META}clientCapabilities`);
  const mismatch = (header: string, got: string | null, want: unknown) => (got === want ? null : rpcError(m.id, HEADER_MISMATCH, `Header mismatch: the ${header} header is ${got === null ? 'missing' : `'${got}'`}, and the body has '${String(want)}'`));
  return (
    mismatch('MCP-Protocol-Version', req.headers.get('mcp-protocol-version'), asked) ??
    mismatch('Mcp-Method', req.headers.get('mcp-method'), m.method) ??
    (m.method === 'tools/call' ? mismatch('Mcp-Name', headerValue(req.headers.get('mcp-name')), m.params?.name) : null)
  );
}

/**
 * The HTTP side of the connector. An unknown token and an expired token get the same 404 whatever the shape of the token.
 * A request with the version 2026-07-28 in its header or in its `_meta` follows the rules of that version: no
 * `initialize` and no `ping`, a 404 for an unknown method, and `resultType` and the server identity in each result.
 */
export async function handleMcp(req: Request, env: Env, x: ExecutionContext, token: string, origin: string, store: StoreVersion): Promise<Response> {
  if (req.method !== 'POST') return reply({ error: 'the connector takes POST only' }, 405, { allow: 'POST' });
  // The token is the primary key, so the database does the comparison. No code path compares it character by character.
  // The runner gets the answers that are the same for each token. Every other caller of that path gets the 404 of an unknown token.
  const discover = token === DISCOVER && (await sameSecret(req.headers.get('x-runner-secret'), env.SANDBOX_RUNNER_SECRET));
  const row = discover
    ? { label: 'runner' }
    : isToken(token)
      ? await env.DB.prepare('SELECT id, label, slug, expires_at FROM connector_tokens WHERE token = ?').bind(token).first<{ id?: string | null; label: string; slug?: string | null; expires_at?: string | null }>()
      : null;
  if (!row || (row.expires_at && row.expires_at <= new Date().toISOString())) return reply({ error: 'no such connector' }, 404);
  const version = req.headers.get('mcp-protocol-version');
  const msg = await readJson(req, MAX_RPC_BYTES);
  if (msg === undefined) return reply(rpcError(null, -32700, 'the body is not JSON, or it is over 1 MB'), 400);
  const m = msg as Request2026 | null;
  if (version && !PROTOCOLS.includes(version)) return reply(rpcError(m && typeof m === 'object' ? m.id : null, UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: PROTOCOLS, requested: version }), 400);
  // A token with a scope and an end time belongs to a sandbox run. The tool calls of that run become its activity.
  const run = row.id && row.slug && row.expires_at ? await env.DB.prepare("SELECT id FROM agent_runs WHERE token_id = ? AND status = 'running'").bind(row.id).first<{ id: string }>() : null;
  const ctx: McpContext = { token, label: row.label, origin, ...(row.slug ? { slug: row.slug } : {}), ...(run ? { run: run.id } : {}) };
  // The rules of 2026-07-28 apply to a request. That version defines no notification from a client over HTTP.
  const modern = !!m && typeof m === 'object' && typeof m.method === 'string' && m.id != null && m.method !== 'initialize' && (version === MODERN || m.params?._meta?.[`${META}protocolVersion`] === MODERN);
  const every = methods(x, store);
  const all = discover ? Object.fromEntries(DISCOVER_METHODS.map((k) => [k, every[k]])) : every;
  if (!modern) {
    const out = await rpc(all, env, msg, ctx);
    return out ? reply(out) : reply(null, 202);
  }
  const bad = modernError(req, m);
  if (bad) return reply(bad, 400);
  const { initialize: _i, ping: _p, ...handlers } = all;
  const out = (await rpc(handlers, env, msg, ctx)) as { result?: Record<string, unknown>; error?: { code: number } };
  if (out.result) out.result = { resultType: 'complete', ...out.result, _meta: { ...(out.result._meta as object), [`${META}serverInfo`]: SERVER_INFO } };
  return reply(out, out.error?.code === -32601 ? 404 : 200);
}
