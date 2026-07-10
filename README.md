<p align="center">
  <img src="website/public/banner.svg" alt="Spark — HTML that reacts. Built for humans. Single-file reactive components: no compiler, no virtual DOM, no build step." width="880" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/spark-html"><img alt="npm" src="https://img.shields.io/npm/v/spark-html?color=ffd24a&amp;label=spark-html" /></a>
  <img alt="size" src="https://img.shields.io/badge/gzip-18.00%20kB-ffd24a" />
  <img alt="deps" src="https://img.shields.io/badge/dependencies-0-ffd24a" />
  <a href="https://github.com/wilkinnovo/spark-html/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/spark-html?color=ffd24a" /></a>
  &middot; <a href="https://spark-html.dev">site</a>
  &middot; <a href="https://spark-html.dev/docs">docs</a>
</p>

---

> "Spark-html is what web frameworks could've been if we didn't spend 21 years bolting JS frameworks on top of HTML instead of just reading the HTML."
> — Anon9

**HTML that reacts. Built for humans.**

The component **is** the file. Save `counter.html` and the browser runs it
byte-for-byte — reactive, scoped, untouched.

```html
<!-- counter.html -->
<h2>Count: {count}</h2>
<button onclick={inc}>+1</button>

<script>
  import { fmt } from './format.js';   // standard JS imports work too
  let count = 0;
  function inc() { count++; }
</script>
```

No compiler generates code from your template. No virtual DOM allocates and diffs
a tree per frame. The file you write is what runs — 18.00 kB gzipped, zero dependencies.

