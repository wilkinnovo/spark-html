# ⚡ spark-html-router

Declarative client routing for [spark-html](https://www.npmjs.com/package/spark-html) — **no JS config, just markup.** Write your routes as `<template route>` blocks and call `router()` once.

```html
<nav>
  <a href="/">Home</a>
  <a href="/about">About</a>
  <a href="/projects">Projects</a>
</nav>

<template route="/">         <div import="components/home"></div>      </template>
<template route="/about">    <div import="components/about"></div>     </template>
<template route="/projects"> <div import="components/projects"></div>  </template>
<template route="*">         <div import="components/not-found"></div> </template>

<script type="module">
  import { router } from 'spark-html-router';
  router();          // that's it
</script>
```

`router()` mounts the page **once** (chrome + the active route together — every
component's `onMount` fires exactly once), shows the `<template route>` that
matches the URL, intercepts same-origin `<a>` clicks for SPA navigation (no full
reload), and tracks Back/Forward. The route templates are inert to the core
runtime, so this is a tiny add-on — the `spark-html` core stays router-free.

## Active links (zero config)

After every navigation the router sets `aria-current="page"` on the `<a>` whose
`href` matches the current route, and clears it from the rest. Highlight the
active link with pure CSS — no `useStore`, no per-link expressions:

```html
<!-- components/site-nav.html -->
<nav>
  <a href="/">Home</a>
  <a href="/about">About</a>
  <a href="/projects">Projects</a>
</nav>

<style>
  nav a[aria-current="page"] { color: #fff; font-weight: 700; }
</style>
```

## Reactive active route

For anything beyond link styling — the document title, analytics, a breadcrumb —
the router also publishes the current path to a built-in `route` store, so any
component can react with `useStore('route')` (no `popstate`/`pushState` wiring):

```html
<script>
  const route = useStore('route');
  $: document.title = route.path === '/' ? 'Home' : 'My Site';
</script>
```

## Focus & scroll on navigation (a11y, zero config)

On a forward navigation the router moves keyboard/screen-reader focus into the
newly rendered view (so users aren't stranded at the top of the old page) and
resets scroll — to the `#hash` target if the URL has one, otherwise to the top.
Back/Forward (popstate) is left alone: the browser restores its scroll position
and focus isn't yanked.

By default the view's root receives focus. To choose a better target (e.g. the
page heading), mark it:

```html
<template route="/about">
  <h1 data-router-focus tabindex="-1">About</h1>
  …
</template>
```

(`[autofocus]` works too.) The router adds a temporary `tabindex="-1"` if needed
and removes it on blur, so nothing lingers in the DOM or the tab order.

## Install

```bash
bun add spark-html-router
```

## API

```js
import { router, navigate } from 'spark-html-router';

await router({ base: '/spark' });   // base = path prefix (e.g. GitHub Pages)
navigate('/about');                 // navigate programmatically
```

| Option | Meaning |
|--------|---------|
| `base` | Path prefix the app is served under (e.g. `/spark`). Stripped before matching, added back when navigating. |
| `root` | Mount root (default `document.body`). |

## Routes

- **Exact match** — `route="/about"` matches `/about` (trailing slashes and the
  base path are normalized away).
- **Dynamic segments** — `route="/blog/:id"` matches `/blog/42`; the captured
  params land on the `route` store. Exact routes win over dynamic ones.
- **Catch-all** — `route="*"` renders for any unmatched path (a 404 page).
- **Default 404** — if the page declares no `route="*"`, the router injects a
  minimal built-in not-found view (a 404 heading + a link home), so unknown
  URLs never render a blank page. Declare your own `route="*"` to replace it.
  With `spark-prerender`, a `404.html` is also generated automatically at
  build time (your own `404.html`, e.g. from `public/`, always wins).

```html
<template route="/blog/:id"><div import="components/post"></div></template>

<!-- components/post.html -->
<h1>Post #{post}</h1>
<script>
  const route = useStore('route');
  $: post = route.params.id;      // "42" on /blog/42
</script>
```

Precedence: **exact → dynamic → catch-all**. Navigating between two matches of
the same dynamic route (`/blog/1` → `/blog/2`) re-mounts the route with the new
params.

## Query string — `route.query`

The URL's search params are a plain reactive object on the `route` store — no
manual `location.search` parsing, no popstate wiring:

```html
<script>
  const route = useStore('route');
  let page = 1;
  $: page = Number(route.query.page || 1);      // ?page=2 → 2

  function next() {
    route.query.page = String(page + 1);        // updates the URL bar + re-renders
  }
</script>
```

- Reading: `route.query` mirrors `URLSearchParams` as `{ page: "2", q: "hi" }`
  (values are strings, like the platform gives them).
- Writing `route.query.page = "3"` updates the URL **in place** via
  `replaceState` — shareable state with no navigation and no history entry.
- Setting a param to `null`/`undefined`/`''` removes it from the URL.
- `navigate('/projects?page=2')` works; navigating without a query string
  clears `route.query` (the URL is the source of truth).

## Nested routes & layouts

Nest `<template route>` blocks to build a persistent layout with swappable
children. A parent route renders whenever the URL is *under* it; the matching
child renders wherever you place the nested templates:

```html
<template route="/dash">
  <div import="components/dash-layout"></div>   <!-- sidebar, header… -->
  <main>
    <template route="/dash">          <div import="components/dash-home"></div>     </template>
    <template route="/dash/settings"> <div import="components/dash-settings"></div> </template>
  </main>
</template>
```

The **parent layout is kept alive** across child navigations — its components
aren't re-mounted, so layout state (open menus, scroll, form input) survives.
Only the part of the tree that actually changed is rebuilt. Precedence per level
is still exact → dynamic → longest layout-prefix → catch-all.

## SEO / prerender

Pair it with [`spark-prerender`](https://www.npmjs.com/package/spark-prerender):
it discovers your `<template route>` routes at build time and emits one
fully-rendered HTML file per route (`about.html`, `projects.html`, …) plus the
host rewrite rules — so crawlers get real content per URL, and the client
adopts the prerendered route with no flash.

## Notes

- Covers exact routes, dynamic `:param` segments, nested routes/layouts, and a
  catch-all. Dynamic routes render on the client (their params aren't known at
  build time, so `spark-prerender` skips them); concrete top-level routes
  prerender as usual (nested children render on the client). Wildcard splats
  (`/docs/*`) are not yet supported.

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
