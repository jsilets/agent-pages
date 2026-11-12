#!/usr/bin/env node
// Proves the archive path of the sign-in folder with a real sign-in, and with no network in any container:
//   1. agentd's pack() and seal() in a container that mounts the sign-in volume read-only: the sealed bytes go to stdout.
//   2. This script stores the bytes as the R2 object of the user (a file in .cloudflare/state-cloud/r2).
//   3. A new agentd container (tmpfs folder, no volume) gets the archive with POST /init, as the Durable Object sends it.
//   4. `claude auth status --json` in that container: loggedIn must be true. Only that one boolean leaves the container.
// With no network, Claude Code cannot renew the sign-in, so the copy can never rotate the token of the volume.
// No step reads, prints or parses a file of the folder. The script prints sizes and times.
//
//   node cloud/dev/archive-roundtrip.mjs <sign-in volume> [image]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aadOf, archiveKey, userKey } from '../src/core.mjs';

const [volume, image = 'agent-pages-agentd-claude'] = process.argv.slice(2);
if (!volume) { console.error('usage: archive-roundtrip.mjs <sign-in volume> [image]'); process.exit(2); }
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const docker = (args, opts = {}) => spawnSync('docker', args, { env, maxBuffer: 64 * 1024 * 1024, timeout: 120_000, ...opts });
const out = {};
const key = await userKey('archive-roundtrip');
const aad = aadOf(key, 'claude');
const k = randomBytes(32);

// 1. Pack and seal inside a container: no network, the volume read-only, the user of the programs.
let t = Date.now();
const script = `const A = await import('/opt/agentd/cloud/agentd/agentd.mjs'); const b = await A.pack(); process.stdout.write(A.seal(b, Buffer.from(process.env.K, 'base64'), process.env.AAD));`;
const sealed = docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '10001:10001', '-e', `K=${k.toString('base64')}`, '-e', `AAD=${aad}`, '-v', `${volume}:/claude-config:ro`, '--entrypoint', 'node', image, '--input-type=module', '-e', script]);
if (sealed.status !== 0) { console.error('pack failed', String(sealed.stderr).slice(-300)); process.exit(1); }
out.ms_pack_seal = Date.now() - t;
out.sealed_bytes = sealed.stdout.length;
out.magic = sealed.stdout.subarray(0, 4).toString();

// 2. Store it as the object of the user.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.cloudflare', 'state-cloud', 'r2', ...archiveKey(key, 'claude').split('/'));
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, sealed.stdout, { mode: 0o600 });
const stored = readFileSync(file);

// 3. A new container with no sign-in, the controls of local-cloud.mjs, and no network.
const name = `agent-pages-cloud-roundtrip-${process.pid}`;
const run = docker(['run', '-d', '--name', name, '--label', 'agent-pages-cloud=roundtrip', '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'KILL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700', '--tmpfs', '/claude-config:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=0700', '-e', 'AGENTD_HARDEN=0', image]);
if (run.status !== 0) { console.error('start failed', String(run.stderr)); process.exit(1); }
try {
  const call = (path, body, token) => {
    const curl = ['exec', '-i', name, 'node', '--input-type=module', '-e', `const r = await fetch('http://127.0.0.1:8080${path}', { method: ${body ? "'POST'" : "'GET'"}, headers: { 'content-type': 'application/json'${token ? `, 'x-agentd-token': '${token}'` : ''} }, body: ${body ? 'await new Response(process.stdin).text()' : 'undefined'} }); process.stdout.write(JSON.stringify({ status: r.status, body: await r.json() }));`];
    const r = docker(curl, { input: body ? JSON.stringify(body) : undefined });
    return JSON.parse(String(r.stdout) || '{}');
  };
  for (let i = 0; i < 50 && call('/health').status !== 200; i++) spawnSync('sleep', ['0.1']);
  const before = docker(['exec', '-u', '10001:10001', name, 'sh', '-c', 'claude auth status --json >/dev/null 2>&1; echo $?']);
  out.exit_code_of_status_before_restore = +String(before.stdout).trim();
  t = Date.now();
  const token = randomBytes(24).toString('base64url');
  const init = call('/init', { token, key: k.toString('base64'), aad, archive: stored.toString('base64'), prewarm: false });
  out.init = init;
  out.ms_init_call = Date.now() - t;
  // 4. Only the boolean leaves the container.
  const st = docker(['exec', '-u', '10001:10001', '-e', 'CLAUDE_CONFIG_DIR=/claude-config', '-e', 'HOME=/tmp', name, 'sh', '-c', `claude auth status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s.slice(s.indexOf("{"),s.lastIndexOf("}")+1)).loggedIn===true))}catch{process.stdout.write("false")}})'`]);
  out.logged_in_after_restore = String(st.stdout).trim() === 'true';
  // A wrong key must not open it.
  const bad = docker(['run', '--rm', '-i', '--network', 'none', '--entrypoint', 'node', image, '--input-type=module', '-e', `const A = await import('/opt/agentd/cloud/agentd/agentd.mjs'); const b = Buffer.from(await new Response(process.stdin).arrayBuffer()); try { A.open(b, Buffer.alloc(32, 1), '${aad}'); console.log('opened'); } catch { console.log('refused'); }`], { input: stored });
  out.wrong_key = String(bad.stdout).trim();
} finally {
  docker(['rm', '-f', name]);
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.logged_in_after_restore && out.init.body?.restored ? 0 : 1);
