# ⚡ spark-html-query

Declarative async data for [spark-html](https://www.npmjs.com/package/spark-html)
— a **self-fetching reactive store**. One dependency (`spark-html`), built
entirely on its `store()`.

A `query` runs an async function and exposes the result as reactive store state.
Any component reads it with the same `useStore` it already knows, and re-renders
as the request settles — no `onMount`, no manual `loading` flags, no `fetch`
boilerplate.

```js
import { query } from 'spark-html-query';

query('user', () => fetch('/api/user').then((r) => r.json()));
```

```html
<!-- any component -->
<script>const user = useStore('user');</script>

<p :hidden="!user.loading">Loading…</p>
<p :hidden="!user.error">Failed: {user.error.message}</p>
<h1 :hidden="user.loading">{user.data?.name}</h1>
<button onclick="{user.refetch}">Reload</button>
```

## Install

```bash
npm install spark-html-query
```

## State

`useStore(name)` returns a reactive object:

| Key | Meaning |
|-----|---------|
| `data` | The latest resolved value (or `initialData` / `null` before the first). |
| `error` | The last rejection, or `null`. |
| `loading` | `true` until the first successful result (no `data` yet). |
| `fetching` | `true` during **any** in-flight fetch, including a refetch over existing data. |
| `refetch()` | Re-run the fetcher. A newer call supersedes an older in-flight one. |
| `mutate(next)` | Set `data` directly without fetching (optimistic update). Value or `(prev) => next`. |
| `stop()` | Stop the `refetchInterval` poller, if any. |

## Options

```js
query('feed', fetchFeed, {
  initialData: [],          // seed data; skips the initial `loading` state
  refetchInterval: 30000,   // poll every 30s
  lazy: true,               // with initialData: wait for the first refetch()
});
```

## Pairs with `derived`

Shape a query into exactly what a component needs, memoized — the view updates
as the request settles:

```js
import { query } from 'spark-html-query';
import { derived } from 'spark-html';

query('todos', fetchTodos);
derived('todoStats', ['todos'], (q) => ({
  total: q.data?.length ?? 0,
  done: q.data?.filter((t) => t.done).length ?? 0,
  loading: q.loading,
}));
```

> `loading` vs `fetching`: show a **skeleton** on `loading` (first load, no data
> yet) and a subtle **spinner** on `fetching` (background refresh that keeps the
> stale data visible). That's the stale-while-revalidate pattern, declaratively.

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
