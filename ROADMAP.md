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
| 2 | Editor + dev tooling | ◻ Not started |
| 3 | Ergonomic papercuts in core | ◻ Not started |
| 4 | Capability gaps (motion, nested routes, head helper) | ⏳ Partial |
| 5 | Trust & quality — size guard ✅ / e2e ◻ | ⏳ Partial |

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

### 2. Editor + dev tooling — ◻ NOT STARTED  ← recommended next
- ◻ **VS Code extension**: highlight `{expr}`, `$:`, `bind:`, `:attr` in `.html`
  components; Emmet; surface runtime warnings as diagnostics.
- ◻ **True HMR**: the Vite plugin still does `full-reload` (state lost on edit) —
  swap-in-place is a dev-only win.
- ◻ **Spark DevTools**: component tree + store state + which bindings re-evaluated.

### 3. Ergonomic papercuts in core — ◻ NOT STARTED
- ◻ **Inline event expressions**: `onclick={count++}` still compiles to
  `count++(event)` and breaks — detect callable-ref vs statement.
- ◻ Documented quirks: comma `let a='', b=''` chains, `let name` shadowing,
  template-literals in attribute exprs, `onsubmit` reactivity.

### 4. Capability gaps — ⏳ PARTIAL (as optional packages, not core)
- ✅ Router **dynamic routes** (`/blog/:id` → `route.params`) — shipped (0.5.0).
- ◻ `spark-html-motion`: CSS-based `transition:fade`/`:slide` (no compiler).
- ◻ Router: **nested routes / layouts**; focus management on navigation (a11y).
- ◻ A `head`/meta helper (hand-rolled in novo + the website — wants to be a package).
- ◻ `Map`/`Set` reactivity (only if demanded).

### 5. Trust & quality — ⏳ PARTIAL
- ✅ CI bundle-size guard — `npm run size` (and part of `npm test`) fails if the
  minified+gzipped runtime exceeds 12 KB. Currently ~9.9 KB.
- ◻ One real-browser e2e (Playwright): mount → hydrate → router → theme.

## Guardrails — what to refuse (this is how Spark stays unique)

- ❌ No required build step / compiler in core.
- ❌ No virtual DOM.
- ❌ No `.spark` dialect or JSX — components stay real `.html`.
- ❌ No SSR runtime server (build-time `spark-prerender` is the right amount).
- ❌ No core bloat past its byte budget — say no, or make it a package.
