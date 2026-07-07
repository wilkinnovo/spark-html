#!/usr/bin/env node
/**
 * spark-html CLI. Today it has one job: `spark-html doctor`, the diagnostic
 * that turns the framework's silent failure modes into named, fixable
 * reports. Runs under node or bun, zero dependencies.
 *
 *   npx spark-html doctor
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const cmd = process.argv[2];

if (cmd !== 'doctor') {
  console.log('spark-html — usage:\n  spark-html doctor    scan this project for the known footguns');
  process.exit(cmd ? 1 : 0);
}

const cwd = process.cwd();
let problems = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => { problems++; console.log(`  \x1b[33m!\x1b[0m ${m}`); };
const fail = (m) => { problems++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };

console.log('\n⚡ spark-html doctor\n');

// ── 1. Duplicate spark-html installs (the dual-package "store not created"
// hazard). Walk every node_modules under the project for a spark-html
// package.json; more than one distinct install path = the bug in waiting. ──
function findInstalls(pkg) {
  const found = [];
  (function walk(dir, depth) {
    if (depth > 8) return;
    const nm = join(dir, 'node_modules');
    if (!existsSync(nm)) return;
    let entries;
    try { entries = readdirSync(nm); } catch { return; }
    // The package itself, directly installed here.
    const self = join(nm, pkg, 'package.json');
    if (existsSync(self)) {
      try { found.push({ path: join(nm, pkg), version: JSON.parse(readFileSync(self, 'utf8')).version }); } catch { /* skip */ }
    }
    // Recurse into each dependency's own nested node_modules.
    for (const e of entries) {
      if (e === '.bin' || e === pkg) continue;
      const sub = join(nm, e);
      if (e.startsWith('@')) { // scope dir — one level deeper
        let scoped; try { scoped = readdirSync(sub); } catch { continue; }
        for (const s of scoped) walk(join(sub, s), depth + 1);
      } else {
        try { if (statSync(sub).isDirectory()) walk(sub, depth + 1); } catch { /* skip */ }
      }
    }
  })(cwd, 0);
  return found;
}

const installs = findInstalls('spark-html');
if (installs.length <= 1) {
  ok(installs.length === 1
    ? `one spark-html install (${installs[0].version})`
    : 'no spark-html install found in node_modules (nothing to dedupe)');
} else {
  const versions = [...new Set(installs.map((i) => i.version))];
  fail(`${installs.length} copies of spark-html installed — two runtimes each own a private store registry, which surfaces as "store not created" in production but never in dev:`);
  for (const i of installs) console.log(`      • ${i.version}  ${i.path.replace(cwd + '/', '')}`);
  console.log(versions.length > 1
    ? '    Fix: align the versions, then dedupe — delete node_modules + the lockfile and reinstall.'
    : '    Fix: dedupe — delete node_modules + the lockfile and reinstall so one hoisted copy remains.');
}

// ── 2. Companion version-range mismatches. Each installed spark-html-* / spark
// companion declares a spark-html range (peer or dep); the installed core must
// satisfy all of them. ──
function installedVersion(pkg) {
  const p = join(cwd, 'node_modules', pkg, 'package.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).version; } catch { return null; }
}

// Minimal semver satisfies for the ranges companions actually declare:
// exact, `*`, `^x.y.z`, `~x.y.z`, and space-joined `>=a <b` (AND) forms.
function cmp(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1; }
  return 0;
}
function satisfiesOne(v, r) {
  r = r.trim();
  if (!r || r === '*' || r === 'latest' || r.startsWith('workspace:')) return true;
  if (r.startsWith('>=')) return cmp(v, r.slice(2).trim()) >= 0;
  if (r.startsWith('<=')) return cmp(v, r.slice(2).trim()) <= 0;
  if (r.startsWith('<')) return cmp(v, r.slice(1).trim()) < 0;
  if (r.startsWith('>')) return cmp(v, r.slice(1).trim()) > 0;
  if (r.startsWith('^')) {
    const base = r.slice(1).split('.').map(Number);
    if (cmp(v, r.slice(1)) < 0) return false;
    const vp = v.split('.').map(Number);
    // Caret: same left-most non-zero component (0.x locks minor, x.y.z locks major).
    if (base[0] > 0) return vp[0] === base[0];
    if (base[1] > 0) return vp[0] === 0 && vp[1] === base[1];
    return vp[0] === 0 && vp[1] === 0 && vp[2] === base[2];
  }
  if (r.startsWith('~')) {
    const base = r.slice(1).split('.').map(Number);
    if (cmp(v, r.slice(1)) < 0) return false;
    const vp = v.split('.').map(Number);
    return vp[0] === base[0] && vp[1] === (base[1] || 0);
  }
  return cmp(v, r) === 0;
}
const satisfies = (v, range) => String(range).split(/\s+/).every((r) => satisfiesOne(v, r));

const coreVersion = installedVersion('spark-html');
let projectDeps = {};
try {
  const pj = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  projectDeps = { ...pj.dependencies, ...pj.devDependencies };
} catch { /* no package.json */ }

const companions = Object.keys(projectDeps).filter((n) => /^spark(-html)?(-[\w-]+)?$/.test(n) && n !== 'spark-html');
if (!coreVersion || !companions.length) {
  ok('no companion version conflicts');
} else {
  let mismatch = 0;
  for (const c of companions) {
    const p = join(cwd, 'node_modules', c, 'package.json');
    if (!existsSync(p)) continue;
    let meta; try { meta = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    const range = (meta.peerDependencies && meta.peerDependencies['spark-html'])
      || (meta.dependencies && meta.dependencies['spark-html']);
    if (range && !satisfies(coreVersion, range)) {
      mismatch++;
      fail(`${c}@${meta.version} wants spark-html ${range}, but ${coreVersion} is installed — upgrade one so they agree.`);
    }
  }
  if (!mismatch) ok(`all ${companions.length} companion(s) agree with spark-html ${coreVersion}`);
}

// ── 3. Stale service-worker heuristic (the documented dev-hang). We can't see
// the browser from here, so this is advisory: if the project ships a service
// worker, remind the reader that a leftover one on a reused localhost port
// hangs the dev server and no file edit clears it. ──
const swFiles = ['public/sw.js', 'public/service-worker.js', 'sw.js', 'service-worker.js']
  .filter((f) => existsSync(join(cwd, f)));
if (swFiles.length) {
  warn(`this project ships a service worker (${swFiles.join(', ')}). If the dev server ever hangs on a reused localhost port with Cache.put errors, it's a stale worker from a previous project — open DevTools → Application → Service Workers → Unregister, or hard-reload. Deleting files never unregisters a worker.`);
} else {
  ok('no service worker to go stale on a dev port');
}

console.log(`\n${problems ? `\x1b[33m${problems} issue(s) to look at.\x1b[0m` : '\x1b[32mAll clear.\x1b[0m'}\n`);
process.exit(problems ? 1 : 0);
