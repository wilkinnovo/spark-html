/**
 * Bundle-size guard for the spark-html runtime.
 *
 * The whole pitch is "tiny core, 0 deps" — so this fails CI if the minified +
 * gzipped runtime grows past its budget. Keeps a future change from quietly
 * bloating the thing that has to stay small. Run via `npm run size` (and it's
 * part of `npm test`).
 */
import { build } from 'esbuild';
import { minify } from 'terser';
import { terserOpts } from './terser-opts.mjs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LIMIT_KB = 18.00; // CEILING UNCHANGED — 2026-07-10 G1 (4th program,
// post-spark-speed-pro-max.md): a terser second pass over the esbuild output
// joined the measured artifact (build-dist.mjs ships the identical bytes),
// 18,427 → ~17,718 gz on unchanged semantics. Wilkin: "the max is 18kb
// runtime... no more" — the ~714-byte harvest is program funding, spent per
// that doc's gate ledger (G2 P4a, G3 moveBefore, G4 dirty-row narrowing,
// G5 lazy-live), never a ceiling conversation.
// ── history ── 18.00: ALL-IN ceiling for spark-speed-up-max-PRO (the
// third speed program), authorized by Wilkin 2026-07-09 late ("up to 18 KB
// gzip") and moved here with the program's first paying gate (P1: V4
// clear-wipe revived +/table-whitespace drop/shared proxy handler —
// +0.26 KB measured, 17.24 → 17.50). Same law as before: the ceiling
// covers the WHOLE program; a gate that would exceed it is DESCOPED or
// funded by same-commit deletions — never a further ask. Program ledger:
// spark-speed-up-max-pro.md §9.
// ── history ── 17.25: ALL-IN ceiling for the spark-speed-up-max program,
// set 2026-07-09 (Wilkin) after the 16.5 interim proved undersized: round
// 1's speed program cost +1.31 KB measured, and round 2's structural work
// (template-dependency dispatch F1 +0.29, trim-first reconcile F2 +0.56)
// tracks the same shape. 17.25 covers F2–F5 entirely; any gate that would
// exceed it is DESCOPED — no further budget conversations for the life of
// 1.x. Interim: 16.0 → 16.5 (2026-07-09, F1). Program ledger:
// spark-speed-up-max.md §9. Final (program CLOSED, 1.2.0 shipped
// 2026-07-09): F1 dispatch 15.97 → 16.26 · F2 reconcile+delegation
// → 17.05 · F3 chunked creates → 17.24 · F4 clear-wipe DESCOPED
// (+0.08 didn't fit) · F5 skipped. 17.24/17.25 used — frozen.
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

// Second pass mirrors build-dist.mjs exactly — the gate measures the bytes
// that actually ship (shared config in terser-opts.mjs, incl. the round-5
// internal-prop mangle harvest).
const two = await minify(res.outputFiles[0].text, terserOpts);
const min = Buffer.from(two.code);
const gzip = gzipSync(min).length;
const kb = (gzip / 1024).toFixed(2);
const limit = LIMIT_KB * 1024;

console.log(`spark-html runtime: ${kb} KB gzip · ${(min.length / 1024).toFixed(2)} KB min · budget ${LIMIT_KB} KB`);

if (gzip > limit) {
  console.error(`\n❌ over budget by ${((gzip - limit) / 1024).toFixed(2)} KB — keep the core tiny (move features to a sibling package).`);
  process.exit(1);
}
console.log('✅ within budget');
