/** spark-router — client routing tests (location/history/event stubs). */
import '../../spark/test/dom-shim.js';
import { body, parseHTML } from '../../spark/test/dom-shim.js';
import { strict as assert } from 'node:assert';

// ── stub location + history + event listeners ──
const listeners = { click: [], popstate: [] };
globalThis.location = { origin: 'http://localhost', href: 'http://localhost/', pathname: '/', search: '', hash: '' };
globalThis.history = {
  pushState(_s, _t, url) {
    const u = new URL(url, location.href);
    location.pathname = u.pathname; location.search = u.search; location.hash = u.hash; location.href = u.href;
  },
};
globalThis.document.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
globalThis.window = globalThis.window || {};
globalThis.window.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
const fireClick = (a) => {
  const e = { type: 'click', target: a, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  listeners.click.forEach((f) => f(e));
  return e;
};
const firePopstate = () => listeners.popstate.forEach((f) => f({ type: 'popstate' }));

// Share ONE spark-html instance with the router (bare specifier → workspace).
const { mount, component } = await import('spark-html');
const { router, navigate } = await import('../src/index.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const has = (s) => assert.ok(body.textContent.includes(s), `expected page to show: ${s}\n  got: ${body.textContent.slice(0, 120)}`);
const hasnt = (s) => assert.ok(!body.textContent.includes(s), `did NOT expect: ${s}`);

component('home', `<h1>Home page</h1>`);
component('about', `<h1>About us</h1>`);
component('projects', `<h1>Our projects</h1>`);
component('notfound', `<h1>404 missing</h1>`);

parseHTML(`
  <nav><a class="lnk-about" href="/about">About</a><a class="lnk-ext" href="https://x.com/p" target="_blank">ext</a></nav>
  <template route="/"><div import="home"></div></template>
  <template route="/about"><div import="about"></div></template>
  <template route="/projects"><div import="projects"></div></template>
  <template route="*"><div import="notfound"></div></template>
`, body);

await router();
await tick();

console.log('\nspark-router');
await test('renders the route matching the initial URL ("/")', () => {
  has('Home page');
  hasnt('About us');
});
await test('navigate() swaps the route, removing the old one', async () => {
  await navigate('/about');
  await tick();
  has('About us');
  hasnt('Home page');
});
await test('a catch-all route="*" renders for unknown paths', async () => {
  await navigate('/does-not-exist');
  await tick();
  has('404 missing');
  hasnt('About us');
});
await test('clicking a same-origin <a> navigates (SPA, no reload)', async () => {
  await navigate('/');
  await tick();
  const e = fireClick(body.querySelector('.lnk-about'));
  assert.equal(e.defaultPrevented, true, 'click was intercepted');
  await tick();
  has('About us');
  assert.equal(location.pathname, '/about', 'history updated');
});
await test('an external/_blank link is NOT intercepted', () => {
  const e = fireClick(body.querySelector('.lnk-ext'));
  assert.equal(e.defaultPrevented, false, 'external link left to the browser');
});
await test('Back/Forward (popstate) re-renders the route', async () => {
  location.pathname = '/projects';
  firePopstate();
  await tick();
  has('Our projects');
  hasnt('About us');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
