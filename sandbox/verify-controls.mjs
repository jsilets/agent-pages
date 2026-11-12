#!/usr/bin/env node
// Proves each control of docker mode. It starts the network, the egress proxy and one container in the same way as the
// runner, and then it tries each forbidden thing inside the container. It needs Docker and no sign-in, and it makes no
// model request. It has no dependencies.
//
//   node sandbox/verify-controls.mjs
//
// It prints one line for each check and exits with 1 when a check fails. It uses the port number 8899 for the names of
// its Docker objects, so it does not touch a runner on another port. It removes what it made.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

process.env.RUNNER_PORT = process.env.VERIFY_PORT || '8899';
process.env.RUN_TIMEOUT_MS = '3000';
const R = await import('./local-runner.mjs');
const { runJob } = await import('./run-comment.mjs');

const USER = 'verify-controls';
const env = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
for (const k of Object.keys(env)) if (!env[k]) delete env[k];
const docker = (...args) => { const r = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 60_000 }); return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }; };
let failed = 0;
const check = (name, ok, proof) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${String(proof).replace(/\s*\n\s*/g, ' | ').slice(0, 300)}`); };

let box;
try {
  await R.ensureInfra();
  ({ box } = await R.ensureBox(USER));
  const sh = (script) => docker('exec', box.name, 'sh', '-c', script);
  const proxy = `agent-pages-egress-${process.env.RUNNER_PORT}`;

  // The file system
  let r = sh('touch /etc/x; touch /work/x; touch /usr/bin/x; touch /home/runner/x');
  check('the root file system is read-only', r.code !== 0 && (r.out.match(/Read-only file system/g) ?? []).length === 4, r.out);
  r = sh('echo ok > /tmp/t && cat /tmp/t && echo ok > /claude-config/.verify && rm /claude-config/.verify && echo ok > /codex-home/.verify && rm /codex-home/.verify && echo volumes-ok');
  check('/tmp and the two sign-in volumes take a write', r.code === 0 && r.out.endsWith('volumes-ok'), r.out);
  r = sh('cp /bin/busybox /tmp/bb && /tmp/bb true');
  check('no program runs from /tmp (noexec)', r.code !== 0 && /Permission denied/.test(r.out), r.out);
  r = docker('inspect', '-f', '{{range .Mounts}}{{.Destination}}:{{.RW}} {{end}}| ro={{.HostConfig.ReadonlyRootfs}}', box.name);
  check('the two volumes are the only mounts that keep data', /^(\/claude-config:true \/codex-home:true|\/codex-home:true \/claude-config:true) \| ro=true$/.test(r.out), r.out);

  // The user and its rights
  r = sh('id -u; id -g; grep -E "^(CapEff|CapPrm|CapBnd|NoNewPrivs)" /proc/self/status');
  check('the user is not root, it has no capability, and no_new_privs is set', /^10001\n10001\nCapPrm:\s+0+\nCapEff:\s+0+\nCapBnd:\s+0+\nNoNewPrivs:\s+1$/.test(r.out), r.out);
  r = sh('chown 0:0 /tmp 2>&1; su -c true 2>&1; echo "exit $?"');
  check('chown and su fail', /Operation not permitted/.test(r.out) && /must be suid/.test(r.out) && /exit 1$/.test(r.out), r.out);

  // The limits
  r = sh('cat /sys/fs/cgroup/pids.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/cpu.max');
  check('the limits of the cgroup: 256 processes, 1 GB of memory, no swap, 2 CPUs', r.out === '256\n1073741824\n0\n200000 100000', r.out);
  r = sh('i=0; while [ $i -lt 400 ]; do sleep 30 & i=$((i+1)); done 2>&1 | tail -1; cat /sys/fs/cgroup/pids.events');
  check('a program cannot start more than 256 processes', /can.t fork|Resource temporarily unavailable/.test(r.out) && /max [1-9]/.test(r.out), r.out);
  sh('pkill -f "sleep 30"');
  r = sh('awk \'BEGIN { s = "x"; while (1) s = s s }\' 2>&1 | tail -1; grep -E "^oom_kill " /sys/fs/cgroup/memory.events');
  check('the kernel stops a program that takes more than 1 GB', /oom_kill [1-9]/.test(r.out), r.out);

  // The network
  r = docker('inspect', '-f', '{{json .NetworkSettings.Ports}} {{json .HostConfig.PortBindings}} {{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}', box.name);
  check('the container has no published port and one network', /^\{\} \{\} agent-pages-sandbox-\d+ $/.test(r.out + ' '), r.out);
  r = docker('network', 'inspect', '-f', '{{.Internal}}', `agent-pages-sandbox-${process.env.RUNNER_PORT}`);
  check('the network is internal', r.out === 'true', r.out);
  r = sh('env -u HTTP_PROXY -u HTTPS_PROXY wget -T 3 -q -O- http://1.1.1.1/ 2>&1; echo "exit $?"; nslookup example.com 2>&1 | tail -2');
  check('a direct connection to the internet fails, and no outside name resolves', /Network unreachable|timed out/.test(r.out) && /exit 1/.test(r.out) && /SERVFAIL|can.t resolve|NXDOMAIN/i.test(r.out), r.out);
  const viaProxy = (target) => sh(`printf 'CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n\\r\\n' | nc -w 5 ${proxy} 3128 | head -1`).out.trim();
  const deny = ['example.com:443', 'api.anthropic.com:80', '1.1.1.1:443', 'evil-api.anthropic.com.example.com:443', 'host.docker.internal:8804'].map((t) => `${t} -> ${viaProxy(t)}`);
  check('the proxy refuses a host that is not on the list, a port that is not 443, and an IP address', deny.every((l) => l.endsWith('403 Forbidden')), deny.join('\n'));
  const allow = ['api.anthropic.com:443', 'platform.claude.com:443', 'chatgpt.com:443', 'auth.openai.com:443'].map((t) => `${t} -> ${viaProxy(t)}`);
  check('the proxy opens a tunnel to the model hosts', allow.every((l) => l.endsWith('200 Connection Established')), allow.join('\n'));
  r = sh(`printf 'GET http://example.com/ HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n' | nc -w 5 ${proxy} 3128 | head -1; printf 'GET /health HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n' | nc -w 5 ${proxy} 3129 | head -1`);
  check('the proxy refuses plain HTTP, and its control port refuses a container', /403 Forbidden\s+HTTP\/1.1 401/.test(r.out), r.out);

  // The connector token: a stand-in connector on this machine, and a job with a token in its URL.
  const TOKEN = 'T0KEN'.repeat(8) + 'abc';
  const seen = [];
  const connector = createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { seen.push(req.url); const id = JSON.parse(b || '{}').id ?? null; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [], ok: true } })); }); });
  await new Promise((ok) => connector.listen(0, '0.0.0.0', ok));
  const mcp_url = `http://localhost:${connector.address().port}/s/_mcp/${TOKEN}`;
  const net = await R.ensureInfra();
  // The stand-in connector is in this process, so this call must not block the process.
  const call = () => new Promise((ok) => { let o = ''; const c = spawn('docker', ['exec', box.name, 'sh', '-c', callScript], { env, stdio: ['ignore', 'pipe', 'ignore'] }); c.stdout.on('data', (d) => { o += d; }); c.on('close', () => ok(o.trim())); });
  // busybox nc ends when its input ends, so the input stays open while the answer arrives.
  const callScript = (`(printf 'POST /mcp HTTP/1.1\\r\\nHost: ${proxy}:3128\\r\\nContent-Type: application/json\\r\\nContent-Length: 46\\r\\nConnection: close\\r\\n\\r\\n{"jsonrpc":"2.0","id":7,"method":"tools/call"}\\n'; sleep 1) | nc -w 5 ${proxy} 3128 | head -1`);
  const before = await call();
  await net.control('PUT', `/route/${box.ip}`, { mcp_url: R.forDocker(mcp_url) });
  const during = await call();
  r = sh('cat /proc/*/cmdline 2>/dev/null | tr "\\0" " "; env');
  const inspect = docker('inspect', box.name).out + docker('logs', proxy).out;
  await net.control('DELETE', `/route/${box.ip}`);
  const after = await call();
  check('the container reaches the connector only while its run is active', /503/.test(before) && /200/.test(during) && /503/.test(after) && seen.length === 1 && seen[0].endsWith(TOKEN), `before: ${before} | during: ${during} | after: ${after} | the connector got ${seen.length} request`);
  check('the token is not in a command line, in the environment, in `docker inspect`, or in the proxy log', !r.out.includes(TOKEN) && !inspect.includes(TOKEN) && !r.out.includes('_mcp') && !inspect.includes('_mcp'), `${r.out.length + inspect.length} characters searched, 0 matches`);
  connector.close();

  // The time limit: a program that does not end.
  const t0 = Date.now();
  const out = await runJob({ mcp_url, comment_id: 'ab12'.repeat(6), slug: 'g/n', agent_label: 'claude', user: USER }, {
    exec: () => spawn('docker', ['exec', '-i', box.name, 'sleep', '600'], { env, stdio: ['pipe', 'pipe', 'pipe'] }),
    mcpUrl: net.mcpUrl, timeoutMs: 2000, kill: () => R.removeBox(box.key, 'timeout'),
  });
  await new Promise((ok) => setTimeout(ok, 1500));
  r = docker('ps', '-a', '--filter', `name=${box.name}`, '--format', '{{.Names}} {{.Status}}');
  check('the time limit ends the run and removes the container with every process in it', out.status === 'timeout' && r.out === '' && Date.now() - t0 < 8000, `status ${out.status} after ${out.ms_total} ms | error: ${out.error} | docker ps: "${r.out}"`);
} catch (e) {
  check('the script ran to its end', false, `${e.stack || e} ${e.cause?.message ?? ''}`);
} finally {
  R.cleanup();
  for (const v of [R.volumeOf(USER), R.codexVolumeOf(USER)]) docker('volume', 'rm', v);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
