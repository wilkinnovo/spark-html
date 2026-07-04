/**
 * spark-html-offline — URL matching, worker generation, registration,
 * the worker's fetch strategy (run for real), and the spark-html-bun step.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldHandle, swSource, offline, CACHE_NAME } from '../src/index.js';
import sparkOffline from '../src/bun.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\nspark-html-offline');

const ORIGIN = 'https://myapp.dev';

await test('shouldHandle: cross-origin http(s) is cached, everything else is not', () => {
  assert.equal(shouldHandle('https://esm.sh/spark-card/card.html', ORIGIN), true, 'CDN import');
  assert.equal(shouldHandle('https://unpkg.com/x/y.js', ORIGIN), true, 'any CDN');
  assert.equal(shouldHandle(`${ORIGIN}/components/nav.html`, ORIGIN), false, 'same-origin off by default');
  assert.equal(shouldHandle('chrome-extension://abc/x.js', ORIGIN), false, 'non-http scheme');
  assert.equal(shouldHandle('not a url', ORIGIN), false, 'garbage');
});

await test('shouldHandle: include opts same-origin paths in, exclude always wins', () => {
  const cfg = { include: ['/components/'], exclude: ['/api/'] };
  assert.equal(shouldHandle(`${ORIGIN}/components/nav.html`, ORIGIN, cfg), true, 'included fragment');
  assert.equal(shouldHandle(`${ORIGIN}/main.js`, ORIGIN, cfg), false, 'not included');
  assert.equal(shouldHandle('https://cdn.dev/api/data', ORIGIN, cfg), false, 'exclude beats cross-origin');
});

await test('swSource() embeds config, cache name, and the matcher', () => {
  const src = swSource({ include: ['/components/'], cacheName: 'my-cache' });
  assert.ok(src.includes('"my-cache"'), 'custom cache name');
  assert.ok(src.includes('"/components/"'), 'include config baked in');
  assert.ok(src.includes('function shouldHandle'), 'matcher embedded');
  assert.ok(swSource().includes(CACHE_NAME), 'default cache name');
  // The generated file must be valid standalone JS.
  new Function(swSource());
});

// ── run the generated worker for real against a fake SW environment ────
function makeSwWorld(src) {
  const listeners = {};
  const cacheStore = new Map();
  const cache = {
    match: async (req) => cacheStore.get(req.url) || undefined,
    put: async (req, res) => { cacheStore.set(req.url, res); },
  };
  const world = {
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => {},
      clients: { claim: async () => {} },
      location: { origin: ORIGIN },
    },
    caches: { open: async () => cache },
    fetch: null, // set per test
    Response: class {
      constructor(body, init = {}) {
        this.body = body;
        this.status = init.status ?? 200;
        this.ok = this.status < 300;
        const h = new Map(Object.entries(init.headers || {}));
        this.headers = { get: (k) => h.get(k) ?? null };
      }
      clone() { return this; }
    },
    console,
  };
  new Function('self', 'caches', 'fetch', 'Response', 'console', src)
    .call(world.self, world.self, world.caches, (...a) => world.fetch(...a), world.Response, console);
  return { listeners, cacheStore, world };
}

function fetchEvent(url) {
  let responded, settle;
  const done = new Promise((r) => { settle = r; });
  const waits = [];
  return {
    request: { url, method: 'GET' },
    respondWith: (p) => { responded = Promise.resolve(p).then((r) => { settle(r); return r; }); },
    waitUntil: (p) => waits.push(p),
    result: () => done,
    waits,
    get handled() { return !!responded; },
  };
}

await test('worker: first fetch goes to network and is cached', async () => {
  const { listeners, cacheStore, world } = makeSwWorld(swSource());
  world.fetch = async (req) => new world.Response('component html', { status: 200 });
  const ev = fetchEvent('https://esm.sh/card.html');
  listeners.fetch(ev);
  assert.ok(ev.handled, 'intercepted');
  const res = await ev.result();
  assert.equal(res.body, 'component html', 'network response returned');
  assert.ok(cacheStore.has('https://esm.sh/card.html'), 'stored in cache');
});

await test('worker: cached entry served instantly, refreshed in background', async () => {
  const { listeners, cacheStore, world } = makeSwWorld(swSource());
  cacheStore.set('https://esm.sh/card.html', new world.Response('old cached'));
  world.fetch = async () => new world.Response('fresh from cdn');
  const ev = fetchEvent('https://esm.sh/card.html');
  listeners.fetch(ev);
  const res = await ev.result();
  assert.equal(res.body, 'old cached', 'cache-first');
  assert.equal(ev.waits.length, 1, 'refresh kept alive via waitUntil');
  await Promise.all(ev.waits);
  assert.equal(cacheStore.get('https://esm.sh/card.html').body, 'fresh from cdn', 'background refresh landed');
});

await test('worker: CDN down + cached → served; CDN down + never cached → 504', async () => {
  const { listeners, cacheStore, world } = makeSwWorld(swSource());
  world.fetch = async () => { throw new Error('ECONNREFUSED'); };
  cacheStore.set('https://esm.sh/cached.html', new world.Response('survives'));
  const hit = fetchEvent('https://esm.sh/cached.html');
  listeners.fetch(hit);
  assert.equal((await hit.result()).body, 'survives', 'offline hit served from cache');
  const miss = fetchEvent('https://esm.sh/never-seen.html');
  listeners.fetch(miss);
  assert.equal((await miss.result()).status, 504, 'offline miss is an honest 504');
});

await test('worker: same-origin and non-GET requests pass through untouched', () => {
  const { listeners } = makeSwWorld(swSource());
  const local = fetchEvent(`${ORIGIN}/src/main.js`);
  listeners.fetch(local);
  assert.equal(local.handled, false, 'local file ignored');
  const post = fetchEvent('https://esm.sh/x.html');
  post.request.method = 'POST';
  listeners.fetch(post);
  assert.equal(post.handled, false, 'POST ignored');
});

await test('offline(): registers the worker; no-ops without serviceWorker', async () => {
  assert.equal(await offline(), null, 'no serviceWorker → null, no throw');
  const calls = [];
  const sw = { register: async (url, opts) => { calls.push([url, opts]); return { scope: '/' }; } };
  // Node ships a global `navigator` getter — replace it wholesale for the test.
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: sw }, configurable: true });
  const reg = await offline();
  assert.ok(reg, 'registration returned');
  assert.deepEqual(calls[0], ['spark-sw.js', undefined], 'default relative url');
  await offline({ sw: '/custom-sw.js', scope: '/app/' });
  assert.deepEqual(calls[1], ['/custom-sw.js', { scope: '/app/' }], 'options honored');
  sw.register = async () => { throw new Error('insecure origin'); };
  assert.equal(await offline(), null, 'registration failure → null, warn only');
  delete globalThis.navigator;
});

await test('worker: skips /__spark/ channels; streams and no-store never cached', async () => {
  const { listeners, cacheStore, world } = makeSwWorld(swSource({ include: ['/'] }));
  const sse = fetchEvent(`${ORIGIN}/__spark/reload`);
  listeners.fetch(sse);
  assert.equal(sse.handled, false, 'SSE channel passes straight through');

  world.fetch = async () => new world.Response('stream', { headers: { 'content-type': 'text/event-stream' } });
  const ev = fetchEvent(`${ORIGIN}/events`);
  listeners.fetch(ev);
  assert.equal((await ev.result()).body, 'stream', 'response still served');
  assert.ok(!cacheStore.has(`${ORIGIN}/events`), 'event-stream not cached');

  world.fetch = async () => new world.Response('fresh', { headers: { 'cache-control': 'no-store' } });
  const ns = fetchEvent(`${ORIGIN}/volatile.json`);
  listeners.fetch(ns);
  assert.equal((await ns.result()).body, 'fresh');
  assert.ok(!cacheStore.has(`${ORIGIN}/volatile.json`), 'no-store honored');
});

await test('bun step: writes the worker in build, serves it in dev', async () => {
  const step = sparkOffline({ include: ['/components/'] });
  const dir = mkdtempSync(join(tmpdir(), 'spark-offline-'));
  await step.run({ outDir: dir });
  const source = readFileSync(join(dir, 'spark-sw.js'), 'utf8');
  assert.ok(source.includes('"/components/"'), 'config flows into the written worker');

  const routes = step.devRoutes();
  assert.ok(routes['/spark-sw.js'], 'dev route registered under the worker path');
  assert.equal(routes['/spark-sw.js'].type, 'text/javascript');
  assert.equal(routes['/spark-sw.js'].body(), source, 'dev serves the same source');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
