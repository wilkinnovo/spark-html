# ⚡ spark-html-offline

Offline-capable URL imports for [spark-html](https://www.npmjs.com/package/spark-html)
— a tiny service worker that caches `<div import="https://…">` components on
first fetch and serves them when the CDN is unreachable or the user is
offline. Zero dependencies.

It kills the #1 critique of CDN imports: **"CDN down = component gone."**
With the worker installed, a component imported by URL is served from cache
instantly on every visit after the first, and refreshed in the background —
users are never more than one visit behind, and never broken.

```js
// src/main.js — zero config
import { offline } from 'spark-html-offline';
offline();
```

```js
// vite.config.js — emits /spark-sw.js in build, serves it in dev
import spark from 'spark-html/vite';
import offlineSw from 'spark-html-offline/vite';

export default { plugins: [spark(), offlineSw()] };
```

```html
<!-- this now works on a plane -->
<div import="https://esm.sh/some-pkg/card.html"></div>
```

Works with any CDN — esm.sh, unpkg, jsdelivr, raw.githubusercontent, your own.

## Install

```bash
npm install spark-html-offline
```

## How it works

The worker intercepts **cross-origin GET requests only** (the CDN-import
case) with a cache-first, background-revalidate strategy:

1. **First visit** — fetched from the network, stored in the cache.
2. **Every visit after** — served from cache instantly; a background fetch
   refreshes the entry for next time.
3. **Network gone** — the cached copy is served; a URL never seen before
   answers `504`.

Same-origin requests are untouched by default, so dev servers, HMR, and your
own assets behave exactly as before.

## Options

```js
// vite.config.js
offlineSw({
  file: 'spark-sw.js',        // emitted worker file name
  include: ['/components/'],  // ALSO cache these same-origin paths
  exclude: ['/api/'],         // never touch these (substring match)
  cacheName: 'spark-offline-v1',
});
```

```js
// main.js
offline({
  sw: 'spark-sw.js',  // worker URL, relative to the page base
  scope: '/',         // registration scope
});
```

`offline()` no-ops safely wherever service workers don't exist — prerender
builds, old browsers, non-secure origins — your app runs exactly as before,
just without the safety net.

## No build step?

You don't need Vite. Generate the worker once and host it next to
`index.html`:

```js
// node make-sw.mjs > spark-sw.js
import { swSource } from 'spark-html-offline';
console.log(swSource({ include: ['/components/'] }));
```

Then call `offline()` from any `<script type="module">`.

## API

| Export | Meaning |
|--------|---------|
| `offline(options?)` | Register the worker. Returns the registration, or `null` where unsupported. |
| `swSource(options?)` | The full worker source as a string. |
| `shouldHandle(url, origin, config?)` | The matching rule the worker uses (exported for tests/tooling). |
| `CACHE_NAME` | Default cache bucket name (`'spark-offline-v1'`). |
| `spark-html-offline/vite` | Vite plugin — emits the worker in build, serves it in dev. |

## License

MIT
