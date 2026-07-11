# HTML that reacts. Built for humans.

Single-file HTML components with built-in reactivity. No compiler, no virtual DOM,
no build step — for people who love hand-writing their web apps.

```html
<!-- components/welcome.html -->
<h1>Welcome {name}</h1>

<script>
  let name = 'John Doe';
</script>

<style>
  h1 { color: rebeccapurple; }
</style>
```

**18.00 kB gzipped**.

---

## Install

```bash
bunx create-spark-html-app@latest myapp
cd myapp && bun install && bun dev
```

Or add to an existing project. `spark-html-bun` is the Bun-powered dev
server, bundler, and preview server — no build step required:

```bash
bun add spark-html
bun add -d spark-html-bun
```

```js
// spark.config.js (optional — every field has a default)
export default {};
```

```jsonc
// package.json
{ "scripts": { "dev": "spark dev", "build": "spark build", "preview": "spark preview" } }
```

---

## Quick start

A component is a plain `.html` file — markup, script, and style in one file.

```html
<!-- index.html -->
<body>
  <div import="components/welcome"></div>
  <script type="module">
    import { mount } from 'spark-html';
    mount();
  </script>
</body>
```

That's it. No build step, no framework CLI — `mount()` finds every `<div import="…">`, fetches the component, and activates it.

---

## Template syntax

| Feature                 | Syntax                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Text binding            | `<p>Hello {name}</p>`                                                                                             |
| Expressions             | `<p>{price * qty}</p>` `{ok ? 'x' : 'y'}`                                                                         |
| Events                  | `<button onclick={add}>`                                                                                          |
| Dynamic attributes      | `<button :disabled="count >= 10">`                                                                                |
| Attribute interpolation | `<input value="{input}">`                                                                                         |
| Loops                   | `<template each="todo in todos">…</template>`                                                                     |
| Loop with index         | `<template each="todo, i in todos">…</template>`                                                                  |
| Keyed loops             | `<template each="row in rows" key="row.id">…`                                                                     |
| Conditionals            | `<template if="show">…</template>`                                                                                |
| Else branches           | `<template else-if="score > 60">` / `<template else>` — chain directly after an `if`; first truthy branch renders |
| Async blocks            | `<template await="promise"> + <template then> / <template catch>`                                                 |
| Two-way binding         | `bind:value`, `bind:checked`, `bind:group`, `bind:form`                                                           |
| Reactive statements     | `$: doubled = count * 2`                                                                                          |
| Scoped styles           | `<style>` auto-scoped to the component                                                                            |
| Global style escape     | `:global(body)` / `:global(.x) .y`                                                                                |
| Slots                   | `<slot>` / `<slot name="title">`                                                                                  |
| Lifecycle               | `onMount(fn)` — return a cleanup function                                                                         |
| Literal braces          | `\{` / `\}`                                                                                                       |
| Escape hatch            | `spark-ignore` attribute — subtree never patched                                                                  |

### Async blocks

Declarative loading states with no manual flags:

```html
<template await="loadUser(id)">
  <p>Loading…</p>
  <template then><h1>Hi {await.name}</h1></template>
  <template catch><p>Failed: {await.message}</p></template>
</template>

<script>
  let id = 1;
  async function loadUser(id) {
    const r = await fetch(`/api/users/${id}`);
    if (!r.ok) throw new Error('not found');
    return r.json();
  }
</script>
```

- Reactive — re-evaluates when dependencies change, cancels prior promise, shows loading again.
- `<template await="once(expr)">` fires only on mount.
- Non-promise expressions render `then` immediately.
- `spark-prerender` bakes resolved content into static HTML at build time.

### JS imports

Standard `import` statements work at the top of a component's `<script>` — Spark replays them as dynamic `import()` calls, so there's still no build step:

```html
<!-- components/counter.html -->
<h2>Count: {count}</h2>
<p>{fmt(count)}</p>
<button onclick={inc}>+1</button>

<script>
  import { fmt } from '../lib/format.js';
  let count = 0;
  function inc() { count++; }
</script>
```

- All forms: named (`{ a, b as c }`), default, namespace (`* as m`), side-effect.
- Relative / root-absolute paths resolve against the **component file's** URL; bare specifiers are left to the browser's import maps.
- A script with imports runs async (top-level `await` works); the component reveals only after its modules load, and `mount()` resolves when everything is booted.
- `spark-prerender` executes imports for real at build time, so prerendered HTML contains the actual computed values.

### Props

Attributes on the import placeholder become component props:

```html
<div import="components/profile" name="Ada Lovelace" age="36" admin></div>
```

