/**
 * Bundle-size guard for the spark-html runtime.
 *
 * The whole pitch is "tiny core, 0 deps" — so this fails CI if the minified +
 * gzipped runtime grows past its budget. Keeps a future change from quietly
 * bloating the thing that has to stay small. Run via `npm run size` (and it's
 * part of `npm test`).
 */
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LIMIT_KB = 13.4; // frozen budget for spark-html (minified + gzipped). ~11.2KB after 0.22.x; bumped 0.1KB for the top-level-import prop fix (a plain `<div import> prop="{expr}"` reading its own enclosing component's state now actually evaluates instead of rendering literal braces — was silently broken since imports resolve tree-wide before any component boots); bumped another 0.1KB so an import path's query string (e.g. a server-baked "?id=3") survives the ".html" auto-append instead of landing inside the query value; bumped another 0.1KB so leaveNode() recursively tears down a nested each/if/await anchor's own rendered rows instead of just removing the (invisible) anchor tag and orphaning them; bumped another 0.1KB for braceDepths() — analyzeScript()'s let/const/var and function-declaration rewrites now apply ONLY at the script's own top level (depth 0), not inside a nested helper function's body, where they used to turn a true local variable into an implicit write to the reactive scope proxy — read-and-written by the same expression evaluation (an ordinary pattern), that became a genuine infinite patch loop (a real hang, not just a stale read).

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'packages/spark/src/index.js');

const res = await build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: 'esm',
  write: false,
  logLevel: 'silent',
});

const min = res.outputFiles[0].contents;
const gzip = gzipSync(min).length;
const kb = (gzip / 1024).toFixed(2);
const limit = LIMIT_KB * 1024;

console.log(`spark-html runtime: ${kb} KB gzip · ${(min.length / 1024).toFixed(2)} KB min · budget ${LIMIT_KB} KB`);

if (gzip > limit) {
  console.error(`\n❌ over budget by ${((gzip - limit) / 1024).toFixed(2)} KB — keep the core tiny (move features to a sibling package).`);
  process.exit(1);
}
console.log('✅ within budget');
