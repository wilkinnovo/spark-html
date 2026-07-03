# ⚡ spark-html-sri

Subresource Integrity for [spark-html](https://www.npmjs.com/package/spark-html)
— auto-hash every built asset **and** verify URL-imported components at
runtime. Same mental model as `<script integrity>`, applied to the whole
app. Zero dependencies, zero bytes added to the spark-html core.

```js
// src/main.js — before mount()/router()
import { sri } from 'spark-html-sri';
sri();
```

```js
// vite.config.js — after prerender()
import spark from 'spark-html/vite';
import prerender from 'spark-prerender/vite';
import sriPlugin from 'spark-html-sri/vite';

export default { plugins: [spark(), prerender(), sriPlugin()] };
```

## Install

```bash
npm install spark-html-sri
```

## What you get

**Local files — fully automatic, zero config.** At build time the vite
plugin hashes every JS/CSS file and every component fragment (SHA-384 by
default), stamps `integrity` + `crossorigin="anonymous"` onto the
`<script>`/`<link>` tags (the browser enforces those natively), and bakes
a path → hash manifest into each page. At runtime `sri()` verifies every
component fetch against that manifest before spark-html boots it. A
tampered file — a compromised host, a poisoned cache — is rejected with a
clear console error instead of running.

**Remote URL imports** (`<div import="https://…">`) — **allow list + TOFU.**
Only whitelisted origins can be imported at all:

```js
sri({
  allow: ['cdn.jsdelivr.net', 'unpkg.com', 'esm.sh', 'raw.githubusercontent.com'], // the default
});
```

For allowed origins, integrity is verified via **trust on first use**: the
first fetch stores the content hash (in `localStorage`), and every later
load must hash the same. A CDN compromised *after* your first visit serves
bytes that no longer match — the component is blocked before it runs.
Import pinned URLs (`…@1.2.3/card.html`) so legitimate updates are new
URLs; if you import a mutable URL and it changes on purpose, call
`resetTofu()` (or bump the URL).

**Your API calls are untouched.** Only same-origin paths present in the
build manifest and cross-origin `.html` component imports are governed —
every other fetch passes straight through.

## Dev vs production

`enforce: 'auto'` (the default) **fails open on localhost** — violations
warn in the console but nothing is blocked, so dev servers and HMR are
never in your way — and **enforces everywhere else**. Set `enforce: true`
or `false` to override.

## Options

```js
sri({
  manifest: { '/components/nav.html': 'sha384-…' }, // default: baked in by the vite plugin
  allow: ['esm.sh'],          // remote hosts (subdomains included)
  enforce: 'auto',            // true | false | 'auto' (auto = enforce unless localhost)
  onViolation: (msg, url) => report(msg, url),
});
```

```js
sriPlugin({ algorithm: 'sha384' }); // 'sha256' | 'sha384' | 'sha512'
```

## API

| Export | Meaning |
|--------|---------|
| `sri(options?)` | Install the fetch guard. Returns a restore function. |
| `integrity(data, algo?)` | Compute an SRI string — `"sha384-…"`. |
| `verify(data, integrityString)` | Check data against an SRI string (space-separated list allowed). |
| `resetTofu()` | Forget every remembered remote-component hash. |
| `DEFAULT_ALLOW` | The default remote allow list. |
| `spark-html-sri/vite` | Build plugin — hash, stamp, bake the manifest. |

## Why not put this in the core?

The spark-html runtime has a frozen 13 kB budget. Verification lives here
instead, as an opt-in wrapper around `fetch` — projects that don't use SRI
pay zero bytes, and the core stays tiny.

## License

MIT
