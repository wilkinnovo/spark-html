/**
 * spark-html-dev-tls — run under `bun` (Bun.serve/Bun.spawn are the product).
 * Wired into scripts/test-bun.mjs (skips cleanly when bun is absent).
 *
 * Covers: project auto-detection, and a full proxy round-trip over real TLS —
 * plain request + forwarded-proto header, a Server-Sent-Events stream, and a
 * WebSocket relay — the three things a spark dev server needs proxied.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectDev, startProxy } from '../src/index.js';
import { ensureCert } from '../src/cert.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.stack || e.message}`); }
}

console.log('\nspark-html-dev-tls');

await test('detectDev: spark.json / pages → spark-ssr; spark.config.js → spark-html-bun; else null', () => {
  const ssr = mkdtempSync(join(tmpdir(), 'devtls-ssr-'));
  writeFileSync(join(ssr, 'spark.json'), '{}');
  assert.deepEqual(detectDev(ssr), ['bun', 'spark-ssr']);

  const pages = mkdtempSync(join(tmpdir(), 'devtls-pg-'));
  mkdirSync(join(pages, 'pages'));
  assert.deepEqual(detectDev(pages), ['bun', 'spark-ssr']);

  const bun = mkdtempSync(join(tmpdir(), 'devtls-bun-'));
  writeFileSync(join(bun, 'spark.config.js'), 'export default {}');
  assert.deepEqual(detectDev(bun), ['bun', 'spark', 'dev']);

  const empty = mkdtempSync(join(tmpdir(), 'devtls-empty-'));
  assert.equal(detectDev(empty), null);
});

// openssl is on CI (ubuntu) and dev machines; skip the TLS round-trip if not.
const hasOpenssl = Bun.spawnSync(['openssl', 'version']).success;
await test('proxy round-trip over TLS: request + x-forwarded-proto, SSE, and WebSocket relay', async () => {
  if (!hasOpenssl) { console.log('     (openssl absent — skipping TLS round-trip)'); return; }

  // A stand-in dev server on a private HTTP port.
  const origin = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const u = new URL(req.url);
      if (u.pathname === '/sse') {
        return new Response(new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode('data: tick\n\n')); },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if ((req.headers.get('upgrade') || '').toLowerCase() === 'websocket') { if (srv.upgrade(req)) return; }
      return new Response('xfp=' + req.headers.get('x-forwarded-proto'));
    },
    websocket: { message(ws, m) { ws.send('echo:' + m); } },
  });

  const dir = mkdtempSync(join(tmpdir(), 'devtls-cert-'));
  const { cert, key } = await ensureCert({ dir, ips: [] });
  const proxy = startProxy({ port: 0, targetPort: origin.port, cert, key });
  const base = `https://127.0.0.1:${proxy.port}`;
  const tls = { tls: { rejectUnauthorized: false } };

  try {
    // 1. plain request carries the injected forwarded-proto to the origin.
    const body = await (await fetch(base + '/', tls)).text();
    assert.equal(body, 'xfp=https', 'x-forwarded-proto: https reaches the origin over TLS');

    // 2. an SSE frame streams through.
    const sse = await fetch(base + '/sse', tls);
    const reader = sse.body.getReader();
    const frame = new TextDecoder().decode((await reader.read()).value).trim();
    assert.equal(frame, 'data: tick', 'SSE frame proxied through TLS');
    await reader.cancel();

    // 3. a WebSocket echo relays through the proxy.
    const ws = new WebSocket(base.replace('https', 'wss') + '/__spark_hmr', { tls: { rejectUnauthorized: false } });
    const echoed = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no WS echo in 4s')), 4000);
      ws.onopen = () => ws.send('ping');
      ws.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('WS error')); };
    });
    assert.equal(echoed, 'echo:ping', 'WebSocket HMR relayed through TLS');
    ws.close();
  } finally {
    proxy.stop(true);
    origin.stop(true);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
