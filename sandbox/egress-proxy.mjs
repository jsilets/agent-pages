#!/usr/bin/env node
// The only way out of the network of the sandbox containers. It has no dependencies.
//
// Port 3128, for the sandbox containers:
//   CONNECT <host>:443     A tunnel to a host of the allow list, and to no other host. The proxy does not open the TLS
//                          stream, so it never sees a model request or a sign-in.
//   POST /mcp              The connector. The proxy finds the run by the address of the container that asks, and it
//                          sends the request to the connector URL of that run. The container never gets the token.
//   everything else        403.
// Port 3129, for the runner only (the header x-control-secret must match CONTROL_SECRET):
//   PUT /route/<ip>        Body: { "mcp_url": "…" }. The container with this address now reaches this connector URL.
//   DELETE /route/<ip>     The end of the run.
//   PUT /cache             Body: { "answers": { "<method>": { "status": 200, "body": "<JSON text>" } } }. Stored answers
//                          for the methods below, which the runner got from the host before the first run.
//   GET /health
//
// A container that has no run gets a stored answer for `server/discover`, `initialize` and `tools/list`, when a run
// before it got one or the runner gave one with PUT /cache. The answers are the same for each token.
// So a program that starts before its job arrives can connect and wait.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The hosts that Claude Code and Codex need for a run with a subscription sign-in.
 * Claude Code: https://code.claude.com/docs/en/network-config.md, "Network access requirements". api.anthropic.com has
 * the model, and platform.claude.com renews the sign-in. claude.ai and claude.com are for the sign-in in connect.mjs.
 * Codex: chatgpt.com has the model for a ChatGPT sign-in, and auth.openai.com renews the sign-in. api.openai.com is for a
 * sign-in with an API key.
 */
export const DEFAULT_ALLOW = ['api.anthropic.com', 'platform.claude.com', 'claude.ai', 'claude.com', 'chatgpt.com', 'auth.openai.com', 'api.openai.com'];

/** True when the list has the host. An entry that starts with a dot matches each subdomain. */
export const hostAllowed = (host, allow) => { const h = String(host).toLowerCase().replace(/\.$/, ''); return allow.some((a) => (a.startsWith('.') ? h.endsWith(a) : h === a)); };

/** Reads `host:port` of a CONNECT request. Returns null for anything that is not a host name with a port. */
export function connectTarget(authority) {
  const m = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(authority || '');
  // An IP address is not a name of the allow list, and a tunnel to an address would pass the list.
  if (!m || /^[0-9.]+$/.test(m[1])) return null;
  return { host: m[1].toLowerCase(), port: +m[2] };
}

const sameSecret = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? '')); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
/** ::ffff:10.0.0.2 and 10.0.0.2 are the same container. */
const ip = (socket) => String(socket.remoteAddress || '').replace(/^::ffff:/, '');
const CACHED = new Set(['initialize', 'tools/list', 'notifications/initialized', 'server/discover']);

