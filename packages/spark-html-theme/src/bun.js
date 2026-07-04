/**
 * spark-html-theme/bun — bake the no-flash init script into every page, as a
 * spark-html-bun pipeline step.
 *
 * theme() runs as a deferred module — after first paint — so on a reload the
 * page briefly renders in the default theme before data-theme is applied.
 * This step inserts the tiny inline script (themeInitScript) right after
 * <head> in each page, so the saved/OS theme is on <html> before any paint:
 *
 *   import theme from 'spark-html-theme/bun';
 *   export default { pipeline: [prerender(), theme()] };
 *
 * Keep `key`/`attribute` in sync with the theme() call in your bootstrap.
 * Component fragments have no <head> and are skipped naturally; pages already
 * carrying data-spark-theme are left alone (idempotent). Put it after
 * prerender() in the pipeline so per-route pages are covered.
 */
import { join, resolve } from 'node:path';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { themeInitScript } from './init.js';

async function htmlFiles(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...await htmlFiles(full));
    else if (name.endsWith('.html')) out.push(full);
  }
  return out;
}

// The script must run BEFORE the page's stylesheets paint, so it goes at the
// start of <head> — unlike font links, which append before </head>. The
// pattern must not match a <header> element (component fragments have those).
const HEAD_OPEN = /<head(\s[^>]*)?>/i;

function inject(html, block) {
  return html.replace(HEAD_OPEN, (m) => `${m}\n${block}`);
}

export default function sparkTheme(options = {}) {
  const block = `<script data-spark-theme>${themeInitScript(options)}</script>`;
  const applies = (html) =>
    HEAD_OPEN.test(html) && /<\/head>/i.test(html) && !html.includes('data-spark-theme');
  return {
    name: 'spark-html-theme',
    async run({ outDir }) {
      const root = resolve(outDir);
      if (!existsSync(root)) return;
      let pages = 0;
      for (const file of await htmlFiles(root)) {
        const html = await readFile(file, 'utf8');
        if (!applies(html)) continue; // fragment, or already injected
        await writeFile(file, inject(html, block), 'utf8');
        pages++;
      }
      if (pages) console.log(`[spark-html-theme] injected no-flash init into ${pages} page(s)`);
    },
    // Dev: same script into served pages, so reloads don't flash in dev either.
    transformHtml(html, { dev }) {
      if (!dev || !applies(html)) return html;
      return inject(html, block);
    },
  };
}
