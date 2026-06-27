# ⚡ spark-html-theme

One-line dark / light / system theming for [spark-html](https://www.npmjs.com/package/spark-html).
Creates a reactive `theme` store, applies a `data-theme` attribute to `<html>`,
follows the OS preference, and remembers the choice — no boilerplate.

```js
// main.js
import { theme } from 'spark-html-theme';
theme();                 // that's it
```

```html
<!-- components/theme-toggle.html -->
<button onclick="{theme.toggle}">{theme.resolved}</button>

<script>
  const theme = useStore('theme');   // { mode, resolved, toggle, set }
</script>
```

Then style with the attribute:

```css
:root        { --bg: #fff; --text: #111; }
[data-theme="dark"] { --bg: #000; --text: #fff; }
body { background: var(--bg); color: var(--text); }
```

## Install

```bash
npm install spark-html-theme
```

## The `theme` store

| Field        | Meaning |
|--------------|---------|
| `mode`       | The user's choice: `'system'` \| `'light'` \| `'dark'`. |
| `resolved`   | What actually applies right now: `'light'` \| `'dark'`. |
| `toggle()`   | Flip the visible theme (light↔dark) — **always a visible change**. Best for a single toggle button. Persists. |
| `cycle()`    | Advance through `modes` (tri-state, includes `'system'`). Adjacent modes can look identical. Persists. |
| `set(mode)`  | Jump to a specific mode and persist. |

Both `mode` and `resolved` are reactive — read them in any component via
`useStore('theme')`.

## Options

```js
theme({
  key: 'theme-mode',                 // localStorage key
  attribute: 'data-theme',           // attribute written on <html>
  modes: ['system', 'light', 'dark'],// toggle() cycle order
  name: 'theme',                     // store name
});
```

## No flash of the wrong theme

A `type="module"` script runs after first paint, so add a tiny inline script to
`<head>` to set the theme before the page renders:

```html
<script>
  document.documentElement.dataset.theme =
    (localStorage.getItem('theme-mode') === 'dark' ||
     ((localStorage.getItem('theme-mode') || 'system') === 'system' &&
      matchMedia('(prefers-color-scheme: dark)').matches)) ? 'dark' : 'light';
</script>
```

(Or import `themeInitScript()` to get that string and inline it from your build.)
