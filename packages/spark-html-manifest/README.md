# ⚡ spark-html-manifest

PWA setup for [spark-html](https://www.npmjs.com/package/spark-html) sites
from a **single config** — a Vite plugin that generates
`manifest.webmanifest`, resizes your icons from one source image, injects
the `<head>` tags, and (optionally) emits a minimal offline app-shell
service worker. No manual icon exports, no copy-paste boilerplate.

```js
// vite.config.js
import spark from 'spark-html/vite';
import prerender from 'spark-prerender/vite';
import manifest from 'spark-html-manifest/vite';

export default {
  plugins: [
    spark(),
    prerender(),
    manifest({
      name: 'My Spark App',
      shortName: 'Spark',
      themeColor: '#ffd24a',
      icon: 'public/icon.png', // one image → 192 + 512 png, resized with sharp
      offline: true,           // minimal offline app shell + auto registration
    }),
  ],
};
```

That's the whole setup. `npm run build` now produces:

- `manifest.webmanifest` — name, colors, display mode, icons
- `icons/spark-192.png`, `icons/spark-512.png` — resized from your source
- `<link rel="manifest">`, `<meta name="theme-color">`, apple-touch-icon —
  injected into **every** built page (after `spark-prerender` writes them)
- with `offline: true`: `spark-manifest-sw.js` + its registration script

In dev, the manifest and worker are served straight from config, so
Lighthouse/devtools "installable" checks pass locally too.

## Install

```bash
npm install spark-html-manifest
```

## Config

```js
manifest({
  name: 'My Spark App',        // required
  shortName: 'Spark',          // home-screen label (default: name)
  description: '…',
  themeColor: '#ffd24a',       // default '#ffffff'
  backgroundColor: '#000000',  // default: themeColor
  display: 'standalone',       // 'standalone' | 'browser' | 'minimal-ui' | 'fullscreen'
  startUrl: '.',
  icon: 'public/icon.png',     // source image (≥512px recommended)
  sizes: [192, 512],           // generated sizes
  icons: [{ src: '…' }],       // OR: explicit icons — skips generation
  filename: 'manifest.webmanifest',
  offline: { shell: ['./'], version: '1' }, // or just `true`
  extra: { shortcuts: [...] }, // merged verbatim into the manifest
});
```

## The offline worker

`offline: true` emits a deliberately small service worker:

- the **app shell** (`shell` URLs) is precached at install;
- Vite's hash-named `/assets/…` files are **cache-first** (they're immutable);
- everything else same-origin is **network-first** with cache fallback — the
  app opens offline but is never a deploy behind while online;
- offline navigation to any route falls back to the shell.

Want offline **URL-imported components** (cross-origin CDN imports) instead
or as well? That's [spark-html-offline](https://www.npmjs.com/package/spark-html-offline) —
note a page registers one worker per scope, so pick the one that matches
your need (this one covers your own origin; spark-html-offline covers CDNs).

## Programmatic API

Everything the plugin does is exposed as pure functions:

| Export | Meaning |
|--------|---------|
| `manifestJson(config)` | The manifest object. |
| `manifestHtml(config, { href, sw })` | The `<head>` block as a string. |
| `swSource(options?)` | The app-shell worker source. |
| `iconPath(config, size)` | Generated icon file name. |
| `ICON_SIZES` | Default sizes (`[192, 512]`). |

`sharp` is imported lazily — if it can't load on your build machine, icons
are skipped with a warning and everything else still works.

## License

MIT
