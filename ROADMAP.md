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

## Priorities

### 1. Zero-build / CDN / URL-import — lean into the one thing nobody else has ⭐ (in progress)
The sharpest, most under-exploited differentiator. Already true in the code
(`mount()` fetches components; the package is single-file ESM):
- `import { mount } from 'https://esm.sh/spark-html'` — no npm, no Vite, no build.
- Components served as static files; importable **by URL** (`import="https://…/card.html"`).
- Ship: a documented "no install, no build" quickstart, an `examples/no-build/`
  that runs on any static server, and URL-import hardening. No other framework
  (React/Svelte/Vue/Solid) can do this.

### 2. Editor + dev tooling — the biggest *adoption* lever, zero uniqueness cost
- **VS Code extension**: highlight `{expr}`, `$:`, `bind:`, `:attr` in `.html`
  components; Emmet; surface the runtime warnings as diagnostics.
- **True HMR**: the Vite plugin does `full-reload` today (state lost on edit) —
  swap-in-place is a dev-only win.
- **Spark DevTools**: component tree + store state + which bindings re-evaluated
  (makes "surgical reactivity" visible).

### 3. Ergonomic papercuts in core (cheap credibility)
- **Inline event expressions**: `onclick={count++}` compiles to `count++(event)`
  and breaks — must detect callable-ref vs statement.
- Documented quirks: comma `let a='', b=''` chains, `let name` shadowing,
  template-literals in attribute exprs, `onsubmit` reactivity.

### 4. Capability gaps — as optional packages, not core
- `spark-html-motion`: CSS-based `transition:fade`/`:slide` (no compiler).
- Router: nested routes / layouts; focus management on navigation (a11y).
- A `head`/meta helper (hand-rolled in novo + the website — wants to be a package).
- `Map`/`Set` reactivity (only if demanded).

### 5. Trust & quality
- One real-browser e2e (Playwright): mount → hydrate → router → theme.
- CI bundle-size guard (fail if `spark-html` gzip exceeds budget).

## Guardrails — what to refuse (this is how Spark stays unique)

- ❌ No required build step / compiler in core.
- ❌ No virtual DOM.
- ❌ No `.spark` dialect or JSX — components stay real `.html`.
- ❌ No SSR runtime server (build-time `spark-prerender` is the right amount).
- ❌ No core bloat past its byte budget — say no, or make it a package.
