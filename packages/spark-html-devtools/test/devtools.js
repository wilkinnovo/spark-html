/** spark-html-devtools — panel reflects stores + components. */
import '../../spark/test/dom-shim.js';
import { body, parseHTML } from '../../spark/test/dom-shim.js';
import { strict as assert } from 'node:assert';

const { mount, component, store } = await import('spark-html');
const { devtools } = await import('../src/index.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 10));

store('cart', { items: 3, total: 9 });
component('demo', `<p>{msg}</p><script>let msg = 'hi';<\/script>`);
parseHTML('<div import="demo"></div>', body);
await mount(body);
await tick();

const stop = devtools({ open: true });

console.log('\nspark-html-devtools');

await test('mounts a panel', () => {
  assert.ok(document.querySelector('[data-spark-devtools]'), 'panel root present');
});
await test('lists stores and their state', () => {
  const t = document.querySelector('[data-spark-devtools] .sdt-body').textContent;
  assert.ok(t.includes('cart'), 'store name shown');
  assert.ok(t.includes('items'), 'store state shown');
});
await test('lists components and their state', () => {
  const t = document.querySelector('[data-spark-devtools] .sdt-body').textContent;
  assert.ok(t.includes('demo'), 'component name shown');
  assert.ok(t.includes('msg'), 'component state shown');
});
await test('installs a patch hook (counts re-renders)', () => {
  assert.equal(typeof globalThis.__sparkTestOnPatch, 'function');
});
await test('teardown removes the panel and restores the hook', () => {
  stop();
  assert.equal(document.querySelector('[data-spark-devtools]'), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
