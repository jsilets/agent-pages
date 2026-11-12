// The runner of one user: the logic of the Durable Object UserRunner, with no Cloudflare import, so `node --test` can
// run it with fakes (test/core.test.mjs). worker.mjs gives it the real storage, container, R2 bucket and host.
//
// One Durable Object for each user is the identity, the queue (one run at a time), the lifecycle of the one container of
// the user, and the warm policy: start on intent (/warm), linger after a run, stop when idle. Alarms drive each step that
// waits, so no state lives only in memory. The container runs agentd (cloud/agentd/agentd.mjs).
//
// Adapters (all async unless noted):
//   storage    get(k), put(k, v), delete(k), getAlarm(), setAlarm(ms)          the Durable Object storage
//   container  running (getter), start({ image, instance, env }), destroy(why), setInactivityTimeout(ms),
//              intercept(), agentd(path, body | undefined, { token, ms }) -> { status, body }
//   r2         get(key) -> Uint8Array | null, put(key, bytes, meta), delete(key)
//   host       fetch(url, init) -> Response     the host Worker: a service binding, or fetch for development
//   env        the variables of the Worker (see DEFAULTS)
import { jobError, MODELS } from './models.mjs';

export const DEFAULTS = {
  LINGER_MS: 90_000, WARM_MS: 60_000, RUN_TIMEOUT_MS: 180_000, MAX_QUEUE: 5, SIGNIN_MS: 10 * 60_000,
  /** The time that a run may take over its limit before the Durable Object kills the container: agentd reports first. */
  GRACE_MS: 15_000,
  /** The time that a new container has to answer GET /health. */
  BOOT_MS: 30_000,
  INSTANCE_CLAUDE: 'standard-1', INSTANCE_CODEX: 'standard-1',
};
const NAMES = { claude: 'Claude Code', codex: 'Codex' };
const ASSISTANT = { claude: 'claude', codex: 'chatgpt' };

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const b64 = (bytes) => { let s = ''; const u = new Uint8Array(bytes); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomB64url = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/**
 * The name of the Durable Object of a user: SHA-256 of the identity, with a fixed prefix, as 64 hex characters.
 * idFromName() hashes this name again. Two identities get the same object only on a SHA-256 collision. The object, its
 * R2 keys and its log lines have the hash, never the email address.
 */
export async function userKey(user) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(`agent-pages-user:v1:${String(user ?? '')}`)));
}
/**
 * The key of the Durable Object for one assistant of one person. Each assistant has its own object, and so its own
 * container. One object for both needed a stop of one container and a start of the other for each change of assistant,
 * and Cloudflare then took 34 to 38 seconds to start the second container (measured in production, 2026-11-12).
 * Claude keeps the key of the person, so the sign-ins from before this change stay.
 */
export async function objectKey(user, engine) {
  if (engine !== 'codex') return userKey(user);
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(`agent-pages-user-codex:v1:${String(user ?? '')}`)));
}
export const archiveKey = (key, engine) => `cred/v1/${key}/${engine}`;
export const aadOf = (key, engine) => `agent-pages/cred/v1/${key}/${engine}`;
/** A sign-in id carries the user key, so /connect/code and /connect/status (which have no user) reach the right object. */
export const flowId = (key, id) => `${key}-${id}`;
export const keyOfFlow = (id) => (/^([0-9a-f]{64})-([A-Za-z0-9_-]{16,64})$/.exec(String(id ?? '')) ?? [])[1] ?? null;
const sessionOf = (id) => String(id).slice(65);

/** Constant-time comparison of two strings. An empty value matches nothing. */
export function same(a, b) {
  const x = enc.encode(String(a ?? '')), y = enc.encode(String(b ?? ''));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0 && x.length > 0;
}

