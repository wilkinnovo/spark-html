/**
 * spark-html-bun — dev/build/preview against a real temp project. Runs under
 * `bun` (Bun.serve/Bun.build are the product); the root `npm test` chain
 * invokes it through scripts/test-bun.mjs, which skips when bun is absent.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { dev, build, preview, loadConfig } from '../src/index.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.stack || e.message}`); }
}

console.log('\nspark-html-bun');

// ── a minimal real project ──────────────────────────────────────────────
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'spark-bun-'));
  mkdirSync(join(root, 'public', 'components'), { recursive: true });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'index.html'),
    '<!doctype html>\n<html><head><title>t</title></head>' +
    '<body><div import="components/hello"></div>' +
    '<script type="module" src="/src/main.js"></script></body></html>');
  writeFileSync(join(root, 'src', 'main.js'), "console.log('app');\nexport {};");
  writeFileSync(join(root, 'public', 'components', 'hello.html'),
    '<h1>Hi {who}</h1>\n<script>let who = "bun";</script>');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'x', type: 'module', dependencies: { 'spark-html': '*' },
  }));
  // Symlink spark-html into the temp project so Bun can resolve it from
  // the import map builder. When the test runs from within the monorepo,
  // Bun.resolveSync('spark-html', <test-dir>) finds the repo's copy.
  try {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const src = Bun.resolveSync('spark-html', testDir);
    const nm = join(root, 'node_modules');
    mkdirSync(nm);
    symlinkSync(src, join(nm, 'spark-html'));
  } catch { /* non-monorepo — skip, tests may fail but won't throw setup errors */ }
  return root;
}

// ── config ──────────────────────────────────────────────────────────────
await test('loadConfig: defaults + spark.config.js + base normalization', async () => {
  const root = makeProject();
  writeFileSync(join(root, 'spark.config.js'),
    "export default { base: 'spark', pipeline: [{ name: 'x' }] };");
  const c = await loadConfig(root);
  assert.equal(c.base, '/spark/');
  assert.equal(c.outDir, 'dist');
  assert.equal(c.pipeline.length, 1);
});

// ── dev ─────────────────────────────────────────────────────────────────
const devRoot = makeProject();
const devServer = await dev({ root: devRoot, port: 0, quiet: true });
const D = `http://localhost:${devServer.port}`;

await test('dev: component fragments get Content-Type + no-cache, served raw', async () => {
  const res = await fetch(`${D}/components/hello.html`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const body = await res.text();
  assert.ok(body.includes('{who}'), 'fragment untouched (no injection)');
});

await test('dev: the page gets an import map + the HMR client', async () => {
  const res = await fetch(`${D}/`);
  const html = await res.text();
  assert.ok(html.includes('<script type="importmap">'), 'import map injected');
  // Mapped to the entry FILE (…/index.js), not the bare package dir — so a
  // package's own relative sibling import resolves under /@modules/<pkg>/.
  assert.ok(html.includes('"spark-html":"/@modules/spark-html/'), 'bare specifier mapped to its entry file');
  assert.ok(html.includes('/__spark_hmr'), 'HMR client injected');
  assert.ok(html.includes('<div import="components/hello">'), 'markup untouched');
});

await test('dev: /@modules/spark-html serves the resolved runtime as JS', async () => {
  const res = await fetch(`${D}/@modules/spark-html`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript');
  assert.ok((await res.text()).includes('function mount'), 'the real runtime');
});

await test('dev: /@modules/<pkg>/<file> serves sibling files (relative imports)', async () => {
  // A package entry that imports './sibling.js' resolves it to this URL form;
  // it must serve the file from inside the package dir, not 404.
  const res = await fetch(`${D}/@modules/spark-html/index.js`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('function mount'), 'entry served by file path');
});

await test('dev: extensionless paths fall back to the app shell (SPA)', async () => {
  const res = await fetch(`${D}/about`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('importmap'), 'index.html served');
});

await test('dev: editing a component broadcasts { name } over /__spark_hmr', async () => {
  const msg = await new Promise((resolveMsg, reject) => {
    const ws = new WebSocket(`ws://localhost:${devServer.port}/__spark_hmr`);
    const timer = setTimeout(() => reject(new Error('no HMR message within 5s')), 5000);
    ws.onopen = () => {
      // small delay so the subscription is live before the file changes
      setTimeout(() => {
        writeFileSync(join(devRoot, 'public', 'components', 'hello.html'),
          '<h1>Hi again {who}</h1>\n<script>let who = "bun";</script>');
      }, 100);
    };
    ws.onmessage = (ev) => { clearTimeout(timer); ws.close(); resolveMsg(JSON.parse(ev.data)); };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('ws error')); };
  });
  assert.equal(msg.name, 'hello');
});

