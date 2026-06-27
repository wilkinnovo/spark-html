import { defineConfig } from 'vite';
import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import spark from 'spark-html/vite';
import prerender from 'spark-prerender/vite';

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
  plugins: [spark(), prerender(), spa404()],
});
