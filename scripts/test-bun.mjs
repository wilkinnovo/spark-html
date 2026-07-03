/**
 * Run the spark-html-bun test suite under Bun (Bun.serve/Bun.build are the
 * product under test). Skips cleanly when Bun isn't installed, so the plain
 * `node`-based test chain still passes on a Bun-less machine.
 */
import { spawnSync } from 'node:child_process';

const has = spawnSync('bun', ['--version'], { encoding: 'utf8' });
if (has.status !== 0) {
  console.log('\nspark-html-bun: bun not found — skipping (Bun-only suite)');
  process.exit(0);
}

const r = spawnSync('bun', ['packages/spark-html-bun/test/bun.js'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