export class RunnerCore {
  constructor({ key, storage, container, r2, host, env = {}, now = () => Date.now(), log = (o) => console.log(JSON.stringify(o)) }) {
    Object.assign(this, { key, storage, c: container, r2, host, env, now });
    this.log = (o) => log({ at: new Date(now()).toISOString(), src: 'runner', user: key.slice(0, 12), ...o });
    const n = (k) => (env[k] === undefined || env[k] === '' ? DEFAULTS[k] : +env[k]);
    this.cfg = { linger: n('LINGER_MS'), warm: n('WARM_MS'), timeout: n('RUN_TIMEOUT_MS'), maxQueue: n('MAX_QUEUE'), signin: n('SIGNIN_MS'), grace: n('GRACE_MS'), boot: n('BOOT_MS'), instance: { claude: env.INSTANCE_CLAUDE || DEFAULTS.INSTANCE_CLAUDE, codex: env.INSTANCE_CODEX || DEFAULTS.INSTANCE_CODEX } };
    this.chain = Promise.resolve();
    this.pending = new Set();
  }

  get disabled() { return this.env.RUNNER_DISABLED === '1' || this.env.RUNNER_DISABLED === 'true'; }

  /** One state change at a time. Requests from the container (fromContainer) do not take the lock, so a run can talk while a step waits. */
  lock(fn) { const p = this.chain.then(fn, fn); this.chain = p.catch(() => {}); return p; }
  /** The queue has its own short lock, so POST /run answers at once while a step of the container waits. */
  qlock(fn) { const p = (this.qchain ?? Promise.resolve()).then(fn, fn); this.qchain = p.catch(() => {}); return p; }
  /** Work that the caller does not wait for. A test waits for it with idle(). The alarm is the backstop in the cloud. */
  defer(fn) { const p = Promise.resolve().then(fn).catch((e) => this.log({ ev: 'error', where: 'deferred', error: String(e?.message || e).slice(0, 200) })).finally(() => this.pending.delete(p)); this.pending.add(p); return p; }
  async idle() { while (this.pending.size) await Promise.all([...this.pending]); await this.chain; }

