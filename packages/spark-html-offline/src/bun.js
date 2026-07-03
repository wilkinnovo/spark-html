/**
 * spark-html-offline/bun — emit + serve the worker file, as a spark-html-bun
 * pipeline step.
 *
 *   • run({ outDir }) — write the generated service worker into the output dir
 *     (default /spark-sw.js) so offline() finds it in production.
 *   • devRoutes() — serve the same source in dev, so the worker can be
 *     exercised locally too (it only touches cross-origin URLs by default, so
 *     HMR and local files are unaffected).
 *
 *   import offline from 'spark-html-offline/bun';
 *   export default { pipeline: [offline({ include: ['/components/'] })] };
 */
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { swSource } from './index.js';

export default function sparkOffline(options = {}) {
  const file = (options.file || 'spark-sw.js').replace(/^\//, '');
  const source = swSource(options);
  return {
    name: 'spark-html-offline',
    async run({ outDir }) {
      const root = resolve(outDir);
      if (!existsSync(root)) return;
      await writeFile(join(root, file), source, 'utf8');
    },
    devRoutes() {
      return { [`/${file}`]: { type: 'text/javascript', body: () => source } };
    },
  };
}
