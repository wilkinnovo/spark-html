# ⚡ spark-html-websocket

Declarative WebSocket for [spark-html](https://www.npmjs.com/package/spark-html)
— a live connection as a **reactive store**, with auto-reconnect, JSON
parsing, status, and `send()`. Zero dependencies. No more hand-rolled
connect/reconnect/parse/cleanup boilerplate in `onMount`.

```js
import { ws } from 'spark-html-websocket';
ws('wss://stream.example.com/prices', { name: 'prices' });
```

```html
<!-- any component -->
<p :hidden="prices.status !== 'open'">● live</p>
<h1>{prices.data?.btc}</h1>
<button onclick="{() => prices.send({ subscribe: 'btc' })}">Subscribe</button>
<script>
  const prices = useStore('prices');
</script>
```

Or fully declarative, the way the router declares routes:

```html
<template ws="wss://stream.example.com/prices" store="prices"></template>
<script type="module">
  import { sockets } from 'spark-html-websocket';
  sockets();
</script>
```

## Install

```bash
npm install spark-html-websocket
```

## The store

| Key | Meaning |
|-----|---------|
| `data` | The last (post-filter) message — JSON-parsed when it looks like JSON. Survives reconnects. |
| `status` | `'connecting'` · `'open'` · `'closed'` · `'error'` |
| `error` | The last connection error, `null` when healthy. |
| `send(v)` | Send a message; objects are stringified. Queued until the socket opens. |
| `close()` | Deliberate close — never reconnects. |
| `open()` | Re-open after a `close()` (or exhausted retries). |

## Options

```js
ws('wss://x.dev/feed', {
  name: 'feed',                          // store name (default "ws:x.dev/feed")
  json: true,                            // parse messages as JSON when possible
  filter: (d) => d.type === 'ticker',    // only these land in `data`
  onMessage: (d) => { store('candles').list.push(d); }, // feed ANY store
  reconnect: { retries: Infinity, base: 500, max: 10000 }, // backoff (ms); false disables
  protocols: ['v1'],
});
```

- **Auto-reconnect** — a dropped connection retries with exponential backoff
  (`base·2ⁿ` capped at `max`); `data` keeps rendering through the gap.
- **Shared handles** — `ws()` with the same name returns the existing store;
  two components never open two sockets.
- **Prerender-safe** — during `spark-prerender` builds (or anywhere
  `WebSocket` doesn't exist) the store is created inert with
  `status: 'closed'`, so components render their fallback and the build never
  hangs. No guard needed.

Declarative attributes: `ws` (url), `store` (name), `raw` (skip JSON),
`retries` / `backoff` / `backoff-max` (reconnect tuning, ms).
