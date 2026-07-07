# ⚡ spark-html-offline

Offline-capable URL imports for [spark-html](https://www.npmjs.com/package/spark-html)
— a tiny service worker that caches `<div import="https://…">` components on
first fetch and serves them when the CDN is unreachable or the user is
offline. Zero dependencies.

It kills the #1 critique of CDN imports: **"CDN down = component gone."**
With the worker installed, a component imported by URL is served from cache
instantly on every visit after the first, and refreshed in the background —
users are never more than one visit behind, and never broken.

```js
// src/main.js — zero config
import { offline } from 'spark-html-offline';
offline();
```

```js
// spark.config.js — writes /spark-sw.js in build, serves it in dev
import offlineSw from 'spark-html-offline/bun';

export default { pipeline: [offlineSw()] };
```

```html
<!-- this now works on a plane -->
<div import="https://esm.sh/some-pkg/card.html"></div>
```

Works with any CDN — esm.sh, unpkg, jsdelivr, raw.githubusercontent, your own.

## Install

```bash
bun add spark-html-offline
```

## How it works

The worker intercepts **cross-origin GET requests only** (the CDN-import
case) with a cache-first, background-revalidate strategy:

1. **First visit** — fetched from the network, stored in the cache.
2. **Every visit after** — served from cache instantly; a background fetch
   refreshes the entry for next time.
3. **Network gone** — the cached copy is served; a URL never seen before
   answers `504`.

Same-origin requests are untouched by default, so dev servers, HMR, and your
own assets behave exactly as before.

## Options

```js
// spark.config.js
offlineSw({
  file: 'spark-sw.js',        // written worker file name
  include: ['/components/'],  // ALSO cache these same-origin paths
  exclude: ['/api/'],         // never touch these (substring match)
  cacheName: 'spark-offline-v1',
});
```

```js
// main.js
offline({
  sw: 'spark-sw.js',  // worker URL, relative to the page base
  scope: '/',         // registration scope
});
```

`offline()` no-ops safely wherever service workers don't exist — prerender
builds, old browsers, non-secure origins — your app runs exactly as before,
just without the safety net.

## No build step?

You don't need the build step. Generate the worker once and host it next to
`index.html`:

```js
// node make-sw.mjs > spark-sw.js
import { swSource } from 'spark-html-offline';
console.log(swSource({ include: ['/components/'] }));
```

Then call `offline()` from any `<script type="module">`.

## API

| Export | Meaning |
|--------|---------|
| `offline(options?)` | Register the worker. Returns the registration, or `null` where unsupported. |
| `swSource(options?)` | The full worker source as a string. |
| `shouldHandle(url, origin, config?)` | The matching rule the worker uses (exported for tests/tooling). |
| `CACHE_NAME` | Default cache bucket name (`'spark-offline-v1'`). |
| `spark-html-offline/bun` | Build step — writes the worker in build, serves it in dev. |

## The Spark family

Small, single-purpose packages that share one philosophy: no compiler, no
virtual DOM, no build step required — built for humans who love hand-writing
their web apps. Add only what you use.

| Package | What it does |
|---|---|
| [`spark-html`](https://www.npmjs.com/package/spark-html) | The runtime — components, reactivity, stores, forms, scoped styles. ~14.4 kB gzip, 0 deps. |
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
| [`spark-ssr`](https://www.npmjs.com/package/spark-ssr) | Full-stack SSR on Bun — the template is the backend: inferred DB, REST CRUD, auth, live updates. Precompiled + response-cached: fast by default. |
| [`spark-html-image`](https://www.npmjs.com/package/spark-html-image) | Build-time image optimization — webp/avif + responsive `srcset`, zero config. |
| [`spark-html-font`](https://www.npmjs.com/package/spark-html-font) | Font loading optimizer — preload + size-adjusted fallbacks, no FOUT. |
| [`spark-html-manifest`](https://www.npmjs.com/package/spark-html-manifest) | PWA manifest + icons + head tags (and optional service worker) from one config. |
| [`spark-html-offline`](https://www.npmjs.com/package/spark-html-offline) | Offline URL imports — a service worker that caches CDN components. |
| [`spark-html-sri`](https://www.npmjs.com/package/spark-html-sri) | Subresource Integrity — hash + verify assets and remote components. |
| [`create-spark-html-app`](https://www.npmjs.com/package/create-spark-html-app) | Scaffold a spark-html app in one command. |
| [`prettier-plugin-spark`](https://www.npmjs.com/package/prettier-plugin-spark) | Prettier for components — formats `<script>`/`<style>`, markup stays byte-for-byte. |
| [`spark-html-language-server`](https://www.npmjs.com/package/spark-html-language-server) | LSP — diagnostics, go-to-definition, prop autocomplete, hover docs. |

## License

MIT
