/**
 * spark-html-manifest/bun — one config → a full PWA, as a spark-html-bun
 * pipeline step. Same output, split the two ways the Bun
 * runner consumes:
 *
 *   • run({ outDir }) — emit manifest.webmanifest, resize the source icon into
 *     every configured size (sharp, imported lazily), optionally emit the
 *     app-shell worker, then stamp <link rel="manifest"> + <meta theme-color>
 *     (+ worker registration) into every built page. Put it after prerender()
 *     so per-route pages are covered.
 *   • devRoutes() — serve the manifest (and worker) straight from config so
 *     devtools' "installable" checks work in dev too.
 *   • transformHtml() — inject the same head tags into served pages in dev.
 *
 *   import manifest from 'spark-html-manifest/bun';
 *   export default { pipeline: [prerender(), manifest({
 *     name: 'My App', themeColor: '#ffd24a', icon: 'public/icon.png', offline: true,
 *   })] };
 */
import { join, resolve, dirname } from 'node:path';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { manifestJson, manifestHtml, swSource, iconPath, ICON_SIZES } from './index.js';

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

export default function sparkManifest(config = {}) {
  const filename = config.filename || 'manifest.webmanifest';
  const offline = config.offline || false;
  const swFile = (offline && offline.file) || 'spark-manifest-sw.js';
  const headBlock = () =>
    manifestHtml(config, { href: filename, sw: offline ? swFile : undefined });

  return {
    name: 'spark-html-manifest',

    async run({ outDir }) {
      const root = resolve(outDir);
      if (!existsSync(root)) return;

      // Emit manifest + worker.
      await writeFile(join(root, filename), JSON.stringify(manifestJson(config), null, 2), 'utf8');
      if (offline) {
        await writeFile(join(root, swFile), swSource(typeof offline === 'object' ? offline : {}), 'utf8');
      }

      // Icons (unless the author supplied explicit ones).
      if (config.icon && !config.icons) {
        if (!existsSync(config.icon)) {
          console.warn(`[spark-html-manifest] icon source not found: ${config.icon} — icons skipped`);
        } else {
          // sharp is imported lazily so the plugin never breaks a build where
          // native deps can't load — you just generate icons elsewhere.
          let sharp;
          try {
            sharp = (await import('sharp')).default;
          } catch (e) {
            console.warn(`[spark-html-manifest] sharp unavailable — icons skipped (${e.message})`);
            sharp = null;
          }
          if (sharp) {
            const sizes = config.sizes || ICON_SIZES;
            for (const size of sizes) {
              const dest = join(root, iconPath(config, size));
              await mkdir(dirname(dest), { recursive: true });
              await sharp(config.icon).resize(size, size, { fit: 'cover' }).png().toFile(dest);
            }
            console.log(`[spark-html-manifest] ${sizes.length} icon(s) generated from ${config.icon}`);
          }
        }
      }

      // Stamp head tags into every page (after prerender wrote its pages).
      const block = headBlock();
      let pages = 0;
      for (const file of await htmlFiles(root)) {
        const html = await readFile(file, 'utf8');
        if (!/<\/head>/i.test(html)) continue;              // fragment — skip
        if (html.includes('data-spark-manifest')) continue; // already injected
        await writeFile(file, html.replace(/<\/head>/i, `${block}\n</head>`), 'utf8');
        pages++;
      }
      if (pages) console.log(`[spark-html-manifest] injected PWA tags into ${pages} page(s)`);
    },

    // Dev: serve the manifest (and worker) straight from config.
    devRoutes() {
      const routes = {
        [`/${filename}`]: {
          type: 'application/manifest+json',
          body: () => JSON.stringify(manifestJson(config), null, 2),
        },
      };
      if (offline) {
        routes[`/${swFile}`] = {
          type: 'text/javascript',
          body: () => swSource(typeof offline === 'object' ? offline : {}),
        };
      }
      return routes;
    },

    transformHtml(html, { dev }) {
      if (!dev) return html;
      if (html.includes('data-spark-manifest') || !/<\/head>/i.test(html)) return html;
      return html.replace(/<\/head>/i, `${headBlock()}\n</head>`);
    },
  };
}
