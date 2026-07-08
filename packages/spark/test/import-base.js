/**
 * Relative import="components/x" resolution — two regressions, one rule.
 *
 * The rule: a relative import path resolves against the APP BASE — an
 * authored <base href> when present, otherwise the page URL as FIRST loaded,
 * captured before any client-side router navigation can mutate location.
 *
 * Regression A (bugs.md #2, fixed in rc.3): after a router navigation to a
 * 2+-segment URL ("/dash/settings"), fetch()'s default base is the mutated
 * location.href, so "components/x" resolved under "/dash/" → 404.
 *
 * Regression B (1.0.0 → broke the production website): the rc.3 fix forced
 * the ORIGIN ROOT instead, which 404'd every relative import on any
 * subdirectory deployment (GitHub Pages serves the site at /spark-html/).
 * The base must be where the app was loaded from, not "/".
 *
 * The dom-shim has no `location`; defining one flips the runtime into its
 * browser-path base resolution. Absolute paths pass through untouched.
 */
import './dom-shim.js';
import { body, head, parseHTML } from './dom-shim.js';
import { strict as assert } from 'node:assert';

// The app loads at the site root first; imports later in this file happen
// after a simulated router navigation.
globalThis.location = { origin: 'http://app.test', href: 'http://app.test/' };

const fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  return { ok: true, status: 200, text: async () => '<p class="inner">hi</p>' };
};

const { mount } = await import('../src/index.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 10));

await test('the base is captured at first mount, before router navigation', async () => {
  body.childNodes = [];
  parseHTML('<div import="components/first"></div>', body);
  await mount();            // first resolution captures the base (site root)
  await tick();
  assert.ok(fetched.includes('/components/first.html'),
    `expected /components/first.html, fetched: ${JSON.stringify(fetched)}`);
});

await test('after a client-side navigation to a deep URL, relative imports still use the captured base', async () => {
  // The router mutates location without a reload — the app base must not move.
  globalThis.location.href = 'http://app.test/dash/settings';
  fetched.length = 0;
  body.childNodes = [];
  parseHTML('<div import="components/widget"></div>', body);
  await mount();
  await tick();
  assert.ok(fetched.includes('/components/widget.html'),
    `expected /components/widget.html, fetched: ${JSON.stringify(fetched)}`);
  assert.ok(!fetched.some((u) => u.includes('/dash/')),
    'must not resolve under the navigated route path');
});

await test('an absolute import path passes through untouched', async () => {
  fetched.length = 0;
  body.childNodes = [];
  parseHTML('<div import="/__spark/page/pin/[id]?id=3"></div>', body);
  await mount();
  await tick();
  assert.ok(fetched.includes('/__spark/page/pin/[id].html?id=3'),
    `absolute path (with query) must be untouched, fetched: ${JSON.stringify(fetched)}`);
});

await test('SUBDIRECTORY DEPLOYMENT (the 1.0.0 production regression): a site served at /spark-html/ resolves relative imports under /spark-html/', async () => {
  // Fresh runtime instance (Node honors the query string) loading as GitHub
  // Pages does: the document URL is inside a subdirectory, no <base> tag.
  globalThis.location.href = 'http://app.test/spark-html/';
  const fresh = await import('../src/index.js?subdir-instance');
  fetched.length = 0;
  body.childNodes = [];
  parseHTML('<div import="components/sidebar"></div>', body);
  await fresh.mount();
  await tick();
  assert.ok(fetched.includes('/spark-html/components/sidebar.html'),
    `expected /spark-html/components/sidebar.html, fetched: ${JSON.stringify(fetched)}`);
  assert.ok(!fetched.includes('/components/sidebar.html'),
    'must NOT resolve at the origin root — that 404s on subdirectory hosts');
});

await test('an authored <base href> wins over the captured page URL', async () => {
  globalThis.location.href = 'http://app.test/anywhere/deep';
  const fresh = await import('../src/index.js?base-instance');
  parseHTML('<base href="http://app.test/myapp/">', head);
  globalThis.document.baseURI = 'http://app.test/myapp/';
  fetched.length = 0;
  body.childNodes = [];
  parseHTML('<div import="components/widget"></div>', body);
  await fresh.mount();
  await tick();
  head.childNodes = [];
  delete globalThis.document.baseURI;
  assert.ok(fetched.includes('/myapp/components/widget.html'),
    `expected /myapp/components/widget.html, fetched: ${JSON.stringify(fetched)}`);
});

await test('LAZY FIRST IMPORT: the base is frozen at the first mount(), even when the first relative import happens only after navigation', async () => {
  // The app boots at the root with NO relative imports on the entry page —
  // they live inside a lazily activated route. The router then navigates
  // deep, and the route content mounts the app's FIRST relative import. It
  // must resolve against the boot URL, not the navigated one.
  globalThis.location.href = 'http://app.test/';
  const fresh = await import('../src/index.js?lazy-first-import');
  body.childNodes = [];
  await fresh.mount();                    // boot: zero imports on the page
  globalThis.location.href = 'http://app.test/dash/settings';
  fetched.length = 0;
  body.childNodes = [];
  parseHTML('<div import="components/late"></div>', body);
  await fresh.mount();                    // route activation → first import
  await tick();
  assert.ok(fetched.includes('/components/late.html'),
    `expected /components/late.html, fetched: ${JSON.stringify(fetched)}`);
  assert.ok(!fetched.some((u) => u.includes('/dash/')),
    'must not resolve under the navigated route path');
});

console.log(`\nimport-base: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
