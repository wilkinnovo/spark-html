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
const { mount, component, store } = await import('spark-html');
const { router, navigate } = await import('../src/index.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const has = (s) => assert.ok(body.textContent.includes(s), `expected page to show: ${s}\n  got: ${body.textContent.slice(0, 120)}`);
const hasnt = (s) => assert.ok(!body.textContent.includes(s), `did NOT expect: ${s}`);

globalThis.__homeMounts = 0;
component('home', `<h1>Home page</h1><script>onMount(() => { globalThis.__homeMounts++; });<\/script>`);
component('about', `<h1>About us</h1>`);
component('projects', `<h1>Our projects</h1>`);
component('notfound', `<h1>404 missing</h1>`);
component('user', `<h1>User {uid}</h1><script>const route = useStore('route'); let uid = ''; $: uid = route.params.id;<\/script>`);
component('me', `<h1>My profile</h1>`);

parseHTML(`
  <nav><a class="lnk-home" href="/">Home</a><a class="lnk-about" href="/about">About</a><a class="lnk-ext" href="https://x.com/p" target="_blank">ext</a><a class="lnk-hash" href="#sec">Sec</a></nav>
  <template route="/"><div import="home"></div></template>
  <template route="/about"><div import="about"></div></template>
  <template route="/projects"><div import="projects"></div></template>
  <template route="/users/:id"><div import="user"></div></template>
  <template route="/users/me"><div import="me"></div></template>
  <template route="*"><div import="notfound"></div></template>
`, body);

await router();
await tick();

console.log('\nspark-router');
await test('renders the route matching the initial URL ("/")', () => {
  has('Home page');
  hasnt('About us');
});
await test('boots each route component exactly once (single mount)', () => {
  assert.equal(globalThis.__homeMounts, 1, `onMount should fire once, fired ${globalThis.__homeMounts}×`);
});
await test('exposes a reactive `route` store with the active path', () => {
  assert.equal(store('route').path, '/', 'route store reflects the initial URL');
});
await test('marks the matching <a> with aria-current="page"', async () => {
  const home = body.querySelector('.lnk-home');
  const about = body.querySelector('.lnk-about');
  const ext = body.querySelector('.lnk-ext');
  assert.equal(home.getAttribute('aria-current'), 'page', 'home link active at "/"');
  assert.equal(about.getAttribute('aria-current'), null, 'about link not active at "/"');
  await navigate('/about');
  await tick();
  assert.equal(about.getAttribute('aria-current'), 'page', 'about link active at "/about"');
  assert.equal(home.getAttribute('aria-current'), null, 'home link cleared');
  assert.equal(ext.getAttribute('aria-current'), null, 'external link never marked');
  await navigate('/');
  await tick();
});
await test('navigate() swaps the route, removing the old one', async () => {
  await navigate('/about');
  await tick();
  has('About us');
  hasnt('Home page');
  assert.equal(store('route').path, '/about', 'route store updates on navigation');
});
await test('a catch-all route="*" renders for unknown paths', async () => {
  await navigate('/does-not-exist');
  await tick();
  has('404 missing');
  hasnt('About us');
});
await test('SPA navigation does not reprint the "⚡ ready" banner', async () => {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await navigate('/');
    await tick();
  } finally {
    console.log = orig;
  }
  assert.ok(!lines.some((l) => l.includes('⚡ ready')), `navigation logged a ready banner: ${lines.join(' | ')}`);
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
await test('an in-page #anchor is NOT intercepted and not marked active', async () => {
  await navigate('/');
  await tick();
  const hash = body.querySelector('.lnk-hash');
  const e = fireClick(hash);
  assert.equal(e.defaultPrevented, false, 'hash link left to the browser (native scroll)');
  assert.equal(hash.getAttribute('aria-current'), null, 'in-page anchor never gets aria-current');
});
await test('a dynamic route="/users/:id" captures the param into route.params', async () => {
  await navigate('/users/7');
  await tick();
  has('User 7');
  assert.equal(store('route').params.id, '7', 'param captured');
});
await test('navigating between dynamic matches updates params', async () => {
  await navigate('/users/9');
  await tick();
  has('User 9');
  hasnt('User 7');
  assert.equal(store('route').params.id, '9');
});
await test('an exact route wins over a dynamic one', async () => {
  await navigate('/users/me');
  await tick();
  has('My profile');
  hasnt('User me');
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
