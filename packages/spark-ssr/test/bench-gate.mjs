// CI floor gate over test/bench.js output (improvements.md I2b).
// Usage: node|bun test/bench-gate.mjs <bench-output.txt>
//
// Floors calibrated 2026-07-09 from the last 3 uploaded bench.yml artifacts
// (runs 29040136390 / 29040086528 / 29039897610 — ubuntu-latest, Bun 1.3.14):
//   1000-row renderFragment p50: 4.07–4.17 ms   → floor 9 ms
//   throughput todo:           14,773–15,755 r/s → floor 7,000
//   throughput big (1k rows):   8,843–9,263 r/s  → floor 4,400
//   throughput blog (40 md):   10,678–12,768 r/s → floor 5,300
// Floors sit at ~half the worst observed run: they exist to catch 2×
// regressions loudly, not 5% wobble on a shared runner. The dev-box numbers
// to defend (big ~6,900 req/s, 1000-row ~4.4 ms, packages/spark-ssr
// invariant) are tracked by running test/bench.js locally around render-path
// changes — this gate is the backstop, not the ledger.
// A metric missing from the output fails the gate: a gate that can't
// measure must not pass silently.
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'test/bench-output.txt';
const out = readFileSync(file, 'utf8');

const FLOORS = { todo: 7000, big: 4400, blog: 5300 };
const RENDER_1000_MAX_MS = 9;

const fails = [];

const p50 = out.match(/^\s*1000 rows[^\n]*?p50\s+([\d.]+) ms/m);
if (!p50) fails.push('1000-row renderFragment p50 not found in bench output');
else if (parseFloat(p50[1]) > RENDER_1000_MAX_MS)
  fails.push(`1000-row render p50 ${p50[1]} ms > ${RENDER_1000_MAX_MS} ms floor`);

const tp = out.match(/throughput: todo (\d+) req\/s · big (\d+) req\/s · blog (\d+) req\/s/);
if (!tp) fails.push('throughput line not found in bench output');
else
  for (const [i, name] of ['todo', 'big', 'blog'].entries())
    if (parseInt(tp[i + 1], 10) < FLOORS[name])
      fails.push(`${name} ${tp[i + 1]} req/s < ${FLOORS[name]} req/s floor`);

if (fails.length) {
  for (const f of fails) console.error(`BENCH GATE FAIL: ${f}`);
  process.exit(1);
}
console.log(`BENCH GATE PASS: 1000-row p50 ${p50[1]} ms ≤ ${RENDER_1000_MAX_MS} ms; todo ${tp[1]} ≥ ${FLOORS.todo}, big ${tp[2]} ≥ ${FLOORS.big}, blog ${tp[3]} ≥ ${FLOORS.blog} req/s`);
