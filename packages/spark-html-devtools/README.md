# ⚡ spark-html-devtools

A tiny in-page inspector for [spark-html](https://github.com/wilkinnovo/spark)
apps. Drop it in during development and get a ⚡ panel (bottom-right) showing:

- **Stores** — every named store and its live state.
- **Components** — the component tree (`[name]` hosts) with each component's
  reactive state.
- **Patches** — a counter, plus a brief amber outline on whichever component just
  re-rendered, so Spark's surgical reactivity is *visible*.

It's read-only — it never mutates your app.

```js
import { devtools } from 'spark-html-devtools';

if (import.meta.env?.DEV) devtools();   // dev only
```

## Install

```bash
npm install -D spark-html-devtools
```

## API

```js
const stop = devtools({ open: true }); // start expanded
// …
stop(); // remove the panel + restore hooks
```

Requires `spark-html` ≥ 0.21.4 (uses its `inspectStores()` introspection).
