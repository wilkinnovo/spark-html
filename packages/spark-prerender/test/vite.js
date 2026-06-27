/**
 * spark-prerender/vite plugin — prerenders dist/*.html in `closeBundle`.
 * We simulate a built `dist/` by copying the fixture, then drive the plugin
 * hooks directly (no real Vite needed).
 */
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, cpSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import sparkPrerender from '../src/vite.js';

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\nspark-prerender/vite');

// Simulate dist/ by copying the fixture site into a temp out dir.
const dist = mkdtempSync(join(tmpdir(), 'spark-dist-'));
cpSync(join(here, 'fixture'), dist, { recursive: true });

await test('plugin shape: build-only, named, with closeBundle', () => {
  const p = sparkPrerender();
  assert.equal(p.name, 'spark-prerender');
  assert.equal(p.apply, 'build');
  assert.equal(typeof p.closeBundle, 'function');
});

await test('closeBundle prerenders the listed pages in place', async () => {
  const p = sparkPrerender({ pages: ['index.html'] });
  p.configResolved({ build: { outDir: dist } });
  await p.closeBundle();

  const out = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.ok(out.includes('My Tasks'), 'interpolation rendered');
  assert.ok(out.includes('Write parser — done'), 'each rendered');
  assert.ok(out.includes('<title>Sparksplash — prerendered</title>'), 'metadata injected');
});

await test('a missing page is skipped without throwing', async () => {
  const p = sparkPrerender({ pages: ['does-not-exist.html'] });
  p.configResolved({ build: { outDir: dist } });
  await assert.doesNotReject(() => p.closeBundle());
});

await test('routed entry: each route file is isolated (no home leak)', async () => {
  // A <template route> entry as index.html — the "/" output IS this file, so a
  // naive in-loop write would clobber it and leak the home route into the rest.
  const rdist = mkdtempSync(join(tmpdir(), 'spark-routed-'));
  cpSync(join(here, 'fixture'), rdist, { recursive: true });
  copyFileSync(join(here, 'fixture', 'routed.html'), join(rdist, 'index.html'));

  const p = sparkPrerender({ pages: ['index.html'] });
  p.configResolved({ build: { outDir: rdist } });
  await p.closeBundle();

  const about = readFileSync(join(rdist, 'about.html'), 'utf8');
  assert.ok(about.includes('about page'), 'about.html has its own content');
  assert.ok(!about.includes('home page'), 'about.html must NOT leak the home route');
  assert.equal((about.match(/data-spark-route=/g) || []).length, 1, 'exactly one outlet');

  const index = readFileSync(join(rdist, 'index.html'), 'utf8');
  assert.ok(index.includes('home page'), 'index.html has the home route');
  assert.ok(!index.includes('about page'), 'index.html must NOT leak the about route');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
