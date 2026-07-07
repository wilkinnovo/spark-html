/**
 * spark-prerender tests — prerender a fixture site and assert the output is
 * fully-rendered, crawler-ready HTML: interpolations resolved, each/if and
 * nested imports rendered, and metadata injected into <head>.
 */
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { prerender } from '../src/prerender.js';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'fixture', 'index.html');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

const html = await prerender(entry);
const has = (s) => assert.ok(html.includes(s), `expected output to include: ${s}`);
const hasnt = (s) => assert.ok(!html.includes(s), `expected output NOT to include: ${s}`);

console.log('\nspark-prerender — fixture');

await test('interpolations are resolved (no raw braces in rendered output)', () => {
  has('My Tasks');
  hasnt('{heading}');
  hasnt('{items.length}');
  // Braces may legitimately remain inside an inert <template> (crawlers don't
  // render template content), and CSS/JS use braces too — strip those, then
  // assert no interpolation leaks into the actually-rendered markup.
  const rendered = html
    .replace(/<template[\s\S]*?<\/template>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '');
  assert.ok(!/\{[a-zA-Z]/.test(rendered), 'unresolved interpolation in rendered markup');
});

await test('each loop is rendered with real data', () => {
  has('Write parser — done');
  has('Ship prerender — todo');
});

await test('a derived/ternary interpolation resolves', () => {
  has('2 tasks');
});

await test('nested import (footer) resolved in a later settle wave', () => {
  has('built with spark');
  hasnt('{note}');
});

await test('component hosts are present and revealed (no FOUC cloak)', () => {
  has('data-spark-ready');
  has('name="app"');
  has('name="footer"');
});

await test('component CSS is scoped + injected, incl. @media (new parser)', () => {
  has('[name="app"] h1');
  has('@media (max-width: 600px) { [name="app"] h1');
});

await test('metadata: pageTitle → <title>', () => {
  has('<title>Sparksplash — prerendered</title>');
  hasnt('placeholder title');
});

await test('metadata: pageDescription → <meta name="description">', () => {
  assert.ok(
    /<meta[^>]+name="description"[^>]+content="A statically prerendered Spark page\."/.test(html) ||
    /<meta[^>]+content="A statically prerendered Spark page\."[^>]+name="description"/.test(html),
    'description meta not found',
  );
});

await test('output is a full HTML document with a doctype', () => {
  assert.ok(/^<!DOCTYPE html>/i.test(html.trim()), 'missing doctype');
  has('<html');
  has('</html>');
});

await test('idempotent-ish: a second prerender of the same entry works', async () => {
  const again = await prerender(entry);
  assert.ok(again.includes('My Tasks') && again.includes('built with spark'));
});

// ── Phase 2: awaitable data hook ──
console.log('\nspark-prerender — data hook (Phase 2)');

const dataEntry = join(here, 'fixture', 'data.html');
let dataFetchCalls = 0;
const mockFetch = async (url) => {
  dataFetchCalls++;
  if (String(url).endsWith('/api/photos')) {
    return { ok: true, status: 200, json: async () => [
      { title: 'Sunrise over the bay' },
      { title: 'Forest path' },
      { title: 'Ocean at dusk' },
    ] };
  }
  return { ok: false, status: 404, json: async () => null };
};
const dataHtml = await prerender(dataEntry, { fetch: mockFetch });
const dhas = (s) => assert.ok(dataHtml.includes(s), `expected data output to include: ${s}`);

await test('load() data is fetched (via the delegated fetch) and rendered', () => {
  assert.ok(dataFetchCalls >= 1, 'data fetch was not called');
  dhas('Sunrise over the bay');
  dhas('Forest path');
  dhas('Ocean at dusk');
});

await test('state derived from loaded data re-renders after the hook', () => {
  dhas('3 photos');
  assert.ok(!dataHtml.includes('loading…'), 'still shows the pre-load placeholder');
});

await test('a component-file fetch is NOT sent to the data fetch', () => {
  // Only /api/photos should have hit mockFetch — the gallery component itself
  // is read from disk, not delegated.
  assert.equal(dataFetchCalls, 1, `data fetch called ${dataFetchCalls}× (expected 1)`);
});

await test('load() metadata (pageTitle) is injected too', () => {
  dhas('<title>Gallery — prerendered with data</title>');
});

await test('without options.fetch, Phase 1 pages are unaffected', async () => {
  // The original metadata fixture has no load() — still prerenders as before.
  const again = await prerender(entry);
  assert.ok(again.includes('My Tasks') && again.includes('built with spark'));
});

// ── Browser-global stubs ──
console.log('\nspark-prerender — browser-global stubs');

const stubEntry = join(here, 'fixture', 'stub.html');
const stubHtml = await prerender(stubEntry);

await test('components using matchMedia/localStorage prerender (stubs on by default)', () => {
  assert.ok(stubHtml.includes('theme: light'), 'matchMedia stub → light');
  assert.ok(stubHtml.includes('first visit'), 'localStorage stub → first visit');
});

await test('custom stubs override the defaults (deterministic)', async () => {
  const dark = await prerender(stubEntry, {
    stubs: {
      matchMedia: () => ({
        matches: true, media: '', addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {},
      }),
    },
  });
  assert.ok(dark.includes('theme: dark'), 'custom matchMedia stub → dark');
});

// ── JS imports in <script> tags ──
console.log('\nspark-prerender — JS imports');

const jsImportEntry = join(here, 'fixture', 'jsimport.html');
const jsImportHtml = await prerender(jsImportEntry);
const jihas = (s) => assert.ok(jsImportHtml.includes(s), `expected jsimport output to include: ${s}`);

await test('a component with JS imports prerenders its structure', () => {
  jihas('class="imported"');
  jihas('class="greeting"');
  jihas('class="count"');
});

await test('imports EXECUTE at build time — real values land in the HTML', () => {
  // capitalize('hello world') and pluralize(3, 'item') ran for real.
  jihas('Hello world');
  jihas('3 items');
});

await test('host has [import] for client-side hydration of imported values', () => {
  jihas('name="imported"');
  jihas('import="components/imported.html"');
});

await test('component <style> from an importing component is still scoped + injected', () => {
  jihas('[name="imported"]');
});

console.log('\nspark-prerender — store()');

// A component's own `import { store } from 'spark-html'` must resolve to the
// SAME cache-busted runtime instance prerender itself mounted with — a plain
// `import('spark-html')` (Node's own resolution, no cache-bust) gets a
// SEPARATE module with its own empty `stores` Map, so useStore() sees
// nothing the component just registered. Found by the M4.6 audit.
const storeEntry = join(here, 'fixture', 'store.html');
const storeHtml = await prerender(storeEntry);

await test('a component that both store()s and useStore()s the same store sees real data', () => {
  assert.ok(storeHtml.includes('Items (3)'), 'store data reached the interpolation, not undefined');
  assert.ok(storeHtml.includes('class="item">alpha<'), 'each loop rendered real store items');
  assert.ok(storeHtml.includes('class="item">beta<'));
  assert.ok(storeHtml.includes('class="item">gamma<'));
  assert.ok(!storeHtml.includes('Items ()'), 'not the blank-store regression');
});

// The ENTRY document's own <script type="module"> — inline or external
// src= — never executed at all; prerender called spark.mount() itself and
// skipped whatever else the script did (store() setup, most commonly — the
// standard `store(...); mount();` shape of a scaffolded src/main.js). Found
// by the M4.6 audit, root-caused as a separate, harder issue than the
// component-script case above; fixed by actually running the entry
// script(s) for their side effects before mount() (idempotent, so it's
// always safe to also call it explicitly afterward either way).
//
// This also exercises a second, more fundamental bug the fix's own testing
// surfaced: the runtime-per-page "isolation" relied on a query-string
// cache-bust (spark.js?prerender=<random>) — the standard Node trick — but
// Bun resolves file: imports by path and ignores the query, so it silently
// returned the SAME module (and `stores` Map) for every page. Both fixtures
// below reuse the store name 'todos' with DIFFERENT data specifically so a
// regression shows up as one page's items leaking into the next, not just
// as "the store is empty." Fixed by copying the runtime to a genuinely
// distinct temp file per page instead of a query string.
const entryInlineHtml = await prerender(join(here, 'fixture', 'entry-store-inline.html'));
const entryExternalHtml = await prerender(join(here, 'fixture', 'entry-store-external.html'));

await test('an INLINE entry <script type="module"> that store()s before mount() actually runs', () => {
  assert.ok(entryInlineHtml.includes('Items (2)'), 'entry script\'s store() reached the component');
  assert.ok(entryInlineHtml.includes('class="item">inline-a<'));
  assert.ok(entryInlineHtml.includes('class="item">inline-b<'));
  assert.ok(!entryInlineHtml.includes('Items ()'), 'not the blank-store regression');
});

await test('an EXTERNAL entry <script type="module" src="…"> that store()s before mount() actually runs', () => {
  assert.ok(entryExternalHtml.includes('Items (3)'), 'entry script\'s store() reached the component');
  assert.ok(entryExternalHtml.includes('class="item">ext-a<'));
  assert.ok(entryExternalHtml.includes('class="item">ext-b<'));
  assert.ok(entryExternalHtml.includes('class="item">ext-c<'));
  assert.ok(!entryExternalHtml.includes('Items ()'), 'not the blank-store regression');
});

await test('entry script execution leaves no temp file behind', () => {
  const files = readdirSync(join(here, 'fixture'));
  assert.ok(!files.some((f) => f.startsWith('.spark-prerender-entry-')), 'temp file was cleaned up');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

