# spark-html-language-server

Language server (LSP) for [Spark](https://github.com/wilkinnovo/spark) single-file
`.html` components. Zero dependencies, speaks LSP over stdio.

## What you get

- **Diagnostics**, live as you type:
  - `{binding}` used in the template but never declared in `<script>`
  - JS imports that are never used
  - script syntax errors (the exact code the runtime would execute)
  - `<div import="…">` pointing at a component file that doesn't exist
  - `each` without `key=` (hint — keyed reconciliation is opt-in)
  - malformed `each` expressions
- **Go-to-definition** — jump from `<div import="components/card">` to
  `card.html`, and from any `{symbol}` to its `let` / `function` / `$:` /
  `export let` declaration.
- **Autocomplete**
  - props on import placeholders, read from the target component's
    `export let` declarations
  - every template directive (`each`, `if`/`else-if`/`else`, `await`/`then`/`catch`,
    `bind:value|checked|group|form`, `:hidden`-style dynamic attributes, `key`,
    `route`, `transition:fade|slide|scale`, `spark-ignore`)
  - script symbols and Spark builtins (`useStore`, `onMount`, `props`) inside
    `{…}` and `<script>`
- **Hover docs** for every directive and declaration.

## Install

```bash
bun add -g spark-html-language-server
```

The `spark-html-language-server` binary starts the server on stdio — the
transport every LSP client speaks.

## VS Code

Install the **Spark (spark-html)** extension from
[`editors/vscode`](https://github.com/wilkinnovo/spark/tree/main/editors/vscode) —
it bundles syntax highlighting and launches this server automatically (globally
installed binary, or `node_modules/.bin` in your project).

## Programmatic use

The analyzer is exported for tooling:

```js
import { analyze } from 'spark-html-language-server';

const { declarations, props, diagnostics } = analyze(componentSource);
```

## Scope (v0.x)

The server analyzes one component at a time — the same boundary the runtime
has. It does not type-check across files (props completion reads the target
file's `export let` names, not their types), and remote URL imports are not
resolved.

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

## License

MIT
