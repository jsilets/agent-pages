#!/usr/bin/env node
// The price of the cloud runner for each warm policy. It uses episode() and price() of sandbox/cost.mjs, and changes
// what this design changes:
//   - Durable Object duration has two bounds. "high": the object is billed for the whole life of its container (the rule
//     of sandbox/cost.mjs). "low": the object is billed only while it handles requests: the start, the run, the drain.
//     Cloudflare bills a Durable Object "while the Durable Object is actively running", and not when it is "idle and
//     eligible for hibernation". Whether a running container keeps its object active is not documented (GUESS).
//   - R2: one GetObject for each container start (the restore), one PutObject for each run (the save after the run),
//     and one more for each container stop (the drain save). Storage: one archive of 118 KB for each user and engine.
//   - A user with no container costs only storage: no alarm waits, and the object is evicted.
//
//   node cloud/cost.mjs [inputs.json] [--users=10000] [--json]
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { episode, price } from '../sandbox/cost.mjs';

const scale = (use, k) => Object.fromEntries(Object.entries(use).map(([key, v]) => [key, v * k]));

/** One episode with the cloud rules. Returns the use, plus do_active_s for the low bound. */
export function cloudEpisode(inp, policy, n) {
  const e = inp.engine, c = inp.cloud;
  const use = episode(inp, policy, n);
  // Low bound: the object is active for the start and the restore, each run, the save, and the drain at the stop.
  const busy = (policy.intent ? e.warm_busy_s : e.cold_busy_s) + (n - 1) * e.warm_busy_s;
  use.do_active_s = c.start_s + c.restore_s + busy + c.save_s * n + c.save_s;
  if (policy.intent) use.do_active_s += c.unused_warms_per_episode * (c.start_s + c.restore_s + c.save_s);
  // R2: the episode() of sandbox/cost.mjs has n PutObject and 1 GetObject. The drain adds one PutObject.
  use.do_active_s = Math.min(use.do_active_s, use.life_s);
  use.r2_a = n + (c.r2_puts_per_episode_extra ?? 1);
  return use;
}

export function cloudPrice(inp, use, included = false) {
  const p = price(inp, use, included);
  const r = inp.rates, f = included ? inp.included : {};
  const over = (amount, key) => Math.max(0, amount - (f[key] ?? 0));
  const reqs = over(use.do_requests, 'do_requests') * r.do_request;
  const high = p.durable_object;
  const low = over(use.do_active_s * 0.125, 'do_gb_s') * r.do_gb_s + reqs;
  const base = p.total - p.durable_object;
  return { ...p, do_high: high, do_low: low, total_high: base + high, total_low: base + low };
}

/** Storage of the users who are connected, each month: R2 archives and Durable Object SQLite. */
export function storage(inp, users) {
  const r = inp.rates, f = inp.included, c = inp.cloud;
  const r2gb = (users * c.archive_mb) / 1024, dogb = (users * c.do_storage_kb) / 1024 / 1024;
  return { r2_gb: r2gb, do_gb: dogb, usd: Math.max(0, r2gb - f.r2_gb_month) * r.r2_gb_month + Math.max(0, dogb - f.do_storage_gb_month) * r.do_storage_gb_month, usd_no_included: r2gb * r.r2_gb_month + dogb * r.do_storage_gb_month };
}

export function table(inp, users = inp.load.users) {
  const runs = users * inp.load.runs_per_user;
  const n = inp.load.burst_size;
  const rows = [];
  for (const policy of inp.policies) {
    const together = policy.linger_s >= inp.load.burst_gap_s - inp.engine.warm_busy_s;
    for (const [pattern, ep, per] of [['isolated', cloudEpisode(inp, policy, 1), 1], [`bursts of ${n}`, together ? cloudEpisode(inp, policy, n) : scale(cloudEpisode(inp, policy, 1), n), n]]) {
      const perRun = scale(ep, 1 / per);
      const month = scale(perRun, runs);
      const m = cloudPrice(inp, month), mi = cloudPrice(inp, month, true);
      rows.push({ policy: policy.name, pattern, billable_s_per_run: perRun.life_s, usd_per_run_low: cloudPrice(inp, perRun).total_low, usd_per_run_high: cloudPrice(inp, perRun).total_high, month_low: m.total_low, month_high: m.total_high, month_after_included_low: mi.total_low, month_after_included_high: mi.total_high, parts: m });
    }
  }
  return rows;
}

const usd = (v) => (v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(5)}`);

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? new URL('./cost-inputs.json', import.meta.url);
  const inp = JSON.parse(readFileSync(file, 'utf8'));
  const usersArg = process.argv.find((a) => a.startsWith('--users='));
  const list = usersArg ? [+usersArg.slice(8)] : [1000, 10000];
  if (process.argv.includes('--json')) { console.log(JSON.stringify(list.map((u) => ({ users: u, rows: table(inp, u), storage: storage(inp, u) })), null, 2)); process.exit(0); }
  const i = inp.instances[inp.instance];
  for (const users of list) {
    console.log(`\n${users} users x ${inp.load.runs_per_user} runs = ${users * inp.load.runs_per_user} runs a month. Instance ${inp.instance} (${i.vcpu} vCPU, ${i.memory_gib} GiB). Durable Object duration: low / high bound.\n`);
    console.log('| Policy | Arrivals | Billable s / run | Cost / run | Month | Month, after included usage |');
    console.log('|---|---|---|---|---|---|');
    for (const r of table(inp, users)) console.log(`| ${r.policy} | ${r.pattern} | ${r.billable_s_per_run.toFixed(1)} | ${usd(r.usd_per_run_low)} to ${usd(r.usd_per_run_high)} | ${usd(r.month_low)} to ${usd(r.month_high)} | ${usd(r.month_after_included_low)} to ${usd(r.month_after_included_high)} |`);
    const s = storage(inp, users);
    console.log(`\nIdle cost of ${users} connected users with no run: ${usd(s.usd)} a month after included usage (${usd(s.usd_no_included)} with none): ${s.r2_gb.toFixed(2)} GB of archives in R2, ${(s.do_gb * 1024).toFixed(1)} MB of Durable Object storage. No container, no alarm, no duration.`);
  }
  console.log('\nAdd $5 a month for the Workers Paid plan.');
}
