# ⚡ spark-html-sri

Subresource Integrity for [spark-html](https://www.npmjs.com/package/spark-html)
— auto-hash every built asset **and** verify URL-imported components at
runtime. Same mental model as `<script integrity>`, applied to the whole
app. Zero dependencies, zero bytes added to the spark-html core.

```js
// src/main.js — before mount()/router()
import { sri } from 'spark-html-sri';
sri();
```

```js
// spark.config.js — sri() runs last, after prerender()
import prerender from 'spark-prerender/bun';
import sriPlugin from 'spark-html-sri/bun';

export default { pipeline: [prerender(), sriPlugin()] };
```

## Install

```bash
bun add spark-html-sri
```

## What you get

**Local files — fully automatic, zero config.** At build time the build
step hashes every JS/CSS file and every component fragment (SHA-384 by
default), stamps `integrity` + `crossorigin="anonymous"` onto the
`<script>`/`<link>` tags (the browser enforces those natively), and bakes
a path → hash manifest into each page. At runtime `sri()` verifies every
component fetch against that manifest before spark-html boots it. A
tampered file — a compromised host, a poisoned cache — is rejected with a
clear console error instead of running.

**Remote URL imports** (`<div import="https://…">`) — **allow list + TOFU.**
Only whitelisted origins can be imported at all:

```js
sri({
  allow: ['cdn.jsdelivr.net', 'unpkg.com', 'esm.sh', 'raw.githubusercontent.com'], // the default
});
```

For allowed origins, integrity is verified via **trust on first use**: the
first fetch stores the content hash (in `localStorage`), and every later
load must hash the same. A CDN compromised *after* your first visit serves
bytes that no longer match — the component is blocked before it runs.
Import pinned URLs (`…@1.2.3/card.html`) so legitimate updates are new
URLs; if you import a mutable URL and it changes on purpose, call
`resetTofu()` (or bump the URL).

**Your API calls are untouched.** Only same-origin paths present in the
build manifest and cross-origin `.html` component imports are governed —
every other fetch passes straight through.

## Dev vs production

`enforce: 'auto'` (the default) **fails open on localhost** — violations
warn in the console but nothing is blocked, so dev servers and HMR are
never in your way — and **enforces everywhere else**. Set `enforce: true`
or `false` to override.

## Options

```js
sri({
  manifest: { '/components/nav.html': 'sha384-…' }, // default: baked in by the build step
  allow: ['esm.sh'],          // remote hosts (subdomains included)
  enforce: 'auto',            // true | false | 'auto' (auto = enforce unless localhost)
  onViolation: (msg, url) => report(msg, url),
});
```

```js
sriPlugin({ algorithm: 'sha384' }); // 'sha256' | 'sha384' | 'sha512'
```

## API

| Export | Meaning |
|--------|---------|
| `sri(options?)` | Install the fetch guard. Returns a restore function. |
| `integrity(data, algo?)` | Compute an SRI string — `"sha384-…"`. |
| `verify(data, integrityString)` | Check data against an SRI string (space-separated list allowed). |
| `resetTofu()` | Forget every remembered remote-component hash. |
| `DEFAULT_ALLOW` | The default remote allow list. |
| `spark-html-sri/bun` | Build step — hash, stamp, bake the manifest. |

## Why not put this in the core?

The spark-html runtime has a frozen 15 kB budget. Verification lives here
instead, as an opt-in wrapper around `fetch` — projects that don't use SRI
pay zero bytes, and the core stays tiny.

## The Spark family

Small, single-purpose packages that share one philosophy: no compiler, no
virtual DOM, no build step required — built for humans who love hand-writing
their web apps. Add only what you use.

| Package | What it does |
|---|---|
| [`spark-html`](https://www.npmjs.com/package/spark-html) | The runtime — components, reactivity, stores, forms, scoped styles. ~14.6 kB gzip, 0 deps. |
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
