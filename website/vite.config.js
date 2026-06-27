import { defineConfig } from 'vite';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import spark from 'spark-html/vite';
import prerender from 'spark-prerender/vite';

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
  plugins: [spark(), prerender({ prerender: { fetch: prerenderFetch } }), spa404()],
});
