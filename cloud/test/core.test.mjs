// The state machine of the Durable Object of one user, with fakes: queue, warm, linger, idle, time limit, kill switch,
// sign-in, archive, and the HTTP front. node --test cloud/test/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveKey, handle, keyOfFlow, RunnerCore, userKey } from '../src/core.mjs';
import { fakeClock, fakeContainer, fakeHost, fakeR2, fakeStorage } from './fakes.mjs';

const ORIGIN = 'https://pages.example.com';
const job = (n = 1, more = {}) => ({ mcp_url: `${ORIGIN}/s/_mcp/TOKEN${n}`, comment_id: String(n).padStart(24, 'a'), slug: 'g/n', agent_label: 'claude', engine: 'claude', user: 'ada@example.com', callback_url: `${ORIGIN}/s/_run/run${n}`, model: null, ...more });

async function setup({ env = {}, behaviour } = {}) {
  const key = await userKey('ada@example.com');
  const clock = fakeClock();
  const storage = fakeStorage(), r2 = fakeR2(), host = fakeHost();
  const logs = [];
  let core;
  const container = fakeContainer(() => core, { behaviour });
  core = new RunnerCore({ key, storage, container, r2, host, env: { HOST_ORIGINS: ORIGIN, RUNNER_SECRET: 's'.repeat(32), ...env }, now: clock.now, log: (o) => logs.push(o) });
  const settle = async () => { for (let i = 0; i < 5; i++) { await core.idle(); await Promise.all(container.pendingRuns.splice(0).map((r) => (typeof r === 'function' ? null : r))); } await core.idle(); };
  /** Connects Claude through the sign-in routes, as the viewer does. */
  const connect = async (engine = 'claude') => {
    const [s1, start] = await core.connect({ engine });
    assert.equal(s1, 200);
    await core.connectCode({ id: start.id, code: 'code-123456789' });
    const [, st] = await core.connectStatus({ id: start.id });
    assert.equal(st.status, 'connected');
    return start;
  };
  return { key, clock, storage, r2, host, logs, container, core: () => core, settle, connect };
}

test('a user with no sign-in: not_signed_in at once, and no container', async () => {
  const t = await setup();
  const [status, body] = await t.core().run(job());
  assert.equal(status, 202);
  assert.deepEqual(body, { accepted: true });
  await t.settle();
  assert.equal(t.container.starts.length, 0);
  assert.deepEqual(t.host.results().map((r) => r.status), ['not_signed_in']);
  const [, st] = await t.core().status();
  assert.equal(st.assistants.claude.connected, false);
  assert.equal(st.assistants.chatgpt.connected, false);
  assert.equal(st.assistants.claude.default_model, 'sonnet');
});

