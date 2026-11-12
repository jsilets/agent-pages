#!/usr/bin/env node
// Replays the progress events of one run with realistic timing, with no assistant and no sign-in.
// Use it to build the viewer without a real run. It has no dependencies.
//
//   node sandbox/fake-progress.mjs <callback_url> [quote] [new text] [--result done|failed|not_signed_in|none] [--speed 1] [--dry]
//
// <callback_url> is the URL of the run: http://localhost:8802/s/_run/<run id>. Each event goes to <callback_url>/progress.
// With --result (default: none) the script also sends the final result to <callback_url>, as run-comment.mjs does.
// --speed 2 halves each pause. --dry prints the events and sends nothing.
//
// The events, in order (the same contract that run-comment.mjs sends):
//   { seq, at, kind: "started" }
//   { seq, at, kind: "tool", tool: "list_comments" | "get_page" | "edit_page" | "reply_to_comment" }
//   { seq, at, kind: "focus", quote }                 the old_text of the edit, one time for each edit
//   { seq, at, kind: "typing", quote, text }          the new_text so far, at most one event each 300 ms, then the full text
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The events of one run as [ms from the start, event] pairs. The times come from real runs with the default model. */
export function fakeSequence(quote = 'Heat pumps move heat from one place to another place, and they do not make heat from fuel, which is why they use much less energy than a boiler for the same amount of warmth in a house.', text = 'Heat pumps move heat instead of making it, so they use much less energy than a boiler.') {
  const ev = [[0, { kind: 'started' }]];
  ev.push([2600, { kind: 'tool', tool: 'list_comments' }], [2650, { kind: 'tool', tool: 'get_page' }]);
  ev.push([6200, { kind: 'tool', tool: 'edit_page' }], [6450, { kind: 'focus', quote: quote.slice(0, 500) }]);
  // The model writes about 12 characters each 100 ms. The sender groups them into one event each 300 ms.
  let t = 6900;
  for (let n = 36; n < text.length; n += 36, t += 300) ev.push([t, { kind: 'typing', quote: quote.slice(0, 500), text: text.slice(0, n).slice(0, 2000) }]);
  ev.push([t, { kind: 'typing', quote: quote.slice(0, 500), text: text.slice(0, 2000) }]);
  ev.push([t + 2400, { kind: 'tool', tool: 'reply_to_comment' }]);
  return { events: ev, end: t + 4200 };
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); if (i < 0) return dflt; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const dry = argv.includes('--dry');
  if (dry) argv.splice(argv.indexOf('--dry'), 1);
  const result = opt('result', 'none');
  const speed = +opt('speed', 1) || 1;
  const [callback, quote, text] = argv;
  if (!callback) { console.error('usage: fake-progress.mjs <callback_url> [quote] [new text] [--result done|failed|not_signed_in|none] [--speed 1] [--dry]'); process.exit(2); }
  const url = callback.replace(/\/+$/, '') + '/progress';
  const { events, end } = fakeSequence(quote || undefined, text || undefined);
  const t0 = Date.now();
  let seq = 0;
  for (const [ms, e] of events) {
    await sleep(Math.max(0, ms / speed - (Date.now() - t0)));
    const body = { seq: ++seq, at: new Date().toISOString(), ...e };
    let status = 'dry';
    if (!dry) status = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) }).then((r) => r.status, (e2) => `error: ${e2.message}`);
    console.log(`${String(Date.now() - t0).padStart(6)} ms  ${status}  ${JSON.stringify(body)}`);
  }
  if (result === 'none') return;
  await sleep(Math.max(0, end / speed - (Date.now() - t0)));
  const body = result === 'done' ? { status: 'done', detail: 'engine=claude model=fake turns=4 tools=list_comments,get_page,edit_page,reply_to_comment' } : { status: result, detail: result === 'not_signed_in' ? 'Claude Code has no sign-in in this sandbox' : 'a fake failure' };
  const status = dry ? 'dry' : await fetch(callback, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }).then((r) => r.status, (e2) => `error: ${e2.message}`);
  console.log(`${String(Date.now() - t0).padStart(6)} ms  ${status}  result ${JSON.stringify(body)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
