# ⚡ spark-html-bun

Dev server, bundler, and preview server for [spark-html](https://www.npmjs.com/package/spark-html)
apps — built **entirely on [Bun](https://bun.sh)**, zero dependencies. It's what
replaces the old Vite setup: `spark dev` / `spark build` / `spark preview`.

```jsonc
// package.json
"scripts": {
  "dev":     "spark dev",
  "build":   "spark build",
  "preview": "spark preview"
}
```

```bash
bun add -d spark-html-bun
bun dev
```

## What each command does

- **`spark dev`** — `Bun.serve` over your project root + `public/`. Component
  fragments (`components/*.html`) are served **raw** with `no-cache`, never
  rewritten. Bare imports resolve through an injected `<script type="importmap">`
  (built from your `package.json`), so the browser runs your ES modules directly
  — **no bundling in dev**. Scoped component HMR rides a plain WebSocket
  (`/__spark_hmr`) + `fs.watch`: edit a component and only its instances
  re-mount — fresh markup **and** fresh scoped CSS — sibling state preserved
  (slotted / loop-managed hosts full-reload, always correct; components not on
  the current page are a no-op — the next mount fetches them fresh). Editing a
  `.css` file swaps the matching `<link>` in place with no reload; editing page
  HTML or a JS module reloads. Editor save patterns (temp file + rename) are
  debounced into a single update.
- **`spark build`** — empties `dist/`, copies `public/` verbatim (components ship
  as authored), bundles the HTML entry's scripts/styles with `Bun.build`
  (hashed under `assets/`, `base` honored), then runs the **pipeline** in order.
- **`spark preview`** — static server over `dist/` with the same rewrites the
  deploy targets apply: exact file → `path + '.html'` (the `_redirects`
  convention `spark-prerender` emits) → `404.html`.

CLI flags: `--port N`, `--base /repo/`, `--out-dir dir`, `--strict-port`.

## Configuration

Everything has a default — `spark.config.js` is optional:

```js
// spark.config.js
import prerender from 'spark-prerender/bun';
import image from 'spark-html-image/bun';

export default {
  base: '/',                 // deploy prefix (GitHub Pages: '/repo/')
  entry: 'index.html',
  outDir: 'dist',
  publicDir: 'public',
  componentsDir: 'components',
  pipeline: [prerender({ site: 'https://example.com' }), image()],
};
```

The **pipeline** is an explicit, ordered array of build steps — each companion
package ships one at `pkg/bun`:

| Step | Package |
|------|---------|
| `prerender()` | `spark-prerender/bun` — SEO prerender + sitemap/robots/redirects |
| `image()` | `spark-html-image/bun` — webp/avif + responsive `srcset` |
| `font()` | `spark-html-font/bun` — preload + size-adjusted fallbacks |
| `manifest()` | `spark-html-manifest/bun` — PWA manifest + icons + worker |
| `offline()` | `spark-html-offline/bun` — offline service worker |
| `sri()` | `spark-html-sri/bun` — hash + stamp integrity (run **last**) |

Order matters: `prerender()` first (it writes one HTML file per route), then the
steps that rewrite those pages; `sri()` last so it hashes the final bytes.

## `import.meta.env`

Vite-compatible `BASE_URL` / `DEV` / `PROD` / `MODE` are available in your app
source — substituted at serve time in dev, and via `Bun.build`'s `define` in the
build. No bundler config needed.

## Programmatic API

```js
import { dev, build, preview, loadConfig } from 'spark-html-bun';

const server = await dev({ port: 3000 });   // returns the Bun server
await build({ base: '/repo/' });            // returns { outDir }
```

## Requirements

Bun ≥ 1.2. Spark itself has no hard dependency on this package — any static file
server works — but `spark-html-bun` gives you scoped HMR, no-build dev, and the
whole build pipeline in one tool.

## License

MIT