// One WS listener per scenario: collect every message for `ms` after `fire()`.
function collectHmr(fire, ms = 700) {
  return new Promise((resolveMsgs, reject) => {
    const ws = new WebSocket(`ws://localhost:${devServer.port}/__spark_hmr`);
    const msgs = [];
    ws.onopen = () => {
      setTimeout(() => {
        fire();
        setTimeout(() => { ws.close(); resolveMsgs(msgs); }, ms);
      }, 100);
    };
    ws.onmessage = (ev) => msgs.push(JSON.parse(ev.data));
    ws.onerror = () => reject(new Error('ws error'));
  });
}

await test('dev: editing a stylesheet broadcasts { css } with its served URL', async () => {
  const msgs = await collectHmr(() => {
    writeFileSync(join(devRoot, 'src', 'style.css'), 'body { color: red; }');
  });
  assert.deepEqual(msgs, [{ css: '/src/style.css' }]);
});

await test('dev: editing the entry page broadcasts { reload: true }', async () => {
  const msgs = await collectHmr(() => {
    writeFileSync(join(devRoot, 'index.html'),
      readFileSync(join(devRoot, 'index.html'), 'utf8') + '<!-- edited -->');
  });
  assert.deepEqual(msgs, [{ reload: true }]);
});

await test('dev: rapid duplicate saves coalesce into one HMR message', async () => {
  const file = join(devRoot, 'public', 'components', 'hello.html');
  const msgs = await collectHmr(() => {
    // editor-style save: temp write + rename + rewrite, several events at once
    writeFileSync(file + '.tmp', '<h1>Yo {who}</h1>\n<script>let who = "bun";</script>');
    renameSync(file + '.tmp', file);
    writeFileSync(file, '<h1>Yo {who}</h1>\n<script>let who = "bun";</script>');
  });
  assert.deepEqual(msgs, [{ name: 'hello' }]);
});

await test('dev: encoded path traversal cannot escape the project root', async () => {
  const name = `spark-secret-${Date.now()}.txt`;
  const secret = join(devRoot, '..', name);
  writeFileSync(secret, 'TOP SECRET', 'utf8');
  try {
    // %2e%2e%2f = "../" — survives URL normalization, decoded on the server.
    const res = await fetch(`${D}/%2e%2e%2f${name}`);
    assert.equal(res.status, 404, 'traversal refused');
    assert.ok(!(await res.text()).includes('TOP SECRET'), 'file outside the root is never served');
  } finally { rmSync(secret, { force: true }); }
});

devServer.stop(true);

// ── build ───────────────────────────────────────────────────────────────
const buildRoot = makeProject();
const ran = [];
writeFileSync(join(buildRoot, 'spark.config.js'), 'export default {};');
await build({
  root: buildRoot, quiet: true,
  pipeline: [
    { name: 'a', run: (ctx) => ran.push(['a', ctx.outDir, ctx.base]) },
    { name: 'b', run: () => ran.push(['b']) },
  ],
});

