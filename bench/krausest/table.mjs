// Ratio table from webdriver-ts results: node table.mjs <resultsDir> [--gate <cpuMax> <fpMax>]
// Pairs spark-html vs vanillajs per benchmark, prints medians + ratios and
// the CPU geomean (benchmarks 01–09). Defensive about result-file shape
// (values.total for CPU, plain array / DEFAULT for memory).
//
// --gate turns the table into a CI gate (speed-gate.yml): exit 1 if the CPU
// geomean exceeds cpuMax, the 43_first-paint ratio exceeds fpMax, or either
// number is missing from the results (a gate that can't measure must not
// pass silently). Thresholds live in the workflow, rationale in
// .claude/skills/spark-project/references/workflows.md.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'results';
const gateIdx = process.argv.indexOf('--gate');
const gate = gateIdx > -1 ? { cpu: parseFloat(process.argv[gateIdx + 1]), fp: parseFloat(process.argv[gateIdx + 2]) } : null;
const rows = new Map(); // benchmark -> { vanilla, spark }
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s[s.length >> 1] + s[(s.length - 1) >> 1]) / 2 : NaN;
};
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  let r;
  try { r = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
  const fw = r.framework || '';
  const side = fw.startsWith('vanillajs-') || fw.startsWith('vanillajs_') || fw === 'vanillajs' || fw.startsWith('vanillajs-keyed') || /^vanillajs\b/.test(fw) ? 'vanilla'
    : fw.includes('spark-html') ? 'spark' : null;
  if (!side || !r.benchmark) continue;
  let v = r.values;
  if (v && !Array.isArray(v)) v = v.total ?? v.DEFAULT ?? v[Object.keys(v)[0]];
  if (v && !Array.isArray(v) && Array.isArray(v.values)) v = v.values;
  if (!Array.isArray(v) || !v.length) continue;
  const e = rows.get(r.benchmark) || {};
  e[side] = median(v);
  rows.set(r.benchmark, e);
}
const names = [...rows.keys()].sort();
let logSum = 0, n = 0, fpRatio = NaN;
console.log('benchmark'.padEnd(28), 'vanilla'.padStart(9), 'spark'.padStart(9), 'ratio'.padStart(7));
for (const b of names) {
  const { vanilla, spark } = rows.get(b);
  const ratio = vanilla && spark ? spark / vanilla : NaN;
  console.log(b.padEnd(28), (vanilla?.toFixed(1) ?? '—').padStart(9), (spark?.toFixed(1) ?? '—').padStart(9), (isNaN(ratio) ? '—' : ratio.toFixed(2) + '×').padStart(7));
  if (/^0[1-9]_/.test(b) && !isNaN(ratio)) { logSum += Math.log(ratio); n++; }
  if (b.startsWith('43_first-paint')) fpRatio = ratio;
}
const geomean = n ? Math.exp(logSum / n) : NaN;
if (n) console.log(`\nCPU geomean (01–09, ${n} benchmarks): ${geomean.toFixed(3)}×`);
if (gate) {
  const fails = [];
  if (!(n >= 9)) fails.push(`only ${n}/9 CPU benchmarks paired — incomplete run`);
  else if (geomean > gate.cpu) fails.push(`CPU geomean ${geomean.toFixed(3)}× > ${gate.cpu}× threshold`);
  if (isNaN(fpRatio)) fails.push(`43_first-paint missing from results`);
  else if (fpRatio > gate.fp) fails.push(`first-paint ratio ${fpRatio.toFixed(3)}× > ${gate.fp}× threshold`);
  if (fails.length) {
    for (const f of fails) console.error(`GATE FAIL: ${f}`);
    process.exit(1);
  }
  console.log(`GATE PASS: geomean ${geomean.toFixed(3)}× ≤ ${gate.cpu}×, first-paint ${fpRatio.toFixed(3)}× ≤ ${gate.fp}×`);
}
