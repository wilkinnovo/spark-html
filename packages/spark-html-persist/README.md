# ⚡ spark-html-persist

Persist a [spark-html](https://www.npmjs.com/package/spark-html) store across
reloads — **one line**. Hydrates from storage on boot, saves on every change.
Built on `store()` + `subscribe()`, one dependency.

```js
import { persist } from 'spark-html-persist';

// a normal store(), but it survives reloads:
persist('settings', { theme: 'dark', fontSize: 14 });
```

```html
<!-- any component -->
<script>const s = useStore('settings');</script>
<button onclick="{s.theme = s.theme === 'dark' ? 'light' : 'dark'}">{s.theme}</button>
```

Change `s.theme`, reload the page — it's still there.

## Install

```bash
npm install spark-html-persist
```

## API

```js
persist(name, initial?, options?)
```

Returns the same store as `store(name)` — `useStore(name)` reads it everywhere.
Saved values layer **on top of** `initial`, so adding a new default key works
even for users with an older saved blob.

| Option | Default | Meaning |
|--------|---------|---------|
| `key` | `spark:<name>` | Storage key. |
| `storage` | `localStorage` | Any `Storage` — pass `sessionStorage` for per-tab state. |
| `include` | all keys | Persist only these keys. |
| `exclude` | — | Persist everything except these keys. |

```js
persist('user', { name: '', token: '', draft: '' }, {
  storage: sessionStorage,
  exclude: ['token'],   // keep secrets out of storage
});
```

Writes are coalesced to one `setItem` per tick, and storage errors (quota,
private mode, corrupt JSON) fall back silently to the defaults — never throws.
