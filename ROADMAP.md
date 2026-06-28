# Spark Roadmap

> How to improve Spark while keeping it **unique**. The test for every item:
> *does it preserve the north star, or erode it?*

## North star (never trade away)

**The `.html` you save is the component that runs — byte-for-byte.**
- No compiler, no proprietary file format, no virtual DOM, view-source-readable.
- ~10KB gzip, **0 runtime dependencies**.
- Mental model = HTML + JS. A component is a file; state is a variable; an update
  is an assignment.

## The principle that's working — keep enforcing it

Core stays tiny; features ship as optional sibling packages (`spark-html-router`,
`spark-html-theme`, `spark-prerender`). **A feature only enters `spark-html` core
if it can't live as a sibling package and pays for its bytes.** Everything else
is `spark-html-*`.

## Progress snapshot

| # | Theme | Status |
|---|-------|--------|
| 1 | Zero-build / CDN / URL-import | ✅ **Done** |
| — | Router: active links + dynamic `:params` + anchor fix | ✅ Done (bonus) |
| — | `spark-html-theme` package | ✅ Done (bonus) |
| 2 | Editor + dev tooling — VS Code ✅, HMR ✅, DevTools ✅, Zed ✅ + format-on-save ✅ | ✅ Done |
| 3 | Ergonomic papercuts — inline handlers ✅, quirks fixed + tested ✅ | ✅ Done |
| 4 | Capability gaps — head ✅, dynamic routes ✅, Map/Set ✅, nested routes ✅, motion ✅, router focus ✅ | ✅ Done |
| 5 | Trust & quality — size guard ✅, e2e ✅ | ✅ Done |

## Priorities

### 1. Zero-build / CDN / URL-import ⭐ — ✅ DONE
The sharpest differentiator, now productized and live:
- ✅ `examples/no-build/` — a runnable, tooling-free app (CDN import map + static
  components), serveable with any static server.
- ✅ Website home: a tabbed hero with **URL import shown first** — a component
  fetched **live, cross-origin, from a CDN** (jsDelivr); prerender bakes it from
  the local copy. Verified live.
- ✅ "Use it — no build required" section on the home page; "No build / CDN"
  docs section; README snippet.
- ✅ URL imports work as-is (`mount()` fetches any URL) — no core change needed.

### 2. Editor + dev tooling — ✅ DONE
- ✅ **VS Code extension** (`editors/vscode`): TextMate injection that
  JS-highlights `{interpolations}` on top of HTML.
- ✅ **Zed extension** (`editors/zed`): full highlighting — `{interpolation}` as
  JS, `<script>`/`<style>` injected, HTML structure — backed by the
  tree-sitter-svelte grammar (Spark is a syntactic subset of Svelte).
- ✅ **Format on save** via `prettier-plugin-spark` (new package): formats the
  `<script>`/`<style>` blocks and leaves markup **byte-for-byte** intact, so
  Spark's hybrid syntax (`{interp}`, `onclick="{fn}"`, `:attr`) is never
  corrupted — the bundled `html`/`svelte` parsers both mangle it. Zed sets
  `prettier_parser_name = "spark"`; enable the plugin once in settings.
- ✅ **HMR**: editing a component re-renders just its instances in place —
  sibling component state is preserved, no full reload. Slotted / loop-managed
  hosts fall back to a full reload (always correct). (spark-html 0.21.3)
- ✅ **Spark DevTools** (`spark-html-devtools`): in-page panel — live store state,
  component tree + state, patch counter, and an amber flash on the component that
  just re-rendered. (0.1.0; uses `inspectStores()` added in spark-html 0.21.4.)


### 3. Ergonomic papercuts in core — ✅ DONE
- ✅ **Inline event expressions**: `onclick={count++}` / `{x = e.target.value}` /
  `{add(5)}` run as statements; a bare ref (`{fn}` / `{obj.method}`) is still
  called with the event (0.21.2).
- ✅ Documented quirks (comma `let a='', b=''`, `let name` shadowing, template
  literals in `{…}`, `onsubmit`) were already fixed — now locked with regression
  tests.

### 4. Capability gaps — ✅ DONE (as optional packages, not core)
- ✅ Router **dynamic routes** (`/blog/:id` → `route.params`) — shipped (0.5.0).
- ✅ **`spark-html-head`** — reactive `<title>`/`<meta>` per route, 0 deps (0.1.0).
- ✅ **`Map`/`Set` reactivity** — mutating a Map/Set in state or a store now
  re-renders; methods still run on the real collection (0.21.5).
- ✅ **Nested routes / layouts** — nest `<template route>`; parent layouts are
  kept alive across child navigation (state preserved). (router 0.6.0)
- ✅ **`spark-html-motion`** — declarative `transition="fade|slide|scale"` on
  if/each blocks via a tiny `lifecycle()` seam in core + the Web Animations API
  (0 deps). Leaving nodes are held until their exit animation finishes; honors
  prefers-reduced-motion. (motion 0.1.0, spark-html 0.21.6.)
- ✅ **Router focus on navigation** — moves focus into the new view and resets
  scroll (to `#hash` or top) on forward nav; leaves Back/Forward alone. Custom
  target via `[data-router-focus]`. (router 0.7.0.)

### 5. Trust & quality — ✅ DONE
- ✅ CI bundle-size guard — `npm run size` (and part of `npm test`) fails if the
  minified+gzipped runtime exceeds 12 KB. Currently ~10.2 KB.
- ✅ One real-browser e2e (Playwright): builds the site and drives Chromium
  through mount → hydrate → router → theme (`npm run e2e`, `e2e` CI workflow).

## Guardrails — what to refuse (this is how Spark stays unique)

- ❌ No required build step / compiler in core.
- ❌ No virtual DOM.
- ❌ No `.spark` dialect or JSX — components stay real `.html`.
- ❌ No SSR runtime server (build-time `spark-prerender` is the right amount).
- ❌ No core bloat past its byte budget — say no, or make it a package.
