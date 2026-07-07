/**
 * `spark-html doctor` — the dual-package / drifted-install diagnostic.
 *
 * We build throwaway node_modules trees and assert the CLI's exit code and
 * report: clean project passes, a duplicate nested install is caught (the
 * "store not created" hazard), and a companion whose spark-html range the
 * installed core doesn't satisfy is flagged. Each case is the loud-failure
 * the runtime guard can only hint at from inside the browser.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'bin', 'cli.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.stack || e.message}`); }
}

function pkg(dir, name, version, extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, ...extra }));
}
function run(cwd) {
  const r = spawnSync(process.execPath, [CLI, 'doctor'], { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

console.log('\nspark-html doctor');

test('a clean single-install project passes (exit 0)', () => {
  const root = mkdtempSync(join(tmpdir(), 'doctor-clean-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { 'spark-html': '^0.30.0' } }));
  pkg(join(root, 'node_modules', 'spark-html'), 'spark-html', '0.30.0');
  const { code, out } = run(root);
  assert.equal(code, 0, out);
  assert.match(out, /All clear/);
  rmSync(root, { recursive: true, force: true });
});

test('a duplicate nested spark-html install is caught (exit 1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'doctor-dup-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { 'spark-html': '^0.30.0', 'spark-html-router': '^0.30.0' } }));
  pkg(join(root, 'node_modules', 'spark-html'), 'spark-html', '0.30.0');
  // A router that drags in its own nested, older copy — the exact lockfile-drift shape.
  pkg(join(root, 'node_modules', 'spark-html-router'), 'spark-html-router', '0.30.0');
  pkg(join(root, 'node_modules', 'spark-html-router', 'node_modules', 'spark-html'), 'spark-html', '0.27.14');
  const { code, out } = run(root);
  assert.equal(code, 1, out);
  assert.match(out, /2 copies of spark-html/);
  assert.match(out, /0\.27\.14/, 'names the drifted version');
  assert.match(out, /store not created/, 'explains the symptom');
  rmSync(root, { recursive: true, force: true });
});

test('a companion whose range the core does not satisfy is flagged (exit 1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'doctor-range-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { 'spark-html': '1.0.0', 'spark-html-persist': '0.5.0' } }));
  pkg(join(root, 'node_modules', 'spark-html'), 'spark-html', '1.0.0');
  // Persist pins the old 0.x line via peerDependencies — 1.0.0 doesn't satisfy `^0.27`.
  pkg(join(root, 'node_modules', 'spark-html-persist'), 'spark-html-persist', '0.5.0', {
    peerDependencies: { 'spark-html': '^0.27.0' },
  });
  const { code, out } = run(root);
  assert.equal(code, 1, out);
  assert.match(out, /spark-html-persist@0\.5\.0 wants spark-html \^0\.27\.0/);
  rmSync(root, { recursive: true, force: true });
});

test('a satisfied companion range passes (exit 0)', () => {
  const root = mkdtempSync(join(tmpdir(), 'doctor-range-ok-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { 'spark-html': '1.2.3', 'spark-html-persist': '1.0.0' } }));
  pkg(join(root, 'node_modules', 'spark-html'), 'spark-html', '1.2.3');
  pkg(join(root, 'node_modules', 'spark-html-persist'), 'spark-html-persist', '1.0.0', {
    peerDependencies: { 'spark-html': '>=1.0.0 <2' },
  });
  const { code, out } = run(root);
  assert.equal(code, 0, out);
  assert.match(out, /companion\(s\) agree/);
  rmSync(root, { recursive: true, force: true });
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
