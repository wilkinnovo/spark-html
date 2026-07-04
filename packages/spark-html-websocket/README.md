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
bun add spark-html-websocket
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

## The Spark family

Small, single-purpose packages that share one philosophy: no compiler, no
virtual DOM, no build step required — built for humans who love hand-writing
their web apps. Add only what you use.

| Package | What it does |
|---|---|
| [`spark-html`](https://www.npmjs.com/package/spark-html) | The runtime — components, reactivity, stores, forms, scoped styles. 13 kB gzip, 0 deps. |
| [`spark-html-bun`](https://www.npmjs.com/package/spark-html-bun) | Dev server, bundler & preview on Bun — scoped HMR, no-build dev, post-build pipeline. |
| [`spark-html-router`](https://www.npmjs.com/package/spark-html-router) | `<template route>` routing — nested routes/layouts, `route.query`, active links. |
| [`spark-html-theme`](https://www.npmjs.com/package/spark-html-theme) | Dark/light/system theming in one line — persisted, no flash. |
| [`spark-html-head`](https://www.npmjs.com/package/spark-html-head) | Reactive `<title>`/`<meta>` per route + a `head` store. |
| [`spark-html-motion`](https://www.npmjs.com/package/spark-html-motion) | Enter/leave transitions on if/each blocks — `transition="fade|slide|scale"`. |
| [`spark-html-devtools`](https://www.npmjs.com/package/spark-html-devtools) | In-page devtools — live stores, component tree, patch activity. |
| [`spark-html-query`](https://www.npmjs.com/package/spark-html-query) | Declarative async data — a self-fetching store (`loading`/`error`/`data`/`refetch`). |
| [`spark-html-persist`](https://www.npmjs.com/package/spark-html-persist) | Persist stores to localStorage/sessionStorage in one line. |
| [`spark-html-websocket`](https://www.npmjs.com/package/spark-html-websocket) | A WebSocket as a reactive store — auto-reconnect, JSON, `send()`. |
| [`spark-prerender`](https://www.npmjs.com/package/spark-prerender) | Build-time SEO prerender + sitemap/robots — no SSR server. |
| [`spark-html-image`](https://www.npmjs.com/package/spark-html-image) | Build-time image optimization — webp/avif + responsive `srcset`, zero config. |
| [`spark-html-font`](https://www.npmjs.com/package/spark-html-font) | Font loading optimizer — preload + size-adjusted fallbacks, no FOUT. |
| [`spark-html-manifest`](https://www.npmjs.com/package/spark-html-manifest) | PWA manifest + icons + head tags (and optional service worker) from one config. |
| [`spark-html-offline`](https://www.npmjs.com/package/spark-html-offline) | Offline URL imports — a service worker that caches CDN components. |
| [`spark-html-sri`](https://www.npmjs.com/package/spark-html-sri) | Subresource Integrity — hash + verify assets and remote components. |
| [`create-spark-html-app`](https://www.npmjs.com/package/create-spark-html-app) | Scaffold a spark-html app in one command. |
| [`prettier-plugin-spark`](https://www.npmjs.com/package/prettier-plugin-spark) | Prettier for components — formats `<script>`/`<style>`, markup stays byte-for-byte. |
| [`spark-html-language-server`](https://www.npmjs.com/package/spark-html-language-server) | LSP — diagnostics, go-to-definition, prop autocomplete, hover docs. |
