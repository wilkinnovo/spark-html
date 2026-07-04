# ⚡ spark-html-image

Build-time image optimization for [spark-html](https://www.npmjs.com/package/spark-html)
sites — a `spark-html-bun` pipeline step that converts your `<img>` references
to **webp/avif** with a responsive `srcset`, **zero config**. No more
hand-written `scripts/optimize-images.js` wired into the build command.

```js
// spark.config.js
import prerender from 'spark-prerender/bun';
import image from 'spark-html-image/bun';

export default {
  pipeline: [prerender(), image()],
};
```

That's it. After the build, every local `.png`/`.jpg` referenced by an `<img>`
in the output — pages **and** component `.html` fragments — is:

- converted to webp at several widths (never upscaled past the original),
- rewritten with `srcset` + `sizes` (the original file stays as the `src`
  fallback),
- given `width`/`height` (no layout shift) and `loading="lazy"` +
  `decoding="async"` when absent.

```html
<img src="/img/hero.png" alt="hero">
<!-- becomes -->
<img src="/img/hero.png" alt="hero"
     srcset="/img/hero-640.webp 640w, /img/hero-960.webp 960w, /img/hero.webp 1600w"
     sizes="100vw" width="1600" height="900" loading="lazy" decoding="async">
```

External URLs, SVGs, and any `<img>` that already has a `srcset` (or sits in a
`<picture>`) are left alone — the author knows best.

## Install

```bash
bun add -d spark-html-image
```

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `widths` | `[640, 960, 1280, 1920]` | srcset widths, capped at each image's intrinsic width. |
| `formats` | `['webp']` | `'webp'` and/or `'avif'`; order = `<source>` order in picture mode. |
| `quality` | `80` | Encoder quality. |
| `sizes` | `'100vw'` | Written alongside `srcset` when the img has no `sizes`. |
| `picture` | `false` | Wrap in `<picture>` with one `<source>` per format (use with avif). |
| `lazy` | `true` | Add `loading="lazy"` + `decoding="async"` when absent. |

```js
image({ formats: ['avif', 'webp'], picture: true, quality: 75 })
```

It runs in `closeBundle` (order `post`), after
[`spark-prerender`](https://www.npmjs.com/package/spark-prerender) has written
its per-route HTML — so prerendered pages are optimized too. Conversion uses
[sharp](https://sharp.pixelplumbing.com/).

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
