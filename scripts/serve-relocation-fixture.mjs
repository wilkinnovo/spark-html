/**
 * I2a relocation gate (improvements.md) — build/serve a throwaway project of
 * the given mode (client / ssr / prerender) around the ONE shared page at
 * e2e/fixtures/relocation/shared/page.html, unmodified. Mirrors
 * scripts/serve-template-for-e2e.mjs's pattern (temp dir inside the monorepo
 * so Bun workspace resolution links the LOCAL package sources, not whatever
 * is on the registry).
 *
 * Usage: bun scripts/serve-relocation-fixture.mjs <client|ssr|prerender> [port]
 *
 * Each mode copies the shared page + its relative imports into a
 * mode-appropriate directory (public/components/ for client + prerender,
 * pages/ for ssr) at the SAME relative paths the page's own `./helpers.js`
 * and `./components/child.html` imports expect — the page file itself is
 * never rewritten.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function $async(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: 'inherit', ...opts });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(cmd + ' exited ' + code))));
    c.on('error', reject);
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SHARED = join(ROOT, 'e2e/fixtures/relocation/shared');

const MODE = process.argv[2];
const PORT = Number(process.argv[3]) || 5200;
if (!['client', 'ssr', 'prerender'].includes(MODE)) {
  console.error('Usage: bun scripts/serve-relocation-fixture.mjs <client|ssr|prerender> [port]');
  process.exit(1);
}

// Copy the shared page, unmodified, into `pageDir` (its `./helpers.js` JS
// import is component-relative, so helpers.js is a sibling of page.html);
// the page's `import="components/child"` HTML attribute resolves against
// the PROJECT ROOT's `components/` folder in every mode (client/prerender:
// app base = site root; ssr: components/ lives beside pages/) — same
// convention every create-spark-html-app template already uses.
function placePage(root, pageDir, publicDir) {
  mkdirSync(pageDir, { recursive: true });
  mkdirSync(join(root, 'components'), { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  cpSync(join(SHARED, 'page.html'), join(pageDir, 'page.html'));
  cpSync(join(SHARED, 'helpers.js'), join(publicDir, 'helpers.js'));
  cpSync(join(SHARED, 'components/child.html'), join(root, 'components/child.html'));
}

const tmp = mkdtempSync(join(ROOT, 'tmp-e2e-reloc-'));
console.log(`[relocation] ${MODE} fixture at ${tmp}, port ${PORT}`);

let serverArgs;
let serverEnv = { ...process.env };

if (MODE === 'client' || MODE === 'prerender') {
  placePage(join(tmp, 'public'), join(tmp, 'public/components'), join(tmp, 'public'));
  // page.html becomes the page's root import; index.html is the app shell.
  writeFileSync(join(tmp, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>relocation fixture</title></head>
<body>
<div import="components/page"></div>
<script type="module" src="/src/main.js"></script>
</body></html>
`);
  mkdirSync(join(tmp, 'src'), { recursive: true });
  writeFileSync(join(tmp, 'src/main.js'), `import { mount } from 'spark-html';\nmount();\n`);

  const deps = { 'spark-html': '*' };
  const devDeps = { 'spark-html-bun': '*' };
  if (MODE === 'prerender') {
    devDeps['spark-prerender'] = '*';
    writeFileSync(join(tmp, 'spark.config.js'), `import prerender from 'spark-prerender/bun';\nexport default { pipeline: [prerender({ pages: ['index.html'] })] };\n`);
  }
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({
    name: 'relocation-fixture-' + MODE, private: true, version: '0.0.0', type: 'module',
    scripts: { dev: 'spark dev', build: 'spark build', preview: 'spark preview' },
    dependencies: deps, devDependencies: devDeps,
  }, null, 2) + '\n');

  await $async('bun', ['install', '--no-save'], { cwd: tmp });
  if (MODE === 'prerender') {
    await $async('bun', ['run', 'build'], { cwd: tmp });
    serverArgs = ['x', 'spark', 'preview', '--port', String(PORT), '--strict-port'];
  } else {
    // client: dev server, no build step — sidesteps whatever's on the
    // registry, always exercises the local workspace source directly.
    serverArgs = ['x', 'spark', 'dev', '--port', String(PORT)];
  }
} else {
  // ssr — pages/page.html IS the route; no auth/db configured, so no secret
  // is required even though spark-ssr start runs production mode.
  placePage(tmp, join(tmp, 'pages'), join(tmp, 'public'));
  cpSync(join(tmp, 'pages/page.html'), join(tmp, 'pages/index.html'));
  // The page's <spark-ssr> module source (relocMarker) — SSR-only, gives
  // the page a non-empty data-source plan so it hydrates instead of running
  // its script on the server (see reloc-source.js's own comment).
  mkdirSync(join(tmp, 'lib'), { recursive: true });
  cpSync(join(SHARED, 'reloc-source.js'), join(tmp, 'lib/reloc-source.js'));
  writeFileSync(join(tmp, 'spark.json'), JSON.stringify({}, null, 2) + '\n');
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({
    name: 'relocation-fixture-ssr', private: true, version: '0.0.0', type: 'module',
    dependencies: { 'spark-html': '*', 'spark-ssr': '*' },
  }, null, 2) + '\n');

  await $async('bun', ['install', '--no-save'], { cwd: tmp });
  serverArgs = ['x', 'spark-ssr', 'start', '--port', String(PORT)];
}

console.log(`[relocation] starting ${MODE} server on :${PORT}…`);
const server = spawn('bun', serverArgs, { cwd: tmp, stdio: ['ignore', 'inherit', 'inherit'], env: serverEnv });

function shutdown() {
  server.kill('SIGTERM');
  setTimeout(() => rmSync(tmp, { recursive: true, force: true }), 500);
}
server.on('exit', (code) => console.log(`[relocation] ${MODE} server exited (code ${code})`));
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('SIGINT', () => { shutdown(); process.exit(0); });

await new Promise(() => {});
