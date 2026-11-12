#!/usr/bin/env node
// The price of the sandbox on Cloudflare for each warm policy, from measured inputs. It has no dependencies.
//
//   node sandbox/cost.mjs [inputs.json] [--instance=basic] [--json]
//
// The default inputs are cost-inputs.json next to this file. COST.md explains each input and each formula.
// Change a number there when a new measurement replaces it, and run this again.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * One episode: the life of one container, from its start to its stop. An isolated run is an episode of one run. A burst
 * is an episode of `n` runs when the container lives from one run to the next, and `n` episodes of one run when it does not.
 * Returns the use of each billed resource for one episode.
 */
export function episode(inp, policy, n) {
  const e = inp.engine, c = inp.cloud;
  const L = policy.linger_s;
  const gap = inp.load.burst_gap_s;
  const prewarm = L > 0;
  // The first run of a container with no warm on intent starts its program after the job arrives.
  const firstBusy = policy.intent ? e.warm_busy_s : e.cold_busy_s;
  const waitBefore = policy.intent ? c.typing_s : 0;
  // Seconds from the start of the container to the end of its last run, then the linger (a save happens in it).
  const life = c.start_s + c.restore_s + waitBefore + (n > 1 ? (n - 1) * gap + e.warm_busy_s : firstBusy) + Math.max(c.save_s, L);
  const busy = firstBusy + (n - 1) * e.warm_busy_s;
  // CPU: the program that runs each job, the program that waits for the next job, and the time a program waits.
  // The first program starts in the run (cold) or at the warm call. With a linger, a new program waits after each run.
  const programs = 1 + (prewarm ? n : 0);
  const waiting = prewarm || policy.intent ? life - c.start_s - c.restore_s - busy : 0;
  const cpu = e.cpu_run_s * n + programs * e.cpu_program_start_s + waiting * e.cpu_idle_per_s;
  const out = { life_s: life, cpu_s: cpu, do_requests: n * c.do_requests_per_run + (policy.intent ? 1 : 0), r2_a: n, r2_b: 1, worker_requests: n * c.worker_requests_per_run };
  // A person who opens a comment box and posts nothing: the container starts, waits warm_s, and stops.
  if (policy.intent) {
    const u = c.unused_warms_per_episode;
    const wlife = c.start_s + c.restore_s + e.warm_s;
    out.life_s += u * wlife;
    out.cpu_s += u * (e.cpu_program_start_s + e.warm_s * e.cpu_idle_per_s);
    out.do_requests += u;
    out.r2_b += u;
  }
  return out;
}

/** The price of a use, with the rates and the instance type of the inputs. `included` subtracts the free amounts first. */
export function price(inp, use, included = false) {
  const r = inp.rates, i = inp.instances[inp.instance], f = included ? inp.included : {};
  const over = (amount, key) => Math.max(0, amount - (f[key] ?? 0));
  const parts = {
    memory: over(use.life_s * i.memory_gib, 'memory_gib_s') * r.memory_gib_s,
    cpu: over(use.cpu_s, 'vcpu_s') * r.vcpu_s,
    disk: over(use.life_s * i.disk_gb, 'disk_gb_s') * r.disk_gb_s,
    // A Durable Object is billed for 128 MB while it is active. The model takes it as active for the whole life of its container.
    durable_object: over(use.life_s * 0.125, 'do_gb_s') * r.do_gb_s + over(use.do_requests, 'do_requests') * r.do_request,
    r2: over(use.r2_a, 'r2_class_a') * r.r2_class_a + over(use.r2_b, 'r2_class_b') * r.r2_class_b,
    workers: over(use.worker_requests, 'worker_requests') * r.worker_request,
  };
  return { ...parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
}

const scale = (use, k) => Object.fromEntries(Object.entries(use).map(([key, v]) => [key, v * k]));

/** One row for each policy and arrival pattern: the seconds, the CPU and the price of one run, and the price of one month. */
export function table(inp) {
  const runs = inp.load.users * inp.load.runs_per_user;
  const n = inp.load.burst_size;
  const rows = [];
  for (const policy of inp.policies) {
    // In a burst the container lives to the next run only when the linger is longer than the gap after a run.
    const together = policy.linger_s >= inp.load.burst_gap_s - inp.engine.warm_busy_s;
    for (const [pattern, ep, runsPerEp] of [
      ['isolated', episode(inp, policy, 1), 1],
      [`bursts of ${n}`, together ? episode(inp, policy, n) : scale(episode(inp, policy, 1), n), n],
    ]) {
      const perRun = scale(ep, 1 / runsPerEp);
      const month = scale(perRun, runs);
      rows.push({ policy: policy.name, pattern, billable_s_per_run: perRun.life_s, cpu_s_per_run: perRun.cpu_s, usd_per_run: price(inp, perRun).total, usd_month: price(inp, month).total, usd_month_after_included: price(inp, month, true).total, month_parts: price(inp, month) });
    }
  }
  return rows;
}

const usd = (v) => (v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(5)}`);

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? new URL('./cost-inputs.json', import.meta.url);
  const inp = JSON.parse(readFileSync(file, 'utf8'));
  const pick = process.argv.find((a) => a.startsWith('--instance='));
  if (pick) inp.instance = pick.slice(11);
  if (!inp.instances[inp.instance]) { console.error(`no instance type ${inp.instance} in the inputs`); process.exit(2); }
  const rows = table(inp);
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    const i = inp.instances[inp.instance];
    console.log(`Instance ${inp.instance} (${i.vcpu} vCPU, ${i.memory_gib} GiB, ${i.disk_gb} GB). ${inp.load.users} users x ${inp.load.runs_per_user} runs = ${inp.load.users * inp.load.runs_per_user} runs a month. A burst is ${inp.load.burst_size} runs, ${inp.load.burst_gap_s} s apart.\n`);
    console.log('| Policy | Arrivals | Billable s / run | CPU s / run | Cost / run | Month, no included usage | Month, after included usage |');
    console.log('|---|---|---|---|---|---|---|');
    for (const r of rows) console.log(`| ${r.policy} | ${r.pattern} | ${r.billable_s_per_run.toFixed(1)} | ${r.cpu_s_per_run.toFixed(1)} | ${usd(r.usd_per_run)} | ${usd(r.usd_month)} | ${usd(r.usd_month_after_included)} |`);
    console.log('\nThe Workers Paid plan costs $5 a month in each case. "After included usage" takes this load as the only use of the account.');
    console.log('\nShare of the month, no included usage (memory / CPU / disk / Durable Objects / R2 / Workers):');
    for (const r of rows) { const p = r.month_parts; console.log(`- ${r.policy}, ${r.pattern}: ${['memory', 'cpu', 'disk', 'durable_object', 'r2', 'workers'].map((k) => usd(p[k])).join(' / ')}`); }
  }
}