await test('build: publicDir copied verbatim; entry bundled + rewritten', async () => {
  const dist = join(buildRoot, 'dist');
  assert.equal(readFileSync(join(dist, 'components', 'hello.html'), 'utf8'),
    readFileSync(join(buildRoot, 'public', 'components', 'hello.html'), 'utf8'),
    'component ships byte-for-byte');
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.ok(html.includes('<div import="components/hello">'), 'placeholder kept');
  assert.ok(!html.includes('/src/main.js'), 'entry script rewritten');
  assert.ok(/assets\/[\w-]+\.js/.test(html), 'hashed asset under assets/');
  const assets = readdirSync(join(dist, 'assets'));
  assert.ok(assets.some((f) => f.endsWith('.js')), 'bundle emitted');
});

await test('build: pipeline steps run in order with { outDir, base }', () => {
  assert.deepEqual(ran.map((r) => r[0]), ['a', 'b']);
  assert.equal(ran[0][1], join(buildRoot, 'dist'));
  assert.equal(ran[0][2], '/');
});

await test('build: base is honored via publicPath', async () => {
  const r = makeProject();
  await build({ root: r, base: '/spark/', quiet: true });
  const html = readFileSync(join(r, 'dist', 'index.html'), 'utf8');
  assert.ok(html.includes('src="/spark/assets/'), 'asset URLs carry the base');
});

await test('build: a URL that is a suffix of another entry URL is not corrupted', async () => {
  const r = mkdtempSync(join(tmpdir(), 'spark-bun-collide-'));
  mkdirSync(join(r, 'lib'));
  writeFileSync(join(r, 'app.js'), 'export const a = 1;');
  writeFileSync(join(r, 'lib', 'app.js'), 'export const b = 2;');
  // "/app.js" is a suffix of "/lib/app.js" — a bare replaceAll would mangle it.
  writeFileSync(join(r, 'index.html'),
    '<!doctype html><html><head></head><body>' +
    '<script type="module" src="/lib/app.js"></script>' +
    '<script type="module" src="/app.js"></script>' +
    '</body></html>');
  writeFileSync(join(r, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }));
  await build({ root: r, quiet: true });
  const html = readFileSync(join(r, 'dist', 'index.html'), 'utf8');
  assert.ok(!html.includes('/lib/assets/'), 'the /lib/ path was not mangled by a suffix match');
  const refs = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(refs.length, 2, 'both script srcs remain');
  assert.ok(refs.every((u) => /^\/assets\/app-\w+\.js$/.test(u)), 'both rewritten to hashed assets');
  assert.notEqual(refs[0], refs[1], 'each entry mapped to its own hashed file');
});

await test('build: the same file referenced twice maps both tags to one bundle', async () => {
  const r = mkdtempSync(join(tmpdir(), 'spark-bun-dup-'));
  writeFileSync(join(r, 'app.js'), 'export const a = 1;');
  writeFileSync(join(r, 'other.js'), 'export const b = 2;');
  // "/app.js" and "./app.js" resolve to the SAME file — Bun.build dedupes the
  // entrypoint, so index-based output mapping would splice other.js's bundle
  // into the second tag and leave /other.js unrewritten (a 404 in prod).
  writeFileSync(join(r, 'index.html'),
    '<!doctype html><html><head></head><body>' +
    '<script type="module" src="/app.js"></script>' +
    '<script type="module" src="./app.js"></script>' +
    '<script type="module" src="/other.js"></script>' +
    '</body></html>');
  writeFileSync(join(r, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }));
  await build({ root: r, quiet: true });
  const html = readFileSync(join(r, 'dist', 'index.html'), 'utf8');
  const refs = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(refs.length, 3, 'all three script srcs remain');
  assert.ok(refs.every((u) => /^\/assets\/[\w-]+\.js$/.test(u)), 'every tag rewritten to a hashed asset');
  assert.equal(refs[0], refs[1], 'both spellings of the same file share one bundle');
  assert.ok(/^\/assets\/other-[\w-]+\.js$/.test(refs[2]), 'the other entry keeps its own bundle');
});

