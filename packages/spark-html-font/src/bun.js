/**
 * spark-html-font/bun — bake the font tags into every built page, as a
 * spark-html-bun pipeline step.
 *
 * Inserts the <link rel="preload">s + inline <style data-spark-font> right
 * before </head> in each page — so the font fetch starts with the HTML and
 * first paint uses the size-adjusted fallback. Component fragments have no
 * <head> and are skipped naturally; pages already carrying data-spark-font
 * are left alone (idempotent). Put it after prerender() in the pipeline so
 * per-route pages are covered.
 *
 *   import font from 'spark-html-font/bun';
 *   export default { pipeline: [prerender(), font({ fonts: [...] })] };
 */
import { join, resolve } from 'node:path';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fontHtml } from './index.js';

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

export default function sparkFont(config = {}) {
  return {
    name: 'spark-html-font',
    async run({ outDir }) {
      const root = resolve(outDir);
      if (!existsSync(root)) return;
      const block = fontHtml(config);
      if (!block) return;
      let pages = 0;
      for (const file of await htmlFiles(root)) {
        const html = await readFile(file, 'utf8');
        if (!/<\/head>/i.test(html)) continue;          // fragment (component) — skip
        if (html.includes('data-spark-font')) continue; // already injected
        await writeFile(file, html.replace(/<\/head>/i, `${block}\n</head>`), 'utf8');
        pages++;
      }
      if (pages) console.log(`[spark-html-font] injected font loading into ${pages} page(s)`);
    },
    // Dev: inject the same tags into served pages so fonts load in dev too.
    transformHtml(html, { dev }) {
      if (!dev) return html;
      if (html.includes('data-spark-font') || !/<\/head>/i.test(html)) return html;
      const block = fontHtml(config);
      return block ? html.replace(/<\/head>/i, `${block}\n</head>`) : html;
    },
  };
}
