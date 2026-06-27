/**
 * Route prerendering: enumerate <template route>, render one HTML per route
 * (with the route active + adoptable), and emit deploy rewrites.
 */
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { prerender, routesOf, routeToFile, redirectsFor, vercelConfigFor } from '../src/prerender.js';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'fixture', 'routed.html');
const source = readFileSync(entry, 'utf8');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\nspark-prerender — routes');

await test('routesOf() finds the concrete routes (catch-all excluded)', () => {
  assert.deepEqual(routesOf(source), ['/', '/about', '/projects']);
});

await test('routeToFile() maps routes to static files', () => {
  assert.equal(routeToFile('/'), 'index.html');
  assert.equal(routeToFile('/about'), 'about.html');
  assert.equal(routeToFile('/a/b'), 'a/b.html');
});

await test('prerendering a route bakes its content + an adoptable marker', async () => {
  const about = await prerender(entry, { route: '/about' });
  assert.ok(about.includes('about page'), 'about content rendered');
  assert.ok(/data-spark-route="\/about"/.test(about), 'adoptable outlet marker present');
  assert.ok(!about.includes('home page'), 'other routes not rendered');
  assert.ok(about.includes('About</a>'), 'chrome (nav) still rendered');
});

await test('the "/" route renders the home page', async () => {
  const home = await prerender(entry, { route: '/' });
  assert.ok(home.includes('home page'));
  assert.ok(!home.includes('about page'));
});

await test('an unknown path renders the catch-all (404) page', async () => {
  const missing = await prerender(entry, { route: '/nope' });
  assert.ok(missing.includes('404 Not Found page'), 'catch-all rendered');
  assert.ok(/data-spark-route="\/nope"/.test(missing));
});

await test('redirects + vercel config rewrite clean URLs with an SPA fallback', () => {
  const routes = ['/', '/about', '/projects'];
  const red = redirectsFor(routes);
  assert.ok(red.includes('/about  /about.html  200'));
  assert.ok(red.includes('/projects  /projects.html  200'));
  assert.ok(red.trim().endsWith('/*  /index.html  200'), 'SPA fallback last');
  const vercel = JSON.parse(vercelConfigFor(routes));
  assert.ok(vercel.rewrites.some((r) => r.source === '/about' && r.destination === '/about.html'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