> ⚡ **1.29× hand-written vanilla JS — with no build step at all.**
> On the krausest js-framework-benchmark, spark-html 1.5 lands a CPU geomean of
> **1.286× the hand-written `vanillajs` reference** — past Angular, past Vue at
> the margin on the published scale — and first paint sits at parity with
> vanilla (we retired our old "beats vanilla to first paint" headline once more
> samples showed that metric's noise; the honesty audit trail is in
> `benchmarks.md`). *(Paired local run; [method & full table](#performance).)*

## Built for humans

AI writes more of the web every day — and that's exactly why Spark exists. Some
of us still love hand-writing our web apps: reading every line we ship,
understanding the whole stack, owning the craft. Spark is built for those
people. It makes hand-crafting a web app as easy as it can be, and then stops:
no compiler rewriting your source, no virtual DOM between you and the page, no
scaffolding you didn't ask for. Twenty-one small packages, each one readable in a
sitting — add only what you use, and everything you write stays yours,
byte-for-byte, in view-source forever.

## 1.0 — released, and proven on the way out the door

Spark hit **1.0.0** on 2026-07-07 — all 21 packages, one wave. A 1.0 is a
promise, so we made the release earn it. **The battery it passed on the exact
promotion commit:**

- **100,000 / 100,000** fuzz scenarios clean (+ 9 corpus regressions) — every
  scenario asserts the patched DOM is byte-identical to a from-scratch render
  of the same final state. Convergence isn't a goal; it's the oracle.
- **Bench above the 0.7.0 baseline** (big page 7.3–7.5k req/s vs the 6.9k
  baseline we defend) — performance is measured, never assumed.
- **e2e 7/7, full `npm test` green, size gate at 14.63 / 15.0 kB** — and the
  budget is **frozen for the life of 1.x**. If a feature doesn't fit, the
  answer is a sibling package, not a bigger core. That rule is the pitch.
  (One deliberate exception since: the budget was raised once, 15.0 → 16.0 kB,
  itemized line-by-line, to fund the 1.1.0 speed release — then re-frozen.)
- **21 release tags pushed in seven batches of ≤3, publish workflows verified
  per batch** (the >3-tag trap where GitHub silently skips every tag-triggered
  workflow never got a chance), then every package **confirmed on the npm
  registry** — we verify the registry, not the green checkmark.

Semver from here: everything documented is API for the life of 1.x. The
surfaces allowed to change in a minor are explicitly marked experimental —
see each package's README.

## Quick start

```bash
bunx create-spark-html-app@latest myapp
cd myapp && bun install && bun dev
```

…or add it to an existing project — `spark-html-bun` is the dev server,
bundler, and preview server (no build step required):

```js
// spark.config.js (optional — everything has a default)
export default {};

// main.js
import { mount } from 'spark-html';
mount();
```

```html
<!-- index.html -->
<div import="components/counter"></div>
```

…or **no build at all** — straight from a CDN, no install, no bundler:

```html
<script type="importmap">
  { "imports": { "spark-html": "https://esm.sh/spark-html@1" } }
</script>
<div import="components/counter"></div>
<script type="module">import { mount } from 'spark-html'; mount()</script>
```

Serve any static folder and open it — that's the whole toolchain. Components are
just files at a URL, so you can even `import` one straight from a CDN. See
[`examples/no-build`](examples/no-build).

## Performance

**Measured, not claimed.** On the [krausest js-framework-benchmark](https://github.com/krausest/js-framework-benchmark)
(the industry-standard table), spark-html 1.5.0 lands a **CPU geomean of
1.286× hand-written vanilla JS** — paired run against the `vanillajs`
reference, 15 iterations, windowed Chrome, same machine, official
webdriver-ts harness. On the published solidjs.com scale that is **past
Angular (1.45) and past Vue (1.31) — at the margin, and while being the
only framework in that neighborhood with no build step at all.** First
paint is at parity with vanilla (single-sample fp spreads ±20% per run;
an A/B against the prior release measured Δ+0.6 ms — details in
`benchmarks.md`). Local run, upstream submission open (PR #2048);
numbers below are medians:

| Benchmark | vanilla (ms) | spark (ms) | ratio |
|---|---:|---:|---:|
| create 1,000 rows | 96.2 | 128.9 | 1.34× |
| replace 1,000 rows | 111.3 | 156.4 | 1.41× |
| update every 10th (×16) | 53.7 | 74.5 | 1.39× |
| select row | 12.0 | 14.8 | 1.23× |
| swap rows | 60.4 | 79.7 | 1.32× |
| remove one | 55.4 | 64.2 | 1.16× |
| create 10,000 rows | 1125.2 | 1452.3 | 1.29× |
| append 1,000 | 121.7 | 158.2 | 1.30× |
| clear (×8) | 35.1 | 40.9 | 1.17× |

How it stays fast:

- **Components ship as authored HTML** — no compiler generates code from your
  template. The file you write is what runs.
- **No virtual DOM** — patches mutate the DOM directly. No intermediate tree to
  allocate, diff, or discard per frame.
- **18.00 kB gzipped, zero dependencies** — parses, mounts, and patches in a single
  microtask.
- **Keyed reconciliation with minimal moves** — the diff trims the unchanged
  prefix/suffix and runs a longest-increasing-subsequence pass on the rest (a
  swap is 2 DOM moves, not 997), rows are created 64 at a time from one native
  clone of a stamped recipe (analysis runs once per template, never per row),
  and row events use document-level delegation — creating 1,000 rows allocates
  zero listeners and zero handler closures.
- **Template-level dependency dispatch** — the template's observed dependency
  graph sends a changed key straight to the affected bindings in every row,
  with no per-row bookkeeping at all. Selection-shaped bindings
  (`key === selected ? … : …`) go further: a keyed index patches exactly the
  row losing the value and the row gaining it — two rows touched, not 1,000.
- **The runtime warms itself** — after mount, at browser idle, spark exercises
  its own row pipeline once against a detached template, so the first real
  interaction runs JIT-warm instead of paying first-run compilation cost.
  Something a build-time framework can't do for you: it happens against your
  actual live templates, in your user's actual browser.

  ```html
  <p>{a} + {b} = {a + b}</p>
  <p>{c}</p>
  <script>let a = 1, b = 2, c = 3;</script>
  ```

  Updating `a` re-evaluates `{a}` and `{a + b}`. The `{c}` binding is skipped.

- **Row-level loop patching** — mutating one item re-walks only that row:

  ```html
  <template each="todo in todos" key="todo.id">
    <p>{todo.text} — {todo.done ? '✓' : '○'}</p>
  </template>
  <script>let todos = [{ id: 1, text: 'a', done: false }, /* …999 more… */];</script>
  ```

  `todos[3].done = true` re-walks only row index 3 — the other 999 rows are
  untouched. A structural change (push, splice, re-sort) still re-reconciles but
  skips rows whose identity (key) didn't move.

- **Tracked `Map`/`Set` mutations** — `map.set(key, val)`, `set.add(item)`, and
  `delete`/`clear` trigger re-renders, just like array push and object property
  assignment. No special API or immutability discipline required.
- **Server-side, the same story** — [`spark-ssr`](packages/spark-ssr/README.md)
  precompiles every page and component into a render program (parsed once,
  mtime-invalidated): a request is a string-emitting loop — no DOM built, no
  HTML re-parsed. Production adds an auto-detected full-page response cache
  for anonymous GETs (invalidated by the same write hooks that power `live`),
  streaming for big list pages, batched relation queries, and bounded LRU
  source caches. A 1,000-row page that rendered in ~27 ms renders in ~4 ms;
  a cached public page serves at in-memory-string speed.

## Limits

Spark trades completeness for simplicity — these are deliberate edges, not roadmap gaps:

- **One reactive scope per component** — all top-level `let`/`function` declarations share a single proxy scope within each component.
- **Only top-level declarations become component state** — `let`/`const` inside a function body are true block-scoped locals (as of 0.28), and destructuring (`let {a} = obj`) stays local everywhere.
- **Class instances / `Date`** — not deeply reactive (intentional). Reassign the variable to trigger an update. Plain objects, arrays, `Map`, and `Set` are all tracked.
- **Loops reconcile by index by default** — add `key="…"` for identity-stable reordering (keeps focus, preserves element state).
- **The script rewriter is a scanner, not a parser** — it is string- and comment-aware (code-shaped text inside string literals stays byte-intact, as of 0.30), with one documented unparseable construct: a regex literal containing a quote character. That case warns loudly and names the fix (move the regex to an imported `.js` module).
- **CSP** — the runtime uses `new Function` for expressions and event handlers, so a strict Content Security Policy needs `unsafe-eval`. For integrity of what you _load_, [`spark-html-sri`](packages/spark-html-sri/README.md) hashes and verifies assets and URL-imported components.
- **`import.meta`** — not available inside component scripts (imports are replayed as dynamic `import()`). Bare specifiers need an import map when running without a bundler.

## How it works

1. **`mount()`** finds `<div import="…">` placeholders and fetches each file.
2. **Text-level extraction** — `<script>` and `<style>` are extracted from the
   raw text before the markup ever touches `innerHTML`. Browsers strip `<script>`
   tags injected via `innerHTML`; text-level extraction sidesteps the entire class
   of bugs that every other client-only framework has to work around.
3. **The script runs inside a `Proxy` scope** — every assignment schedules a
   patch of only that component's DOM. Patches are batched onto a single microtask.
4. **Cheap patches** — static subtrees (no bindings) are walked once and then
   skipped. A patch costs work proportional to _dynamic_ nodes, not the whole tree.
5. **Deep reactivity** — plain objects and arrays read from scope are wrapped in
   proxies so `todos.push(x)` and `row.done = true` re-render without replacing
   the value. `Map` and `Set` mutations are tracked too.
6. **Styles are auto-scoped** via a `[name="component"]` prefix. `@media`/`@supports`
   scope correctly, `@keyframes`/`@font-face` pass through, `:global(…)` opts out.
7. **Loops reconcile by key** — each item keeps its DOM nodes across updates
   (matched by index, or by `key`), so inputs inside loops keep focus.
8. **A cloak style** hides components via `visibility:hidden` until booted and
   patched — no flash of raw `{braces}` or unstyled markup.

## Packages

**Runtime**

| Package                                  | What it does                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`spark-html`](packages/spark/README.md) | The runtime — `mount()`, components, reactivity, `store`/`derived`, `bind:form`, scoped styles, plus `npx spark-html doctor`. 18.00 kB gzip, 0 deps. |

**UI &amp; UX siblings** (add only what you use)

| Package                                                         | What it does                                                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`spark-html-router`](packages/spark-html-router/README.md)     | Declarative routing — `<template route>` + `router()`, nested routes/layouts, `route.query`, active links. |
| [`spark-html-theme`](packages/spark-html-theme/README.md)       | One-line dark/light/system theming — `theme()`, persisted, no flash.                                       |
| [`spark-html-head`](packages/spark-html-head/README.md)         | Reactive document `<title>`/`<meta>` per route — plus a `head` store for per-component overrides.          |
| [`spark-html-motion`](packages/spark-html-motion/README.md)     | Declarative enter/leave transitions — `transition="fade\|slide\|scale"` on if/each blocks.                 |
| [`spark-html-devtools`](packages/spark-html-devtools/README.md) | In-page devtools panel — live store state, component tree, patch counter, re-render flash.                 |

**Data**

| Package                                                           | What it does                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`spark-html-query`](packages/spark-html-query/README.md)         | Declarative async data — a self-fetching reactive store (`loading`/`error`/`data`/`refetch`). |
| [`spark-html-persist`](packages/spark-html-persist/README.md)     | Persist a store across reloads in one line — hydrate from localStorage, save on change.       |
| [`spark-html-websocket`](packages/spark-html-websocket/README.md) | A WebSocket as a reactive store — auto-reconnect, JSON parsing, status, `send()`.             |

**Build, assets &amp; security**

| Package                                                         | What it does                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`spark-html-bun`](packages/spark-html-bun/README.md)           | Dev server, bundler &amp; preview on Bun — `spark dev`/`build`/`preview`, scoped HMR, no-build dev, the post-build pipeline.                                                                                                               |
| [`spark-prerender`](packages/spark-prerender/README.md)         | Build-time SEO prerender — real HTML per route (+ sitemap/robots), no SSR server, no app changes.                                                                                                                                          |
| [`spark-ssr`](packages/spark-ssr/README.md)                     | Full-stack SSR on Bun — the template is the backend: inferred schema, REST/CRUD API, auth &amp; sessions, jobs/mail, source-agnostic hydration (`<spark-ssr>`). Precompiled render programs + a full-page response cache: fast by default. Security-audited ([`SECURITY.md`](packages/spark-ssr/SECURITY.md)). |
| [`spark-html-image`](packages/spark-html-image/README.md)       | Build-time image optimization — `<img>` rewritten to webp/avif with responsive `srcset`, zero config.                                                                                                                                      |
| [`spark-html-font`](packages/spark-html-font/README.md)         | Font loading optimizer — `@font-face` + preload + size-adjusted fallbacks, no FOUT, no layout shift.                                                                                                                                       |
| [`spark-html-manifest`](packages/spark-html-manifest/README.md) | PWA manifest + icons + head tags (and optional service worker) from one config.                                                                                                                                                            |
| [`spark-html-offline`](packages/spark-html-offline/README.md)   | Offline URL imports — a tiny service worker that caches CDN components on first fetch.                                                                                                                                                     |
| [`spark-html-sri`](packages/spark-html-sri/README.md)           | Subresource Integrity — hash built assets/components, verify at runtime, allow-list remote origins.                                                                                                                                        |

