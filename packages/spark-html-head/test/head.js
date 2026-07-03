/** spark-html-head — title/meta react to pushState + popstate. */
import '../../spark/test/dom-shim.js';
import { strict as assert } from 'node:assert';

// ── stub location + history + popstate listener ──
globalThis.location = { pathname: '/' };
const popstate = [];
globalThis.addEventListener = (type, fn) => { if (type === 'popstate') popstate.push(fn); };
globalThis.history = {
  pushState(_s, _t, url) { location.pathname = String(url).split(/[?#]/)[0]; },
  replaceState(_s, _t, url) { location.pathname = String(url).split(/[?#]/)[0]; },
};

const { head } = await import('../src/index.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
const nav = (p) => history.pushState({}, '', p);

console.log('\nspark-html-head');

head({
  title: { '/': 'Home', '/about': 'About', '*': 'Not found' },
  titleTemplate: (t) => `${t} · Site`,
  meta: { description: (path) => `the ${path} page`, 'og:title': (path) => `OG ${path}` },
});

test('sets the title for the initial route', () => {
  assert.equal(document.title, 'Home · Site');
});

test('updates the title on pushState navigation', () => {
  nav('/about');
  assert.equal(document.title, 'About · Site');
});

test('falls back to "*" for unknown routes', () => {
  nav('/nope');
  assert.equal(document.title, 'Not found · Site');
});

test('updates the title on popstate (back/forward)', () => {
  location.pathname = '/';
  popstate.forEach((fn) => fn());
  assert.equal(document.title, 'Home · Site');
});

test('upserts <meta name="description"> reactively', () => {
  nav('/about');
  const el = document.querySelector('meta[name="description"]');
  assert.ok(el, 'meta created');
  assert.equal(el.getAttribute('content'), 'the /about page');
});

test('uses property= for namespaced meta (og:title)', () => {
  const el = document.querySelector('meta[property="og:title"]');
  assert.ok(el, 'og meta created');
  assert.equal(el.getAttribute('content'), 'OG /about');
});

test('base is stripped before matching', () => {
  const stop = head({ title: { '/about': 'AB' }, base: '/spark' });
  location.pathname = '/spark/about';
  popstate.forEach((fn) => fn());
  assert.equal(document.title, 'AB');
  stop();
});

// ── the reactive `head` store: per-component overrides ──
const { store } = await import('spark-html');
const headStore = store('head');

test('a store write overrides the config title VERBATIM (no titleTemplate)', () => {
  nav('/about');
  assert.equal(document.title, 'About · Site', 'config title first');
  headStore.title = 'Parser · Novo';
  assert.equal(document.title, 'Parser · Novo', 'store title wins, un-templated');
});

test('store meta keys override config and add new tags', () => {
  headStore.description = 'a data-driven description';
  assert.equal(
    document.querySelector('meta[name="description"]').getAttribute('content'),
    'a data-driven description', 'store overrides the config resolver');
  headStore['og:image'] = 'https://x/img.png';
  assert.equal(
    document.querySelector('meta[property="og:image"]').getAttribute('content'),
    'https://x/img.png', 'store-only keys are added');
});

test('overrides are cleared on path change (config fallback returns)', () => {
  nav('/');
  assert.equal(document.title, 'Home · Site', 'stale store title dropped');
  assert.equal(headStore.title, undefined, 'store reset for the new route');
  assert.equal(
    document.querySelector('meta[name="description"]').getAttribute('content'),
    'the / page', 'meta falls back to the config resolver');
});

test('a store write for the CURRENT route re-applies immediately', () => {
  headStore.title = 'Live title';
  assert.equal(document.title, 'Live title');
  assert.equal(headStore.description, undefined, 'other keys untouched');
});

test('store-only meta additions are REMOVED on route change (no stale leak)', () => {
  nav('/about');
  headStore['og:image'] = 'https://x/about-img.png';
  assert.equal(
    document.querySelector('meta[property="og:image"]').getAttribute('content'),
    'https://x/about-img.png', 'added while on /about');
  nav('/');
  assert.ok(!document.querySelector('meta[property="og:image"]'),
    'the created og:image element is gone on the next route');
});

test('a store override of a PRE-EXISTING meta is restored on route change', () => {
  const pre = document.createElement('meta');
  pre.setAttribute('property', 'og:type');
  pre.setAttribute('content', 'website');
  document.head.appendChild(pre);
  nav('/about');
  headStore['og:type'] = 'article';
  assert.equal(pre.getAttribute('content'), 'article', 'store override applied');
  nav('/');
  assert.equal(pre.getAttribute('content'), 'website',
    'author-written content restored, element kept');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
