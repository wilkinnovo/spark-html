/**
 * Props + slot content survive prerender → client hydration.
 * Prerender a top-level import that passes props and slot content, then run
 * the real client mount() over the output and assert both come back.
 */
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { prerender } from '../src/prerender.js';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'fixture', 'composed.html');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\nspark-prerender — props + slots through hydration');

const out = await prerender(entry);

await test('prerendered output renders props + slot content (for crawlers)', () => {
  assert.ok(out.includes('Hello Card — 3'), 'props rendered');
  assert.ok(out.includes('Slotted content here'), 'slot rendered');
});

await test('output serializes props back as attributes', () => {
  assert.ok(/title="Hello Card"/.test(out), 'title prop attr');
  assert.ok(/count="3"/.test(out), 'count prop attr');
  assert.ok(/import="components\/card\.html"/.test(out), 'hydratable import');
});

await test('output stashes original slot content in a <template data-spark-slots>', () => {
  assert.ok(/<template data-spark-slots[^>]*>[\s\S]*slot="body"[\s\S]*Slotted content here/.test(out),
    'slot template present');
});

await test('client mount() over the output keeps props + slots (no loss)', async () => {
  const shim = await import('../../spark/test/dom-shim.js');
  const { body } = shim;
  const compDir = join(here, 'fixture', 'components');
  globalThis.fetch = async (path) => {
    const rel = String(path).replace(/^.*components\//, '').replace(/[?#].*$/, '');
    try { return { ok: true, status: 200, text: async () => readFileSync(join(compDir, rel), 'utf8') }; }
    catch { return { ok: false, status: 404, text: async () => '' }; }
  };
  const bodyInner = out.replace(/[\s\S]*<body[^>]*>/i, '').replace(/<\/body>[\s\S]*/i, '');
  body.innerHTML = bodyInner;

  const spark = await import('../../spark/src/index.js');
  await spark.mount(body);
  await new Promise((r) => setTimeout(r, 20));

  const card = body.querySelector('[name="card"]');
  assert.ok(card, 'card present after client mount');
  const text = card.textContent;
  assert.ok(text.includes('Hello Card — 3'), 'props survived hydration');
  assert.ok(text.includes('Slotted content here'), 'slot survived hydration');
  assert.ok(!text.includes('no body'), 'fallback not used (real slot projected)');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
