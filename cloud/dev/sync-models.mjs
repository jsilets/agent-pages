#!/usr/bin/env node
// Writes src/models.json from MODELS of sandbox/run-comment.mjs. The Worker cannot import that file (it starts
// programs), so it reads this copy. test/drift.test.mjs fails until this runs after a change of MODELS.
//   node cloud/dev/sync-models.mjs
import { writeFileSync } from 'node:fs';
import { MODELS } from '../../sandbox/run-comment.mjs';
writeFileSync(new URL('../src/models.json', import.meta.url), JSON.stringify(MODELS, null, 2) + '\n');
console.log('src/models.json:', Object.entries(MODELS).map(([e, m]) => `${e} ${m.models.map((x) => x.id).join(',')}`).join('; '));
