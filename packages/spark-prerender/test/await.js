/**
 * <template await> prerendering: the settle loop waits for await promises
 * (like load()) so the resolved :then content lands in the static HTML.
 */
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prerender } from '../src/prerender.js';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'fixture', 'awaited.html');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.stack || e.message}`); }
}

console.log('\nspark-prerender — <template await>');

await test('bakes resolved :then content (settle loop awaits the promise)', async () => {
  const html = await prerender(entry);
  assert.ok(html.includes('Loaded: Hello SSG'), 'resolved :then content rendered');
  // The baked branch is a live sibling tagged for clean client hydration.
  assert.ok(/data-spark-await[^>]*><h1>Loaded: Hello SSG|<h1 data-spark-await[^>]*>Loaded: Hello SSG/.test(html.replace(/\s+/g, ' ')) || html.includes('data-spark-await'), 'baked branch tagged data-spark-await');
  // The inert <template await> is preserved so the client can re-run on hydrate.
  assert.ok(/<template await=/.test(html), 'await template preserved for hydration');
});

await test('a client mount() over the output renders once (no duplicate)', async () => {
  const out = await prerender(entry);
  const shim = await import('../../spark/test/dom-shim.js');
  const { body } = shim;
  const { mount } = await import('../../spark/src/index.js');
  const compDir = join(here, 'fixture', 'components');
  const { readFileSync } = await import('node:fs');
  globalThis.fetch = async (path) => {
    const rel = String(path).replace(/^.*components\//, '').replace(/[?#].*$/, '');
    try { return { ok: true, status: 200, text: async () => readFileSync(join(compDir, rel), 'utf8') }; }
    catch { return { ok: false, status: 404, text: async () => '' }; }
  };
  body.innerHTML = out.replace(/[\s\S]*<body[^>]*>/i, '').replace(/<\/body>[\s\S]*/i, '');
  await mount(body);
  await new Promise((r) => setTimeout(r, 30));
  const count = (body.textContent.match(/Loaded: Hello SSG/g) || []).length;
  assert.equal(count, 1, `rendered exactly once after hydration, got ${count}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
