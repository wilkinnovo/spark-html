/**
 * spark-prerender/bun — the prerender as a spark-html-bun pipeline step.
 *
 *   // spark.config.js
 *   import prerender from 'spark-prerender/bun';
 *   export default {
 *     pipeline: [prerender({ pages: ['index.html'], site: 'https://example.com' })],
 *   };
 *
 * Prerenders each page in place, and a
 * routed entry (<template route>) expands to one file per route + 404.html +
 * host rewrite rules (_redirects, vercel.json) + sitemap.xml/robots.txt.
 * A failed page logs and is skipped — the build still succeeds with the
 * un-prerendered (client-rendered) HTML, so SEO degrades gracefully.
 */
import { resolve, join, dirname } from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { prerender, routesOf, routeToFile, redirectsFor, vercelConfigFor, NOT_FOUND_ROUTE, noindexRoutesOf, sitemapFor, robotsFor } from './prerender.js';

/**
 * @param {object} [options]
 * @param {string[]} [options.pages=['index.html']] HTML files in the out dir to prerender.
 * @param {object}   [options.prerender] Options forwarded to prerender() (e.g. fetch, meta).
 * @param {string}   [options.site] Deployed origin (https://example.com). Enables
 *                   sitemap.xml generation and the Sitemap: line in robots.txt.
 * @param {string[]|(() => string[]|Promise<string[]>)} [options.extraRoutes]
 *                   Additional sitemap routes for data-driven pages.
 */
export default function sparkPrerender(options = {}) {
  const pages = options.pages || ['index.html'];
  return {
    name: 'spark-prerender',
    async run({ outDir, projectRoot = process.cwd() }) {
      const root = resolve(outDir);
      for (const page of pages) {
        const file = join(root, page);
        try {
          // A routed page (spark-html-router) expands to one file per route +
          // host rewrite rules.
          const source = await readFile(file, 'utf8');
          const routes = routesOf(source);
          if (routes.length) {
            const all = routes.includes('/') ? routes : ['/', ...routes];
            // Render every route from the ORIGINAL entry first, then write —
            // the "/" route's output IS this entry file, so writing mid-loop
            // would clobber the source the remaining routes re-read (leaking
            // the home route into about.html etc.).
            const rendered = [];
            for (const route of all) {
              rendered.push([routeToFile(route), await prerender(file, { root, route, projectRoot, ...(options.prerender || {}) })]);
            }
            // 404.html — GitHub Pages (and most static hosts) serve it for any
            // unknown path. A user-provided one always wins.
            if (!existsSync(join(root, '404.html')) && !all.some((r) => routeToFile(r) === '404.html')) {
              rendered.push(['404.html', await prerender(file, { root, route: NOT_FOUND_ROUTE, projectRoot, ...(options.prerender || {}) })]);
            }
            for (const [name, out] of rendered) {
              const dest = join(root, name);
              await mkdir(dirname(dest), { recursive: true });
              await writeFile(dest, out, 'utf8');
            }
            // _redirects ships in the publish dir (Netlify reads it from the
            // deployed output); vercel.json must live at the PROJECT ROOT —
            // Vercel reads it from the repo, not the build output.
            await writeFile(join(root, '_redirects'), redirectsFor(all), 'utf8');
            await writeFile(join(resolve(projectRoot), 'vercel.json'), vercelConfigFor(all), 'utf8');
            // sitemap.xml + robots.txt — SEO files nobody should hand-maintain.
            const seo = [];
            const noindex = noindexRoutesOf(source);
            if (options.site && !existsSync(join(root, 'sitemap.xml'))) {
              let extra = options.extraRoutes || [];
              if (typeof extra === 'function') extra = await extra();
              const indexable = all
                .filter((r) => r !== NOT_FOUND_ROUTE && !noindex.includes(r))
                .concat(extra);
              await writeFile(join(root, 'sitemap.xml'), sitemapFor(indexable, options.site), 'utf8');
              seo.push('sitemap.xml');
            }
            if (!existsSync(join(root, 'robots.txt'))) {
              await writeFile(join(root, 'robots.txt'), robotsFor({ site: options.site, noindex }), 'utf8');
              seo.push('robots.txt');
            }
            const extras = ['_redirects', 'vercel.json', ...seo].join(', ');
            console.log(`[spark-prerender] prerendered ${all.length} routes from ${page} (+ ${extras})`);
            continue;
          }
          const html = await prerender(file, { root, projectRoot, ...(options.prerender || {}) });
          await writeFile(file, html, 'utf8');
          console.log(`[spark-prerender] prerendered ${page}`);
        } catch (e) {
          console.warn(`[spark-prerender] skipped ${page} — ${e.message}`);
        }
      }
    },
  };
}
