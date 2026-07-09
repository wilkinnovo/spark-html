// Regression for post-v1-bugs.md #4: a seed column that is `null` in every
// row must still be created (TEXT, nullable) with a startup warning naming
// it — never silently dropped from the schema. Also covers the related bug
// found alongside it: only the FIRST seed row used to be scanned, so a key
// absent from row 0 but present later was dropped too.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inferSchema } from '../src/schema.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

function pages(table, seed) {
  return [{ blocks: [{ table, seed }], analysis: null, plan: [], forms: [], code: '' }];
}

test('an all-null seed column is created (TEXT), not dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-null-'));
  writeFileSync(join(dir, 'users.json'), JSON.stringify([{ id: 1, avatar: null }, { id: 2, avatar: null }]));
  const schema = inferSchema(pages('users', './users.json'), {}, dir);
  assert.equal(schema.users.columns.avatar, 'TEXT');
  assert.deepEqual(schema.users.allNullSeedCols, ['avatar']);
});

test('a column present only in a LATER row is still inferred (not just row 0)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-later-'));
  writeFileSync(join(dir, 'users.json'), JSON.stringify([{ id: 1 }, { id: 2, avatar: 'x.png' }]));
  const schema = inferSchema(pages('users', './users.json'), {}, dir);
  assert.equal(schema.users.columns.avatar, 'TEXT');
  assert.equal(schema.users.allNullSeedCols, undefined);
});

test('a non-null value anywhere wins the type, even after nulls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-mixed-'));
  writeFileSync(join(dir, 'users.json'), JSON.stringify([{ id: 1, age: null }, { id: 2, age: 42 }]));
  const schema = inferSchema(pages('users', './users.json'), {}, dir);
  assert.equal(schema.users.columns.age, 'INTEGER');
  assert.equal(schema.users.allNullSeedCols, undefined);
});

console.log(`\nschema-null-seed: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
