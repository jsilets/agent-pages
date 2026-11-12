#!/usr/bin/env node
// Connects one assistant for one user of docker mode: runs the sign-in of the unmodified program in the volume of the user.
// It has no dependencies. Run it in a terminal, because the sign-in asks a question.
//
//   node sandbox/connect.mjs <claude|chatgpt> [user] [--status | --logout]
//
// `user` is the author name that the host sends with a job: the Access email of the person, or `local` in development.
// The default is `local`.
//
//   claude    runs `claude auth login`. Claude Code prints a link. The person signs in on the Anthropic page and pastes
//             the code that the page shows.
//   chatgpt   runs `codex login --device-auth`. Codex prints a link and a one-time code. The person opens the link,
//             signs in to ChatGPT, and types the code. "Device code authorization for Codex" must be on in the
//             security settings of the ChatGPT account, or the workspace admin must allow it.
// The sign-in goes from the program to its maker. This script reads no credential and stores none: the program writes
// its own file in the volume.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexVolumeOf, IMAGE, volumeOf } from './local-runner.mjs';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const status = flag('--status'), logout = flag('--logout');
const [agent, user = 'local'] = argv;
if (agent !== 'claude' && agent !== 'chatgpt') { console.error('usage: connect.mjs <claude|chatgpt> [user] [--status | --logout]'); process.exit(2); }

const A = agent === 'claude'
  ? { name: 'Claude', volume: volumeOf(user), mount: '/claude-config', login: ['claude', 'auth', 'login'], status: ['claude', 'auth', 'status'], logout: ['claude', 'auth', 'logout'], yes: /"loggedIn":\s*true/ }
  : { name: 'ChatGPT', volume: codexVolumeOf(user), mount: '/codex-home', login: ['codex', 'login', '--device-auth'], status: ['codex', 'login', 'status'], logout: ['codex', 'logout'], yes: /^logged in/im };

const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts });
if (docker(['image', 'inspect', '-f', '{{.Id}}', IMAGE]).status !== 0) {
  console.log(`Building the image ${IMAGE}…`);
  if (docker(['build', '-t', IMAGE, dirname(fileURLToPath(import.meta.url))], { stdio: 'inherit' }).status !== 0) process.exit(1);
}
// The same limits as a run, but with the normal network: the sign-in needs the sign-in hosts, and a person watches it.
const run = (cmd, tty) => ['run', '--rm', ...(tty ? ['-it'] : []), '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-v', `${A.volume}:${A.mount}`, IMAGE, ...cmd];
const connected = () => { const r = docker(run(A.status, false)); return A.yes.test(`${r.stdout}${r.stderr}`); };

console.log(`User:    ${user}`);
console.log(`Volumes: ${volumeOf(user)} (Claude, /claude-config), ${codexVolumeOf(user)} (ChatGPT, /codex-home)`);
if (logout) docker(run(A.logout, false), { stdio: 'inherit' });
else if (!status) {
  if (!process.stdin.isTTY) { console.error('Run this command in a terminal. The sign-in asks a question.'); process.exit(2); }
  console.log(`Starting the sign-in of ${A.name} in the volume ${A.volume}…\n`);
  docker(run(A.login, true), { stdio: 'inherit' });
}
const ok = connected();
console.log(`\n${A.name}: ${ok ? 'connected' : 'not connected'}`);
process.exit(ok || logout ? 0 : 1);
