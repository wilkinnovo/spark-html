# ⚡ Spark App

A starter built with [spark-html](https://github.com/wilkinnovo/spark-html) — single-file
HTML components with built-in reactivity. No compiler, no virtual DOM, no build step.

The scaffold is a **multi-page SPA** with client-side routing, live demos, and a
shared design system — edit any component and save to see it update instantly.
Depending on the options you picked at scaffold time it also wires up
`spark-html-theme` (dark/light), `spark-html-image` (build-time webp/avif),
`spark-html-sri` (integrity checks), and `spark-html-manifest` (PWA manifest +
icons + offline app shell). `spark-html-head`, `spark-html-persist`,
`spark-prerender`, and `spark-html-devtools` are always included.

## Develop

```bash
bun install
bun run dev          # dev server with HMR
```

In dev mode, `spark-html-devtools` adds a debugging overlay — inspect
component state, stores, and the mounted tree live.

## Build (SEO-ready)

```bash
bun run build     # static output → dist/, serve anywhere
bun run preview   # preview the production build locally
```

`bun run build` is **SEO-friendly out of the box**: the `spark-prerender`
pipeline step runs your app at build time and writes fully-rendered HTML into
`dist/` — so crawlers and AI tools read real content (headings, text, links),
not empty placeholders. The browser still hydrates over it for full
interactivity.

Per-route `<title>` and `<meta>` tags are set reactively via
`spark-html-head` in `src/main.js` — no per-component boilerplate.

Don't need SEO? Remove the `prerender(...)` step from `spark.config.js`.

## Architecture

Client routing is set up in `src/main.js` — `router()` (from
`spark-html-router`) replaces `mount()` and discovers your routes from
`<template route>` blocks in `index.html`. Per-route `<title>` and `<meta>`
are handled by `head()` (from `spark-html-head`), and `spark-html-devtools`
provides a live debugging overlay in dev mode.

Each route is just an HTML file in `public/components/`.

## What's inside

The scaffold's components in `public/components/` each demonstrate a Spark feature
(all using only the published runtime — no experimental APIs):

| Component | Features shown |
|---|---|
| `nav.html` | Client routing (active link highlight via `aria-current="page"`), theme toggle via `useStore('theme')` |
| `hero.html` | Local state, `$:` reactive declarations, shared store (`useStore('app')`) |
| `home.html` | Page composition — imports `hero` + demo components for the `/` route |
| `about.html` | Page composition — uses `feature-card` with props and slots for the `/about` route |
| `demo-todo.html` | `bind:value`/`bind:checked`, `<template each>` with `key`, `$:` derived counts |
| `demo-props.html` | `export let` props, named `<slot>`, component composition |
| `demo-await.html` | `<template await>` with `once()`, `onMount`, loading/then/catch states |
| `feature-card.html` | Reusable card via `export let` + `<slot>`, used by `about` and `demo-props` |
| `footer.html` | Static content component, imported by the shell |

A component is a `.html` file with optional `<script>` and `<style>`. Top-level
variables are reactive state — assigning to one re-patches that component's DOM.
Derive values with `$:`, share state across components with `useStore(name)`, use
`bind:value` for two-way binds, and pass props as attributes on the `import`
placeholder.

See the [full docs](https://wilkinnovo.github.io/spark-html/docs) for the complete
template syntax reference.
