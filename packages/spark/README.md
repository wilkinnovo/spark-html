# ⚡ spark-html

Single-file HTML components with built-in reactivity. No compiler, no virtual DOM, no build step.

## Install

Scaffold a ready-to-run app (Vite + plugin + live welcome screen):

```bash
npx create-spark-html-app yourapp
cd yourapp && npm install && npm run dev
```

Or add Spark to an existing project:

```bash
npm install spark-html
```

## Quick start

A component is a plain `.html` file — markup, script, style:

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

Import it in your page and mount:

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

## With Vite

```js
// vite.config.js
import { defineConfig } from 'vite';
import spark from 'spark-html/vite';

export default defineConfig({ plugins: [spark()] });
```

The plugin serves component fragments raw and full-reloads when they change.

## API

### Template syntax

| Feature             | Syntax                                           |
|---------------------|--------------------------------------------------|
| Text binding        | `<p>Hello {name}</p>`                            |
| Expressions         | `<p>{price * qty}</p>` `{ok ? 'x' : 'y'}`        |
| Events              | `<button onclick={add}>`                         |
| Dynamic attributes  | `<button :disabled="count >= 10">`               |
| Attribute interp    | `<input value="{input}">`                        |
| Loops               | `<template each="todo in todos">…</template>`    |
| Loops with index    | `<template each="todo, i in todos">…</template>` |
| Keyed loops         | `<template each="row in rows" key="row.id">…`    |
| Scoped styles       | `<style>` auto-scoped to the component           |
| Global styles       | `:global(body)` / `:global(.x) .y` escapes scoping (anywhere in a selector) |
| Two-way binding     | `<input bind:value="draft">` / `bind:checked`     |
| Reactive statements | `$: doubled = count * 2` — re-runs on change      |
| Conditional blocks  | `<template if="show">…</template>`                |
| Slots               | `<slot>` / `<slot name="title">` — project caller content |
| Lifecycle           | `onMount(fn)` builtin; return a fn for cleanup    |
| Escape hatch        | `spark-ignore` attribute — subtree never patched  |

### Props

Attributes on the import placeholder become props. `export let` in the
component declares which variables are props, with defaults:

```html
<div import="components/profile" name="Ada Lovelace" age="36" admin></div>
```

```html
<!-- components/profile.html -->
<h2>{name}{admin ? ' (admin)' : ''}, {age}</h2>
<script>
  export let name = 'Anonymous';
  export let age = 0;        // "36" is coerced to number 36
  export let admin = false;  // bare attribute → true
</script>
```

Coercion: numbers, `true`/`false`, `null`, and JSON (`items='["a","b"]'`)
are parsed; everything else stays a string. Variables declared with plain
`let` are private — outside attributes cannot override them.

### Stores (shared state)

Create named stores in app code; subscribe from any component with the
`useStore` builtin. Every subscriber re-patches when the store changes:

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
    cart.items = [...cart.items, 'thing'];
    cart.total = cart.total + 4;
  }
</script>
```

### JavaScript

```js
import { mount, unmount, component, store } from 'spark-html';

await mount();          // whole document
await mount('#app');    // a subtree
unmount(el);            // run onMount cleanups + drop store subs, then remove el

// register a component from a string (no file needed) — great for tests
component('hello', `
  <h1>Hi {who}</h1>
  <script>let who = 'tester';<\/script>
`);
```

## How it works

1. `mount()` finds `<div import="...">` placeholders and fetches each file.
2. Script and style are extracted from the raw text **before** the markup
   touches `innerHTML` (browsers strip script tags injected that way).
3. The script runs inside a `Proxy` scope; every assignment schedules a
   patch of only that component's DOM. Patches are batched onto a single
   microtask, so a burst of assignments costs one DOM update. Plain
   objects/arrays read from scope are deeply reactive, so `todos.push(x)`
   and `row.done = true` re-render without replacing the value.
4. Patches are cheap by construction. Static subtrees (no bindings) are
   walked once and then skipped, so a patch costs work proportional to the
   *dynamic* nodes, not the whole tree. And while a binding (or `$:`) is
   evaluated the scope records which keys it read, so a plain `count++`
   re-evaluates only the bindings that read `count` — O(changed). Changes
   that can't be pinned to a key (deep mutation, store writes, member-path
   binds) fall back to a full, still-cheap pass — never stale.
5. Styles are auto-scoped via a `[name="component"]` prefix by a small CSS
   parser: `@media`/`@supports` selectors scope correctly, `@keyframes`/
   `@font-face` are left alone, and `:global(…)` opts out anywhere in a
   selector.
6. Loops reconcile: each item keeps its DOM nodes across updates (matched
   by index, or by `key`), so inputs inside loops keep focus.
7. A cloak style hides components until they're booted and patched — no
   flash of raw `{braces}` or unstyled markup on load.

## Limits

- One reactive scope per component (top-level `let`/`function`)
- Block-scoped `let/const` inside functions hoist to component scope
- Plain objects/arrays are deeply reactive; `Map`/`Set`/class instances are
  not tracked — reassign them to update. Loops reconcile by index — add
  `key="…"` for identity-stable reordering
- No SSR/hydration (client-rendered) and no built-in router (a companion
  package); the runtime uses `new Function` so a strict CSP needs `unsafe-eval`
