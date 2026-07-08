# ⚡ spark-html-manifest

PWA setup for [spark-html](https://www.npmjs.com/package/spark-html) sites
from a **single config** — a `spark-html-bun` build step that generates
`manifest.webmanifest`, resizes your icons from one source image, injects
the `<head>` tags, and (optionally) emits a minimal offline app-shell
service worker. No manual icon exports, no copy-paste boilerplate.

```js
// spark.config.js
import prerender from 'spark-prerender/bun';
import manifest from 'spark-html-manifest/bun';

export default {
  pipeline: [
    prerender(),
    manifest({
      name: 'My Spark App',
      shortName: 'Spark',
      themeColor: '#ffd24a',
      icon: 'public/icon.png', // one image → 192 + 512 png, resized with sharp
      offline: true,           // minimal offline app shell + auto registration
    }),
  ],
};
```

That's the whole setup. `bun run build` now produces:

- `manifest.webmanifest` — name, colors, display mode, icons
- `icons/spark-192.png`, `icons/spark-512.png` — resized from your source
- `<link rel="manifest">`, `<meta name="theme-color">`, apple-touch-icon —
  injected into **every** built page (after `spark-prerender` writes them)
- with `offline: true`: `spark-manifest-sw.js` + its registration script

In dev, the manifest and worker are served straight from config, so
Lighthouse/devtools "installable" checks pass locally too.

## Install

```bash
bun add spark-html-manifest
```

## Config

```js
manifest({
  name: 'My Spark App',        // required
  shortName: 'Spark',          // home-screen label (default: name)
  description: '…',
  themeColor: '#ffd24a',       // default '#ffffff'
  backgroundColor: '#000000',  // default: themeColor
  display: 'standalone',       // 'standalone' | 'browser' | 'minimal-ui' | 'fullscreen'
  startUrl: '.',
  icon: 'public/icon.png',     // source image (≥512px recommended)
  sizes: [192, 512],           // generated sizes
  icons: [{ src: '…' }],       // OR: explicit icons — skips generation
  filename: 'manifest.webmanifest',
  offline: { shell: ['./'], version: '1' }, // or just `true`
  extra: { shortcuts: [...] }, // merged verbatim into the manifest
});
```

## The offline worker

`offline: true` emits a deliberately small service worker:

- the **app shell** (`shell` URLs) is precached at install;
- the build's hash-named `/assets/…` files are **cache-first** (they're immutable);
- everything else same-origin is **network-first** with cache fallback — the
  app opens offline but is never a deploy behind while online;
- offline navigation to any route falls back to the shell.

Want offline **URL-imported components** (cross-origin CDN imports) instead
or as well? That's [spark-html-offline](https://www.npmjs.com/package/spark-html-offline) —
note a page registers one worker per scope, so pick the one that matches
your need (this one covers your own origin; spark-html-offline covers CDNs).

## Programmatic API

Everything the plugin does is exposed as pure functions:

| Export | Meaning |
|--------|---------|
| `manifestJson(config)` | The manifest object. |
| `manifestHtml(config, { href, sw })` | The `<head>` block as a string. |
| `swSource(options?)` | The app-shell worker source. |
| `iconPath(config, size)` | Generated icon file name. |
| `ICON_SIZES` | Default sizes (`[192, 512]`). |

`sharp` is imported lazily — if it can't load on your build machine, icons
are skipped with a warning and everything else still works.

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
