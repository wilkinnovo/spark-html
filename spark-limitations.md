# Spark Limitations

Originally discovered while building an Unsplash-like gallery with component composition, slots, and dynamic data, against `spark-html@0.15.0`. Items fixed in later releases are marked below.

## 1. `import` inside `<template each>` loops — ✅ FIXED in 0.16.0

```html
<!-- Works as of 0.16.0 -->
<template each="item in items">
  <div import="components/my-card" title="{item.title}">...</div>
</template>
```

**What was wrong:** `querySelectorAll('[import]')` does not descend into `<template>` content (its children live in a separate `DocumentFragment`), so `mount()`'s one-shot import resolution never saw placeholders cloned out of a loop. The cloaked placeholder then sat empty — a silent failure.

**The fix:** each/if blocks now resolve their `[import]` placeholders when they render — fetching, booting, and swapping in the component host — with the placeholder's path and prop attributes interpolated against the loop scope (`import="/users/{u.id}"`, `name="{u.name}"`). Imports inside `<template if>` work the same way.

## 2. Slot content cannot reference `each` loop variables

```html
<!-- BROKEN: slot content can't see `item` from the each loop -->
<template each="item in items">
  <div import="components/wrapper">
    <span slot="title">{item.name}</span>
  </div>
</template>
```

**Why:** Slot content is patched with `parentHost.__sparkScope` — the parent component's top-level scope. The each-loop proxy scope is a separate scope chain that is not accessible from slot projection.

**Workaround:** Keep inline rendering inside each loops; use components only outside loops.

## 3. `export let` props — ✅ work (the original report was a misdiagnosis)

```html
<!-- components/modal.html -->
<script>
  export let id = '';
  export let author = '';
</script>
```

`export let` props **do** work in served components: the placeholder's attributes override the declared defaults. The original "doesn't render" symptom came from limitation #1 — the failing case was an `export let` component imported *inside an each-loop*, which never resolved at all (so its props never applied). The blame landed on `export let` rather than on the loop-import bug. With #1 fixed, both symptoms are gone.

```html
<!-- works: prop overrides the default -->
<div import="components/modal" id="42" author="Ada"></div>
```

`store()` / `useStore()` (section 8) is still the right tool for *shared* cross-component state; `export let` is for passing data down to a child.

## 4. Attribute interpolation `{expr}` in slot content `src` attributes

```html
<!-- may not evaluate correctly -->
<img slot="image" src="https://example.com/id/{selected.id}/1000" />
```

Attribute interpolation (`{...}` inside attribute values) may not be evaluated when the element is projected into a slot. The image may fail to load silently.

**Workaround:** Render images directly in the parent template (outside slot projection), or construct the URL in the parent scope using `:src` dynamic attribute.

## 5. `:hidden` with CSS `display` — hidden attribute can be overridden

```html
<!-- Login screen stays visible after :hidden sets the attribute -->
<div class="login-screen" :hidden="isLoggedIn">
```

```css
.login-screen { display: flex; }  /* overrides [hidden] { display: none } */
```

**Why:** Spark's `:hidden` directive sets/removes the HTML `hidden` attribute. The browser's user-agent stylesheet has `[hidden] { display: none; }`, but an author stylesheet rule like `.login-screen { display: flex; }` has higher specificity (0,1,0 vs 0,0,1), so `display: flex` wins — the element stays visible even though `hidden` is present.

**Workaround:** Add a global `!important` rule so `hidden` always hides:
```css
:global([hidden]) { display: none !important; }
```

## 6. `:hidden` with string expressions — non-boolean evaluation

```html
<!-- Always hidden, even when query is empty -->
<section class="hero" :hidden="query">
```

**Why:** Spark's `:hidden` directive checks `typeof result === 'boolean'`. When the expression evaluates to a string (e.g. `""` or `"hello"`), it falls through to the else branch and calls `el.setAttribute("hidden", String(result))`. This sets `hidden=""` (string) instead of removing it, so the element is always hidden regardless of the value.

**Workaround:** Always use a boolean expression with `:hidden`:
```html
<section class="hero" :hidden="query !== ''">
```

## 7. `onclick` expression syntax — block statements with semicolons do not work

