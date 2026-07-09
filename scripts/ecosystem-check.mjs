/**
 * improvements.md I5a — "one framework, not 21 packages": mechanical
 * tripwires so the coherence promises rely on a red gate, not vigilance.
 * Wired into the root `npm test` chain (a check not wired never runs).
 *
 * For every packages/* :
 *   1. any spark-html dependency is peerDependencies ">=1 <2" — NEVER a
 *      hard `dependency` (the dual-package hazard; the peerDeps flip
 *      shipped in the 1.0 wave — this keeps it true).
 *   2. README.md exists and has at least one fenced code block.
 *   3. at least one test file exists AND is wired into the root `npm test`
 *      chain or scripts/test-bun.mjs (mechanizes "a suite not in the chain
 *      never runs").
 *   4. package.json has `license` and `repository`.
 *   5. the core's export surface (packages/spark/src/index.js's `export {}`
 *      line) matches exactly the names recorded in V1-API-FREEZE.md — a
 *      rename/removal is a breaking change and must fail this before it can
 *      ship as an accident.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

const pkgDirs = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

// ── wired-test-file set (root chain + scripts/test-bun.mjs) ──────────────
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const testChain = rootPkg.scripts.test;
const bunChain = readFileSync(join(ROOT, 'scripts/test-bun.mjs'), 'utf8');
const wiredFiles = new Set([
  ...(testChain.match(/packages\/[\w.\/-]+\.js/g) || []),
  ...(bunChain.match(/packages\/[\w.\/-]+\.js/g) || []),
]);

for (const name of pkgDirs) {
  const dir = join(ROOT, 'packages', name);
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) { errors.push(`${name}: no package.json`); continue; }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  // 1. spark-html must be a peerDependency, never a hard dependency.
  if (pkg.dependencies && pkg.dependencies['spark-html']) {
    errors.push(`${name}: spark-html is a hard "dependency" (${pkg.dependencies['spark-html']}) — must be peerDependencies ">=1 <2" (the dual-package hazard)`);
  }
  if (pkg.peerDependencies && pkg.peerDependencies['spark-html']) {
    const range = pkg.peerDependencies['spark-html'];
    if (!/^>=1(\.0\.0)?\s*<2$/.test(range.trim())) {
      errors.push(`${name}: peerDependencies.spark-html is "${range}", expected ">=1.0.0 <2" (or ">=1 <2")`);
    }
  }

  // 2. README exists and names at least one runnable example.
  const readmePath = join(dir, 'README.md');
  if (!existsSync(readmePath)) {
    errors.push(`${name}: no README.md`);
  } else if (!/```/.test(readFileSync(readmePath, 'utf8'))) {
    errors.push(`${name}: README.md has no fenced code block (no runnable example)`);
  }

  // 3. at least one test file, and it must be wired into the root chain.
  const testDir = join(dir, 'test');
  if (!existsSync(testDir)) {
    errors.push(`${name}: no test/ directory`);
  } else {
    const testFiles = readdirSync(testDir).filter((f) => f.endsWith('.js'));
    if (!testFiles.length) {
      errors.push(`${name}: test/ has no .js files`);
    } else {
      const anyWired = testFiles.some((f) => wiredFiles.has(`packages/${name}/test/${f}`));
      if (!anyWired) {
        errors.push(`${name}: test/ has files (${testFiles.join(', ')}) but NONE are wired into the root npm test chain or scripts/test-bun.mjs — they never run`);
      }
    }
  }

  // 4. license + repository fields present.
  for (const field of ['license', 'repository']) {
    if (!pkg[field]) errors.push(`${name}: package.json missing "${field}"`);
  }
}

// 5. core API-surface snapshot vs V1-API-FREEZE.md.
const coreSrc = readFileSync(join(ROOT, 'packages/spark/src/index.js'), 'utf8');
const exportLine = coreSrc.match(/^export \{([^}]+)\};?\s*$/m);
if (!exportLine) {
  errors.push('core: could not find the `export {...}` line in packages/spark/src/index.js');
} else {
  const liveExports = exportLine[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
  const freezeDoc = readFileSync(join(ROOT, 'V1-API-FREEZE.md'), 'utf8');
  // The freeze doc's export table rows look like "| `name(args?)` | **bucket** | ...".
  // Pull the bare identifier out of each backtick-quoted cell in the Core
  // export table section only (between "## Core" and the next "##").
  const coreSection = freezeDoc.split(/^## Core /m)[1]?.split(/^## /m)[0] || '';
  const freezeNames = new Set(
    [...coreSection.matchAll(/\|\s*`([a-zA-Z_$][\w$]*)/g)].map((m) => m[1])
      .filter((n) => n !== 'default'), // the "export default {...}" convenience row, not a named export
  );
  const missingFromDoc = liveExports.filter((n) => !freezeNames.has(n));
  const missingFromCode = [...freezeNames].filter((n) => !liveExports.includes(n));
  if (missingFromDoc.length) {
    errors.push(`core: index.js exports ${missingFromDoc.join(', ')} — not recorded in V1-API-FREEZE.md's Core table (undocumented surface change, possibly a breaking one)`);
  }
  if (missingFromCode.length) {
    errors.push(`core: V1-API-FREEZE.md's Core table lists ${missingFromCode.join(', ')} — no longer exported from index.js (a removal that must be a major version, or the doc is stale)`);
  }
}

if (errors.length) {
  console.error('\n❌ ecosystem-check failed:\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`\n${errors.length} issue(s).\n`);
  process.exit(1);
}
console.log(`✅ ecosystem-check: ${pkgDirs.length} packages, core export surface matches V1-API-FREEZE.md`);
