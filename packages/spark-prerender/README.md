# ⚡ spark-prerender

A friendly **SEO interface for [spark-html](https://www.npmjs.com/package/spark-html)** — make a client-rendered Spark site indexable by crawlers with **no rewrite, no SSR server, and no app-code changes**.

It is a build-time CLI. Point it at your entry HTML and it writes back fully-rendered, crawler-ready HTML: `{interpolations}` resolved, `each`/`if` and nested imports rendered, component `<style>` scoped and inlined, and page metadata injected into `<head>`.

## The one idea

This is **not a second renderer**. The Spark runtime is DOM-agnostic, so prerendering just:

> sets up a server DOM (linkedom) + the few globals the runtime expects → runs the **real** `mount()` → lets the component tree settle → serializes `document`.

One renderer, one source of truth, **zero client/prerender drift**.

## Install

```bash
npm install --save-dev spark-prerender
```

## Use

```bash
# one page or many (multi-page sites are an MPA — just list each page)
npx spark-prerender dist/index.html dist/docs.html

# write copies elsewhere instead of rewriting in place
npx spark-prerender site/index.html --out build --root site
```

As a post-build step over a Vite `dist/`:

```bash
vite build
npx spark-prerender dist/index.html dist/docs.html
```

### Vite plugin (auto on build)

Or let it run automatically as part of `vite build`:

```js
// vite.config.js
import spark from 'spark-html/vite';
import prerender from 'spark-prerender/vite';

export default {
  plugins: [
    spark(),
    prerender({ pages: ['index.html', 'docs.html'] }),
  ],
};
```

It runs in `closeBundle`, rewriting each page in place. A page that fails is
logged and skipped — the build still succeeds with the client-rendered HTML,
so it never breaks your build.

For a routed entry, `_redirects` is written into the build output dir (Netlify
reads it from the deployed output), but `vercel.json` is written to the
**project root** — Vercel reads its config from the repo root, not the build
output, so a copy under `dist/` would be silently ignored.

A routed entry also emits **`404.html`** automatically — GitHub Pages (and
most static hosts) serve it for unknown paths, so no manual generate-404 build
step is needed. It renders the app's `route="*"` catch-all (or the router's
built-in default 404 when none is declared). A `404.html` you ship yourself
(e.g. from `public/`) or a declared `/404` route always wins — the generated
one is skipped.

### sitemap.xml + robots.txt

Routed entries also generate the SEO files nobody should hand-maintain:

```js
prerender({
  site: 'https://example.com',                     // enables sitemap.xml
  extraRoutes: async () => (await getProjects()).map((p) => `/projects/${p.slug}`),
});
```

- **`robots.txt`** is emitted with zero config (`Allow: /`); with `site` set it
  also references the sitemap.
- **`sitemap.xml`** (requires `site` — the spec wants absolute URLs) lists every
  concrete route; `extraRoutes` adds data-driven URLs (CMS slugs etc.).
- Mark a route **`<template route="/admin" noindex>`**: it's excluded from the
  sitemap, `Disallow`ed in robots.txt, and its prerendered page gets a
  `<meta name="robots" content="noindex">`.
- Your own `sitemap.xml` / `robots.txt` (e.g. from `public/`) are never
  overwritten. The CLI takes `--site <url>` for the same behavior.

### Options

| Flag | Meaning |
|------|---------|
| `--out <dir>` | Write `<dir>/<basename>` instead of rewriting the entry in place. |
| `--root <dir>` | Base dir for resolving `import="components/x"` (default: the entry's dir; also tries `<root>/public` and `<root>/dist`). |
| `--vercel-root <dir>` | Where to write `vercel.json` for a routed entry (default: cwd). Vercel reads its config from the project root, not the build output. |
| `-h`, `--help` | Show help. |

### Programmatic API

```js
import { prerender } from 'spark-prerender';

const html = await prerender('dist/index.html', { root: 'dist' });
```

## Metadata — no special API

The prerenderer reads designated variables off each component's scope (first
defined wins, in DOM order) and writes them into `<head>`:

