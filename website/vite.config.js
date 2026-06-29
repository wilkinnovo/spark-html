import { defineConfig } from 'vite';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build as esbuild } from 'esbuild';
import spark from 'spark-html/vite';
import prerender from 'spark-prerender/vite';

// Compute the hero stats from the live source — so they NEVER go stale. Vite
// runs from website/, so the repo root is one level up.
let _statsCache;
async function computeStats() {
  if (_statsCache) return _statsCache;
  const ROOT = resolve('..');
  // runtime: gzip of the minified runtime — the same metric as size-check.
  const out = await esbuild({
    entryPoints: [resolve(ROOT, 'packages/spark/src/index.js')],
    bundle: true, minify: true, write: false, format: 'esm',
  });
  const runtimeKb = Math.round(gzipSync(out.outputFiles[0].contents).length / 1024);
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'packages/spark/package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {}).length;
  const pkgDirs = readdirSync(resolve(ROOT, 'packages'))
    .filter((d) => existsSync(resolve(ROOT, 'packages', d, 'package.json')));
  // tests: count `await test(` cases across every package's test dir, floored
  // to a tens boundary so the "N+ tests" claim is always honest.
  let tests = 0;
  for (const d of pkgDirs) {
    const tdir = resolve(ROOT, 'packages', d, 'test');
    if (!existsSync(tdir)) continue;
    for (const f of readdirSync(tdir)) {
      if (f.endsWith('.js')) tests += (readFileSync(resolve(tdir, f), 'utf8').match(/await test\(/g) || []).length;
    }
  }
  _statsCache = { build: 0, runtimeKb, deps, packages: pkgDirs.length, tests: Math.floor(tests / 10) * 10 };
  return _statsCache;
}

// Expose stats two ways:
//  • `virtual:spark-stats` — imported by main.js → seeds a `stats` store (dev).
//  • a closeBundle pass that BAKES the numbers into the built home.html, so
//    prerender (which runs mount() but not main.js) emits them into the static
//    HTML too. Both paths read the same computed values.
function sparkStats() {
  const VID = 'virtual:spark-stats';
  return {
    name: 'spark-stats',
    resolveId(id) { if (id === VID) return '\0' + VID; },
    async load(id) {
      if (id === '\0' + VID) return `export default ${JSON.stringify(await computeStats())};`;
    },
    closeBundle: {
      order: 'pre', // run before spark-prerender reads the built components
      async handler() {
        const file = resolve('dist/components/home.html');
        if (!existsSync(file)) return;
        const stats = await computeStats();
        let html = readFileSync(file, 'utf8');
        for (const [k, v] of Object.entries(stats)) html = html.replaceAll(`{stats.${k}}`, String(v));
        writeFileSync(file, html);
      },
    },
  };
}

// At build time, resolve the home's URL-imported demo component from the LOCAL
// copy instead of hitting the CDN — so prerender bakes it with no network
// dependency. In the browser it's fetched live, cross-origin, from the CDN.
function prerenderFetch(url) {
  if (typeof url === 'string' && url.includes('/components/url-card.html')) {
    const text = readFileSync(resolve('public/components/url-card.html'), 'utf8');
    return Promise.resolve({ ok: true, status: 200, text: async () => text });
  }
  return Promise.resolve({ ok: false, status: 404, text: async () => '' });
}

// On GitHub Pages the site is served from /<repo>/, not /. The deploy workflow
// sets BASE_PATH; locally it defaults to '/'.
const base = process.env.BASE_PATH ?? '/';

// Deep-link fallback for GitHub Pages (no server rewrites): serve the SPA shell
// for unknown paths so /docs etc. load and the router takes over.
function spa404() {
  return {
    name: 'spa-404', apply: 'build',
    closeBundle: { order: 'post', handler() {
      const idx = resolve('dist', 'index.html');
      if (existsSync(idx)) copyFileSync(idx, resolve('dist', '404.html'));
    } },
  };
}

export default defineConfig({
  base,
  // spark() serves components in dev; prerender() auto-detects the
  // <template route> blocks and emits one fully-rendered HTML file per route.
  plugins: [sparkStats(), spark(), prerender({ prerender: { fetch: prerenderFetch } }), spa404()],
});
