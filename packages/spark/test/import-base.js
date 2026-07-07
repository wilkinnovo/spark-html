/**
 * Regression: a relative import="components/x" must fetch against the APP
 * root, not the page's current URL. fetch()'s default base is location.href,
 * so on a client-routed URL 2+ segments deep ("/dash/settings") a relative
 * path used to resolve to "/dash/components/x.html" → 404 for every
 * relatively-imported component on the page (bugs.md Open #2).
 *
 * The dom-shim has no `location`; defining one here flips the runtime into
 * its browser-path base resolution. An authored <base href> must win
 * (subdirectory deployments), and absolute paths pass through untouched.
 */
import './dom-shim.js';
import { body, head, parseHTML } from './dom-shim.js';
import { strict as assert } from 'node:assert';

// Simulate a browser sitting on a deep client-routed URL.
globalThis.location = { origin: 'http://app.test', href: 'http://app.test/dash/settings' };

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

await test('relative import resolves against the origin root, not the current URL', async () => {
  body.childNodes = [];
  parseHTML('<div import="components/widget"></div>', body);
  await mount();
  await tick();
  assert.ok(fetched.includes('/components/widget.html'),
    `expected /components/widget.html, fetched: ${JSON.stringify(fetched)}`);
  assert.ok(!fetched.some((u) => u.includes('/dash/')),
    'must not resolve under the current route path');
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

await test('an authored <base href> wins over the origin root', async () => {
  fetched.length = 0;
  parseHTML('<base href="http://app.test/myapp/">', head);
  globalThis.document.baseURI = 'http://app.test/myapp/';
  body.childNodes = [];
  parseHTML('<div import="components/widget"></div>', body);
  await mount();
  await tick();
  head.childNodes = [];
  delete globalThis.document.baseURI;
  assert.ok(fetched.includes('/myapp/components/widget.html'),
    `expected /myapp/components/widget.html, fetched: ${JSON.stringify(fetched)}`);
});

console.log(`\nimport-base: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
