/**
 * spark-prerender/vite — run the prerender automatically as part of
 * `vite build`, over the emitted `dist/*.html`.
 *
 *   // vite.config.js
 *   import spark from 'spark-html/vite';
 *   import prerender from 'spark-prerender/vite';
 *
 *   export default {
 *     plugins: [
 *       spark(),
 *       prerender({ pages: ['index.html', 'docs.html'] }),
 *     ],
 *   };
 *
 * Runs in `closeBundle` (after assets are written), rewriting each page in
 * place. A failed page logs and is skipped — the build still succeeds with
 * the un-prerendered (client-rendered) HTML, so SEO degrades gracefully and
 * never breaks the build.
 */
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { prerender } from './prerender.js';

/**
 * @param {object} [options]
 * @param {string[]} [options.pages=['index.html']] HTML files in the out dir to prerender.
 * @param {object}   [options.prerender] Options forwarded to prerender() (e.g. fetch, meta).
 */
export default function sparkPrerender(options = {}) {
  const pages = options.pages || ['index.html'];
  let outDir = 'dist';
  return {
    name: 'spark-prerender',
    apply: 'build',
    configResolved(config) {
      if (config && config.build && config.build.outDir) outDir = config.build.outDir;
    },
    async closeBundle() {
      const root = resolve(outDir);
      for (const page of pages) {
        const file = join(root, page);
        try {
          const html = await prerender(file, { root, ...(options.prerender || {}) });
          await writeFile(file, html, 'utf8');
          console.log(`[spark-prerender] prerendered ${page}`);
        } catch (e) {
          console.warn(`[spark-prerender] skipped ${page} — ${e.message}`);
        }
      }
    },
  };
}
