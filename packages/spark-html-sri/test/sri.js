/**
 * spark-html-sri — hashing, verification, the runtime fetch guard
 * (manifest, allow list, TOFU), and the vite plugin's stamping pass.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { integrity, verify, sri, resetTofu, DEFAULT_ALLOW } from '../src/index.js';
import sparkSri from '../src/vite.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\nspark-html-sri');

const nodeSri = (data, algo = 'sha384') => `${algo}-${createHash(algo).update(data).digest('base64')}`;

// The runtime thinks it's on a production page; TOFU persists to localStorage.
const storage = new Map();
Object.defineProperty(globalThis, 'location', {
  value: { href: 'https://myapp.dev/', origin: 'https://myapp.dev', hostname: 'myapp.dev' },
  configurable: true,
});
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  configurable: true,
});

await test('integrity() matches node crypto across algorithms; verify() round-trips', async () => {
  for (const algo of ['sha256', 'sha384', 'sha512']) {
    assert.equal(await integrity('hello spark', algo), nodeSri('hello spark', algo), algo);
  }
  const h = await integrity('<div>{x}</div>');
  assert.equal(await verify('<div>{x}</div>', h), true, 'round trip');
  assert.equal(await verify('<div>{y}</div>', h), false, 'tamper detected');
  assert.equal(await verify('x', `sha999-bogus ${h}`.replace(h, await integrity('x'))), true, 'any token in a list passes');
  assert.equal(await verify('x', ''), false, 'empty integrity never passes');
});

// A controllable fetch: url → body (or a function).
function fakeFetch(routes) {
  const calls = [];
  const fn = async (input) => {
    // Resolve like a browser: relative inputs resolve against the page.
    const url = new URL(typeof input === 'string' ? input : input.url, 'https://myapp.dev/').href;
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'function' ? body() : body, { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

await test('same-origin: manifest paths verified, tampered content blocked, others untouched', async () => {
  const good = '<p>{count}</p>';
  const orig = fakeFetch({
    'https://myapp.dev/components/counter.html': good,
    'https://myapp.dev/components/evil.html': '<img onerror=steal()>',
    'https://myapp.dev/api/data': '{"ok":true}',
  });
  globalThis.fetch = orig;
  const off = sri({
    manifest: {
      '/components/counter.html': await integrity(good),
      '/components/evil.html': await integrity('<p>the original</p>'),
    },
  });
  const ok = await fetch('components/counter.html');
  assert.equal(await ok.text(), good, 'verified content flows through');
  const blocked = await fetch('/components/evil.html');
  assert.equal(blocked.status, 424, 'mismatch blocked');
  const api = await fetch('/api/data');
  assert.equal(await api.text(), '{"ok":true}', 'unlisted path untouched');
  off();
  assert.equal(globalThis.fetch, orig, 'off() restores fetch');
});

await test('remote imports: unknown origin rejected, allow list honors subdomains', async () => {
  resetTofu();
  globalThis.fetch = fakeFetch({
    'https://evil.example.com/card.html': 'gotcha',
    'https://cdn.jsdelivr.net/gh/x/card.html': '<b>{label}</b>',
    'https://evil.example.com/api.json': '{"fine":1}',
  });
  const violations = [];
  const off = sri({ onViolation: (m, u) => violations.push(u) });
  assert.equal((await fetch('https://evil.example.com/card.html')).status, 424, 'origin not allowed');
  assert.equal(violations.length, 1, 'violation observed');
  assert.equal((await fetch('https://cdn.jsdelivr.net/gh/x/card.html')).status, 200, 'default allow list');
  assert.equal(await (await fetch('https://evil.example.com/api.json')).text(), '{"fine":1}', 'non-.html cross-origin (APIs) untouched');
  off();
});

await test('remote imports: TOFU — first use trusted + persisted, silent change rejected', async () => {
  resetTofu();
  let body = '<b>v1 {label}</b>';
  globalThis.fetch = fakeFetch({ 'https://esm.sh/pkg/card.html': () => body });
  let off = sri({});
  assert.equal(await (await fetch('https://esm.sh/pkg/card.html')).text(), body, 'first fetch trusted');
  assert.equal(await (await fetch('https://esm.sh/pkg/card.html')).text(), body, 'same content keeps passing');
  off();

  // New page load (fresh sri()) — the hash came back from localStorage.
  body = '<b>compromised</b>';
  off = sri({});
  assert.equal((await fetch('https://esm.sh/pkg/card.html')).status, 424, 'changed content blocked across sessions');
  off();

  resetTofu();
  off = sri({});
  assert.equal((await fetch('https://esm.sh/pkg/card.html')).status, 200, 'resetTofu() re-trusts');
  off();
});

await test('enforce:false fails open — warns, observes, but never blocks', async () => {
  resetTofu();
  globalThis.fetch = fakeFetch({ 'https://evil.example.com/card.html': 'sketchy' });
  const violations = [];
  const off = sri({ enforce: false, onViolation: (m) => violations.push(m) });
  const res = await fetch('https://evil.example.com/card.html');
  assert.equal(await res.text(), 'sketchy', 'not blocked');
  assert.equal(violations.length, 1, 'still observed');
  off();
});

await test('vite plugin stamps integrity + crossorigin, bakes the manifest, skips remote tags', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'spark-sri-'));
  mkdirSync(join(dist, 'assets'));
  mkdirSync(join(dist, 'components'));
  const js = 'console.log("app")';
  const css = 'body{color:red}';
  const frag = '<div class="nav">{title}</div>';
  writeFileSync(join(dist, 'assets', 'index-abc.js'), js);
  writeFileSync(join(dist, 'assets', 'index-abc.css'), css);
  writeFileSync(join(dist, 'components', 'nav.html'), frag);
  writeFileSync(join(dist, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="/assets/index-abc.css" />' +
    '<script type="module" src="/assets/index-abc.js"></script>' +
    '<script src="https://example.com/remote.js"></script>' +
    '</head><body><div import="components/nav"></div></body></html>');

  const p = sparkSri();
  p.configResolved({ build: { outDir: dist }, base: '/' });
  await p.closeBundle.handler();

  const page = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.ok(page.includes(`src="/assets/index-abc.js" integrity="${nodeSri(js)}" crossorigin="anonymous"`), 'script stamped');
  assert.ok(page.includes(`integrity="${nodeSri(css)}"`), 'stylesheet stamped');
  assert.ok(!/remote\.js" integrity/.test(page), 'remote script left alone');
  const manifest = JSON.parse(page.match(/<script type="application\/json" data-spark-sri>(.*?)<\/script>/)[1]);
  assert.equal(manifest['/components/nav.html'], nodeSri(frag), 'fragment in manifest');
  assert.equal(manifest['/assets/index-abc.js'], nodeSri(js), 'asset in manifest');
  assert.ok(!('/index.html' in manifest), 'pages themselves are not manifest entries');
  assert.equal(readFileSync(join(dist, 'components', 'nav.html'), 'utf8'), frag, 'fragment untouched');

  await p.closeBundle.handler();
  assert.equal(readFileSync(join(dist, 'index.html'), 'utf8'), page, 'idempotent across runs');
});

await test('vite plugin honors a non-root base (GitHub Pages)', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'spark-sri-base-'));
  mkdirSync(join(dist, 'assets'));
  const js = 'export {}';
  writeFileSync(join(dist, 'assets', 'app.js'), js);
  writeFileSync(join(dist, 'index.html'),
    '<head><script type="module" src="/spark/assets/app.js"></script></head><body></body>');

  const p = sparkSri({ algorithm: 'sha512' });
  p.configResolved({ build: { outDir: dist }, base: '/spark/' });
  await p.closeBundle.handler();

  const page = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.ok(page.includes(`integrity="${nodeSri(js, 'sha512')}"`), 'base-prefixed href resolved + custom algorithm');
  const manifest = JSON.parse(page.match(/data-spark-sri>(.*?)<\/script>/)[1]);
  assert.ok('/spark/assets/app.js' in manifest, 'manifest keys carry the base');
});

await test('runtime + plugin agree end-to-end: the baked manifest verifies a real fetch', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'spark-sri-e2e-'));
  mkdirSync(join(dist, 'components'));
  const frag = '<h1>{msg}</h1>';
  writeFileSync(join(dist, 'components', 'hero.html'), frag);
  writeFileSync(join(dist, 'index.html'), '<head></head><body></body>');
  const p = sparkSri();
  p.configResolved({ build: { outDir: dist }, base: '/' });
  await p.closeBundle.handler();
  const manifest = JSON.parse(readFileSync(join(dist, 'index.html'), 'utf8').match(/data-spark-sri>(.*?)<\/script>/)[1]);

  globalThis.fetch = fakeFetch({
    'https://myapp.dev/components/hero.html': frag,
    'https://myapp.dev/components/hero2.html': frag + '<!-- tampered -->',
  });
  const off = sri({ manifest: { ...manifest, '/components/hero2.html': manifest['/components/hero.html'] } });
  assert.equal((await fetch('/components/hero.html')).status, 200, 'genuine fragment verifies');
  assert.equal((await fetch('/components/hero2.html')).status, 424, 'tampered fragment blocked');
  off();
});

assert.ok(DEFAULT_ALLOW.includes('esm.sh'), 'sanity: default allow list exported');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
