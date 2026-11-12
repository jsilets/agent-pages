#!/usr/bin/env node
// Connects one assistant for one user of docker mode, from a terminal. It has no dependencies.
// It uses the same code as POST /connect of the runner: the sign-in of the unmodified program runs in a container of the
// user, on the internal network, and the egress proxy lets it reach the sign-in hosts only while it waits.
//
//   node sandbox/connect.mjs <claude|chatgpt> [user] [--status | --logout]
//
// `user` is the author name that the host sends with a job: the Access email of the person, or `local` in development.
// The default is `local`.
//
//   claude    runs `claude auth login --claudeai`. Claude Code prints a link. The person signs in on the Anthropic page
//             and pastes the code that the page shows here.
//   chatgpt   runs `codex login --device-auth`. Codex prints a link and a one-time code. The person opens the link,
//             signs in to ChatGPT, and types the code. "Device code authorization for Codex" must be on in the
//             security settings of the ChatGPT account, or the workspace admin must allow it.
// The sign-in goes from the program to its maker. This script reads no credential and stores none: the program writes
// its own file in the volume. A sign-in that fails removes the volume it made, and --logout signs out and removes the volume.
//
// The script uses its own Docker objects (the port number 8898 in their names), so it does not touch a runner that runs.
// Stop a runner that has a container of this user first, or use the web app: two programs must not share one sign-in folder.
import { createInterface } from 'node:readline';

process.env.RUNNER_PORT = process.env.CONNECT_PORT || '8898';
process.env.RUNNER_MODE = 'docker';
const R = await import('./local-runner.mjs');

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const status = flag('--status'), logout = flag('--logout');
const [agent, user = 'local'] = argv;
if (agent !== 'claude' && agent !== 'chatgpt') { console.error('usage: connect.mjs <claude|chatgpt> [user] [--status | --logout]'); process.exit(2); }
const engine = agent === 'claude' ? 'claude' : 'codex';
const name = agent === 'claude' ? 'Claude' : 'ChatGPT';
// The runner prints one JSON line for each event. Here they go to stderr, so the terminal shows the steps for the person.
console.log = (...a) => process.stderr.write(`${a.join(' ')}\n`);
const say = (t) => process.stdout.write(`${t}\n`);
const connected = async () => (await R.assistantStatus(user)).assistants[agent].connected;

say(`User:    ${user}`);
say(`Volumes: ${R.volumeOf(user)} (Claude, /claude-config), ${R.codexVolumeOf(user)} (ChatGPT, /codex-home)`);
let ok;
try {
  if (logout) { await R.disconnect(user, engine); ok = false; }
  else if (status) ok = await connected();
  else {
    const s = await R.startSignIn(user, engine);
    say(`\nOpen this link in a browser and sign in:\n  ${s.url}`);
    if (s.user_code) say(`Then type this one-time code on the page:\n  ${s.user_code}\n\nWaiting for the approval…`);
    if (s.needs_code) {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
      const code = await new Promise((r) => rl.question('Paste the code that the Anthropic page shows: ', (a) => { rl.close(); r(a.trim()); }));
      const sent = R.sendCode(s.id, code);
      if (sent.status !== 200) say(`The code was not sent: ${sent.body.error ?? sent.body.status}`);
    }
    let st;
    while ((st = R.signInStatus(s.id).body).status === 'pending') await new Promise((r) => setTimeout(r, 1000));
    if (st.detail) say(st.detail);
    ok = st.status === 'connected';
  }
} catch (e) {
  say(String(e.message || e));
  ok = false;
} finally {
  await R.shutdown();
}
say(`\n${name}: ${ok ? 'connected' : 'not connected'}`);
process.exit(ok || logout ? 0 : 1);
