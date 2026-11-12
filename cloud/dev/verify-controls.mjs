#!/usr/bin/env node
// Proves the controls of the cloud image in a real container, the way sandbox/verify-controls.mjs does for docker mode.
// It needs Docker and no sign-in, and it makes no model request. The container has a normal network, as a Cloudflare
// container with enableInternet: true has: the firewall and the proxy of agentd must hold the allow list by themselves.
//
//   node cloud/dev/verify-controls.mjs [image]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const image = process.argv[2] || 'agent-pages-agentd-claude';
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const docker = (...args) => { const r = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 60_000 }); return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }; };
let failed = 0;
const check = (name, ok, proof) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${String(proof).replace(/\s*\n\s*/g, ' | ').slice(0, 400)}`); };
const name = `agent-pages-cloud-verify-${process.pid}`;
const r = docker('run', '-d', '--name', name, '--label', 'agent-pages-cloud=verify', '--init', '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'KILL', '--security-opt', 'no-new-privileges',
  '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700', '--tmpfs', '/claude-config:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=0700', '--cpus', '0.5', '--memory', '4g', '--pids-limit', '256', image);
if (r.code !== 0) { console.error(r.out); process.exit(1); }
const sh = (script, user = '10001:10001') => docker('exec', '-u', user, name, 'sh', '-c', script);
try {
  for (let i = 0; i < 50; i++) { if (/"ok":true/.test(sh('wget -q -O- http://127.0.0.1:8080/health', '0:0').out)) break; spawnSync('sleep', ['0.1']); }
  const health = JSON.parse(sh('wget -q -O- http://127.0.0.1:8080/health', '0:0').out || '{}');
  check('agentd set the firewall (egress: enforced)', health.hardening?.egress === 'enforced', JSON.stringify(health.hardening));
  let x = sh('iptables -S OUTPUT; ip6tables -S OUTPUT', '0:0');
  check('the rules: loopback, then a reset for each other connection of uid 10001', /-A OUTPUT -o lo -j ACCEPT/.test(x.out) && /-p tcp -m owner --uid-owner 10001 -j REJECT --reject-with tcp-reset/.test(x.out), x.out);
  let t = Date.now();
  x = sh('env -u HTTPS_PROXY -u HTTP_PROXY wget -T 10 -q -O- https://1.1.1.1/ 2>&1; echo "exit $?"');
  const msDirect = Date.now() - t;
  check('a program (uid 10001) cannot reach an address directly, and it fails at once (reset)', /refused|reset/i.test(x.out) && /exit [1-9]/.test(x.out) && msDirect < 1500, `${msDirect} ms: ${x.out}`);
  t = Date.now();
  x = sh('env -u HTTPS_PROXY -u HTTP_PROXY wget -T 10 -q -O- https://example.com/ 2>&1; echo "exit $?"');
  // musl retries a DNS query that gets no answer for 5 s. The programs use the proxy and make no DNS query of their own.
  check('a direct request by name fails too (the DNS query of musl ends after its 5 s retry time)', /bad address/.test(x.out) && Date.now() - t < 7000, `${Date.now() - t} ms: ${x.out}`);
  t = Date.now();
  x = sh('nslookup example.com 2>&1 | tail -2; echo "exit $?"');
  check('a program cannot resolve a name (no DNS), and it fails at once', !/Address: \d+\.\d+/.test(x.out.split('Name:')[1] ?? '') && Date.now() - t < 3000, `${Date.now() - t} ms: ${x.out}`);
  const viaProxy = (target) => sh(`printf 'CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n\\r\\n' | nc -w 5 127.0.0.1 3128 | head -1`).out.trim();
  t = Date.now();
  const deny = ['example.com:443', 'api.anthropic.com:80', '1.1.1.1:443', 'chatgpt.com:443', 'evil-api.anthropic.com.example.com:443', 'runner.internal:80'].map((h) => `${h} -> ${viaProxy(h)}`);
  check('the proxy refuses a host off the list, a port that is not 443, an IP address, and the other engine', deny.every((l) => l.endsWith('403 Forbidden')), `${Date.now() - t} ms for 6: ${deny.join(' ; ')}`);
  const allow = ['api.anthropic.com:443', 'platform.claude.com:443'].map((h) => `${h} -> ${viaProxy(h)}`);
  check('the proxy opens a tunnel to the model hosts', allow.every((l) => l.endsWith('200 Connection Established')), allow.join(' ; '));
  x = sh('wget -q -O- http://127.0.0.1:8080/drain 2>&1; wget -q -O- --post-data={} http://127.0.0.1:8080/drain 2>&1; echo "exit $?"');
  check('a program cannot call the routes of agentd: each one needs the token', /401|404|exit 1/.test(x.out), x.out);
  x = sh('touch /etc/x /work/x /usr/bin/x 2>&1; echo ok > /tmp/t && cat /tmp/t; echo ok > /claude-config/.v && rm /claude-config/.v && echo folder-ok');
  check('the root file system is read-only; /tmp and the sign-in folder take a write', (x.out.match(/Read-only file system/g) ?? []).length === 3 && x.out.endsWith('folder-ok'), x.out);
  x = sh('cp /bin/busybox /tmp/bb && /tmp/bb true; echo "exit $?"');
  check('no program runs from /tmp (noexec)', /Permission denied/.test(x.out), x.out);
  x = sh('id -u; grep -E "^(CapEff|NoNewPrivs)" /proc/self/status');
  check('a program runs as uid 10001 with no capability and no_new_privs', /^10001\nCapEff:\s+0+\nNoNewPrivs:\s+1$/.test(x.out), x.out);
  x = sh('cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/pids.max');
  check('the limits of standard-1: 4 GiB, 1/2 vCPU; 256 processes', x.out === '4294967296\n50000 100000\n256', x.out);
  x = docker('inspect', '-f', '{{json .NetworkSettings.Ports}}', name);
  check('no published port: the Durable Object channel (8080) is the only listener for the outside', !/HostPort/.test(x.out), x.out);
  const token = randomBytes(24).toString('base64url');
  x = sh(`wget -q -O- --header 'content-type: application/json' --post-data '{"token":"${token}","key":"${Buffer.alloc(32, 5).toString('base64')}","aad":"x","prewarm":false}' http://127.0.0.1:8080/init`, '0:0');
  const procs = sh('cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\\0" " "; env');
  check('after /init, the token is in no command line and in no environment that a program can read', !procs.out.includes(token) && /"ok":true/.test(x.out), `${procs.out.length} characters searched`);
} finally {
  const logs = docker('logs', name).out;
  check('the log of agentd has a line for each refused tunnel, and no token', /"ev":"deny"/.test(logs) && !/x-agentd-token|"token"/.test(logs), `${logs.split('\n').length} lines`);
  docker('rm', '-f', name);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