export function startProxy({ allow = DEFAULT_ALLOW, secret, port = 3128, controlPort = 3129, log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o })) } = {}) {
  /** Container address to connector URL. */
  const routes = new Map();
  /** JSON-RPC method to the last good answer of the connector. */
  const cache = new Map();

  const readBody = (req, max = 4 * 1024 * 1024) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (d) => { n += d.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  async function mcp(req, res) {
    const from = ip(req.socket);
    let body, rpc = null;
    try {
      body = await readBody(req);
      rpc = JSON.parse(body.toString('utf8'));
    } catch {}
    const method = rpc && typeof rpc.method === 'string' ? rpc.method : null;
    const target = routes.get(from);
    if (!target) {
      const hit = method && cache.get(method);
      if (!hit) { log({ ev: 'mcp', from, method, status: 503, cause: 'no run' }); res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":"no run for this container"}'); }
      // The stored answer has the id of an old request. The client needs its own id.
      let text = hit.body;
      if (text && rpc.id !== undefined) { try { text = JSON.stringify({ ...JSON.parse(text), id: rpc.id }); } catch {} }
      log({ ev: 'mcp', from, method, status: hit.status, cached: true });
      res.writeHead(hit.status, hit.headers);
      return res.end(text);
    }
    const url = new URL(target);
    const headers = { 'content-type': req.headers['content-type'] || 'application/json', accept: req.headers.accept || 'application/json, text/event-stream' };
    for (const h of ['mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id']) if (req.headers[h]) headers[h] = req.headers[h];
    const t0 = Date.now();
    const up = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: req.method, headers: { ...headers, 'content-length': body ? body.length : 0 } }, (r) => {
      const outHeaders = { 'content-type': r.headers['content-type'] || 'application/json' };
      const keep = method && CACHED.has(method) && r.statusCode >= 200 && r.statusCode < 300;
      const chunks = [];
      res.writeHead(r.statusCode, outHeaders);
      r.on('data', (d) => { if (keep) chunks.push(d); res.write(d); });
      r.on('end', () => {
        res.end();
        if (keep) cache.set(method, { status: r.statusCode, headers: outHeaders, body: Buffer.concat(chunks).toString('utf8') });
        // The tool name is not a secret. The URL of the connector is, so the log never has it.
        log({ ev: 'mcp', from, method, tool: method === 'tools/call' ? rpc?.params?.name : undefined, status: r.statusCode, ms: Date.now() - t0 });
      });
    });
    up.on('error', (e) => { log({ ev: 'mcp', from, method, status: 502, cause: e.code || 'error' }); if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"the connector did not answer"}'); });
    up.setTimeout(120_000, () => up.destroy(new Error('timeout')));
    up.end(body);
  }

  const proxy = createServer((req, res) => {
    // A client that uses the proxy for this address too sends the whole URL.
    let path = req.url;
    if (/^http:\/\//i.test(path)) { try { const u = new URL(path); if (u.host === req.headers.host) path = u.pathname; } catch {} }
    if (path === '/mcp') return void mcp(req, res);
    // The log keeps the host of a refused request and never its path: a path can hold a token.
    let target = '(a path)';
    try { if (/^https?:\/\//i.test(req.url)) target = new URL(req.url).host.slice(0, 80); } catch {}
    log({ ev: 'deny', from: ip(req.socket), method: req.method, target });
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('this proxy has no route for the request\n');
  });
  proxy.on('connect', (req, socket, head) => {
    const from = ip(socket);
    const t = connectTarget(req.url);
    if (!t || t.port !== 443 || !hostAllowed(t.host, allow)) {
      log({ ev: 'deny', from, target: String(req.url).slice(0, 120) });
      return socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    }
    const up = connect(t.port, t.host, () => {
      log({ ev: 'tunnel', from, target: `${t.host}:${t.port}` });
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.setNoDelay(true); socket.setNoDelay(true);
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  proxy.on('clientError', (_e, socket) => socket.destroy());

  const control = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!sameSecret(req.headers['x-control-secret'], secret)) return send(401, { error: 'no' });
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, routes: routes.size, cached: [...cache.keys()], allow });
    if (req.url === '/cache') {
      if (req.method !== 'PUT') return send(405, { error: 'PUT' });
      try {
        const { answers } = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8'));
        const list = Object.entries(answers ?? {});
        if (!list.length || list.some(([k, a]) => !CACHED.has(k) || !(a?.status >= 200 && a.status < 300) || typeof a.body !== 'string')) throw new Error('answers');
        for (const [k, a] of list) cache.set(k, { status: a.status, headers: { 'content-type': 'application/json' }, body: a.body });
        return send(200, { ok: true, cached: [...cache.keys()] });
      } catch {
        return send(400, { error: 'send { "answers": { "<method>": { "status": 2xx, "body": "…" } } } for ' + [...CACHED].join(', ') });
      }
    }
    const m = /^\/route\/([0-9a-f.:]+)$/i.exec(req.url);
    if (!m) return send(404, { error: 'no such route' });
    if (req.method === 'DELETE') { routes.delete(m[1]); return send(200, { ok: true }); }
    if (req.method !== 'PUT') return send(405, { error: 'PUT or DELETE' });
    try {
      const { mcp_url } = JSON.parse((await readBody(req, 8192)).toString('utf8'));
      const u = new URL(mcp_url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
      routes.set(m[1], u.href);
      send(200, { ok: true });
    } catch {
      send(400, { error: 'send { "mcp_url": "<http or https URL>" }' });
    }
  });
  proxy.listen(port, '0.0.0.0');
  control.listen(controlPort, '0.0.0.0');
  log({ ev: 'start', port, controlPort, allow });
  return { proxy, control, routes, cache, close: () => { proxy.close(); control.close(); proxy.closeAllConnections?.(); control.closeAllConnections?.(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const secret = process.env.CONTROL_SECRET;
  if (!secret || secret.length < 16) { console.error('CONTROL_SECRET must have 16 characters or more'); process.exit(1); }
  const allow = process.env.EGRESS_ALLOW ? process.env.EGRESS_ALLOW.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : DEFAULT_ALLOW;
  startProxy({ allow, secret, port: +process.env.PROXY_PORT || 3128, controlPort: +process.env.CONTROL_PORT || 3129 });
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => process.exit(0));
}
