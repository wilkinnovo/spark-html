/**
 * Cookbook fixture checker (improvements.md I4b) — runs under bun via
 * scripts/test-bun.mjs. Every recipe in e2e/fixtures/cookbook/<name>/ is
 * checked in CI at the depth its recipe.json declares:
 *
 *   mount    — really mounted (spark-html-test-utils, linkedom): the page
 *              renders, `expect` appears in the DOM. Optional `setup` module
 *              (the recipe's main.js equivalent) is imported first.
 *   ssr      — really served (spark-ssr serve() on the fixture dir): GET /
 *              answers 200 and contains `expect`.
 *   bun-test — the recipe IS a runnable test file; it must exit 0.
 *   parse    — the page source parses as a spark SFC (for recipes whose
 *              runtime needs a browser/network/build the suite can't give —
 *              the recipe.json says which).
 *   files    — named files exist (walkthrough recipes).
 *
 * The website cookbook section is GENERATED from these same fixtures
 * (website/scripts/gen-cookbook.mjs) — the fixture IS the doc snippet;
 * there is no second copy to rot.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(ROOT, 'e2e/fixtures/cookbook');
process.env.SPARK_TEST_SECRET ||= 'cookbook-check-secret';

// Recipes import packages the way a USER writes them (bare specifiers);
// symlink the named workspace sources into the fixture's node_modules.
function linkPackages(dir, names = []) {
  if (!names.length) return;
  const { mkdirSync, symlinkSync } = require('node:fs');
  const nm = join(dir, 'node_modules');
  mkdirSync(nm, { recursive: true });
  for (const n of names) {
    const srcDir = join(ROOT, 'packages', n === 'spark-html' ? 'spark' : n);
    try { symlinkSync(srcDir, join(nm, n)); } catch { /* exists */ }
  }
}

let pass = 0, fail = 0;
const ok = (n, m) => { pass++; console.log(`  ✅ ${n} — ${m}`); };
const bad = (n, m) => { fail++; console.log(`  ❌ ${n} — ${m}`); };

console.log('\ncookbook fixtures');

const recipes = readdirSync(BASE).sort();
const only = process.argv[2];
if (!only) {
  // One subprocess per recipe: isolated module graphs and globals — an ssr
  // check's linkedom globals must never leak into a mount check's document,
  // and two spark-html import paths in one process trip the dup-core guard.
  let anyFail = 0;
  for (const name of recipes) {
    const r = spawnSync('bun', [fileURLToPath(import.meta.url), name], { stdio: 'inherit' });
    if (r.status !== 0) anyFail = 1;
  }
  if (recipes.length < 10) { console.log(`  ❌ cookbook — only ${recipes.length}/10 recipes present`); anyFail = 1; }
  console.log(anyFail ? '\ncookbook: FAIL' : `\ncookbook: all ${recipes.length} recipes green`);
  process.exit(anyFail);
}
for (const name of recipes.filter((n) => n === only)) {
  const dir = join(BASE, name);
  let meta;
  try { meta = JSON.parse(readFileSync(join(dir, 'recipe.json'), 'utf8')); }
  catch (e) { bad(name, `recipe.json unreadable: ${e.message}`); continue; }
  if (!meta.title || !Array.isArray(meta.modes) || !meta.description || !meta.check) {
    bad(name, 'recipe.json must declare title, modes[], description, check');
    continue;
  }
  const c = meta.check;
  try {
    if (c.type === 'mount') {
      linkPackages(dir, c.links);
      const { mount } = await import(join(ROOT, 'packages/spark-html-test-utils/src/index.js'));
      if (c.setup) await import(join(dir, c.setup));
      const src = readFileSync(join(dir, 'page.html'), 'utf8');
      const h = await mount({ root: '<div import="page"></div>', components: { page: src } });
      await h.settle();
      if (!h.query(c.expect)) throw new Error(`mounted DOM lacks selector "${c.expect}"`);
      h.cleanup();
      ok(name, `mounted, "${c.expect}" rendered`);
    } else if (c.type === 'ssr') {
      const { serve } = await import(join(ROOT, 'packages/spark-ssr/src/index.js'));
      const server = await serve({ root: dir, port: 0, quiet: true, watch: false });
      try {
        const res = await fetch(`http://localhost:${server.port}/`);
        const html = await res.text();
        if (res.status !== 200) throw new Error(`GET / → ${res.status}`);
        if (!html.includes(c.expect)) throw new Error(`page lacks "${c.expect}"`);
        ok(name, `served, "${c.expect}" rendered`);
      } finally { await server.stop(true); }
    } else if (c.type === 'bun-test') {
      linkPackages(dir, ['spark-html-test-utils', 'spark-html']);
      const r = spawnSync('bun', [join(dir, c.file)], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`${c.file} exited ${r.status}: ${r.stderr || r.stdout}`);
      ok(name, `${c.file} ran green`);
    } else if (c.type === 'parse') {
      const { parseSFC } = await import(join(ROOT, 'packages/spark/src/index.js'));
      const src = readFileSync(join(dir, 'page.html'), 'utf8');
      const sfc = parseSFC(src);
      if (!sfc || !(sfc.markup || '').trim()) throw new Error('parseSFC produced empty markup');
      ok(name, 'page parses as a spark SFC');
    } else if (c.type === 'files') {
      for (const f of c.files) if (!existsSync(join(dir, f))) throw new Error(`missing ${f}`);
      ok(name, `${c.files.join(', ')} present`);
    } else {
      throw new Error(`unknown check type '${c.type}'`);
    }
  } catch (e) {
    bad(name, e.message);
  }
}

if (recipes.length < 10) bad('cookbook', `only ${recipes.length}/10 recipes present`);
console.log(`\ncookbook: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
