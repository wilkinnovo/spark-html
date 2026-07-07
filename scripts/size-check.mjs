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

const LIMIT_KB = 15.0; // budget raised once at M1 (v1 plan §2). Allocation:
//   Fail-loud dev invariants + inspect API (M1.2/1.3)  ~0.4 KB
//   Reactive props (M2.1, actual ~0.29)                 ~0.7 KB
//   Frozen 1.0 margin                                    ~0.5 KB
//   Total: 1.6 KB added to 13.42 → 15.0 KB
// Past bumps: ~11.2KB after 0.22.x; +0.1KB for top-level-import prop fix; +0.1KB for import query-string survival; +0.1KB for leaveNode() recursive teardown; +0.1KB for braceDepths(); +0.1KB for evalPropValue() real-type preservation; +0.29KB for reactive whole-value {expr} props (M2.1, 0.29.0).

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
