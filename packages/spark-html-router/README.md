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

`router()` mounts the page, shows the `<template route>` that matches the URL,
intercepts same-origin `<a>` clicks for SPA navigation (no full reload), and
tracks Back/Forward. The route templates are inert to the core runtime, so this
is a tiny add-on — the `spark-html` core stays router-free.

## Install

```bash
npm install spark-html-router
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
- **Catch-all** — `route="*"` renders for any unmatched path (a 404 page).

## SEO / prerender

Pair it with [`spark-prerender`](https://www.npmjs.com/package/spark-prerender):
it discovers your `<template route>` routes at build time and emits one
fully-rendered HTML file per route (`about.html`, `projects.html`, …) plus the
host rewrite rules — so crawlers get real content per URL, and the client
adopts the prerendered route with no flash.

## Notes

- v1 covers flat, exact-match routes + a catch-all. Path params (`/blog/:id`)
  and nested routes are not yet supported.
