// Run against the local host with its remote Browser Run binding.
// node tools/check-pdf-download.mjs http://localhost:8791 packed.html output.pdf
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const [base, source, output] = process.argv.slice(2);
assert(base && source && output, 'Usage: check-pdf-download.mjs http://localhost:PORT packed.html output.pdf');
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'This check writes only to a local host.');
const slug = 'checks/pdf-document';
const published = await fetch(`${base}/api/pages/${slug}`, {
  method: 'PUT', headers: { 'content-type': 'text/html' }, body: await readFile(source, 'utf8'),
});
assert.equal(published.status, 201, await published.clone().text());
const page = await published.json();
assert.equal(page.kind, 'page');
assert.equal(page.audit, undefined, 'A document must not run the slide audit.');
const response = await fetch(`${base}/pdf/${slug}/${page.version}`);
assert.equal(response.status, 200, response.ok ? '' : await response.text());
assert.equal(response.headers.get('content-type'), 'application/pdf');
assert.match(response.headers.get('content-disposition'), /^attachment; filename=".+\.pdf"$/);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
await writeFile(output, bytes);
// Requires qpdf. A PDF header alone does not prove the downloaded file is readable.
execFileSync('qpdf', ['--check', output], { stdio: 'inherit' });
const cached = Buffer.from(await (await fetch(`${base}/pdf/${slug}/${page.version}`)).arrayBuffer());
assert.deepEqual(cached, bytes);
console.log(JSON.stringify({ kind: page.kind, viewer: `${base}/p/${slug}`, version: page.version, download: 'attachment', pdf: output, bytes: bytes.length, cache: 'identical' }));
