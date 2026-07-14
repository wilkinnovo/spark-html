/**
 * Run the Bun-only test suites under Bun (Bun.serve/Bun.build/bun:sqlite are
 * the product under test): spark-html-bun and spark-ssr. Skips cleanly when
 * Bun isn't installed, so the plain `node`-based test chain still passes on a
 * Bun-less machine.
 */
import { spawnSync } from 'node:child_process';

const has = spawnSync('bun', ['--version'], { encoding: 'utf8' });
if (has.status !== 0) {
  console.log('\nspark-html-bun / spark-ssr: bun not found — skipping (Bun-only suites)');
  process.exit(0);
}

for (const suite of ['packages/spark-html-bun/test/bun.js', 'packages/spark-ssr/test/ssr.js', 'packages/spark-ssr/test/security.js', 'packages/spark-ssr/test/schema-null-seed.js', 'packages/spark-html-dev-tls/test/dev-tls.js', 'scripts/cookbook-check.mjs']) {
  const r = spawnSync('bun', [suite], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
process.exit(0);
