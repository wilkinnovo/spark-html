# ⚡ spark-html-head

Reactive document `<title>` and `<meta>` per route for
[spark-html](https://www.npmjs.com/package/spark-html) — one line. Pairs with
[`spark-html-router`](https://www.npmjs.com/package/spark-html-router)
(or any pushState router): it hooks the History API + `popstate`, so the head
updates on every navigation with no wiring.

```js
import { head } from 'spark-html-head';

head({
  title: { '/': 'Home', '/about': 'About', '*': 'Not found' },
  titleTemplate: (t) => `${t} · My Site`,
  meta: { description: (path) => `The ${path} page` },
});
```

## Install

```bash
bun add spark-html-head
```

## Options

| Option | Type | Meaning |
|--------|------|---------|
| `title` | `string` \| `(path) => string` \| `{ [path]: string }` | The document title. A map may include an `'*'` fallback. |
| `titleTemplate` | `(title) => string` | Wrap the resolved title, e.g. `` t => `${t} · Site` ``. |
| `meta` | `{ [key]: string \| (path) => string }` | `<meta>` to keep updated. Key `"description"` → `<meta name>`; a key with a colon (`"og:title"`) → `<meta property>`. |
| `base` | `string` | Path prefix stripped before matching (e.g. `"/spark"`). |

`head()` returns a `stop()` function. It's framework-agnostic — works with any
router that uses `history.pushState`.

## Per-component metadata — the `head` store

For data-driven pages (CMS, DB), the component that already holds the data
sets its own metadata reactively — no giant `path → title` map in main.js:

```html
<script>
  const route = useStore('route');
  const head = useStore('head');
  let project;
  $: project = projects.all.find((p) => p.slug === route.params.slug);
  $: head.title = project ? `${project.name} · Novo` : 'Novo — 404';
  $: head.description = project?.description;
</script>
```

- `head.title` overrides the config title **verbatim** (`titleTemplate` is not
  re-applied — the component composes the final string).
- Any other key is a `<meta>` override or addition (`description`,
  `og:title`, …), same name/property rules as the config.
- Overrides are **cleared on every path change**, so the next route falls back
  to your `head()` config until its component writes its own values.

> For build-time SEO, declare `pageTitle`/`pageDescription` as component state so
> [`spark-prerender`](https://www.npmjs.com/package/spark-prerender) bakes them
> per route; `head()` handles the live client-side updates on SPA navigation.

## The Spark family

Small, single-purpose packages that share one philosophy: no compiler, no
virtual DOM, no build step required. Add only what you use.

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