await test("build: a companion package's own nested spark-html copy is deduped to the app's own", async () => {
  // Reproduces lockfile drift: `bun install` can leave a companion package
  // with its OWN nested node_modules/spark-html (its sub-dependency range
  // resolved/pinned to a DIFFERENT version at some earlier install, still
  // satisfying its own `^0.27.0` — no warning at install time) instead of
  // sharing the app's top-level copy. Each copy is a SEPARATE module with
  // its own top-level state (the real bug: `stores = new Map()` per copy —
  // theme()/ws() populate one copy's Map, but a component's ambient
  // useStore() — injected by whichever copy actually booted it — reads a
  // DIFFERENT, empty one: "store not created" for every companion package,
  // production-only, since dev mode's import map already coincidentally
  // routes every bare specifier through one canonical URL).
  const r = mkdtempSync(join(tmpdir(), 'spark-bun-dedupe-'));
  mkdirSync(join(r, 'node_modules', 'spark-html'), { recursive: true });
  writeFileSync(join(r, 'node_modules', 'spark-html', 'package.json'),
    JSON.stringify({ name: 'spark-html', version: '0.27.99', main: 'index.js', type: 'module' }));
  writeFileSync(join(r, 'node_modules', 'spark-html', 'index.js'),
    "export const MARK = 'TOP_LEVEL_COPY';\n");

  mkdirSync(join(r, 'node_modules', 'my-companion', 'node_modules', 'spark-html'), { recursive: true });
  writeFileSync(join(r, 'node_modules', 'my-companion', 'package.json'),
    JSON.stringify({ name: 'my-companion', version: '1.0.0', main: 'index.js', type: 'module' }));
  writeFileSync(join(r, 'node_modules', 'my-companion', 'index.js'),
    "export { MARK as companionMark } from 'spark-html';\n");
  writeFileSync(join(r, 'node_modules', 'my-companion', 'node_modules', 'spark-html', 'package.json'),
    JSON.stringify({ name: 'spark-html', version: '0.27.5', main: 'index.js', type: 'module' }));
  writeFileSync(join(r, 'node_modules', 'my-companion', 'node_modules', 'spark-html', 'index.js'),
    "export const MARK = 'NESTED_DUPLICATE_COPY';\n");

  writeFileSync(join(r, 'index.html'),
    '<!doctype html><html><head></head><body>' +
    '<script type="module" src="/src/main.js"></script></body></html>');
  mkdirSync(join(r, 'src'));
  writeFileSync(join(r, 'src', 'main.js'),
    "import { MARK } from 'spark-html';\nimport { companionMark } from 'my-companion';\nconsole.log(MARK, companionMark);\n");
  writeFileSync(join(r, 'package.json'), JSON.stringify({
    name: 'x', type: 'module', dependencies: { 'spark-html': '*', 'my-companion': '*' },
  }));

  await build({ root: r, quiet: true });
  const assetsDir = join(r, 'dist', 'assets');
  const jsFile = readdirSync(assetsDir).find((f) => f.endsWith('.js'));
  const bundled = readFileSync(join(assetsDir, jsFile), 'utf8');
  assert.ok(bundled.includes('TOP_LEVEL_COPY'), 'the app-level spark-html copy reaches the bundle');
  assert.ok(!bundled.includes('NESTED_DUPLICATE_COPY'),
    "the companion package's own nested copy must NOT be separately bundled — both must share one module instance");
});

// ── preview ─────────────────────────────────────────────────────────────
writeFileSync(join(buildRoot, 'dist', 'about.html'), '<h1>about</h1>');
writeFileSync(join(buildRoot, 'dist', '404.html'), '<h1>nope</h1>');
const previewServer = await preview({ root: buildRoot, port: 0, quiet: true });
const P = `http://localhost:${previewServer.port}`;

await test('preview: / serves index.html; /about serves about.html (redirects convention)', async () => {
  assert.ok((await (await fetch(`${P}/`)).text()).includes('import="components/hello"'));
  assert.equal(await (await fetch(`${P}/about`)).text(), '<h1>about</h1>');
});

await test('preview: unknown paths serve 404.html with status 404', async () => {
  const res = await fetch(`${P}/definitely-not-a-page`);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), '<h1>nope</h1>');
});

previewServer.stop(true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
