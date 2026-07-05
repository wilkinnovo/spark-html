# spark-html-motion

Declarative **enter / leave transitions** for
[spark-html](https://github.com/wilkinnovo/spark-html) — the Spark way: no compiler,
no virtual DOM, 0 dependencies (1.5 kB gzipped). When an `<template if>` / `<template
each>` block adds or removes an element, it animates in/out. A leaving element
is held in the DOM until its exit animation finishes, then removed.

## Install

```sh
bun add spark-html-motion
```

## Use

Register once, **before `mount()`**, then opt elements in with a `transition`
attribute:

```js
import { mount } from 'spark-html';
import { motion } from 'spark-html-motion';

motion();
mount(document.body);
```

```html
<template each="t in todos">
  <li transition="slide">{t.text}</li>
</template>

<template if="open">
  <div class="panel" transition="fade">…</div>
</template>
```

- `transition="fade | slide | scale"` — or the directive form `transition:fade`.
- `transition-duration="300"` — milliseconds (per element).
- `transition-easing="ease-out"` — any CSS easing (per element).

The **initial render is not animated** by default (only later enters/leaves) —
pass `motion({ appear: true })` if you want the first paint to animate too.
`prefers-reduced-motion: reduce` is honored automatically (no animation).

## Options & defaults

```js
motion({
  preset: 'fade',   // default preset for a bare `transition` attribute
  duration: 200,    // ms
  easing: 'ease',
  appear: false,    // animate the initial mount?
});
```

## Custom presets

`presets` is a plain object of `{ in: Keyframe[], out: Keyframe[] }` (standard
[Web Animations](https://developer.mozilla.org/docs/Web/API/Element/animate)
keyframes) — add your own:

```js
import { presets, motion } from 'spark-html-motion';
presets.zoom = {
  in: [{ transform: 'scale(0)' }, { transform: 'scale(1)' }],
  out: [{ transform: 'scale(1)' }, { transform: 'scale(0)' }],
};
motion();
// <li transition="zoom">…</li>
```

## How it works

Spark core exposes a tiny `lifecycle({ enter, leave })` seam; this package
registers into it and drives the Web Animations API. Nothing animates unless you
call `motion()`, and elements without a `transition` attribute are added/removed
instantly — so the cost is strictly opt-in.

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

## License

MIT © Wilkin Novo
