# ⚡ spark-html-font

Font loading optimizer for [spark-html](https://www.npmjs.com/package/spark-html)
sites — configure every font **once**, get the whole loading story: correct
`@font-face` + `font-display`, preload links, and a **size-adjusted fallback
face** so the swap doesn't shift the layout. Zero dependencies.

```js
// spark.config.js — bake into every built page
import prerender from 'spark-prerender/bun';
import font from 'spark-html-font/bun';

export default {
  pipeline: [prerender(), font({
    fonts: [
      { family: 'Inter', src: '/fonts/inter-var.woff2', weight: '100 900' },
      { family: 'Fira Code', google: true, weights: [400, 700] },
    ],
  })],
};
```

```css
body { font-family: var(--font-inter); }
code { font-family: var(--font-fira-code); }
```

What lands in `<head>` (before `</head>`, on every built page):

- `<link rel="preload" as="font">` per self-hosted file — the fetch starts
  with the HTML;
- an inline `<style>` with the `@font-face` rules (`font-display: swap` by
  default) **plus** an `"Inter Fallback"` face — `local("Arial")` with
  `size-adjust` / `ascent-override` / `descent-override` — so text set in the
  fallback occupies the same space as the real font: **no layout shift on
  swap**;
- for Google fonts: `preconnect` to both Google hosts + the `css2`
  stylesheet URL (no build-time network);
- a `--font-<slug>` CSS var per family with the full stack
  (`"Inter", "Inter Fallback", system-ui, sans-serif`).

Built-in approximate fallback metrics ship for popular families (Inter,
Roboto, Open Sans, Lato, Montserrat, Poppins, Nunito, Source Sans Pro);
pass `metrics: { sizeAdjust, ascent, descent, lineGap }` for anything else,
or `adjust: false` to skip the fallback face.

## Runtime form

No build step? Inject the same tags from main.js:

```js
import { fonts } from 'spark-html-font';
fonts({ fonts: [{ family: 'Inter', src: '/fonts/inter-var.woff2' }] });
```

Idempotent; returns a `stop()` that removes the tags.

## Install

```bash
npm install -D spark-html-font
```

## Options

| Option (per font) | Meaning |
|--------|---------|
| `family` | The font-family name. |
| `src` | Self-hosted file(s); format sniffed from the extension. |
| `google: true` | Google-hosted — emits preconnect + css2 stylesheet instead. |
| `weight` / `weights` | `400`, `"100 900"` (variable), or `[400, 700]` for Google. |
| `display` | `font-display` strategy, default `swap`. |
| `metrics` / `adjust` / `adjustFrom` | Fallback-face tuning (see above). |
| `preload` | Per-font preload toggle; also a top-level `preload` for all. |

Top-level: `fallback` — generic families appended to every var stack
(default `['system-ui', 'sans-serif']`).

## The Spark family

Small, single-purpose packages that share one philosophy: no compiler, no
virtual DOM, no build step required. Add only what you use.

| Package | What it does |
|---|---|
| [`spark-html`](https://www.npmjs.com/package/spark-html) | The runtime — components, reactivity, stores, forms, scoped styles. 13 kB gzip, 0 deps. |
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
