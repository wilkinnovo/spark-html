# create-spark-html-app

Scaffold a [Spark](https://github.com/wilkinnovo/spark) app in seconds — a Vite
project wired to `spark-html` with live, reactive **Spark** components.

## Usage

```bash
npm create spark-html-app@latest my-app
# or
npx create-spark-html-app my-app
```

Then:

```bash
cd my-app
npm install
npm run dev
```

Run it with no name to be prompted:

```bash
npm create spark-html-app@latest
```

## What you get

The scaffold comes with the **whole Spark ecosystem pre-wired** — you delete
what you don't need instead of wiring what you do:

| Always on | Optional (prompted) |
|-----------|---------------------|
| `spark-html` — the runtime | `spark-html-router` — multi-page SPA *(default yes)* |
| `spark-html-head` — reactive title/meta | `spark-html-theme` — dark/light toggle *(yes)* |
| `spark-html-persist` — localStorage store demo | `spark-html-image` — webp/avif + srcset at build *(yes)* |
| `spark-prerender` — SEO HTML + sitemap/robots | `spark-html-sri` — integrity checks *(yes)* |
| `spark-html-devtools` — dev-only inspector | `spark-html-manifest` — PWA manifest + icons + offline shell *(no)* |

Every included feature ships with a live demo component, ready to run.

Non-interactive? Pass flags instead of answering prompts:

```bash
npx create-spark-html-app my-app --yes       # accept the defaults
npx create-spark-html-app my-app --all       # everything on
npx create-spark-html-app my-app --minimal   # core only
npx create-spark-html-app my-app --pwa --no-image   # per-feature
```

Everything is plain HTML and JavaScript — no compiler, no virtual DOM, no
proprietary file format. Edit a component, save, and the page updates.

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
| [`create-spark-html-app`](https://www.npmjs.com/package/create-spark-html-app) | Scaffold a Vite + spark-html app in one command. |
| [`prettier-plugin-spark`](https://www.npmjs.com/package/prettier-plugin-spark) | Prettier for components — formats `<script>`/`<style>`, markup stays byte-for-byte. |
| [`spark-html-language-server`](https://www.npmjs.com/package/spark-html-language-server) | LSP — diagnostics, go-to-definition, prop autocomplete, hover docs. |

## License

MIT
