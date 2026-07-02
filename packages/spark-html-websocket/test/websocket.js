/**
 * spark-html-websocket — reactive store over a (fake) WebSocket.
 * A controllable stub stands in for the platform WebSocket so connect,
 * status, JSON parsing, send-queueing, filters, reconnect/backoff, and
 * deliberate close are all assertable without a network.
 */
import '../../spark/test/dom-shim.js';
import { strict as assert } from 'node:assert';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ── controllable fake WebSocket ──
const instances = [];
class FakeWebSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    instances.push(this);
  }
  send(raw) { this.sent.push(raw); }
  close() { this.readyState = 3; this.onclose && this.onclose({}); }
  // test helpers
  _open() { this.readyState = 1; this.onopen && this.onopen({}); }
  _message(data) { this.onmessage && this.onmessage({ data }); }
  _drop() { this.readyState = 3; this.onclose && this.onclose({}); } // server-side drop
}
globalThis.WebSocket = FakeWebSocket;

const { ws, sockets } = await import('../src/index.js');
const { store } = await import('spark-html');

console.log('\nspark-html-websocket');

await test('ws() creates a reactive store, connecting immediately', () => {
  const prices = ws('wss://x.dev/prices', { name: 'prices' });
  assert.equal(prices.status, 'connecting');
  assert.equal(instances.length, 1);
  assert.equal(instances[0].url, 'wss://x.dev/prices');
  assert.equal(store('prices'), prices, 'reachable via useStore/store by name');
});

await test('open + JSON message land in status/data', () => {
  const prices = store('prices');
  instances[0]._open();
  assert.equal(prices.status, 'open');
  instances[0]._message('{"btc": 42000}');
  assert.equal(prices.data.btc, 42000, 'JSON parsed');
  instances[0]._message('plain text');
  assert.equal(prices.data, 'plain text', 'non-JSON falls back to the raw string');
});

await test('send() stringifies objects; pre-open sends are queued then flushed', () => {
  const prices = store('prices');
  prices.send({ subscribe: 'btc' });
  assert.deepEqual(instances[0].sent, ['{"subscribe":"btc"}']);
  // a second socket that hasn't opened yet queues
  const chat = ws('wss://x.dev/chat', { name: 'chat' });
  chat.send('hello');
  assert.equal(instances[1].sent.length, 0, 'not sent while connecting');
  instances[1]._open();
  assert.deepEqual(instances[1].sent, ['hello'], 'queue flushed on open');
});

await test('calling ws() again with the same name shares the handle (no second socket)', () => {
  const count = instances.length;
  const again = ws('wss://x.dev/prices', { name: 'prices' });
  assert.equal(again, store('prices'));
  assert.equal(instances.length, count, 'no new connection');
});

await test('the store name defaults to a URL-derived "ws:host/path"', () => {
  ws('wss://feed.example.com/v1/ticker?key=1');
  assert.ok(store('ws:feed.example.com/v1/ticker'), 'derived name registered');
});

await test('filter drops non-matching messages; onMessage feeds any store', () => {
  store('ticks', { count: 0 });
  ws('wss://x.dev/mixed', {
    name: 'mixed',
    filter: (d) => d && d.type === 'tick',
    onMessage: () => { store('ticks').count++; },
  });
  const sock = instances.at(-1);
  sock._open();
  sock._message('{"type":"noise"}');
  assert.equal(store('mixed').data, null, 'filtered out');
  assert.equal(store('ticks').count, 0);
  sock._message('{"type":"tick","v":7}');
  assert.equal(store('mixed').data.v, 7, 'matching message lands');
  assert.equal(store('ticks').count, 1, 'onMessage wrote to another store');
});

await test('a dropped connection reconnects with backoff, keeping last data', async () => {
  const live = ws('wss://x.dev/live', { name: 'live', reconnect: { base: 5, max: 20 } });
  const first = instances.at(-1);
  first._open();
  first._message('{"n":1}');
  const count = instances.length;
  first._drop(); // server-side drop, not a deliberate close
  assert.equal(live.status, 'connecting', 'reconnecting after a drop');
  assert.equal(live.data.n, 1, 'data survives the gap');
  await tick(15);
  assert.equal(instances.length, count + 1, 'a new socket was opened');
  instances.at(-1)._open();
  assert.equal(live.status, 'open', 'back online');
});

await test('retries are exhausted → status closed', async () => {
  ws('wss://x.dev/flaky', { name: 'flaky', reconnect: { retries: 1, base: 1 } });
  const a = instances.at(-1);
  a._drop();                 // attempt 1 scheduled
  await tick(10);
  const b = instances.at(-1);
  assert.notEqual(a, b, 'one retry happened');
  b._drop();                 // retries exhausted
  await tick(10);
  assert.equal(store('flaky').status, 'closed');
});

await test('close() is deliberate: no reconnect, status closed', async () => {
  const chat = store('chat');
  const count = instances.length;
  chat.close();
  await tick(10);
  assert.equal(chat.status, 'closed');
  assert.equal(instances.length, count, 'no reconnect after close()');
});

await test('open() after close() reconnects fresh', () => {
  const chat = store('chat');
  chat.open();
  assert.equal(chat.status, 'connecting');
  instances.at(-1)._open();
  assert.equal(chat.status, 'open');
});

// declarative form — needs the dom-shim's body
const shim = await import('../../spark/test/dom-shim.js');
await test('sockets() scans <template ws> and opens named stores', () => {
  shim.parseHTML(
    '<template ws="wss://x.dev/feed" store="feed" retries="2" backoff="5"></template>' +
    '<template ws="wss://x.dev/logs" raw></template>',
    shim.body,
  );
  const opened = sockets(shim.body);
  assert.equal(opened.length, 2);
  assert.equal(store('feed'), opened[0], 'store attribute names the store');
  instances.at(-1)._open();
  instances.at(-1)._message('{"a":1}');
  assert.equal(store('ws:x.dev/logs').data, '{"a":1}', 'raw attribute skips JSON parsing');
});

await test('without a WebSocket global (prerender), the store is inert + closed', async () => {
  delete globalThis.WebSocket;
  const inert = ws('wss://x.dev/never', { name: 'never' });
  assert.equal(inert.status, 'closed');
  inert.send('x'); // must not throw
  globalThis.WebSocket = FakeWebSocket;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
