/**
 * spark-html-manifest — manifest generation, head tags, the app-shell
 * worker (run for real), and the vite plugin (emit + icons + injection).
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { manifestJson, manifestHtml, swSource, iconPath, ICON_SIZES } from '../src/index.js';
import sparkManifest from '../src/vite.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\nspark-html-manifest');

const config = { name: 'My Spark App', shortName: 'Spark', themeColor: '#ffd24a', description: 'demo' };

await test('manifestJson(): sensible defaults from one config', () => {
  const m = manifestJson(config);
  assert.equal(m.name, 'My Spark App');
  assert.equal(m.short_name, 'Spark');
  assert.equal(m.display, 'standalone', 'display default');
  assert.equal(m.start_url, '.', 'start_url default');
  assert.equal(m.theme_color, '#ffd24a');
  assert.equal(m.background_color, '#ffd24a', 'background falls back to theme');
  assert.deepEqual(m.icons.map((i) => i.sizes), ['192x192', '512x512'], 'default sizes');
  assert.equal(m.icons[0].src, 'icons/spark-192.png', 'icon path from short name');
  assert.throws(() => manifestJson({}), /name is required/, 'name required');
});

await test('manifestJson(): explicit icons, custom sizes, extra passthrough', () => {
  const explicit = manifestJson({ ...config, icons: [{ src: 'i.png', sizes: '48x48' }] });
  assert.equal(explicit.icons.length, 1, 'explicit icons win');
  const sized = manifestJson({ ...config, sizes: [64, 180] });
  assert.deepEqual(sized.icons.map((i) => i.sizes), ['64x64', '180x180']);
  const extra = manifestJson({ ...config, extra: { shortcuts: [{ name: 'New' }], display: 'browser' } });
  assert.equal(extra.display, 'browser', 'extra overrides');
  assert.equal(extra.shortcuts[0].name, 'New', 'extra merged');
});

await test('manifestHtml(): link + theme-color (+ apple icon, + sw registration)', () => {
  const html = manifestHtml(config, { href: 'manifest.webmanifest' });
  assert.ok(html.includes('<link rel="manifest" href="manifest.webmanifest" data-spark-manifest />'), 'link');
  assert.ok(html.includes('<meta name="theme-color" content="#ffd24a"'), 'theme color');
  assert.ok(html.includes('apple-touch-icon" href="icons/spark-512.png"'), 'largest icon as apple fallback');
  assert.ok(!html.includes('serviceWorker'), 'no registration without sw');
  const withSw = manifestHtml(config, { sw: 'spark-manifest-sw.js' });
  assert.ok(withSw.includes(`register('spark-manifest-sw.js')`), 'registration script');
});

await test('swSource(): valid standalone JS with shell + versioned cache baked in', () => {
  const src = swSource({ shell: ['./', 'offline.html'], version: '7' });
  assert.ok(src.includes('"spark-manifest-v7"'), 'versioned cache');
  assert.ok(src.includes('"offline.html"'), 'shell baked in');
  new Function(src); // must parse standalone
});

// Run the worker against a fake SW world (same harness style as spark-html-offline).
function makeSwWorld(src, origin = 'https://app.dev') {
  const listeners = {};
  const cacheStore = new Map();
  const cache = {
    addAll: async (urls) => { for (const u of urls) cacheStore.set(u, `precached:${u}`); },
    match: async (req, _opts) => cacheStore.get(typeof req === 'string' ? req : req.url) || undefined,
    put: async (req, res) => { cacheStore.set(req.url, res); },
  };
  const world = {
    fetch: null,
    Response: class {
      constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.ok = this.status < 300; }
      clone() { return this; }
    },
  };
  const self = {
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    location: { origin },
  };
  const caches = { open: async () => cache, keys: async () => ['spark-manifest-v0', 'other'], delete: async () => true };
  new Function('self', 'caches', 'fetch', 'Response', 'URL', src)
    .call(self, self, caches, (...a) => world.fetch(...a), world.Response, URL);
  return { listeners, cacheStore, world };
}

function fetchEvent(url, mode = 'no-cors') {
  let settle;
  const done = new Promise((r) => { settle = r; });
  return {
    request: { url, method: 'GET', mode },
    respondWith: (p) => Promise.resolve(p).then(settle),
    waitUntil: (p) => Promise.resolve(p).then(settle, settle),
    result: () => done,
  };
}

await test('worker: precaches the shell on install, falls back to it for offline navigation', async () => {
  const { listeners, cacheStore, world } = makeSwWorld(swSource());
  const inst = fetchEvent('');
  listeners.install({ waitUntil: inst.waitUntil });
  await inst.result();
  assert.ok(cacheStore.has('./'), 'shell precached');

  world.fetch = async () => { throw new Error('offline'); };
  const nav = fetchEvent('https://app.dev/deep/link', 'navigate');
  listeners.fetch(nav);
  assert.equal(await nav.result(), 'precached:./', 'offline navigation → app shell');
});

await test('worker: network-first keeps components fresh; cache serves them offline', async () => {
  const { listeners, cacheStore, world } = makeSwWorld(swSource());
  world.fetch = async () => new world.Response('fresh component');
  cacheStore.set('https://app.dev/components/nav.html', new world.Response('stale cached'));
  const ev = fetchEvent('https://app.dev/components/nav.html');
  listeners.fetch(ev);
  assert.equal((await ev.result()).body, 'fresh component', 'online → network wins even when cached');

  world.fetch = async () => { throw new Error('offline'); };
  const off = fetchEvent('https://app.dev/components/nav.html');
  listeners.fetch(off);
  assert.equal((await off.result()).body, 'fresh component', 'offline → last good copy');
});

await test('worker: hash-named assets are cache-first; cross-origin untouched', async () => {
  const { listeners, cacheStore, world } = makeSwWorld(swSource());
  cacheStore.set('https://app.dev/assets/index-CZV8Islq.js', new world.Response('cached asset'));
  let networkHits = 0;
  world.fetch = async () => { networkHits++; return new world.Response('from net'); };
  const ev = fetchEvent('https://app.dev/assets/index-CZV8Islq.js');
  listeners.fetch(ev);
  assert.equal((await ev.result()).body, 'cached asset', 'immutable asset from cache');
  assert.equal(networkHits, 0, 'no network for immutable hit');

  const cross = fetchEvent('https://esm.sh/card.html');
  let handled = false;
  cross.respondWith = () => { handled = true; };
  listeners.fetch(cross);
  assert.equal(handled, false, 'cross-origin passes through');
});

await test('vite plugin: emits manifest (+ worker), generates icons from one source image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-manifest-'));
  let sharp = null;
  try { sharp = (await import('sharp')).default; } catch { /* fine — icon half skipped */ }
  const iconSrc = join(dir, 'icon.png');
  if (sharp) {
    writeFileSync(iconSrc, await sharp({ create: { width: 600, height: 600, channels: 4, background: '#ffd24a' } }).png().toBuffer());
  }

  const emitted = [];
  const plugin = sparkManifest({ ...config, icon: sharp ? iconSrc : undefined, offline: true, sizes: [64, 128] });
  await plugin.generateBundle.call({ emitFile: (f) => emitted.push(f) });

  const manifest = emitted.find((f) => f.fileName === 'manifest.webmanifest');
  assert.ok(manifest, 'manifest emitted');
  assert.equal(JSON.parse(manifest.source).short_name, 'Spark');
  assert.ok(emitted.some((f) => f.fileName === 'spark-manifest-sw.js'), 'worker emitted');
  if (sharp) {
    const icon = emitted.find((f) => f.fileName === iconPath(config, 64));
    assert.ok(icon, 'icon emitted');
    const meta = await sharp(icon.source).metadata();
    assert.equal(meta.width, 64, 'resized to spec');
    assert.ok(emitted.some((f) => f.fileName === iconPath(config, 128)), 'every size generated');
  }
});

