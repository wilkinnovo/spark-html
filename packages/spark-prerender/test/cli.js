/**
 * spark-prerender CLI — drives bin/cli.js as a subprocess over a copied
 * fixture, asserting the routed-entry output lands in the right places:
 * route files + _redirects in the out dir, vercel.json at the project root.
 */
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, cpSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'cli.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\nspark-prerender — cli');

await test('routed entry: vercel.json at project root (cwd), _redirects in out dir', () => {
  // Simulate a project: <proot>/dist with a routed index.html. Run the CLI
  // from <proot> so cwd is the project root.
  const proot = mkdtempSync(join(tmpdir(), 'spark-cli-'));
  const dist = join(proot, 'dist');
  cpSync(join(here, 'fixture'), dist, { recursive: true });
  copyFileSync(join(here, 'fixture', 'routed.html'), join(dist, 'index.html'));

  execFileSync('node', [cli, 'dist/index.html'], { cwd: proot, stdio: 'pipe' });

  assert.ok(existsSync(join(dist, 'about.html')), 'route file written to out dir');
  assert.ok(existsSync(join(dist, '_redirects')), '_redirects in the out dir');
  assert.ok(existsSync(join(proot, 'vercel.json')), 'vercel.json at the project root (cwd)');
  assert.ok(!existsSync(join(dist, 'vercel.json')), 'vercel.json must NOT be in the out dir');
});

await test('--vercel-root overrides where vercel.json is written', () => {
  const proot = mkdtempSync(join(tmpdir(), 'spark-cli-'));
  const dist = join(proot, 'dist');
  const cfg = mkdtempSync(join(tmpdir(), 'spark-cli-cfg-'));
  cpSync(join(here, 'fixture'), dist, { recursive: true });
  copyFileSync(join(here, 'fixture', 'routed.html'), join(dist, 'index.html'));

  execFileSync('node', [cli, 'dist/index.html', '--vercel-root', cfg], { cwd: proot, stdio: 'pipe' });

  assert.ok(existsSync(join(cfg, 'vercel.json')), 'vercel.json at --vercel-root');
  assert.ok(!existsSync(join(proot, 'vercel.json')), 'not at cwd when overridden');
  assert.ok(!existsSync(join(dist, 'vercel.json')), 'not in the out dir');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
