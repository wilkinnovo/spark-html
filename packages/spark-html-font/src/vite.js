/**
 * spark-html-font/vite — bake the font tags into every built page.
 *
 * Runs in closeBundle (order post, after spark-prerender has written its
 * per-route HTML) and inserts the <link rel="preload">s + inline
 * <style data-spark-font> right before </head> in each page — so the font
 * fetch starts with the HTML and first paint uses the size-adjusted
 * fallback. Component fragments have no <head> and are skipped naturally;
 * pages already carrying data-spark-font are left alone (idempotent).
 *
 *   import font from 'spark-html-font/vite';
 *   plugins: [spark(), prerender(), font({ fonts: [...] })]
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
  let outDir = 'dist';
  return {
    name: 'spark-html-font',
    apply: 'build',
    configResolved(viteConfig) {
      if (viteConfig && viteConfig.build && viteConfig.build.outDir) outDir = viteConfig.build.outDir;
    },
    closeBundle: {
      order: 'post',
      async handler() {
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
    },
  };
}