```html
<script>
  let pageTitle = 'Spark — HTML that reacts!';
  let pageDescription = 'Single-file HTML components with built-in reactivity.';
</script>
```

→ a static `<title>` and `<meta name="description">`. Defaults also cover
`ogTitle` / `ogDescription` / `ogImage` (→ `<meta property="og:…">`). Pass your
own `meta` mapping to `prerender()` to customize. If no component declares a
var, the entry HTML's existing `<head>` is left as-is.

## `onMount` never runs at build time

`onMount` is live-only lifecycle (WebSockets, timers, DOM measurements) — the
prerender skips it entirely, and the browser runs it normally when the page
mounts. Components need **no** `typeof __SPARK_PRERENDER__ !== 'undefined'`
guard: async setup that would crash or hang in Node simply doesn't run, and
the component's loading/skeleton state is what gets baked. For content that
should land in the static HTML, use `load()` (below) or `<template await>`.

## Dynamic data — the `load()` hook

For content that comes from an API, declare an async `load()` in the component
script. The prerenderer calls it, **awaits** it, then re-renders — so the data
lands in the static HTML. No `onMount`, no special import:

```html
<ul><template each="p in photos"><li>{p.title}</li></template></ul>

<script>
  let photos = [];
  async function load() {
    const res = await fetch('/api/photos');   // a DATA request, not a component
    photos = await res.json();
  }
</script>
```

`fetch` calls to **components** (relative `*.html`) are read from disk;
everything else (your data) is delegated to `options.fetch` if you pass one
(point it at fixtures or a local API), otherwise the real global `fetch`:

```js
await prerender('dist/index.html', {
  fetch: async (url) => fetch(new URL(url, 'http://localhost:3000')), // local API
});
```

`load()` runs only at build time and only if declared — components without it
do zero extra work, and the client still re-runs it normally in the browser.

## Routes (spark-html-router)

If your entry uses [`spark-html-router`](https://www.npmjs.com/package/spark-html-router)
(`<template route>` blocks), prerendering **expands automatically** to one
fully-rendered HTML file per route — no extra config:

```bash
spark-prerender dist/index.html
# → index.html, about.html, projects.html …
#   + dist/_redirects (Netlify) and ./vercel.json at the project root
#     (clean-URL rewrites + SPA fallback). Override its location with
#     --vercel-root <dir>.
```

Each route's content is baked in with an adoptable `data-spark-route` marker,
so the client router **adopts** it in place — crawlers get real content per
URL, users get no flash. The Vite plugin does the same on `vite build`.
Programmatic helpers: `routesOf(html)`, `routeToFile(route)`,
`redirectsFor(routes)`, `vercelConfigFor(routes)`.

## Scope

What it captures: a component's **initial scope** (interpolations, `each`/`if`,
nested imports, scoped styles, metadata vars) **plus** async data via `load()`
above. This covers marketing, docs, landing pages, and data-backed content.

**Browser-only globals are stubbed** (`matchMedia`, `localStorage`,
`sessionStorage`, `IntersectionObserver`, `ResizeObserver`, `requestIdleCallback`,
`scrollTo`) so components that touch them at script top level prerender instead
of throwing. Disable with `stubBrowserGlobals: false`, or extend/override with
`stubs: { … }`.

Honest limitations:

- **Stores created in `main.js` are not present.** The entry's bootstrap
  `<script>` is not executed (linkedom doesn't run page scripts); the
  prerenderer calls `mount()` itself. Components that read a store render with
  empty state (and warn) — that content is client-rendered.
- **Hydration is supported.** Prerendered HTML carries `import` paths and props
  as attributes (`makeHydratable()`). On the client, `mount()` adopts the
  prerendered DOM in place — it boots each component while detached and swaps
  atomically, so the user never sees a blank or raw braces. The router also
  adopts prerendered route outlets without flashing.
- `spark-ignore` regions (e.g. `<pre>` code samples) are left literal, exactly
  as in the browser.

## Notes

- Only dependency is **linkedom** (server DOM); it lives in this package, so the
  `spark-html` runtime stays 0-dependency.
- Requires a real `node`/`npm` install to populate `package-lock.json` for CI.

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
