/**
 * Build the single-file runtime bundle.
 *
 * Spark ships one ESM file — `packages/spark/dist/spark.js` — that bundles
 * every src/ module (expr, reactivity, script, directives, component, css,
 * index entry) into a minified, single-file ESM with no internal imports.
 * That file is what `main`/`exports` point at, so:
 *   - browser users importing 'spark-html' over a CDN get exactly one file
 *   - bundlers-of-spark-html (spark-html-bun, spark-prerender) pull one file
 *     instead of the multi-module src/ tree (functionally identical, since
 *     esbuild resolves the inter-module imports identically)
 *   - the size-check (scripts/size-check.mjs) ALREADY runs the same esbuild
 *     bundle in-memory; this script just writes the bytes to disk.
 *
 * Plan §5.1: "Publish a concatenated dist/spark.js built at release so the
 * no-build, one-<script>-tag story is untouched — the framework having a
 * release step is not the user having a build step." The dist is committed
 * so fresh clones resolve `main` immediately; `prepublishOnly` regenerates
 * it before each publish so the registry never ships a stale bundle.
 *
 *   node scripts/build-dist.mjs
 */
import { build } from 'esbuild';
import { minify } from 'terser';
import { terserOpts } from './terser-opts.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'packages/spark/src/index.js');
const outDir = join(root, 'packages/spark/dist');
const outFile = join(outDir, 'spark.js');

const res = await build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: 'esm',
  write: false,
  logLevel: 'silent',
});

// G1 (post-spark-speed-pro-max.md, 2026-07-10): terser second pass over the
// esbuild output — same semantics, −709 gz measured at P0. size-check.mjs
// measures this same two-pass artifact; the two must never diverge — the
// shared config (incl. the round-5 internal-prop mangle) lives in
// terser-opts.mjs.
const two = await minify(res.outputFiles[0].text, terserOpts);

await mkdir(outDir, { recursive: true });
await writeFile(outFile, two.code);

const bytes = Buffer.byteLength(two.code);
console.log(`built packages/spark/dist/spark.js — ${(bytes / 1024).toFixed(2)} KB min`);