```html
<!-- components/profile.html -->
<h2>{name}{admin ? ' (admin)' : ''}, {age}</h2>
<script>
  export let name = 'Anonymous';
  export let age = 0;
  export let admin = false;
</script>
```

Numbers, `true`/`false`/`null`, and JSON are coerced automatically; everything else stays a string. Plain `let` variables are private.

### Stores

Named reactive stores shared across components:

```js
// main.js
import { mount, store } from 'spark-html';
store('cart', { items: [], total: 0 });
mount();
```

```html
<!-- any component -->
<p>{cart.items.length} items — ${cart.total}</p>
<script>
  const cart = useStore('cart');
  function add() {
    cart.items.push(thing);
    cart.total += 4;
  }
</script>
```

Stores are deeply reactive — in-place mutations (`push`, `row.key = val`) notify every subscriber automatically.

### Derived stores

Read-only stores computed from other stores:

```js
import { store, derived } from 'spark-html';

store('cart', { items: [] });
derived('cartTotal', ['cart'], (cart) => ({
  count: cart.items.length,
  total: cart.items.reduce((s, i) => s + i.price, 0),
}));
```

Chains and memoizes — only notifies subscribers when a key actually changes.

### Forms

```html
<form bind:form="f" onsubmit={save} novalidate>
  <input name="email" type="email" required bind:value="email" />
  <p :hidden="!(f.submitted && f.errors.email)">{f.errors.email}</p>
  <button type="submit" :disabled="f.pending || !f.valid">
    {f.pending ? 'Saving…' : 'Sign up'}
  </button>
  <p :hidden="!f.error">✗ {f.error?.message}</p>
</form>
```

`bind:form="name"` creates a reactive `{ valid, errors, values, pending, submitted, error }` object driven by native HTML constraint validation. Submit is auto-`preventDefault`'d; async handlers set `pending`/`error` automatically.

---

## How it works

1. **`mount()`** finds `<div import="…">` placeholders and fetches each component file.
2. **Script and style are extracted from raw text** before the markup touches `innerHTML` — browsers strip `<script>` tags injected via `innerHTML`, so text-level extraction sidesteps the whole class of bugs.
3. **The script runs inside a `Proxy` scope** — every assignment schedules a patch of only that component's DOM. Patches are batched onto a single microtask.
4. **Patches are cheap by construction** — static subtrees (no bindings) are walked once and then skipped. A patch costs work proportional to _dynamic_ nodes, not the whole tree. Dependency tracking (`O(changed)`) re-evaluates only bindings that read a changed key.
5. **Deep reactivity** — plain objects and arrays read from scope are wrapped in proxies so `todos.push(x)` and `row.done = true` re-render without replacing the whole value. `Map` and `Set` mutations are tracked too.
6. **Styles are auto-scoped** via a `[name="component"]` prefix. `@media`/`@supports` scope correctly, `@keyframes`/`@font-face` pass through, and `:global(…)` opts out.
7. **Loops reconcile by key** — each item keeps its DOM nodes across updates (matched by index, or by `key`), so inputs inside loops keep focus.
8. **A cloak style** hides components via `visibility:hidden` until booted and patched — no flash of raw `{braces}` or unstyled markup.

---

## Error handling

Failures are **isolated to the component** that caused them — a broken component never blanks the page or stops a sibling from rendering. Broken expressions, `$:` statements, event handlers, script errors, boot, and patch failures are all caught and logged (deduped) with the component name.

Opt into a full-screen **error overlay** for development:

```js
mount(document.body, { devOverlay: true });
// or set globalThis.__SPARK_DEV_OVERLAY__ before mount
```

---

## JavaScript API

```js
import { mount, unmount, component, store, derived, subscribe } from 'spark-html';

await mount();             // mount on document.body
await mount('#app');       // mount on a specific element
unmount(el);               // run onMount cleanups, drop store subs, remove el

store('name', initial);    // create a reactive store
derived('name', deps, fn); // read-only computed store
subscribe('name', fn);     // subscribe to store changes from outside a component

// Register a component from a string (no file needed) — great for tests
component('hello', `
  <h1>Hi {who}</h1>
  <script>let who = 'tester';<\/script>
`);
```

