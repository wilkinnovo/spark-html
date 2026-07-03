/**
 * spark-html-offline/vite — emit + serve the worker file.
 *
 * Build: writes the generated service worker into the output dir (default
 * name /spark-sw.js) so `offline()` finds it in production.
 * Dev: serves the same source from the dev server, so the worker can be
 * exercised locally too (it only touches cross-origin URLs by default, so
 * HMR and local files are unaffected).
 *
 *   import offlineSw from 'spark-html-offline/vite';
 *   plugins: [spark(), offlineSw({ include: ['/components/'] })]
 */
import { swSource } from './index.js';

export default function sparkOffline(options = {}) {
  const file = (options.file || 'spark-sw.js').replace(/^\//, '');
  const source = swSource(options);
  return {
    name: 'spark-html-offline',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url || '').split('?')[0] === `/${file}`) {
          res.setHeader('Content-Type', 'text/javascript');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(source);
          return;
        }
        next();
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: file, source });
    },
  };
}
