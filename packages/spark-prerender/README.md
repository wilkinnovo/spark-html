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

### Options

| Flag | Meaning |
|------|---------|
| `--out <dir>` | Write `<dir>/<basename>` instead of rewriting the entry in place. |
| `--root <dir>` | Base dir for resolving `import="components/x"` (default: the entry's dir; also tries `<root>/public` and `<root>/dist`). |
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
#   + _redirects and vercel.json (clean-URL rewrites + SPA fallback)
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
- **No DOM adoption / hydration in v1.** The output is static, crawler-ready
  HTML. Re-mounting the same runtime over it (true hydration) is a later phase
  (near a boot rewrite). For interactive pages, treat this as the SEO shell.
- `spark-ignore` regions (e.g. `<pre>` code samples) are left literal, exactly
  as in the browser.

## Notes

- Only dependency is **linkedom** (server DOM); it lives in this package, so the
  `spark-html` runtime stays 0-dependency.
- Requires a real `node`/`npm` install to populate `package-lock.json` for CI.