```html
<!-- BROKEN: semicolon inside block causes parse error -->
<button onclick="{
    handleClick;
}">
```

**Why:** Spark parses the expression inside `{...}` as an attribute value. A block statement `{ handleClick; }` is valid JavaScript but Spark's expression parser treats the semicolon as unexpected, throwing `Syntax error in expression`.

**Workaround:** Use an unquoted bare function reference:
```html
<button onclick={handleClick}>
```

This also works inline with multiple statements:
```html
<button onclick="doOne(); doTwo()">
```

## 8. `store()` / `useStore()` — shared reactive state

`store()` and `useStore()` are the recommended mechanism for cross-component communication (since `export let` props do not work).

### Creating a store (`main.js`)

```js
import { mount, store } from 'spark-html';

store('auth', { isLoggedIn: false, user: null });
mount();
```

Stores must be created with `store()` **before** `mount()`.

### Using a store in any component script

`useStore` is a builtin available in every component script — **no import needed**:

```html
<script>
  const auth = useStore('auth');
  auth.isLoggedIn = true;       // triggers re-render in all subscribers
</script>
```

### Store data structure quirk

`store()` spreads the initial value: `{ ...(initial || {}) }`. If you pass an array, elements become numeric keys on an object, losing array methods:

```js
store('items', [1, 2, 3]);      // state becomes { 0: 1, 1: 2, 2: 3 }
```

**Workaround:** wrap arrays in an object:

```js
store('photos', { list: [] });
// access: photos.list
// reassign: photos.list = updated;
```

### Reactive syncing to local scope

Use `$:` to sync store properties into local variables so the template can reference them without a prefix:

```js
const auth = useStore('auth');
$: isLoggedIn = auth.isLoggedIn;
$: currentUser = auth.user;
```

### bind:value with store properties

```html
<input bind:value="ui.formUrl" />
```

Works as expected — the store property is read and written reactively.

### template if with store properties

```html
<template if="ui.showForm">
  ...
</template>
```

Conditional rendering from store values works correctly.

## 9. Component CSS scoping

Spark automatically scopes component `<style>` blocks. Every selector is prefixed with `[name="component-name"]`:

```css
/* Your component style */
.card { background: #fff; }

/* Becomes: */
[name="components/my-card"] .card { background: #fff; }
```

This means component styles are isolated and won't leak to parent or sibling components.

### Bypassing scoping with `:global()`

```css
:global(body) { font-family: sans-serif; }
:global([hidden]) { display: none !important; }
:global(.theme-dark) .card { color: #fff; }   /* partial — now supported */
```

Wrapping a selector (or any part of one) in `:global()` prevents the scoping
prefix from being added to that part.

### CSS scoping internals — ✅ rewritten as a proper parser

The old `scopeCss` was a single regex. It has been replaced by a small,
0-dependency CSS tokenizer that fixes the whole class of bugs the regex caused:

- **`@media` / `@supports` now scope correctly.** Selectors inside them get the
  same `[name="…"]` prefix as base rules — so a responsive override and its base
  rule have *equal* specificity and the later (media) rule wins by source order.
  No more `:global()` workaround for responsive styles.
- **`@keyframes` are left alone.** Step selectors (`0%`, `100%`, `from`, `to`)
  are no longer mis-scoped, so animations work. `@font-face`/`@page` bodies are
  likewise untouched.
- **Comments are stripped first**, so `/* … */` can't bleed into a selector.
- **`:global()` works anywhere in a selector**, not only when it wraps the whole
  thing — `:global(.a) .b` → `.a [name="…"] .b`.

### Sharing styles across components

Each component needs its own `<style>` block for the classes it uses. The same class name in two components results in two separate scoped rules, so `.backdrop` in `photo-form.html` and `.backdrop` in `photo-detail.html` produce independent rules.

## 10. `template if` with `each` — local scope isolation

Variables declared inside an `each` loop body are isolated to the loop iteration. This means you cannot access `photo` from inside a separate `<template if>` block:

```html
<template each="photo in photos">
  <div>{photo.title}</div>
</template>
<template if="someCondition">
  <!-- photo is NOT accessible here -->
</template>
```

## Summary of what works

