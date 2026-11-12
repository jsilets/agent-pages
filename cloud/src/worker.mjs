// The runner Worker on Cloudflare: the same HTTP contract as sandbox/local-runner.mjs (POST /run, /warm, /status,
// /connect, /connect/code, /connect/status, /disconnect), one Durable Object for each assistant of each user, and one container for each
// Durable Object. core.mjs has the logic. This file connects it to the platform.
//
// The Worker has no public URL (workersDev: false, no route, no domain). The host reaches it through a service binding.
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { handle, RunnerCore } from './core.mjs';

/** The intercepted host name. The container reaches the Durable Object of its user through it, and nothing else does. */
const INTERNAL = 'runner.internal';
const AGENTD_PORT = 8080;

/** The host Worker: the service binding HOST when it is set, else a plain fetch (development with a host on localhost). */
const hostOf = (env) => ({ fetch: (url, init) => (env.HOST ? env.HOST.fetch(url, init) : fetch(url, init)) });

const r2Of = (bucket) => ({
  get: async (key) => { const o = await bucket.get(key); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
  put: (key, bytes, meta) => bucket.put(key, bytes, { customMetadata: meta }),
  delete: (key) => bucket.delete(key),
});

/** ctx.container as core.mjs uses it. https://developers.cloudflare.com/containers/api/durable-object-container/ */
function containerOf(ctx) {
  const c = ctx.container;
  return {
    get running() { return c.running; },
    // enableInternet: true, because the allow list is in the container (agentd) and not in a TLS interception: the
    // platform can allow a TLS host only by decrypting it in a Worker, and the model requests carry the OAuth token of
    // the person. See README.md, "Egress".
    start: ({ image, instance, env }) => c.start({ image: c.images[image], instance, enableInternet: true, env }),
    destroy: (why) => c.destroy(why),
    setInactivityTimeout: (ms) => c.setInactivityTimeout(ms),
    // An intercept lasts until the container stops, so each start registers it again.
    intercept: () => c.interceptOutboundHttp(INTERNAL, ctx.exports.Outbound({ props: { id: ctx.id.toString() } })),
    agentd: async (path, body, { token, ms = 15_000 } = {}) => {
      const res = await c.getTcpPort(AGENTD_PORT).fetch(`http://agentd${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-agentd-token': token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
  };
}

/** The Durable Object of one user. Its name is the user key of core.mjs (a SHA-256 hash), never the identity. */
export class UserRunner extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = null;
    ctx.blockConcurrencyWhile(async () => {
      let key = await ctx.storage.get('user_key');
      this.core = key ? this.make(key) : null;
      if (this.core) await this.core.wake();
    });
  }
  make(key) { return new RunnerCore({ key, storage: this.ctx.storage, container: containerOf(this.ctx), r2: r2Of(this.env.CREDENTIALS), host: hostOf(this.env), env: this.env }); }
  /** The first call names the key. Later calls must give the same one. */
  async at(key) {
    if (!this.core) { await this.ctx.storage.put('user_key', key); this.core = this.make(key); }
    if (this.core.key !== key) throw new Error('wrong user key for this object');
    return this.core;
  }
  async call(key, method, body, t) { return (await this.at(key))[method](body, t); }
  async fromContainer(req) { return this.core ? this.core.fromContainer(req) : new Response('no', { status: 401 }); }
  async alarm() { if (this.core) await this.core.alarm(); }
}

/** The outbound handler of each container: http://runner.internal/... goes to the Durable Object that owns the container. */
export class Outbound extends WorkerEntrypoint {
  async fetch(req) {
    const u = new URL(req.url);
    if (u.hostname !== INTERNAL || u.protocol !== 'http:') return new Response('no route', { status: 403 });
    const ns = this.ctx.exports.UserRunner;
    return ns.get(ns.idFromString(this.ctx.props.id)).fromContainer(req);
  }
}

// ctx.exports.UserRunner is the namespace of the Durable Object class of this Worker. A binding with the name of this
// Worker is not possible: the deploy refuses a container on a class that a binding names by script.
const stubs = (ns) => (key) => {
  const stub = ns.getByName(key);
  return new Proxy({}, { get: (_t, method) => (body, t) => stub.call(key, method, body, t) });
};

export default {
  fetch: (req, env, ctx) => handle(req, env, stubs(ctx.exports.UserRunner)),
};