**Tooling**

| Package                                                                       | What it does                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [`create-spark-html-app`](packages/create-spark-html-app/README.md)           | Scaffold a spark-html app — `bunx create-spark-html-app@latest`.                                       |
| [`prettier-plugin-spark`](packages/prettier-plugin-spark/README.md)           | Prettier plugin — formats the `<script>`/`<style>` blocks, leaves markup byte-for-byte.                |
| [`spark-html-language-server`](packages/spark-html-language-server/README.md) | LSP for components (spark-ssr aware) — diagnostics, go-to-definition, prop autocomplete, hover docs for every directive. |
| [`spark-html-test-utils`](packages/spark-html-test-utils/README.md)           | Test helpers — `mount(fixture)` on linkedom, `inspect` the reactive scope, fire realistic DOM events. No browser. |

## This repo

```
packages/        spark-html + its 20 sibling/tooling packages — 21 in all, every one at 1.0.0
examples/        basic (Bun app) · jsimports · no-build (CDN) · pinterest &amp; tabtube (spark-ssr)
editors/         Zed + VS Code extensions for .html component highlighting
website/         the docs/playground/tutorials site — built with Spark itself
```

```bash
bun install      # links workspaces
bun run dev      # the example app
bun run site     # the website
bun run test     # 1200+ assertions, pure node, no browser
bun run e2e      # Playwright: mount → hydrate → router → theme, live tutorials
```

Built something with Spark? Add it to the
[showcase](https://spark-html.dev/showcase) — open a PR.

## License

MIT
