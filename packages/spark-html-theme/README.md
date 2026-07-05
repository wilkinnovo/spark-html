# ⚡ spark-html-theme

One-line dark / light / system theming for [spark-html](https://www.npmjs.com/package/spark-html).
Creates a reactive `theme` store, applies a `data-theme` attribute to `<html>`,
follows the OS preference, and remembers the choice — no boilerplate.

```js
// main.js
import { theme } from 'spark-html-theme';
theme();                 // that's it
```

```html
<!-- components/theme-toggle.html -->
<button onclick="{theme.toggle}">{theme.resolved}</button>

<script>
  const theme = useStore('theme');   // { mode, resolved, toggle, set }
</script>
```

Then style with the attribute:

```css
:root        { --bg: #fff; --text: #111; }
[data-theme="dark"] { --bg: #000; --text: #fff; }
body { background: var(--bg); color: var(--text); }
```

## Install

```bash
bun add spark-html-theme
```

## The `theme` store

| Field        | Meaning |
|--------------|---------|
| `mode`       | The user's choice: `'system'` \| `'light'` \| `'dark'`. |
| `resolved`   | What actually applies right now: `'light'` \| `'dark'`. |
| `toggle()`   | Flip the visible theme (light↔dark) — **always a visible change**. Best for a single toggle button. Persists. |
| `cycle()`    | Advance through `modes` (tri-state, includes `'system'`). Adjacent modes can look identical. Persists. |
| `set(mode)`  | Jump to a specific mode and persist. |

Both `mode` and `resolved` are reactive — read them in any component via
`useStore('theme')`.

## Options

```js
theme({
  key: 'theme-mode',                 // localStorage key
  attribute: 'data-theme',           // attribute written on <html>
  modes: ['system', 'light', 'dark'],// toggle() cycle order
  name: 'theme',                     // store name
});
```

## No flash of the wrong theme

A `type="module"` script runs after first paint, so the saved theme has to be
on `<html>` *before* the browser paints. If you build with
[`spark-html-bun`](https://www.npmjs.com/package/spark-html-bun), add the
pipeline step and it's handled automatically — in `spark dev` **and** in every
built page:

```js
// spark.config.js
import prerender from 'spark-prerender/bun';
import theme from 'spark-html-theme/bun';

export default {
  pipeline: [prerender(), theme()], // after prerender, so route pages get it too
};
```

Pass the same `key` / `attribute` you give `theme()` if you customized them:
`theme({ key: 'my-theme', attribute: 'data-mode' })`.

Without the pipeline, inline the script by hand — `themeInitScript()` returns
the exact string to drop into a `<script>` at the top of `<head>`:

```html
<script>
  document.documentElement.dataset.theme =
    (localStorage.getItem('theme-mode') === 'dark' ||
     ((localStorage.getItem('theme-mode') || 'system') === 'system' &&
      matchMedia('(prefers-color-scheme: dark)').matches)) ? 'dark' : 'light';
</script>
```

## Servers & pipelines: `spark-html-theme/init`

`themeInitScript()` (the inline no-flash snippet) is also exported from
`spark-html-theme/init` — a DOM-free module servers and build pipelines can
import without pulling in the client runtime. spark-ssr inlines it into every
page head automatically when your app depends on spark-html-theme;
`spark-html-theme/bun` bakes it at build time for prerendered sites.

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
| [`spark-ssr`](https://www.npmjs.com/package/spark-ssr) | Full-stack SSR on Bun — the template is the backend: inferred DB, REST CRUD, auth, live updates. Precompiled + response-cached: fast by default. |
| [`spark-html-image`](https://www.npmjs.com/package/spark-html-image) | Build-time image optimization — webp/avif + responsive `srcset`, zero config. |
| [`spark-html-font`](https://www.npmjs.com/package/spark-html-font) | Font loading optimizer — preload + size-adjusted fallbacks, no FOUT. |
| [`spark-html-manifest`](https://www.npmjs.com/package/spark-html-manifest) | PWA manifest + icons + head tags (and optional service worker) from one config. |
| [`spark-html-offline`](https://www.npmjs.com/package/spark-html-offline) | Offline URL imports — a service worker that caches CDN components. |
| [`spark-html-sri`](https://www.npmjs.com/package/spark-html-sri) | Subresource Integrity — hash + verify assets and remote components. |
| [`create-spark-html-app`](https://www.npmjs.com/package/create-spark-html-app) | Scaffold a spark-html app in one command. |
| [`prettier-plugin-spark`](https://www.npmjs.com/package/prettier-plugin-spark) | Prettier for components — formats `<script>`/`<style>`, markup stays byte-for-byte. |
| [`spark-html-language-server`](https://www.npmjs.com/package/spark-html-language-server) | LSP — diagnostics, go-to-definition, prop autocomplete, hover docs. |
