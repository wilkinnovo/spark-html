<p align="center">
  <img src="website/public/banner.png" alt="Spark — HTML that reacts." width="840" />
</p>

<p align="center">
  <b>HTML that reacts.</b><br />
  Single-file reactive components — no compiler, no virtual DOM, no build step.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/spark-html"><img alt="npm" src="https://img.shields.io/npm/v/spark-html?color=ffd24a&label=spark-html" /></a>
  <img alt="size" src="https://img.shields.io/bundlephobia/minzip/spark-html?color=ffd24a&label=gzip" />
  <img alt="deps" src="https://img.shields.io/badge/dependencies-0-ffd24a" />
  <a href="https://github.com/wilkinnovo/spark/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/spark-html?color=ffd24a" /></a>
  &middot; <a href="https://wilkinnovo.github.io/spark/">site</a>
  &middot; <a href="https://wilkinnovo.github.io/spark/docs">docs</a>
</p>

---

The component **is** the file. Save `counter.html` and the browser runs it
byte-for-byte — reactive, scoped, untouched.

```html
<!-- counter.html -->
<h2>Count: {count}</h2>
<button onclick={inc}>+1</button>

<script>
  let count = 0;
  function inc() { count++; }
</script>
```

## Quick start

```bash
npx create-spark-html-app myapp
cd myapp && npm install && npm run dev
```

…or add it to an existing project:

```js
// vite.config.js
import spark from 'spark-html/vite';
export default { plugins: [spark()] };

// main.js
import { mount } from 'spark-html';
mount();
```

```html
<!-- index.html -->
<div import="components/counter"></div>
```

…or **no build at all** — straight from a CDN, no npm, no bundler:

```html
<script type="importmap">
  { "imports": { "spark-html": "https://esm.sh/spark-html@0.21" } }
</script>
<div import="components/counter"></div>
<script type="module">import { mount } from 'spark-html'; mount()</script>
```

Serve any static folder and open it — that's the whole toolchain. Components are
just files at a URL, so you can even `import` one straight from a CDN. See
[`examples/no-build`](examples/no-build).

## Packages

| Package | What it does |
|---|---|
| [`spark-html`](packages/spark/README.md) | The runtime — `mount()`, components, reactivity, stores, scoped styles. ~10kb gzip, 0 deps. |
| [`spark-html-router`](packages/spark-html-router/README.md) | Declarative routing — `<template route>` + `router()`, active links, a reactive `route` store. |
| [`spark-html-theme`](packages/spark-html-theme/README.md) | One-line dark/light/system theming — `theme()`, persisted, no flash. |
| [`spark-prerender`](packages/spark-prerender/README.md) | Build-time SEO prerender — real HTML per route, no SSR server, no app changes. |

## This repo

```
packages/        the four published packages (+ create-spark-html-app)
examples/basic   a minimal Vite app consuming spark-html
website/         the showcase + docs site — built with Spark, the router & theme
```

```bash
npm install      # links workspaces
npm run dev      # the example app
npm run site     # the website
npm test         # 190+ assertions, pure node, no browser
```

Built something with Spark? Add it to the
[showcase](https://wilkinnovo.github.io/spark/showcase) — open a PR.

## License

MIT
