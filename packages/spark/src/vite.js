/**
 * Vite plugin for Spark.
 *
 *   // vite.config.js
 *   import { defineConfig } from 'vite';
 *   import spark from 'spark-html/vite';
 *
 *   export default defineConfig({ plugins: [spark()] });
 *
 * What it does:
 *  - Serves component .html fragments raw (skips Vite's HTML entry transform,
 *    which would inject HMR client code into fragments), with no-cache so edits
 *    are re-fetched fresh.
 *  - HMR: when a component file changes, re-renders just that component's
 *    instances in place — sibling component state is preserved, no full reload.
 *    Components that received slot content, or live inside an each/if block,
 *    fall back to a full reload (always correct).
 */
const HMR_CLIENT = `
import { mount, unmount } from 'spark-html';
if (import.meta.hot) {
  import.meta.hot.on('spark:update', async ({ name }) => {
    const hosts = [...document.querySelectorAll('[name="' + name + '"]')];
    if (!hosts.length) { location.reload(); return; }
    // Scoped HMR only for simple top-level hosts; slotted or loop/if-managed
    // hosts fall back to a full reload so the result is always correct.
    if (hosts.some((h) => h.__sparkHadSlots || h.__sparkManaged)) { location.reload(); return; }
    try {
      for (const host of hosts) {
        const ph = document.createElement('div');
        ph.setAttribute('import', host.__sparkImportPath || ('components/' + name + '.html'));
        const props = host.__sparkProps || {};
        for (const k in props) {
          const v = props[k];
          try { ph.setAttribute(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) {}
        }
        const cls = host.getAttribute('class'); if (cls) ph.setAttribute('class', cls);
        if (host.id) ph.id = host.id;
        const parent = host.parentNode;
        unmount(host);
        host.replaceWith(ph);
        await mount(parent);
      }
      console.log('[spark] ⚡ hot-updated', name);
    } catch (e) { location.reload(); }
  });
}
`;

export default function spark(options = {}) {
  const dir = options.componentsDir ?? 'components';
  const isComponent = (p) => p && p.includes(`/${dir}/`) && p.endsWith('.html');

  return {
    name: 'spark',

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.includes(`/${dir}/`) && req.url.split(/[?#]/)[0].endsWith('.html')) {
          res.setHeader('Content-Type', 'text/html');
          res.setHeader('Cache-Control', 'no-cache'); // always re-fetch fresh on HMR
        }
        next();
      });
    },

    // Inject the tiny HMR client in dev only (not in the production build).
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx || !ctx.server) return; // build: skip
        return [{ tag: 'script', attrs: { type: 'module' }, children: HMR_CLIENT, injectTo: 'body' }];
      },
    },

    handleHotUpdate({ file, server }) {
      if (isComponent(file)) {
        const name = file.split('/').pop().replace(/\.html$/, '');
        server.ws.send({ type: 'custom', event: 'spark:update', data: { name } });
        return []; // we handled it — suppress the default full reload
      }
    },
  };
}
