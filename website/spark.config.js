import prerender from 'spark-prerender/bun';
import theme from 'spark-html-theme/bun';
import font from 'spark-html-font/bun';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// On GitHub Pages the site is served from /<repo>/, not /. The deploy workflow
// sets BASE_PATH; locally it defaults to '/'.
const base = process.env.BASE_PATH ?? '/';

// Bake the computed stats (scripts/gen-stats.js → src/stats.json) into the
// built home component BEFORE prerender reads it — prerender runs mount() but
// not main.js, so the {stats.*} placeholders would otherwise ship literally.
// Must be first in the pipeline so it runs before prerender().
function stats() {
  return {
    name: 'spark-stats',
    async run({ outDir, projectRoot }) {
      const statsFile = resolve(projectRoot, 'src/stats.js');
      const file = join(outDir, 'components/home.html');
      if (!existsSync(statsFile) || !existsSync(file)) return;
      const s = (await import(statsFile)).default;
      let html = readFileSync(file, 'utf8');
      for (const [k, v] of Object.entries(s)) html = html.replaceAll(`{stats.${k}}`, String(v));
      writeFileSync(file, html);
    },
  };
}

// At build time, resolve the home's URL-imported demo component from the LOCAL
// copy instead of hitting the CDN — so prerender bakes it with no network
// dependency. In the browser it's fetched live, cross-origin, from the CDN.
function prerenderFetch(url) {
  if (typeof url === 'string' && url.includes('/components/url-card.html')) {
    const text = readFileSync(resolve(import.meta.dirname, 'public/components/url-card.html'), 'utf8');
    return Promise.resolve({ ok: true, status: 200, text: async () => text });
  }
  return Promise.resolve({ ok: false, status: 404, text: async () => '' });
}

// prerender() auto-detects the <template route> blocks and emits one
// fully-rendered HTML file per route, plus 404.html — GitHub Pages serves it
// for unknown paths, and since the full app shell + router ship in it, deep
// links still resolve client-side — plus sitemap.xml + robots.txt (site = the
// GitHub Pages origin + base).
export default {
  base,
  pipeline: [
    stats(),
    prerender({
      site: 'https://wilkinnovo.github.io' + (base === '/' ? '' : base.replace(/\/$/, '')),
      prerender: { fetch: prerenderFetch },
    }),
    // No-flash theming: the saved/OS theme lands on <html> before first paint,
    // in dev and in every built page (after prerender so route pages are covered).
    theme(),
    // Fonts: preconnect + the css2 stylesheet + a Courier-adjusted "JetBrains
    // Mono Fallback" face and the --font-jetbrains-mono var — text renders at
    // the right metrics before the webfont lands, so the swap is seamless.
    font({
      fallback: ['ui-monospace', 'monospace'],
      fonts: [{ family: 'JetBrains Mono', google: true, weights: [300, 400, 500, 600, 700, 800] }],
    }),
  ],
};
