# ⚡ spark-html-font

Font loading optimizer for [spark-html](https://www.npmjs.com/package/spark-html)
sites — configure every font **once**, get the whole loading story: correct
`@font-face` + `font-display`, preload links, and a **size-adjusted fallback
face** so the swap doesn't shift the layout. Zero dependencies.

```js
// vite.config.js — bake into every built page
import font from 'spark-html-font/vite';

export default {
  plugins: [spark(), prerender(), font({
    fonts: [
      { family: 'Inter', src: '/fonts/inter-var.woff2', weight: '100 900' },
      { family: 'Fira Code', google: true, weights: [400, 700] },
    ],
  })],
};
```

```css
body { font-family: var(--font-inter); }
code { font-family: var(--font-fira-code); }
```

What lands in `<head>` (before `</head>`, on every built page):

- `<link rel="preload" as="font">` per self-hosted file — the fetch starts
  with the HTML;
- an inline `<style>` with the `@font-face` rules (`font-display: swap` by
  default) **plus** an `"Inter Fallback"` face — `local("Arial")` with
  `size-adjust` / `ascent-override` / `descent-override` — so text set in the
  fallback occupies the same space as the real font: **no layout shift on
  swap**;
- for Google fonts: `preconnect` to both Google hosts + the `css2`
  stylesheet URL (no build-time network);
- a `--font-<slug>` CSS var per family with the full stack
  (`"Inter", "Inter Fallback", system-ui, sans-serif`).

Built-in approximate fallback metrics ship for popular families (Inter,
Roboto, Open Sans, Lato, Montserrat, Poppins, Nunito, Source Sans Pro);
pass `metrics: { sizeAdjust, ascent, descent, lineGap }` for anything else,
or `adjust: false` to skip the fallback face.

## Runtime form

No build step? Inject the same tags from main.js:

```js
import { fonts } from 'spark-html-font';
fonts({ fonts: [{ family: 'Inter', src: '/fonts/inter-var.woff2' }] });
```

Idempotent; returns a `stop()` that removes the tags.

## Install

```bash
npm install -D spark-html-font
```

## Options

| Option (per font) | Meaning |
|--------|---------|
| `family` | The font-family name. |
| `src` | Self-hosted file(s); format sniffed from the extension. |
| `google: true` | Google-hosted — emits preconnect + css2 stylesheet instead. |
| `weight` / `weights` | `400`, `"100 900"` (variable), or `[400, 700]` for Google. |
| `display` | `font-display` strategy, default `swap`. |
| `metrics` / `adjust` / `adjustFrom` | Fallback-face tuning (see above). |
| `preload` | Per-font preload toggle; also a top-level `preload` for all. |

Top-level: `fallback` — generic families appended to every var stack
(default `['system-ui', 'sans-serif']`).
