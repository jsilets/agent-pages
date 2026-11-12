// agentd on this machine, with no container: the archive format, the control routes, and the proxy of the programs.
// test/docker.test.mjs runs the real image.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// agentd reads its upstream at import time. The stand-in Durable Object records what agentd sends.
const seen = [];
const upstream = createServer((req, res) => { const b = []; req.on('data', (d) => b.push(d)); req.on('end', () => { seen.push({ method: req.method, url: req.url, token: req.headers['x-agentd-token'], body: Buffer.concat(b) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }); });
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
process.env.AGENTD_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
process.env.AGENTD_PROXY_PORT = '0';
// A stand-in for the Claude program: it prints the sign-in URL, waits for one line, and exits with 1.
const fakeBin = join(mkdtempSync(join(tmpdir(), 'agentd-bin-')), 'claude');
writeFileSync(fakeBin, `#!${process.execPath}
if (process.argv.includes('login')) { console.log('Open https://claude.com/cai/oauth/authorize?code=true&state=x'); console.log('Paste code here if prompted >'); process.stdin.once('data', () => process.exit(1)); }
else { console.log('{"loggedIn":false}'); }
`, { mode: 0o755 });
process.env.CLAUDE_BIN = fakeBin;
process.env.AGENTD_WORK = mkdtempSync(join(tmpdir(), 'agentd-work-'));
const A = await import('../agentd/agentd.mjs');
after(() => upstream.close());

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

test('the archive: AES-256-GCM, bound to the user and the engine; a changed byte or another user fails', () => {
  const key = Buffer.alloc(32, 7);
  const sealed = A.seal(Buffer.from('opaque bytes'), key, 'u1/claude');
  assert.equal(sealed.subarray(0, 4).toString(), 'APC1');
  assert.equal(A.open(sealed, key, 'u1/claude').toString(), 'opaque bytes');
  assert.throws(() => A.open(sealed, key, 'u2/claude'));
  assert.throws(() => A.open(sealed, Buffer.alloc(32, 8), 'u1/claude'));
  const bad = Buffer.from(sealed); bad[bad.length - 1] ^= 1;
  assert.throws(() => A.open(bad, key, 'u1/claude'));
});

test('pack and unpack move a folder as bytes, with dot files', async () => {
  const a = mkdtempSync(join(tmpdir(), 'agentd-a-')), b = mkdtempSync(join(tmpdir(), 'agentd-b-'));
  try {
    mkdirSync(join(a, 'sub'));
    writeFileSync(join(a, '.hidden'), 'one');
    writeFileSync(join(a, 'sub', 'f'), 'two');
    const bytes = await A.pack(a);
    await A.unpack(A.open(A.seal(bytes, Buffer.alloc(32, 1), 'x'), Buffer.alloc(32, 1), 'x'), b);
    assert.equal(readFileSync(join(b, '.hidden'), 'utf8'), 'one');
    assert.equal(readFileSync(join(b, 'sub', 'f'), 'utf8'), 'two');
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('the environment of a program has the proxy and no secret', () => {
  const env = A.programEnv('claude');
  assert.equal(env.HTTPS_PROXY, env.HTTP_PROXY);
  assert.match(env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  for (const k of Object.keys(env)) assert.ok(!/TOKEN|SECRET|KEY/i.test(k), k);
  assert.ok(A.programEnv('codex').CODEX_HOME);
});

test('the firewall: loopback only for uid 10001, with a reset so nothing waits', () => {
  assert.deepEqual(A.FIREWALL[0], ['-A', 'OUTPUT', '-o', 'lo', '-j', 'ACCEPT']);
  assert.ok(A.FIREWALL[1].includes('tcp-reset'));
  assert.ok(A.FIREWALL.slice(1).every((r) => r.includes('--uid-owner') && r.includes('10001')));
});

test('control: the first /init sets the token; a second /init and a call with no token are refused', async () => {
  const server = A.control();
  const port = await listen(server);
  const call = (path, body, token) => fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-agentd-token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await call('/health')).status, 200);
    assert.equal((await call('/drain', {})).status, 401);
    const token = 't'.repeat(40);
    const r = await call('/init', { token, key: Buffer.alloc(32, 3).toString('base64'), aad: 'u/claude', archive: null, prewarm: false });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).restored, false);
    assert.equal((await call('/init', { token: 'x'.repeat(40), key: Buffer.alloc(32).toString('base64'), aad: 'u' })).status, 401);
    assert.equal((await call('/init', { token, key: Buffer.alloc(32).toString('base64'), aad: 'u' }, token)).status, 409);
    assert.equal((await call('/run', { nonce: 'short', job: {} }, token)).status, 400);
    assert.equal((await call('/login/code', { id: 'none', code: 'abcdefgh' }, token)).status, 404);
    const h = await (await call('/health')).json();
    assert.equal(h.has_token, true);
    assert.ok(!JSON.stringify(h).includes(token));
  } finally { server.close(); }
});

test('the proxy: /mcp goes to the Durable Object with the token of agentd; CONNECT to a host off the list fails at once', async () => {
  const proxy = A.egress();
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(r.status, 200);
    const got = seen.find((s) => s.url === '/mcp');
    assert.equal(got.token, 't'.repeat(40));
    assert.equal(got.body.toString(), '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 403);
    const connectLine = (target) => new Promise((resolve) => {
      const t0 = Date.now();
      const s = connect(port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      let text = '';
      s.on('data', (d) => { text += d; }).on('end', () => resolve({ line: text.split('\r\n')[0], ms: Date.now() - t0 })).on('error', () => resolve({ line: 'error', ms: Date.now() - t0 }));
    });
    for (const target of ['example.com:443', 'api.anthropic.com:80', '1.1.1.1:443', 'chatgpt.com:443', 'evil-api.anthropic.com.example.com:443']) {
      const { line, ms } = await connectLine(target);
      assert.equal(line, 'HTTP/1.1 403 Forbidden', target);
      assert.ok(ms < 500, `${target} took ${ms} ms`);
    }
    assert.deepEqual(A.ALLOW.run, ['api.anthropic.com', 'platform.claude.com']);
  } finally { proxy.close(); }
});

test('rootMount reads the source and the type of the last mount on /', () => {
  assert.deepEqual(A.rootMount('none / tmpfs rw 0 0\noverlay / overlay rw,relatime,lowerdir=/x 0 0\ntmpfs /tmp tmpfs rw 0 0\n'), { source: 'overlay', type: 'overlay' });
  assert.equal(A.rootMount('tmpfs /tmp tmpfs rw 0 0\n'), null);
});

test('control: a sign-in that ended does not block a run; a sign-in that waits does', async () => {
  const server = A.control();
  const port = await listen(server);
  const token = 't'.repeat(40);
  const call = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentd-token': token }, body: JSON.stringify(body) });
  try {
    await call('/init', { token, key: Buffer.alloc(32, 3).toString('base64'), aad: 'u/claude', archive: null, prewarm: false });
    const login = await call('/login', {});
    assert.equal(login.status, 200);
    const { id } = await login.json();
    const busy = await call('/run', { nonce: 'n'.repeat(20), job: {} });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error, 'a sign-in is running');
    await call('/login/code', { id, code: 'abcdefgh1234' });
    for (let i = 0; i < 100; i++) { const st = await (await call('/login/status', { id })).json(); if (st.status !== 'pending') break; await new Promise((r) => setTimeout(r, 50)); }
    // The sign-in ended. The run now gets the answer for its own fault (a job with no fields), not the sign-in answer.
    const after = await call('/run', { nonce: 'n'.repeat(20), job: {} });
    assert.equal(after.status, 400);
  } finally { server.close(); }
});