await test('vite plugin: injects head tags into built pages, skips fragments, idempotent', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'spark-manifest-dist-'));
  mkdirSync(join(dist, 'components'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>t</title></head><body></body></html>');
  writeFileSync(join(dist, 'components', 'card.html'), '<div>{x}</div>');

  const plugin = sparkManifest({ ...config, offline: true });
  plugin.configResolved({ build: { outDir: dist } });
  await plugin.closeBundle.handler();

  const page = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.ok(page.includes('rel="manifest"'), 'link injected');
  assert.ok(page.includes('theme-color'), 'meta injected');
  assert.ok(page.includes(`register('spark-manifest-sw.js')`), 'registration injected');
  assert.equal(readFileSync(join(dist, 'components', 'card.html'), 'utf8'), '<div>{x}</div>', 'fragment untouched');

  await plugin.closeBundle.handler();
  assert.equal(readFileSync(join(dist, 'index.html'), 'utf8'), page, 'idempotent');
});

await test('vite plugin dev: serves manifest + worker, transforms index.html', () => {
  const plugin = sparkManifest({ ...config, offline: true });
  let handler;
  plugin.configureServer({ middlewares: { use: (fn) => { handler = fn; } } });
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  handler({ url: '/manifest.webmanifest' }, res, () => { throw new Error('no fall-through'); });
  assert.equal(JSON.parse(res.body).name, 'My Spark App', 'manifest served in dev');
  handler({ url: '/spark-manifest-sw.js' }, res, () => { throw new Error('no fall-through'); });
  assert.ok(res.body.includes('spark-manifest-v1'), 'worker served in dev');
  let fell = false;
  handler({ url: '/index.html' }, res, () => { fell = true; });
  assert.ok(fell, 'other urls fall through');

  const html = plugin.transformIndexHtml('<html><head></head><body></body></html>');
  assert.ok(html.includes('rel="manifest"'), 'dev html transformed');
  assert.equal(plugin.transformIndexHtml(html), html, 'transform idempotent');
});

assert.deepEqual(ICON_SIZES, [192, 512], 'sanity: exported default sizes');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
