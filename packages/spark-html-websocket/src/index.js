/**
 * spark-html-websocket — declarative WebSocket as a reactive store.
 *
 * Every real-time app writes the same connect/reconnect/parse/cleanup
 * boilerplate in onMount. This turns a socket into a named store any
 * component reads with the `useStore` it already knows:
 *
 *   import { ws } from 'spark-html-websocket';
 *   ws('wss://stream.example.com/prices', { name: 'prices' });
 *
 *   // any component:
 *   //   <script>const prices = useStore('prices');</script>
 *   //   <p :hidden="prices.status !== 'open'">live</p>
 *   //   <h1>{prices.data?.btc}</h1>
 *   //   <button onclick="{() => prices.send({ subscribe: 'btc' })}">sub</button>
 *
 * Store shape: { data, status, error, send(v), close(), open() } where
 * status ∈ 'connecting' | 'open' | 'closed' | 'error'. Messages parse as
 * JSON when they look like it (raw string otherwise); objects passed to
 * send() are stringified.
 *
 * Auto-reconnect: a dropped connection retries with exponential backoff
 * (base·2ⁿ capped at max) until `retries` is exhausted; a deliberate
 * close() never reconnects. `data` survives reconnects — subscribers keep
 * rendering the last message during the gap.
 *
 * Declarative form — sockets() scans inert templates the same way the
 * router scans <template route>:
 *
 *   <template ws="wss://stream.example.com/prices" store="prices"></template>
 *   <script type="module">
 *     import { sockets } from 'spark-html-websocket';
 *     sockets();
 *   </script>
 *
 * Prerender-safe: at build time (or wherever WebSocket doesn't exist) the
 * store is created inert with status 'closed' — components render their
 * fallback state and nothing connects. Zero dependencies beyond spark-html.
 */
import { store } from 'spark-html';

// One live handle per store name — calling ws() twice with the same name
// (e.g. from two components) shares the connection instead of duplicating it.
const handles = new Map();

const DEFAULTS = { retries: Infinity, base: 500, max: 10000 };

// Derive a stable store name from the URL when none is given:
// "wss://x.dev/prices?k=1" → "ws:x.dev/prices"
function nameFor(url) {
  return 'ws:' + String(url).replace(/^[a-z]+:\/\//i, '').split(/[?#]/)[0].replace(/\/$/, '');
}

function parseMessage(raw, json) {
  if (!json || typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Open (or join) a reactive WebSocket store.
 *
 * @param {string} url  ws:// or wss:// endpoint.
 * @param {object} [options]
 * @param {string}   [options.name]     Store name (default derived from the URL).
 * @param {boolean}  [options.json=true] Parse incoming messages as JSON when possible.
 * @param {(data, event) => boolean} [options.filter]    Only messages passing this land in `data`.
 * @param {(data, event) => void}    [options.onMessage] Every (post-filter) message — write to any store you like.
 * @param {object}   [options.reconnect] { retries=Infinity, base=500, max=10000 } — backoff in ms; `false` disables.
 * @param {string[]} [options.protocols] WebSocket subprotocols.
 * @returns the reactive store proxy: { data, status, error, send, close, open }
 */
export function ws(url, options = {}) {
  const name = options.name || nameFor(url);
  if (handles.has(name)) return handles.get(name);

  const json = options.json !== false;
  const backoff = options.reconnect === false
    ? { ...DEFAULTS, retries: 0 }
    : { ...DEFAULTS, ...(options.reconnect || {}) };

  const s = store(name, { data: null, status: 'connecting', error: null });
  // Tag for tooling (spark-html-devtools) — non-enumerable, never in dumps.
  try {
    Object.defineProperty(s, Symbol.for('spark.storeKind'), { value: 'ws', configurable: true });
  } catch { /* ignore */ }

  let socket = null;
  let attempts = 0;
  let timer = null;
  let closed = false;   // a deliberate close() — never reconnect
  const queue = [];     // send() before open — flushed on connect

  // No WebSocket here (prerender / old Node): the store stays inert so
  // components render their fallback state and the build never hangs.
  const WS = typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : null;
  const inert = !WS || globalThis.__SPARK_PRERENDER__;

  function connect() {
    if (inert || closed) return;
    s.status = 'connecting'; // no-op write when already connecting (store dedupes)
    socket = options.protocols ? new WS(url, options.protocols) : new WS(url);
    socket.onopen = () => {
      attempts = 0;
      s.status = 'open';
      s.error = null;
      while (queue.length) socket.send(queue.shift());
    };
    socket.onmessage = (event) => {
      const data = parseMessage(event.data, json);
      if (options.filter && !options.filter(data, event)) return;
      if (options.onMessage) {
        try { options.onMessage(data, event); }
        catch (e) { console.warn(`[spark-ws] onMessage for "${name}" threw: ${e.message}`); }
      }
      s.data = data;
    };
    socket.onerror = (event) => {
      s.error = (event && event.error) || new Error('WebSocket error');
      s.status = 'error';
    };
    socket.onclose = () => {
      socket = null;
      if (closed) { s.status = 'closed'; return; }
      if (attempts >= backoff.retries) { s.status = 'closed'; return; }
      // Exponential backoff: base·2ⁿ capped at max.
      const delay = Math.min(backoff.base * 2 ** attempts, backoff.max);
      attempts++;
      s.status = 'connecting';
      timer = setTimeout(connect, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
    };
  }

  s.send = (value) => {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (socket && socket.readyState === 1) socket.send(raw);
    else queue.push(raw); // flushed when the (re)connect opens
  };
  s.close = () => {
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (socket) socket.close();
    else s.status = 'closed';
    handles.delete(name);
  };
  s.open = () => {
    if (!closed && (socket || timer)) return; // already live/scheduled
    closed = false;
    attempts = 0;
    s.status = 'connecting';
    connect();
  };

  if (inert) s.status = 'closed';
  else connect();

  handles.set(name, s);
  return s;
}

/**
 * Declarative form: open a socket per inert <template ws="…"> block.
 *
 *   <template ws="wss://x/prices" store="prices"></template>
 *
 * Attributes: `ws` (url), `store` (name), `raw` (skip JSON parsing),
 * `retries` / `backoff` / `backoff-max` (reconnect tuning, ms).
 * Returns the opened store proxies.
 */
export function sockets(root) {
  if (typeof document === 'undefined') return [];
  const scope = root || document;
  const out = [];
  for (const t of scope.querySelectorAll('template[ws]')) {
    const url = t.getAttribute('ws');
    if (!url) continue;
    const reconnect = {};
    if (t.hasAttribute('retries')) reconnect.retries = Number(t.getAttribute('retries'));
    if (t.hasAttribute('backoff')) reconnect.base = Number(t.getAttribute('backoff'));
    if (t.hasAttribute('backoff-max')) reconnect.max = Number(t.getAttribute('backoff-max'));
    out.push(ws(url, {
      name: t.getAttribute('store') || undefined,
      json: !t.hasAttribute('raw'),
      reconnect: Object.keys(reconnect).length ? reconnect : undefined,
    }));
  }
  return out;
}

export default { ws, sockets };