  async conn() { return (await this.storage.get('conn')) ?? { claude: { connected: false }, codex: { connected: false } }; }
  async setConn(engine, v) { const c = await this.conn(); c[engine] = { ...c[engine], ...v, at: new Date(this.now()).toISOString() }; await this.storage.put('conn', c); }
  async secretKey() {
    let k = await this.storage.get('archive_key');
    if (!k) { k = b64(crypto.getRandomValues(new Uint8Array(32))); await this.storage.put('archive_key', k); }
    return k;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The HTTP contract of the runner (worker.mjs maps each route to one of these). Each returns [status, body].

  async status() {
    const c = await this.conn();
    const one = (engine) => ({ connected: !!c[engine]?.connected, models: MODELS[engine].models, default_model: MODELS[engine].default_model });
    return [200, { assistants: { claude: one('claude'), chatgpt: one('codex') } }];
  }

  async run(job, t_received = this.now()) {
    if (this.disabled) { this.log({ ev: 'refused', cause: 'disabled' }); return [503, { error: 'the runner is switched off (RUNNER_DISABLED)' }]; }
    const { user, mode, ...rest } = job ?? {};
    for (const k of ['model', 'effort']) if (rest[k] == null) delete rest[k];
    const bad = jobError(rest) ?? (originOk(rest.mcp_url, this.env) && originOk(rest.callback_url, this.env) ? null : 'mcp_url and callback_url must have an origin of HOST_ORIGINS');
    if (bad) return [400, { error: bad }];
    if (!rest.callback_url) return [400, { error: 'the cloud runner needs callback_url' }];
    const full = await this.qlock(async () => {
      const queue = (await this.storage.get('queue')) ?? [];
      if (queue.length >= this.cfg.maxQueue) return queue.length;
      queue.push({ job: { ...rest, engine: rest.engine === 'codex' ? 'codex' : 'claude' }, t_received });
      await this.storage.put('queue', queue);
      return 0;
    });
    if (full) { this.log({ ev: 'refused', cause: 'queue', waiting: full }); return [429, { error: `${this.cfg.maxQueue} jobs of this user wait already` }]; }
    try { await this.storage.put('origin', new URL(rest.mcp_url).origin); } catch {}
    await this.schedule();
    this.defer(() => this.pump());
    return [202, { accepted: true }];
  }

  async warm({ engine = 'claude' } = {}) {
    if (engine !== 'claude' && engine !== 'codex') return [400, { error: 'engine must be claude or codex' }];
    if (this.disabled) return [200, { ok: true, warm: false, cause: 'disabled' }];
    if (this.cfg.warm <= 0) return [200, { ok: true, warm: false, cause: 'WARM_MS is 0' }];
    if (!(await this.conn())[engine]?.connected) return [200, { ok: true, warm: false, cause: 'not_signed_in' }];
    this.defer(() => this.lock(async () => {
      const cur = await this.storage.get('current');
      // A container that runs a job of the other engine stays. The job ends first.
      if (cur && cur.engine !== engine) return;
      const t0 = this.now();
      const { box, cold } = await this.ensureBox(engine, 'warm');
      box.linger_until = Math.max(box.linger_until ?? 0, this.now() + this.cfg.warm);
      await this.storage.put('box', box);
      await this.schedule();
      this.log({ ev: 'warm', engine, cold, ms: this.now() - t0 });
    }));
    return [202, { accepted: true }];
  }

  async connect({ engine }) {
    if (engine !== 'claude' && engine !== 'codex') return [400, { error: 'engine must be claude or codex' }];
    if (this.disabled) return [503, { error: 'the runner is switched off (RUNNER_DISABLED)' }];
    return this.lock(async () => {
      const cur = await this.storage.get('current');
      if (cur) return [409, { error: 'a run of this user is running. Try again when it ends.' }];
      const { box } = await this.ensureBox(engine, 'signin');
      const r = await this.c.agentd('/login', {}, { token: box.token, ms: 30_000 });
      if (r.status !== 200) return [r.status === 409 ? 409 : 502, { error: r.body?.error ?? 'the sign-in did not start' }];
      const id = flowId(this.key, r.body.id);
      await this.storage.put('signin', { id, engine, expires_at: Date.parse(r.body.expires_at) || this.now() + this.cfg.signin });
      box.linger_until = Math.max(box.linger_until ?? 0, this.now() + this.cfg.signin);
      await this.storage.put('box', box);
      await this.c.setInactivityTimeout(this.cfg.signin + 60_000);
      await this.schedule();
      this.log({ ev: 'signin_started', engine });
      return [200, { ...r.body, id }];
    });
  }

  /** The code goes to agentd and to nothing else. No log line has it. */
  async connectCode({ id, code }) {
    const s = await this.storage.get('signin');
    const box = await this.storage.get('box');
    if (!s || s.id !== id || !box || !this.c.running) return [404, { error: 'no such sign-in' }];
    const r = await this.c.agentd('/login/code', { id: sessionOf(id), code }, { token: box.token });
    return [r.status, r.body ?? {}];
  }

  async connectStatus({ id }) {
    const s = await this.storage.get('signin');
    const box = await this.storage.get('box');
    if (!s || s.id !== id) return [200, { status: 'expired' }];
    if (!box || !this.c.running) { await this.storage.delete('signin'); return [200, { status: 'expired' }]; }
    const r = await this.c.agentd('/login/status', { id: sessionOf(id) }, { token: box.token });
    const status = r.body?.status ?? 'failed';
    if (status !== 'pending') {
      await this.storage.delete('signin');
      // After the sign-in, the container waits like after a run, with a program that waits.
      box.linger_until = this.now() + this.cfg.linger;
      await this.storage.put('box', box);
      await this.c.setInactivityTimeout(this.cfg.linger + 60_000);
      await this.schedule();
      this.log({ ev: 'signin_end', engine: s.engine, status });
    }
    return [200, { status, ...(r.body?.detail ? { detail: r.body.detail } : {}) }];
  }

  async disconnect({ engine }) {
    if (engine !== 'claude' && engine !== 'codex') return [400, { error: 'engine must be claude or codex' }];
    return this.lock(async () => {
      const cur = await this.storage.get('current');
      if (cur && cur.engine === engine) return [409, { error: 'a run of this assistant is running. Try again when it ends.' }];
      const box = await this.storage.get('box');
      if (box && box.engine === engine && this.c.running) {
        await this.c.agentd('/logout', {}, { token: box.token, ms: 30_000 }).catch(() => null);
        await this.c.destroy('disconnect');
        await this.storage.delete('box');
      }
      await this.r2.delete(archiveKey(this.key, engine));
      await this.setConn(engine, { connected: false });
      const c = await this.conn();
      // With no engine connected, the key goes too. A new sign-in gets a new key.
      if (!c.claude?.connected && !c.codex?.connected) await this.storage.delete('archive_key');
      await this.schedule();
      this.log({ ev: 'disconnect', engine });
      return [200, { ok: true }];
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The container

  /** The running container for the engine: the one that waits, or a new one with the sign-in folder restored. */
  async ensureBox(engine, by) {
    let box = await this.storage.get('box');
    if (box && this.c.running && box.engine === engine) return { box, cold: false };
    if (box && this.c.running) await this.stopBox('engine switch');
    else if (box) { this.log({ ev: 'container_lost', engine: box.engine, s_alive: (this.now() - box.t_start) / 1000 }); await this.storage.delete('box'); }
    const t0 = this.now();
    const conn = await this.conn();
    const key = await this.secretKey();
    const archive = conn[engine]?.connected ? await this.r2.get(archiveKey(this.key, engine)) : null;
    const ms_fetch = this.now() - t0;
    await this.c.intercept();
    await this.c.start({ image: engine, instance: this.cfg.instance[engine], env: { AGENTD_ENGINE: engine, RUN_TIMEOUT_MS: String(this.cfg.timeout) } });
    await this.c.setInactivityTimeout(Math.max(this.cfg.linger, this.cfg.warm, this.cfg.timeout) + 60_000);
    let up = null;
    for (const until = this.now() + this.cfg.boot; this.now() < until; await sleep(100)) {
      up = await this.c.agentd('/health', undefined, { ms: 2000 }).catch(() => null);
      if (up?.status === 200) break;
    }
    if (up?.status !== 200) { await this.c.destroy('boot failed').catch(() => {}); throw new Error(`agentd did not answer in ${this.cfg.boot / 1000} s`); }
    // REQUIRE_EGRESS=1: a container whose firewall did not start serves nothing. The proxy of agentd still holds the
    // allow list for the programs, but a program could then reach other hosts by itself.
    if (this.env.REQUIRE_EGRESS === '1' && up.body?.hardening?.egress !== 'enforced') {
      await this.c.destroy('no firewall').catch(() => {});
      this.log({ ev: 'refused', cause: 'no firewall', hardening: up.body?.hardening ?? null });
      throw new Error('the firewall of the container did not start (REQUIRE_EGRESS=1)');
    }
    const ms_boot = this.now() - t0;
    box = { engine, token: randomB64url(32), t_start: t0, by, runs: 0, linger_until: this.now() + (by === 'warm' ? this.cfg.warm : this.cfg.linger), hardening: up.body?.hardening ?? null };
    // The box goes to storage before /init: the waiting program talks to the connector during /init.
    await this.storage.put('box', box);
    const model = (await this.storage.get('model'))?.[engine];
    const r = await this.c.agentd('/init', { token: box.token, key, aad: aadOf(this.key, engine), archive: archive ? b64(archive) : null, ...(model ? { model } : {}) }, { ms: 30_000 });
    if (r.status === 422) {
      // The archive does not open with the key of this user: a broken object or a foreign one. The person connects again.
      this.log({ ev: 'archive_rejected', engine });
      await this.r2.delete(archiveKey(this.key, engine));
      await this.setConn(engine, { connected: false });
    } else if (r.status !== 200) { await this.c.destroy('init failed').catch(() => {}); await this.storage.delete('box'); throw new Error(`agentd /init answered ${r.status}`); }
    this.log({ ev: 'container_started', engine, by, ms_fetch, ms_boot, ms_restore: r.body?.ms_restore ?? null, restored: !!r.body?.restored, archive_bytes: archive?.byteLength ?? 0, hardening: box.hardening });
    return { box, cold: true };
  }

  /** Ends the programs gently, saves the sign-in folder, and stops the container. */
  async stopBox(why) {
    const box = await this.storage.get('box');
    if (!box) return;
    let drained = null;
    if (this.c.running) {
      drained = await this.c.agentd('/drain', {}, { token: box.token, ms: 60_000 }).catch((e) => ({ status: 0, body: { error: String(e.message) } }));
      await this.c.destroy(why).catch(() => {});
    }
    await this.storage.delete('box');
    this.log({ ev: 'container_stopped', engine: box.engine, why, by: box.by, runs: box.runs, s_billable: (this.now() - box.t_start) / 1000, saved: drained?.body?.saved ?? null, drain_ms: drained?.body?.ms ?? null });
  }

  /** Takes the next job when none runs. */
  pump() {
    return this.lock(async () => {
      if (await this.storage.get('current')) return;
      const item = await this.qlock(async () => {
        const queue = (await this.storage.get('queue')) ?? [];
        const first = queue.shift();
        if (first) await this.storage.put('queue', queue);
        return first;
      });
      if (!item) return;
      const { job, t_received } = item;
      const engine = job.engine;
      const ms_queue = this.now() - t_received;
      if (this.disabled) { await this.report(job.callback_url, { status: 'failed', detail: 'runner: switched off' }); { this.defer(() => this.pump()); return; } }
      if (!(await this.conn())[engine]?.connected) {
        await this.report(job.callback_url, { status: 'not_signed_in', detail: `${NAMES[engine]} has no sign-in for this user` });
        this.log({ ev: 'run', engine, status: 'not_signed_in', container: false, ms_queue });
        { this.defer(() => this.pump()); return; }
      }
      let box, cold;
      const t0 = this.now();
      try {
        ({ box, cold } = await this.ensureBox(engine, 'run'));
      } catch (e) {
        await this.report(job.callback_url, { status: 'failed', detail: `runner: ${String(e.message || e).slice(0, 200)}` });
        this.log({ ev: 'run', engine, status: 'failed', error: String(e.message || e).slice(0, 200) });
        { this.defer(() => this.pump()); return; }
      }
      const cur = { nonce: randomB64url(24), engine, mcp_url: job.mcp_url, callback_url: job.callback_url, comment_id: job.comment_id, slug: job.slug, model: job.model ?? null, t_start: this.now(), deadline: this.now() + this.cfg.timeout + this.cfg.grace, reported: false, cold, ms_queue, ms_container: this.now() - t0 };
      await this.storage.put('current', cur);
      await this.c.setInactivityTimeout(this.cfg.timeout + this.cfg.grace + 60_000);
      await this.schedule();
      const { comment_id, slug, agent_label, model, effort } = job;
      const r = await this.c.agentd('/run', { nonce: cur.nonce, job: { comment_id, slug, agent_label, engine, ...(model ? { model } : {}), ...(effort ? { effort } : {}) } }, { token: box.token }).catch((e) => ({ status: 0, body: { error: String(e.message) } }));
      if (r.status !== 202) {
        await this.storage.delete('current');
        await this.report(job.callback_url, { status: 'failed', detail: `runner: agentd answered ${r.status}: ${String(r.body?.error ?? '').slice(0, 200)}` });
        this.log({ ev: 'run', engine, status: 'failed', cause: 'agentd', agentd_status: r.status });
        { this.defer(() => this.pump()); return; }
      }
      if (job.model) { const m = (await this.storage.get('model')) ?? {}; m[engine] = job.model; await this.storage.put('model', m); }
    });
  }

  /** POSTs the result or a progress event to the host. */
  async report(url, body) {
    try {
      const res = await this.host.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      await res.body?.cancel();
      return res.status;
    } catch { return null; }
  }

  /**
   * The outbound requests of the container to http://runner.internal (the intercept). Only agentd has the token of the
   * container. A program of the container cannot reach this host (the firewall of agentd), and has no token in any case.
   */
  async fromContainer(req) {
    const url = new URL(req.url);
    const box = await this.storage.get('box');
    if (!box || !same(req.headers.get('x-agentd-token'), box.token)) return new Response('no', { status: 401 });
    const cur = await this.storage.get('current');
    const path = url.pathname;
    if (path === '/mcp') {
      const headers = {};
      for (const h of ['content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id']) { const v = req.headers.get(h); if (v) headers[h] = v; }
      let target = cur?.mcp_url;
      if (!target) {
        // No run: the answers that are the same for each token (initialize, server/discover, tools/list), so a program can wait.
        const origin = this.env.DISCOVER_ORIGIN || (this.env.HOST_ORIGINS || '').split(',')[0]?.trim() || (await this.storage.get('origin'));
        if (!origin || !this.env.RUNNER_SECRET) return new Response('{"error":"no run for this container"}', { status: 503, headers: { 'content-type': 'application/json' } });
        target = new URL('/s/_mcp/discover', origin).href;
        headers['x-runner-secret'] = this.env.RUNNER_SECRET;
      }
      // A connector message is small JSON. Reading it whole keeps the request simple to send on (no stream to tee).
      const res = await this.host.fetch(target, { method: req.method, headers, body: req.method === 'GET' ? undefined : await req.arrayBuffer(), redirect: 'manual' });
      return new Response(res.body, { status: res.status, headers: pickHeaders(res.headers, ['content-type', 'mcp-session-id']) });
    }
    let m = /^\/cb\/([A-Za-z0-9_-]+)(\/progress)?$/.exec(path);
    if (m) {
      if (!cur || !same(cur.nonce, m[1])) return new Response('no such run', { status: 404 });
      const text = await req.text();
      let body;
      try { body = JSON.parse(text || '{}'); } catch {}
      if (!body || typeof body !== 'object' || text.length > 64 * 1024) return new Response('send JSON of at most 64 KB', { status: 400 });
      // The result line of the host gets the numbers that only the runner knows, for measure-after-deploy.mjs. No secret.
      if (!m[2] && typeof body.detail === 'string' && body.status === 'done') body.detail = `${body.detail} cold_container=${cur.cold} ms_container=${cur.ms_container} ms_queue=${cur.ms_queue} egress=${box.hardening?.egress ?? 'unknown'} rootfs_ro=${box.hardening?.rootfs_ro ?? 'unknown'}`.slice(0, 500);
      const status = await this.report(cur.callback_url + (m[2] ?? ''), body);
      if (!m[2] && !cur.reported) { cur.reported = true; cur.result = body.status ?? null; await this.storage.put('current', cur); }
      return new Response(null, { status: status ?? 502 });
    }
    m = /^\/archive\/(claude|codex)$/.exec(path);
    if (m && req.method === 'PUT') {
      if (m[1] !== box.engine) return new Response('wrong engine', { status: 403 });
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.byteLength > 32 * 1024 * 1024) return new Response('too large', { status: 413 });
      const gen = ((await this.conn())[m[1]]?.gen ?? 0) + 1;
      await this.r2.put(archiveKey(this.key, m[1]), bytes, { gen: String(gen) });
      await this.setConn(m[1], { connected: true, gen });
      this.log({ ev: 'archive_saved', engine: m[1], bytes: bytes.byteLength });
      return new Response(null, { status: 200 });
    }
    m = /^\/done\/([A-Za-z0-9_-]+)$/.exec(path);
    if (m && req.method === 'POST') {
      if (!cur || !same(cur.nonce, m[1])) return new Response('no such run', { status: 404 });
      const s = await req.json().catch(() => ({}));
      await this.finishRun(cur, s);
      return new Response(null, { status: 200 });
    }
    return new Response('no such route', { status: 404 });
  }

  /** The end of a run: the audit line, the sign-in state, the linger, and the next job. */
  async finishRun(cur, s = {}) {
    await this.storage.delete('current');
    if (!cur.reported) await this.report(cur.callback_url, { status: s.status === 'done' ? 'done' : 'failed', detail: `runner: ${String(s.error ?? 'no result').slice(0, 200)}` });
    if (s.status === 'not_signed_in') {
      // The saved sign-in has ended. It has no use any more, and the viewer shows "not connected".
      await this.r2.delete(archiveKey(this.key, cur.engine));
      await this.setConn(cur.engine, { connected: false });
    }
    const box = await this.storage.get('box');
    if (box) { box.runs++; box.linger_until = Math.max(box.linger_until ?? 0, this.now() + this.cfg.linger); await this.storage.put('box', box); }
    if (box && s.status === 'not_signed_in') await this.stopBox('not signed in');
    else await this.c.setInactivityTimeout(this.cfg.linger + 60_000).catch(() => {});
    this.log({ ev: 'run', comment_id: cur.comment_id, slug: cur.slug, engine: cur.engine, status: s.status ?? 'unknown', cold_container: cur.cold, ms_queue: cur.ms_queue, ms_container: cur.ms_container, ms_runner: this.now() - cur.t_start, ...pickStats(s) });
    await this.schedule();
    this.defer(() => this.pump());
  }

  /** The alarm: the hard time limit, the end of a sign-in, the end of the linger, and the next job. */
  async alarm() {
    await this.lock(async () => {
      const now = this.now();
      const cur = await this.storage.get('current');
      if (cur && now >= cur.deadline) {
        const box = await this.storage.get('box');
        if (box && this.c.running) await this.c.agentd('/kill', {}, { token: box.token, ms: 3000 }).catch(() => null);
        if (!cur.reported) await this.report(cur.callback_url, { status: 'timeout', detail: `${NAMES[cur.engine]} did not finish in ${this.cfg.timeout / 1000} s` });
        // The hard limit is the one case where the runner stops a container with no save: a run that hangs has no clean end.
        await this.c.destroy('timeout').catch(() => {});
        await this.storage.delete('box');
        await this.storage.delete('current');
        this.log({ ev: 'run', comment_id: cur.comment_id, engine: cur.engine, status: 'timeout', ms_runner: now - cur.t_start });
      }
      const s = await this.storage.get('signin');
      if (s && now >= s.expires_at) await this.storage.delete('signin');
      const box = await this.storage.get('box');
      if (box && !this.c.running) { this.log({ ev: 'container_lost', engine: box.engine, s_alive: (now - box.t_start) / 1000 }); await this.storage.delete('box'); }
      else if (box && !(await this.storage.get('current')) && !(await this.storage.get('signin')) && now >= box.linger_until) await this.stopBox(this.disabled ? 'disabled' : box.runs ? 'idle' : 'warm unused');
    });
    await this.pump();
    await this.schedule();
  }

  /** One alarm at the earliest time that something must happen. No alarm when nothing waits. */
  async schedule() {
    const cur = await this.storage.get('current');
    const box = await this.storage.get('box');
    const s = await this.storage.get('signin');
    const queue = (await this.storage.get('queue')) ?? [];
    const times = [];
    if (cur) times.push(cur.deadline);
    else if (queue.length) times.push(this.now() + 1000);
    if (s) times.push(s.expires_at);
    if (box && !cur && !s) times.push(box.linger_until);
    if (!times.length) return null;
    const at = Math.min(...times);
    const old = await this.storage.getAlarm();
    if (old === null || old === undefined || old !== at) await this.storage.setAlarm(at);
    return at;
  }

  /** After a restart of the Durable Object (a deploy): the container can still run. Its timeout must be set again. */
  async wake() {
    if (this.c.running && (await this.storage.get('box'))) await this.c.setInactivityTimeout(Math.max(this.cfg.linger, this.cfg.timeout) + 60_000).catch(() => {});
    await this.schedule();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pickHeaders = (h, keys) => Object.fromEntries(keys.map((k) => [k, h.get(k)]).filter(([, v]) => v));
const STATS = ['model', 'warm', 'ms_total', 'ms_init', 'ms_first_token', 'ms_first_tool', 'ms_reply', 'ms_engine', 'ms_callback', 'num_turns', 'total_cost_usd', 'callback_status', 'progress_sent', 'progress_accepted', 'tools', 'saved', 'save_ms', 'error'];
const pickStats = (s) => Object.fromEntries(STATS.filter((k) => s[k] !== undefined).map((k) => [k, typeof s[k] === 'string' ? s[k].slice(0, 300) : s[k]]));

/** True when the URL has an origin of HOST_ORIGINS, or HOST_ORIGINS is empty (development). An absent URL passes. */
export function originOk(url, env) {
  if (url === undefined) return true;
  const list = String(env.HOST_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  try { return list.includes(new URL(url).origin); } catch { return false; }
}

/** The routes of the runner Worker: path to [method of RunnerCore, how to find the user key]. */
export const ROUTES = {
  '/run': 'run', '/warm': 'warm', '/status': 'status', '/connect': 'connect', '/connect/code': 'connectCode', '/connect/status': 'connectStatus', '/disconnect': 'disconnect',
};

/**
 * The HTTP front of the runner: checks the secret and the body, finds the Durable Object of the user, and calls it.
 * `stubFor(key)` returns the object (or a RunnerCore in development). Bodies of at most 64 KB.
 */
export async function handle(req, env, stubFor) {
  const url = new URL(req.url);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true, mode: 'cloud', disabled: env.RUNNER_DISABLED === '1' });
  const method = ROUTES[url.pathname];
  if (req.method !== 'POST' || !method) return json(404, { error: 'POST /run' });
  // A deployed runner (it has the HOST binding) with no secret refuses every call: a missing secret must not open it.
  if (env.HOST && !env.RUNNER_SECRET) { console.log(JSON.stringify({ src: 'runner', ev: 'refused', cause: 'no_secret' })); return json(503, { error: 'the runner has no RUNNER_SECRET' }); }
  if (env.RUNNER_SECRET && !same(req.headers.get('x-runner-secret'), env.RUNNER_SECRET)) { console.log(JSON.stringify({ src: 'runner', ev: 'refused', cause: 'secret' })); return json(401, { error: 'the header x-runner-secret is missing or wrong' }); }
  const text = await req.text();
  let body;
  try { body = JSON.parse(text); } catch {}
  if (!body || typeof body !== 'object' || text.length > 64 * 1024) return json(400, { error: 'send JSON of at most 64 KB' });
  let key;
  if (method === 'connectCode' || method === 'connectStatus') {
    key = keyOfFlow(body.id);
    if (!key) return json(404, { error: 'no such sign-in' });
    if (body.user !== undefined && key !== (await objectKey(body.user, 'claude')) && key !== (await objectKey(body.user, 'codex'))) return json(404, { error: 'no such sign-in' });
  } else {
    if (typeof body.user !== 'string' || !body.user) return json(400, { error: 'user must be the identity of the person' });
    if (method === 'status') {
      // The state of each assistant comes from its own object.
      const [a, b] = await Promise.all([stubFor(await objectKey(body.user, 'claude')).status(body), stubFor(await objectKey(body.user, 'codex')).status(body)]);
      if (a[0] !== 200 || b[0] !== 200) return json(a[0] !== 200 ? a[0] : b[0], a[0] !== 200 ? a[1] : b[1]);
      return json(200, { assistants: { claude: a[1].assistants.claude, chatgpt: b[1].assistants.chatgpt } });
    }
    key = await objectKey(body.user, body.engine === 'codex' ? 'codex' : 'claude');
  }
  const stub = stubFor(key);
  const t_received = Date.now();
  const [status, out] = method === 'run' ? await stub.run(body, t_received) : await stub[method](body);
  return json(status, out);
}