test('sign-in: the id carries the user key, the code reaches agentd once, the archive goes to R2, no log has the code', async () => {
  const t = await setup();
  const start = await t.connect();
  assert.equal(keyOfFlow(start.id), t.key);
  assert.equal(start.needs_code, true);
  assert.match(start.url, /^https:\/\/claude\.com\//);
  assert.equal(t.container.loginCode, 'code-123456789');
  assert.equal(t.container.starts[0].image, 'claude');
  assert.equal(t.container.starts[0].instance, 'standard-1');
  assert.ok(t.r2.m.has(archiveKey(t.key, 'claude')));
  const [, st] = await t.core().status();
  assert.equal(st.assistants.claude.connected, true);
  assert.ok(!JSON.stringify(t.logs).includes('code-123456789'));
  assert.ok(!JSON.stringify(t.logs).includes('ada@example.com'));
  // The sign-in is over, so the container lingers like after a run.
  assert.equal(await t.storage.getAlarm(), t.clock.now() + 90_000);
});

test('a run: the connector token stays in the Durable Object, progress and result reach the host, then the linger', async () => {
  const t = await setup();
  await t.connect();
  const [status] = await t.core().run(job(1));
  assert.equal(status, 202);
  await t.settle();
  // The container from the sign-in serves the run: no second start.
  assert.equal(t.container.starts.length, 1);
  assert.equal(t.container.lastMcp.result.url, `${ORIGIN}/s/_mcp/TOKEN1`);
  const sent = t.container.runs[0];
  assert.ok(!JSON.stringify(sent).includes('TOKEN1'), 'the job that agentd gets has no connector URL');
  assert.ok(!JSON.stringify(sent).includes('/s/_run/'), 'and no callback URL');
  assert.equal(sent.job.model, undefined, 'a null model is dropped');
  assert.deepEqual(t.host.results().map((r) => [r.url, r.status]), [[`${ORIGIN}/s/_run/run1`, 'done']]);
  assert.equal(t.host.progress().length, 1);
  assert.equal(await t.storage.get('current'), undefined);
  const box = await t.storage.get('box');
  assert.equal(box.runs, 1);
  assert.equal(await t.storage.getAlarm(), t.clock.now() + 90_000);
  const line = t.logs.find((l) => l.ev === 'run');
  assert.equal(line.status, 'done');
  assert.ok(!JSON.stringify(t.logs).includes('TOKEN1'), 'no log line has the token');
});

test('one run at a time: the second job waits for the end of the first, and a full queue answers 429', async () => {
  const t = await setup({ env: { MAX_QUEUE: '2' } });
  await t.connect();
  t.container.autoDone = false;
  await t.core().run(job(1));
  await t.core().idle();
  assert.equal(t.container.runs.length, 1);
  await t.core().run(job(2));
  await t.core().run(job(3));
  const [s4] = await t.core().run(job(4));
  assert.equal(s4, 429);
  await t.core().idle();
  assert.equal(t.container.runs.length, 1, 'job 2 waits while job 1 runs');
  for (let i = 0; i < 3; i++) {
    const next = t.container.pendingRuns.shift();
    await next();
    await t.core().idle();
  }
  assert.equal(t.container.runs.length, 3);
  assert.deepEqual(t.host.results().map((r) => r.url.slice(-4)), ['run1', 'run2', 'run3']);
});

test('the linger ends: drain, which saves, then stop. The next run starts a container and restores the archive', async () => {
  const t = await setup();
  await t.connect();
  await t.core().run(job(1));
  await t.settle();
  t.clock.advance(90_001);
  await t.core().alarm();
  assert.ok(t.container.agentdCalls.some((c) => c.path === '/drain'), 'drain before the stop');
  assert.deepEqual(t.container.destroyed, ['idle']);
  assert.equal(t.container.running, false);
  const stopped = t.logs.find((l) => l.ev === 'container_stopped');
  assert.equal(stopped.why, 'idle');
  assert.ok(stopped.s_billable >= 90);
  await t.core().run(job(2));
  await t.settle();
  assert.equal(t.container.starts.length, 2);
  assert.ok(t.container.init.archive, 'the second container gets the archive');
  assert.equal(Buffer.from(t.container.init.archive, 'base64').toString('hex'), '01020301', 'the latest archive, from the end of run 1');
  assert.ok(t.container.init.aad.endsWith(`${t.key}/claude`));
});

test('warm on intent: /warm starts the container; a run in the warm time takes it; nothing for a user with no sign-in', async () => {
  const t = await setup();
  const [, w0] = await t.core().warm({ engine: 'claude' });
  assert.equal(w0.warm, false);
  assert.equal(w0.cause, 'not_signed_in');
  await t.connect();
  t.clock.advance(100_000);
  await t.core().alarm();
  assert.equal(t.container.running, false);
  const [s] = await t.core().warm({ engine: 'claude' });
  assert.equal(s, 202);
  await t.settle();
  assert.equal(t.container.starts.length, 2);
  assert.equal((await t.storage.get('box')).by, 'warm');
  assert.equal(await t.storage.getAlarm(), t.clock.now() + 60_000);
  t.clock.advance(5000);
  await t.core().run(job(1));
  await t.settle();
  assert.equal(t.container.starts.length, 2, 'the run takes the warm container');
  assert.equal(t.logs.filter((l) => l.ev === 'run').at(-1).cold_container, false);
  // An unused warm container stops after WARM_MS.
  t.clock.advance(91_000);
  await t.core().alarm();
  assert.equal(t.container.running, false);
});

test('the hard time limit: the host gets timeout, the container goes, and the next job runs', async () => {
  const t = await setup({ behaviour: 'hang' });
  await t.connect();
  await t.core().run(job(1));
  await t.core().run(job(2));
  await t.settle();
  const cur = await t.storage.get('current');
  assert.equal(await t.storage.getAlarm(), cur.deadline);
  assert.equal(cur.deadline - cur.t_start, 195_000);
  t.clock.advance(195_001);
  t.container.behaviour = 'reply';
  await t.core().alarm();
  await t.settle();
  assert.deepEqual(t.host.results().map((r) => [r.url.slice(-4), r.status]), [['run1', 'timeout'], ['run2', 'done']]);
  assert.ok(t.container.destroyed.includes('timeout'));
  assert.ok(t.container.agentdCalls.some((c) => c.path === '/kill'));
});

test('the kill switch: no run, no warm, no sign-in; status still answers', async () => {
  const t = await setup({ env: { RUNNER_DISABLED: '1' } });
  assert.equal((await t.core().run(job()))[0], 503);
  assert.equal((await t.core().warm({}))[1].warm, false);
  assert.equal((await t.core().connect({ engine: 'claude' }))[0], 503);
  assert.equal((await t.core().status())[0], 200);
  assert.equal(t.container.starts.length, 0);
});

test('a run that finds no sign-in deletes the archive and stops the container', async () => {
  const t = await setup({ behaviour: 'nosign' });
  await t.connect();
  await t.core().run(job(1));
  await t.settle();
  assert.equal(t.host.results()[0].status, 'not_signed_in');
  assert.equal(t.r2.m.size, 0);
  assert.equal((await t.core().status())[1].assistants.claude.connected, false);
  assert.ok(t.container.destroyed.includes('not signed in'));
});

test('a job of the other engine stops the container gently and starts the other image', async () => {
  const t = await setup();
  await t.connect('claude');
  await t.connect('codex');
  assert.deepEqual(t.container.starts.map((s) => s.image), ['claude', 'codex']);
  assert.ok(t.container.agentdCalls.some((c) => c.path === '/drain'));
  await t.core().run(job(1, { engine: 'claude' }));
  await t.settle();
  assert.deepEqual(t.container.starts.map((s) => s.image), ['claude', 'codex', 'claude']);
  assert.equal(t.host.results()[0].status, 'done');
});

test('the container side: a wrong token gets 401, a wrong run id 404, an archive of the other engine 403', async () => {
  const t = await setup();
  await t.connect();
  const req = (p, token, init = {}) => t.core().fromContainer(new Request(`http://runner.internal${p}`, { method: 'POST', headers: { 'x-agentd-token': token }, ...init }));
  assert.equal((await req('/mcp', 'wrong')).status, 401);
  assert.equal((await req('/mcp', '')).status, 401);
  assert.equal((await req('/cb/nonexistentnonce0000', t.container.token, { body: '{}' })).status, 404);
  assert.equal((await req('/archive/codex', t.container.token, { method: 'PUT', body: 'x' })).status, 403);
  // No run: the connector answer comes from the discover route of the host, with the runner secret.
  const r = await req('/mcp', t.container.token, { body: '{"method":"tools/list"}' });
  assert.equal(r.status, 200);
  const call = t.host.calls.at(-1);
  assert.equal(call.url, `${ORIGIN}/s/_mcp/discover`);
  assert.equal(call.headers['x-runner-secret'], 's'.repeat(32));
});

test('an archive that does not open: the person is not connected any more', async () => {
  const t = await setup();
  await t.connect();
  t.clock.advance(100_000);
  await t.core().alarm();
  t.r2.m.set(archiveKey(t.key, 'claude'), new Uint8Array([0]));
  const realAgentd = t.container.agentd;
  t.container.agentd = async (p, b, o) => (p === '/init' ? realAgentd(p, { ...b, archive: 'bad' }, o) : realAgentd(p, b, o));
  await t.core().warm({ engine: 'claude' });
  await t.settle();
  assert.equal((await t.core().status())[1].assistants.claude.connected, false);
  assert.ok(t.logs.some((l) => l.ev === 'archive_rejected'));
});

test('disconnect: logout in the container, the archive and the key go', async () => {
  const t = await setup();
  await t.connect();
  assert.ok(await t.storage.get('archive_key'));
  const [s] = await t.core().disconnect({ engine: 'claude' });
  assert.equal(s, 200);
  assert.ok(t.container.agentdCalls.some((c) => c.path === '/logout'));
  assert.equal(t.r2.m.size, 0);
  assert.equal(await t.storage.get('archive_key'), undefined);
  assert.equal(t.container.running, false);
});

test('the HTTP front: the secret, the user, the routes of a sign-in by id', async () => {
  const env = { RUNNER_SECRET: 'x'.repeat(32) };
  const calls = [];
  const stubFor = (key) => new Proxy({}, { get: (_t, m) => async (body) => { calls.push({ key, m, body }); return [200, { ok: true }]; } });
  const post = (path, body, secret = env.RUNNER_SECRET) => handle(new Request(`http://runner${path}`, { method: 'POST', headers: { 'x-runner-secret': secret }, body: JSON.stringify(body) }), env, stubFor);
  assert.equal((await post('/run', job(), 'wrong')).status, 401);
  assert.equal((await post('/status', {})).status, 400);
  assert.equal((await post('/status', { user: 'ada@example.com' })).status, 200);
  const key = await userKey('ada@example.com');
  assert.equal(calls[0].key, key);
  assert.equal((await post('/connect/code', { id: `${key}-${'A'.repeat(24)}`, code: 'abcdefgh' })).status, 200);
  assert.equal(calls[1].key, key);
  assert.equal(calls[1].m, 'connectCode');
  assert.equal((await post('/connect/status', { id: 'nokey' })).status, 404);
  assert.equal((await post('/connect/status', { id: `${key}-${'A'.repeat(24)}`, user: 'eve@example.com' })).status, 404);
  assert.equal((await handle(new Request('http://runner/health'), env, stubFor)).status, 200);
  // Two identities never share an object.
  assert.notEqual(await userKey('ada@example.com'), await userKey('Ada@example.com'));
  assert.match(key, /^[0-9a-f]{64}$/);
  // A deployed runner (it has HOST) with no secret refuses all calls, with or without a header. No object gets a call.
  const n = calls.length;
  const open = (secret) => handle(new Request('http://runner/status', { method: 'POST', headers: secret === undefined ? {} : { 'x-runner-secret': secret }, body: JSON.stringify({ user: 'ada@example.com' }) }), { HOST: {} }, stubFor);
  assert.equal((await open()).status, 503);
  assert.equal((await open('')).status, 503);
  assert.equal(calls.length, n);
});

test('a job with a foreign origin gets 400', async () => {
  const t = await setup();
  const [s, b] = await t.core().run(job(1, { mcp_url: 'https://evil.example/s/_mcp/x' }));
  assert.equal(s, 400);
  assert.match(b.error, /HOST_ORIGINS/);
});

test('REQUIRE_EGRESS=1: a container with no firewall serves no run', async () => {
  const t = await setup({ env: { REQUIRE_EGRESS: '1' } });
  await t.connect();
  t.clock.advance(100_000);
  await t.core().alarm();
  const realAgentd = t.container.agentd;
  t.container.agentd = async (p, b, o) => (p === '/health' ? { status: 200, body: { ok: true, hardening: { egress: 'proxy-only' } } } : realAgentd(p, b, o));
  await t.core().run(job(1));
  await t.settle();
  assert.equal(t.host.results()[0].status, 'failed');
  assert.match(t.host.results()[0].detail, /firewall/);
  assert.ok(t.container.destroyed.includes('no firewall'));
});
