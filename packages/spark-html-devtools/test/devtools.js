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

// ── diagnose module (improvements.md I3) ─────────────────────────────────
const { RULES, scanDirectiveTypos, diffHydration } = await import('../src/diagnose.js');

await test('diagnose: hydration diff flags changed text and lost content, never legit additions', () => {
  // changed text at an aligned node → flagged with a path
  const changed = diffHydration('<p class="count">count: </p>', '<p class="count">count: 7</p>');
  assert.ok(changed && changed.includes('p.count'), `expected a p.count path, got ${changed}`);
  // pure addition (an await block resolving post-hydration) → never flagged
  assert.equal(diffHydration('<div><p>a</p></div>', '<div><p>a</p><p class="await-done">total</p></div>'), null);
  // content LOST after hydration → flagged
  assert.ok(diffHydration('<div><p>a</p><p>b</p></div>', '<div><p>a</p></div>'));
  // framework plumbing (comments, data-spark-*, templates, scripts) is noise
  assert.equal(diffHydration(
    '<p data-spark-x="1">hi</p><!-- c --><template await="p">x</template>',
    '<p>hi</p><script>boot()</script>'), null);
});

await test('diagnose: the duplicate-core console.error escalates to an in-page banner', () => {
  // diagnose booted at import (hook installed); fire the core's message.
  console.error('[spark-html] a second copy of the runtime loaded — two store registries…');
  const b = document.querySelector('[data-spark-diagnose-banner]');
  assert.ok(b, 'banner appended');
  assert.ok(b.textContent.includes('duplicate spark-html detected'), 'banner carries the named fix');
  assert.ok(b.textContent.includes('npx spark-html doctor'), 'banner names the tool');
  b.remove();
});

await test('diagnose: typo scan flags near-misses, never legal customs', async () => {
  // scanDirectiveTypos walks childNodes itself — the dom-shim tree works.
  const host = document.createElement('div');
  parseHTML(`<p :clas="c">x</p>
    <button @clcik="{go}">go</button>
    <input bind:vlaue="draft">
    <template esle><p>f</p></template>
    <p :data-anything="c">fine</p>
    <p :glow="c">fine</p>
    <button @party="{go}">fine</button>
    <template each="t in todos" key="t.id"><i>{t}</i></template>`, host);
  const found = scanDirectiveTypos(host).map((f) => `${f.attr}→${f.suggestion}`).sort();
  assert.deepEqual(found, [':clas→:class', '@clcik→@click', 'bind:vlaue→bind:value', 'esle→else']);
});

await test('diagnose: every rule message is drift-pinned to the docs page', async () => {
  // The docs section (website docs-body.html #diagnostics) must carry each
  // diagnostic verbatim enough that pasting a message into a search lands
  // on its fix. Each pin must appear BOTH in the rule's live message and in
  // the docs — change a message without its docs row and this walks you
  // there (improvements.md I3d).
  const { readFileSync } = await import('node:fs');
  const docs = readFileSync(new URL('../../../website/public/components/docs-body.html', import.meta.url), 'utf8')
    .replace(/<[^>]+>/g, '') // strip real tags FIRST…
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); // …then decode entities
  const samples = {
    'directive-typo': RULES['directive-typo'].message(':clas', ':class'),
    'duplicate-core': RULES['duplicate-core'].message(),
    'hydration-mismatch': RULES['hydration-mismatch'].message('p.count'),
    'ssr-dev-event': RULES['ssr-dev-event'].message('schema: x'),
  };
  const pins = {
    'directive-typo': ['unknown directive', 'did you mean', "If it's intentional, ignore this; only near-misses of known names are flagged."],
    'duplicate-core': ['duplicate spark-html detected', 'npx spark-html doctor', 'store not created'],
    'hydration-mismatch': ['hydration mismatch at', "SSR never runs a page's own <script>", 'MODULE data source'],
    'ssr-dev-event': ['[spark-ssr]'],
  };
  for (const id of Object.keys(RULES)) {
    assert.ok(pins[id], `rule '${id}' has no docs pins — add them here AND a docs row`);
    for (const pin of pins[id]) {
      assert.ok(samples[id].includes(pin), `pin '${pin}' no longer in the live '${id}' message — update message, pins, and docs together`);
      assert.ok(docs.includes(pin), `docs page is missing '${pin}' (rule '${id}') — add/refresh its row in docs-body.html #diagnostics`);
    }
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