| Feature | Works? |
|---------|--------|
| Top-level `import` with slots | Yes |
| Named slots (`slot="name"`) | Yes |
| Multiple elements to same named slot | Yes |
| Parent-scoped expressions in slot content (`{var}`, `onclick={fn}`, `bind:value`) | Yes |
| `template each` — inline rendering | Yes |
| `template if` — inline rendering | Yes |
| `$:` reactive statements | Yes |
| `$:` with store properties (`$: x = store.prop`) | Yes |
| `:attr` dynamic attributes (`:data-id`, `:src`) | Yes |
| `:hidden` with boolean expression | Yes (with `!important` workaround) |
| `<style>` scoped to component | Yes |
| `:global()` scoping escape (whole **or partial** selector) | Yes |
| Scoped selectors inside `@media` / `@supports` | Yes (parser rewrite) |
| `@keyframes` / `@font-face` left unscoped | Yes (parser rewrite) |
| `store()` / `useStore()` | Yes |
| `bind:value` with store properties | Yes |
| `template if` with store properties | Yes |
| `onclick={funcName}` (unquoted) | Yes |
| `onerror` inline JS on images | Yes |
| Ternary expressions in templates (`{a ? b : c}`) | Yes |
| `import` inside `template each` / `template if` | Yes (0.16.0) |
| `export let` props in served components | Yes |
| Loop variable access in slot content | **No** |
| `:hidden` with string expression | **No** — must use boolean expression |
| `onclick="{ funcName; }"` (block + semicolons) | **No** — use `onclick={funcName}` |

## 12. Performance — ✅ no longer O(everything) per change

The original concern was that *any* state change re-ran **all** `$:` statements
and did a **full DOM walk** of the component — O(total nodes), not O(changed).
Two changes fix this without a compiler or a signals rewrite (it's still the
same proxy-based model):

- **Static-subtree skipping (Tier 1).** On the first walk, any subtree with no
  bindings / `each` / `if` / nested component / slot is marked static and
  skipped wholesale on every later patch. A patch now costs O(*dynamic* nodes),
  not O(total). (Measured: a 904-element component re-walks 3 elements on a
  change.) Each element's bindings are also parsed once into a cached "plan"
  instead of re-scanning attributes every patch.
- **Dependency tracking (Tier 2).** While a binding (or `$:`) is evaluated, the
  scope proxy records which keys it reads. A plain top-level write (`count++`)
  then re-evaluates **only** the bindings and `$:` statements that read that key
  — O(changed). (Measured: ~7–8× faster on a targeted update in a 300-field
  component vs. re-evaluating all of them.)

**Safety / fallbacks (never stale):** changes that can't be pinned to a single
key fall back to a full (Tier-1-fast) re-evaluation — in-place deep mutation
(`todos.push`, `row.done = true`), store notifications, and member-path
two-way writes (`bind:value="row.text"`). A binding that reads nothing trackable
(e.g. `{Math.random()}`) is always re-evaluated.

**Remaining gap (honest):** dependency tracking makes *evaluation* O(changed),
but the patch still *traverses* the dynamic nodes (cheap branch checks +
set-intersect) rather than jumping straight to the dirty ones, and `each` loops
still reconcile every flush (per-row evaluation is gated, the reconcile pass is
not). True O(changed) *traversal* — including per-row loop targeting — would
need an effect registry on top of this same tracking substrate; it's the
natural next increment, not a rewrite.

## Additional notes

- **Originally tested:** `spark-html@0.15.0`. Fixes noted above landed in `0.16.0` (loop/if imports) and later.
- **Setup:** Scaffolded with `npx create-spark-html-app`, Vite dev server
- The scaffold's own demo (`welcome.html`) uses no props and no nested each-loop imports — it works entirely within the supported subset above
- Always create stores with `store()` in `main.js` **before** calling `mount()`
- `useStore('name')` is a builtin in component scripts — no `import` statement needed
- Each component fetched from `public/components/` runs its script in an isolated scope — use stores for all cross-component state

## Final word

For a library that's one JS file, the core idea is sound. The proxy-based reactivity, scoped CSS, and file-based components are genuinely well-designed. The limitations are real but knowable — none of them are deal-breakers for the class of apps Spark targets. The two biggest reported gaps — `import` in `each` and `export let` props — are resolved as of 0.16.0; slot loop-variable access remains the main open item.
