// The cloud runner copies three things that it cannot import into a Worker. Each test fails when a copy and its source
// differ, so a change in sandbox/ must reach cloud/ too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as RC from '../../sandbox/run-comment.mjs';
import * as EP from '../../sandbox/egress-proxy.mjs';
import { jobError, MODELS } from '../src/models.mjs';

const ok = { mcp_url: 'https://h.example/s/_mcp/t', comment_id: 'a'.repeat(24), slug: 'g/n', agent_label: 'claude' };
const JOBS = [
  null, 'text', {}, ok, { ...ok, mcp_url: 'ftp://x' }, { ...ok, mcp_url: 'nope' }, { ...ok, comment_id: 'A'.repeat(24) }, { ...ok, comment_id: 'a'.repeat(23) },
  { ...ok, slug: 'g' }, { ...ok, slug: 'G/n' }, { ...ok, slug: `g/${'n'.repeat(130)}` }, { ...ok, slug: 'g-1/n-2' }, { ...ok, agent_label: '' }, { ...ok, agent_label: 'Claude' }, { ...ok, agent_label: 'x'.repeat(41) },
  { ...ok, engine: 'codex' }, { ...ok, engine: 'gpt' }, { ...ok, model: 'sonnet' }, { ...ok, model: 'claude-sonnet-5-5[1m]' }, { ...ok, model: '-x' }, { ...ok, model: null }, { ...ok, effort: 'low' }, { ...ok, effort: 'huge' },
  { ...ok, callback_url: 'http://h/s/_run/1' }, { ...ok, callback_url: 'javascript:1' },
];

test('jobError of the Worker gives the same answer as jobError of run-comment.mjs for each job', () => {
  for (const j of JOBS) assert.equal(jobError(j), RC.jobError(j), JSON.stringify(j));
});

test('the models of POST /status are the MODELS of run-comment.mjs', { skip: !RC.MODELS && 'run-comment.mjs has no MODELS export' }, () => {
  assert.deepEqual(MODELS, RC.MODELS, 'run node cloud/dev/sync-models.mjs');
});

test('the allow lists of agentd are the lists of egress-proxy.mjs', async () => {
  const A = await import('../agentd/agentd.mjs');
  if (EP.RUN_ALLOW) {
    assert.deepEqual(A.ALLOW.run, EP.RUN_ALLOW.claude);
    assert.deepEqual(A.ALLOW.signin, EP.SIGNIN_ALLOW.claude);
  } else assert.ok(A.ALLOW.run.every((h) => EP.DEFAULT_ALLOW.includes(h)));
});

test('the cloud images install Claude Code and Codex with the same steps as sandbox/Dockerfile', () => {
  const local = readFileSync(new URL('../../sandbox/Dockerfile', import.meta.url), 'utf8');
  const claude = readFileSync(new URL('../agentd/claude.Dockerfile', import.meta.url), 'utf8');
  const codex = readFileSync(new URL('../agentd/codex.Dockerfile', import.meta.url), 'utf8');
  const lines = (text, re) => text.split('\n').map((l) => l.trim()).filter((l) => !l.startsWith('#') && re.test(l));
  // The repository key, its checksum, the repository, and the package.
  for (const l of lines(local, /claude-code\.rsa\.pub|downloads\.claude\.ai\/claude-code|apk add --no-cache claude-code/)) assert.ok(claude.includes(l), `claude.Dockerfile lacks: ${l}`);
  for (const l of lines(local, /CODEX_VERSION=|npm install -g|codex-linux-|cp -p bin\/codex|cp -p codex-package|codex --version/)) assert.ok(codex.includes(l), `codex.Dockerfile lacks: ${l}`);
  assert.equal(/FROM alpine:([\d.]+)/.exec(claude)[1], /FROM alpine:([\d.]+)/.exec(local)[1], 'the same Alpine release');
});