For component-level tests, [`spark-html-test-utils`](https://www.npmjs.com/package/spark-html-test-utils) wraps this with a linkedom `mount(fixture)`, `inspect` helpers, and DOM-event firing.

### Doctor

```bash
npx spark-html doctor
```

Scans the project for the framework's known footguns: duplicate `spark-html`
installs (two runtimes → separate store registries → the "store not created"
class of bug), companion version-range mismatches, and a stale service worker
on a reused dev port. Zero config; exits non-zero when something needs a look.

---

## Performance

**Measured, not claimed.** On the [krausest js-framework-benchmark](https://github.com/krausest/js-framework-benchmark), spark-html 1.8.0 lands a **CPU geomean of 1.185× hand-written vanilla JS** (paired run vs the `vanillajs` reference, 25 iterations, windowed Chrome, official webdriver-ts harness; the upstream submission — PR #2048 — is MERGED, so spark-html is listed in the official benchmark). On the published solidjs.com scale that is **past Vue (1.31) and past Angular (1.45)** — with no build step at all — run memory holds ~1.45× vanilla, and in-place mutation (`rows[i].label += '!'`, `rows[1] = x`) rides the same narrow dirty-key lane as reassignment: the idiomatic spark style is also the fast path (update-every-10th 1.36× → 1.12×). First paint sits at parity with vanilla (the metric is single-sample noisy; the A/B against the prior release read −9 ms by medians — see the repo's `benchmarks.md`):

| Benchmark          | ratio vs vanilla |     | Benchmark          | ratio vs vanilla |
| ------------------ | ---------------: | --- | ------------------ | ---------------: |
| create 1,000 rows  |            1.19× |     | remove one         |            1.16× |
| replace 1,000 rows |            1.19× |     | create 10,000 rows |            1.22× |
| update every 10th  |            1.12× |     | append 1,000       |            1.23× |
| select row         |            1.18× |     | clear              |            1.12× |
| swap rows          |            1.26× |     | **CPU geomean**    |       **1.185×** |

- **Components ship as authored HTML** — no compiler generates code from your template, so there is nothing to parse or evaluate at startup. The file you write is the component that runs.
- **Text-level extraction of `<script>`/`<style>`** — browsers strip `<script>` tags injected via `innerHTML` (the only way most client-only frameworks can parse a fetched HTML fragment). Spark extracts script and style from the raw text with a tokenizer before the markup ever touches the DOM — sidestepping the entire class of bugs that every other runtime-only framework has to work around.
- **No virtual DOM** — patches mutate the DOM directly. No intermediate tree to allocate, diff, or discard per frame.
- **O(changed) dependency tracking** — each binding records which scope keys it reads. A write re-evaluates only the bindings and `$:` statements that actually changed — not a full component walk.

  ```html
  <p>{a} + {b} = {a + b}</p>
  <p>{c}</p>
  <script>
    let a = 1, b = 2, c = 3;
  </script>
  ```

  Updating `a` re-evaluates `{a}` and `{a + b}`. The `{c}` binding is skipped — it didn't read `a`.

- **Row-level loop granularity** — mutating one item in a list re-walks only that row, not every row:

  ```html
  <template each="todo in todos" key="todo.id">
    <p>{todo.text} — {todo.done ? '✓' : '○'}</p>
  </template>
  <script>
    let todos = [{ id: 1, text: 'a', done: false }, /* …999 more… */];
    function toggle() { todos[3].done = true; }
  </script>
  ```

  `toggle()` re-walks only row index 3 — the other 999 rows are untouched. A structural change (push, splice, re-sort) still re-reconciles the list shape but skips rows whose identity (key) didn't move. Deep mutations not pinned to a row fall back to a full (still cheap) pass — never stale.

- **Tracked `Map`/`Set` mutations** — `map.set(key, val)`, `set.add(item)`, and `delete`/`clear` trigger re-renders, just like array push and object property assignment. No special API or immutability discipline required.
- **Keyed reconciliation with minimal moves** — the diff trims the unchanged prefix/suffix and runs a longest-increasing-subsequence pass on the rest (a swap is 2 DOM moves, not 997), rows are created 64 at a time from one native clone of a stamped recipe (template analysis runs once, never per row), and row events use document-level delegation — creating 1,000 rows allocates zero listeners and zero handler closures.
- **Template-level dependency dispatch** — the template's observed dependency graph sends a changed key straight to the affected bindings in every row, with no per-row bookkeeping at all.

## Limits

- **One reactive scope per component** — all top-level `let`/`function` declarations share a single proxy scope within each component.
- **Only top-level declarations become component state** — `let`/`const` inside a function body are true block-scoped locals (as of 0.28), and destructuring (`let {a} = obj`) stays local everywhere.
- **Class instances / `Date`** — not deeply reactive (intentional). Reassign the variable to trigger an update. Plain objects, arrays, `Map`, and `Set` are all tracked.
- **Loops reconcile by index by default** — add `key="…"` for identity-stable reordering (keeps focus, preserves element state).
- **The script rewriter is a scanner, not a parser** — it is string- and comment-aware (code-shaped text inside string literals stays byte-intact, as of 0.30), with one documented unparseable construct: a regex literal containing a quote character. That case warns loudly and names the fix (move the regex to an imported `.js` module).
- **CSP** — the runtime uses `new Function` for expressions and event handlers, so a strict Content Security Policy needs `unsafe-eval`. For integrity of what you _load_, [`spark-html-sri`](https://www.npmjs.com/package/spark-html-sri) hashes and verifies assets and URL-imported components.
- **`import.meta`** — not available inside component scripts (imports are replayed as dynamic `import()`). Bare specifiers need an import map when running without a bundler.

## The Spark family

Small, single-purpose packages that share one philosophy: no compiler, no
virtual DOM, no build step required — built for humans who love hand-writing
their web apps. Add only what you use.

| Package                                                                                  | What it does                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`spark-html`](https://www.npmjs.com/package/spark-html)                                 | The runtime — components, reactivity, stores, forms, scoped styles. 18.00 kB gzip, 0 deps.                                                       |
| [`spark-html-bun`](https://www.npmjs.com/package/spark-html-bun)                         | Dev server, bundler & preview on Bun — scoped HMR, no-build dev, post-build pipeline.                                                            |
| [`spark-html-router`](https://www.npmjs.com/package/spark-html-router)                   | `<template route>` routing — nested routes/layouts, `route.query`, active links.                                                                 |
| [`spark-html-theme`](https://www.npmjs.com/package/spark-html-theme)                     | Dark/light/system theming in one line — persisted, no flash.                                                                                     |
| [`spark-html-head`](https://www.npmjs.com/package/spark-html-head)                       | Reactive `<title>`/`<meta>` per route + a `head` store.                                                                                          |
| [`spark-html-motion`](https://www.npmjs.com/package/spark-html-motion)                   | Enter/leave transitions on if/each blocks — `transition="fade\|slide\|scale"`.                                                                  |
| [`spark-html-devtools`](https://www.npmjs.com/package/spark-html-devtools)               | In-page devtools — live stores, component tree, patch activity.                                                                                  |
| [`spark-html-query`](https://www.npmjs.com/package/spark-html-query)                     | Declarative async data — a self-fetching store (`loading`/`error`/`data`/`refetch`).                                                             |
| [`spark-html-persist`](https://www.npmjs.com/package/spark-html-persist)                 | Persist stores to localStorage/sessionStorage in one line.                                                                                       |
| [`spark-html-websocket`](https://www.npmjs.com/package/spark-html-websocket)             | A WebSocket as a reactive store — auto-reconnect, JSON, `send()`.                                                                                |
| [`spark-ssr`](https://www.npmjs.com/package/spark-ssr)                                   | Full-stack SSR on Bun — the template is the backend: inferred DB, REST CRUD, auth, live updates. Precompiled + response-cached: fast by default. |
| [`spark-prerender`](https://www.npmjs.com/package/spark-prerender)                       | Build-time SEO prerender + sitemap/robots — no SSR server.                                                                                       |
| [`spark-html-image`](https://www.npmjs.com/package/spark-html-image)                     | Build-time image optimization — webp/avif + responsive `srcset`, zero config.                                                                    |
| [`spark-html-font`](https://www.npmjs.com/package/spark-html-font)                       | Font loading optimizer — preload + size-adjusted fallbacks, no FOUT.                                                                             |
| [`spark-html-manifest`](https://www.npmjs.com/package/spark-html-manifest)               | PWA manifest + icons + head tags (and optional service worker) from one config.                                                                  |
| [`spark-html-offline`](https://www.npmjs.com/package/spark-html-offline)                 | Offline URL imports — a service worker that caches CDN components.                                                                               |
| [`spark-html-sri`](https://www.npmjs.com/package/spark-html-sri)                         | Subresource Integrity — hash + verify assets and remote components.                                                                              |
| [`create-spark-html-app`](https://www.npmjs.com/package/create-spark-html-app)           | Scaffold a spark-html app in one command.                                                                                                        |
| [`prettier-plugin-spark`](https://www.npmjs.com/package/prettier-plugin-spark)           | Prettier for components — formats `<script>`/`<style>`, markup stays byte-for-byte.                                                              |
| [`spark-html-language-server`](https://www.npmjs.com/package/spark-html-language-server) | LSP — diagnostics, go-to-definition, prop autocomplete, hover docs.                                                                              |
