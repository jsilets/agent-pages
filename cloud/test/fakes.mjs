// Fakes for test/core.test.mjs: the Durable Object storage, a clock, an R2 bucket, the host, and a container whose agentd
// behaves like cloud/agentd/agentd.mjs at its HTTP surface. The fake agentd talks back to the core through
// core.fromContainer(), as the intercept of runner.internal does on Cloudflare.
export function fakeClock(t = Date.parse('2026-11-12T10:00:00Z')) {
  const c = { t, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

export function fakeStorage() {
  const m = new Map();
  const s = {
    m, alarm: null,
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async (k) => m.delete(k),
    getAlarm: async () => s.alarm,
    setAlarm: async (at) => { s.alarm = at; },
  };
  return s;
}

export function fakeR2() {
  const m = new Map();
  return { m, ops: { get: 0, put: 0, delete: 0 }, async get(k) { this.ops.get++; return m.get(k) ?? null; }, async put(k, b) { this.ops.put++; m.set(k, new Uint8Array(b)); }, async delete(k) { this.ops.delete++; m.delete(k); } };
}

/** The host Worker: records each request. The connector answers 200 with the URL it got. */
export function fakeHost() {
  const calls = [];
  return {
    calls,
    results: () => calls.filter((c) => /\/s\/_run\/[^/]+$/.test(c.url)).map((c) => ({ url: c.url, ...JSON.parse(c.body) })),
    progress: () => calls.filter((c) => c.url.endsWith('/progress')),
    async fetch(url, init = {}) {
      const body = init.body && typeof init.body !== 'string' ? await new Response(init.body).text() : init.body ?? '';
      calls.push({ url, method: init.method, headers: init.headers ?? {}, body });
      if (url.includes('/s/_mcp/')) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { url } }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 200 });
    },
  };
}

/**
 * A container with a fake agentd. `behaviour` decides what a run does:
 *   'reply'   the run calls the connector, sends a progress event and the result, saves the archive, and ends
 *   'hang'    the run never reports (for the hard time limit)
 *   'nosign'  the run reports not_signed_in
 */
export function fakeContainer(getCore, { behaviour = 'reply' } = {}) {
  const c = {
    running: false, starts: [], destroyed: [], intercepts: 0, timeouts: [], agentdCalls: [], behaviour, busy: false, runs: [], token: null, archive: null,
    loginCode: null, loginId: 'L'.repeat(24), loginStatus: 'pending', autoDone: true, pendingRuns: [],
    async start(opts) { if (c.running) throw new Error('start on a running container'); c.running = true; c.starts.push(opts); c.token = null; c.busy = false; },
    async destroy(why) { c.running = false; c.destroyed.push(why); c.busy = false; },
    async setInactivityTimeout(ms) { c.timeouts.push(ms); },
    async intercept() { c.intercepts++; },
    async agentd(path, body, { token } = {}) {
      c.agentdCalls.push({ path, body });
      if (!c.running) throw new Error('container not running');
      if (path === '/health') return { status: 200, body: { ok: true, hardening: { egress: 'enforced', rootfs_ro: true } } };
      if (path === '/init') { if (c.token) return { status: 409, body: {} }; c.token = body.token; c.init = body; if (body.archive === 'bad') return { status: 422, body: {} }; return { status: 200, body: { ok: true, restored: !!body.archive, ms_restore: 5 } }; }
      if (token !== c.token) return { status: 401, body: {} };
      const core = getCore();
      const call = (p, init = {}) => core.fromContainer(new Request(`http://runner.internal${p}`, { method: 'POST', ...init, headers: { 'content-type': 'application/json', 'x-agentd-token': c.token, ...(init.headers ?? {}) } }));
      if (path === '/run') {
        if (c.busy) return { status: 409, body: { error: 'a run is running' } };
        c.busy = true;
        c.runs.push(body);
        const run = async () => {
          if (c.behaviour === 'hang') return;
          const mcp = await call('/mcp', { body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}' });
          c.lastMcp = await mcp.json();
          await call(`/cb/${body.nonce}/progress`, { body: JSON.stringify({ seq: 1, kind: 'started' }) });
          const status = c.behaviour === 'nosign' ? 'not_signed_in' : 'done';
          await call(`/cb/${body.nonce}`, { body: JSON.stringify({ status, detail: 'engine=claude' }) });
          if (status === 'done') await call('/archive/claude'.replace('claude', c.starts.at(-1).image), { method: 'PUT', body: new Uint8Array([1, 2, 3, c.runs.length]), headers: { 'content-type': 'application/octet-stream' } });
          c.busy = false;
          await call(`/done/${body.nonce}`, { body: JSON.stringify({ status, ms_first_tool: 800, ms_reply: 3500, saved: status === 'done' }) });
        };
        if (c.autoDone) c.pendingRuns.push(run()); else c.pendingRuns.push(run);
        return { status: 202, body: { accepted: true } };
      }
      if (path === '/login') return { status: 200, body: { id: c.loginId, url: 'https://claude.com/cai/oauth/authorize?x=1', needs_code: true, expires_at: new Date(core.now() + 600_000).toISOString() } };
      if (path === '/login/code') { c.loginCode = body.code; c.loginStatus = 'connected'; await call(`/archive/${c.starts.at(-1).image}`, { method: 'PUT', body: new Uint8Array([9, 9]), headers: { 'content-type': 'application/octet-stream' } }); return { status: 200, body: { ok: true } }; }
      if (path === '/login/status') return { status: 200, body: { status: c.loginStatus } };
      if (path === '/drain') return { status: 200, body: { ok: true, saved: false, unchanged: true, ms: 12 } };
      if (path === '/logout') return { status: 200, body: { ok: true } };
      if (path === '/kill') { c.busy = false; return { status: 200, body: { ok: true } }; }
      return { status: 404, body: {} };
    },
  };
  return c;
}
