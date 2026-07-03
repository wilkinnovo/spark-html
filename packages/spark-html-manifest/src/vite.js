/**
 * spark-html-manifest/vite — one config → a full PWA.
 *
 * Build: emits manifest.webmanifest, resizes the source icon into every
 * configured size (sharp, imported lazily), optionally emits the app-shell
 * worker, and injects <link rel="manifest"> + <meta name="theme-color">
 * (+ worker registration) into every built page — runs in closeBundle
 * (order post, after spark-prerender wrote its per-route HTML).
 * Dev: serves the manifest + injects the tags so devtools' "installable"
 * checks work locally too.
 *
 *   import manifest from 'spark-html-manifest/vite';
 *   plugins: [spark(), prerender(), manifest({
 *     name: 'My App', themeColor: '#ffd24a', icon: 'public/icon.png', offline: true,
 *   })]
 */
import { join, resolve } from 'node:path';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
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

/**
 * @param {object} config  Everything manifestJson takes, plus:
 * @param {string}  [config.icon]     Source image — resized to every size in `sizes`.
 * @param {string}  [config.filename='manifest.webmanifest']
 * @param {boolean|object} [config.offline=false]  Emit + register the app-shell
 *   worker; pass { shell, version, file } to tune it.
 */
export default function sparkManifest(config = {}) {
  const filename = config.filename || 'manifest.webmanifest';
  const offline = config.offline || false;
  const swFile = (offline && offline.file) || 'spark-manifest-sw.js';
  const headBlock = () =>
    manifestHtml(config, { href: filename, sw: offline ? swFile : undefined });
  let outDir = 'dist';

  return {
    name: 'spark-html-manifest',
    configResolved(viteConfig) {
      if (viteConfig && viteConfig.build && viteConfig.build.outDir) outDir = viteConfig.build.outDir;
    },

    // Dev: serve the manifest (and worker) straight from config.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0];
        if (path === `/${filename}`) {
          res.setHeader('Content-Type', 'application/manifest+json');
          res.end(JSON.stringify(manifestJson(config), null, 2));
        } else if (offline && path === `/${swFile}`) {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(swSource(typeof offline === 'object' ? offline : {}));
        } else {
          next();
        }
      });
    },
    transformIndexHtml(html) {
      if (html.includes('data-spark-manifest')) return html;
      return html.replace(/<\/head>/i, `${headBlock()}\n</head>`);
    },

    // Build: emit manifest + icons + worker.
    async generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: filename,
        source: JSON.stringify(manifestJson(config), null, 2),
      });
      if (offline) {
        const shellOpts = typeof offline === 'object' ? offline : {};
        this.emitFile({ type: 'asset', fileName: swFile, source: swSource(shellOpts) });
      }
      if (!config.icon || config.icons) return; // explicit icons — nothing to generate
      if (!existsSync(config.icon)) {
        console.warn(`[spark-html-manifest] icon source not found: ${config.icon} — icons skipped`);
        return;
      }
      // sharp is imported lazily so the plugin never breaks a build where
      // native deps can't load — you just generate icons elsewhere.
      let sharp;
      try {
        sharp = (await import('sharp')).default;
      } catch (e) {
        console.warn(`[spark-html-manifest] sharp unavailable — icons skipped (${e.message})`);
        return;
      }
      for (const size of config.sizes || ICON_SIZES) {
        const png = await sharp(config.icon)
          .resize(size, size, { fit: 'cover' })
          .png()
          .toBuffer();
        this.emitFile({ type: 'asset', fileName: iconPath(config, size), source: png });
      }
      console.log(`[spark-html-manifest] ${(config.sizes || ICON_SIZES).length} icon(s) generated from ${config.icon}`);
    },

    // After prerender wrote its pages: stamp the head tags into every page.
    closeBundle: {
      order: 'post',
      async handler() {
        const root = resolve(outDir);
        if (!existsSync(root)) return;
        const block = headBlock();
        let pages = 0;
        for (const file of await htmlFiles(root)) {
          const html = await readFile(file, 'utf8');
          if (!/<\/head>/i.test(html)) continue;            // fragment — skip
          if (html.includes('data-spark-manifest')) continue; // already injected
          await writeFile(file, html.replace(/<\/head>/i, `${block}\n</head>`), 'utf8');
          pages++;
        }
        if (pages) console.log(`[spark-html-manifest] injected PWA tags into ${pages} page(s)`);
      },
    },
  };
}
