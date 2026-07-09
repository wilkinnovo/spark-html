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

const LIMIT_KB = 16.5; // raised 16.0 → 16.5 on 2026-07-09 (Wilkin, final,
// re-frozen for the life of 1.x) to fund the spark-speed-up-max program's
// template-dependency dispatch (F1–F3): the capture-observed binding graph
// hoisted to template level — column sweeps instead of per-row Sets and
// walks. +0.26 net at F1 after three design iterations of golf (ledger in
// spark-speed-up-max.md §9); the raise buys the remaining F2/F3 headroom.
// Previous raise: 15.0 → 16.0 on 2026-07-08 (Wilkin, itemized) funding the
// first speed program (spark-speed-up.md) — "simplest AND fastest".
// Speed-program ledger (measured per gate):
//   G1 loop-scope proto-chain + live walker      −0.02 KB (14.66 → 14.64)
//   G2 keyed LIS reconciler + row identity-skip  +0.41 KB (14.64 → 15.05)
// Previous era (13.42 → 15.0, M1, v1 plan §2): fail-loud invariants ~0.4,
// reactive props ~0.7, frozen margin ~0.5 (spent on arrow-handler warn,
// app-root/app-base fixes, import-prop coercion → 14.66 at 1.0.0).
// Older bumps: ~11.2KB after 0.22.x; +0.1 top-level-import prop fix; +0.1
// import query-string survival; +0.1 leaveNode() recursive teardown; +0.1
// braceDepths(); +0.1 evalPropValue() type preservation; +0.29 reactive
// whole-value {expr} props (M2.1, 0.29.0).
// "It doesn't fit" still has exactly one answer: a sibling package.

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
