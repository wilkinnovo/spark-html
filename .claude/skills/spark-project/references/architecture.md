# Architecture — core runtime and spark-ssr internals

Accurate as of spark-html 0.27.14 / spark-ssr 0.7.2 (2026-07-06). Anchor by
function name, not line number. A queryable knowledge graph of the whole repo
exists: `graphify query "<question>"` from repo root.

## spark-html core (`packages/spark/src/index.js`, single ~3.2k-line file)

Ships as source (`main: ./src/index.js`, `files: ["src"]`), zero dependencies.
A component is an `.html` file: markup + one `<script>` + optional `<style>`
(`parseSFC`). Mounted via `mount()` / auto-boot; imported into pages with
`<div import="/path/to/component">`.

### Expression pipeline
- `compileExpr`/`compileStmt` — cached `new Function` wrappers; scope access
  goes through a `with`-like proxy pattern. `runExpr`/`evaluate`/`execute`
  run them against a component scope; `execute` handles event handlers
  (`$event`, `__val__`).
- `parseTemplate`/`interpolate` — `{expr}` text interpolation, cached per
  template string. `interpEnd` finds the matching `}` (string/depth aware).
- `evalPropValue` — the whole-value `{expr}` prop path (added 0.27.13):
  a prop that is exactly one `{expr}` evaluates directly, preserving
  arrays/objects/functions instead of stringifying.

### Script rewriter (the "not a parser" part)
`analyzeScript(rawCode)` (cached) rewrites a component's `<script>` so
top-level state becomes reactive:
- `extractTopLevel` / `extractDeclaredNames` — find top-level `let/const/var`
  names (incl. comma chains; destructuring intentionally skipped — stays
  local) and `function` declarations; these become scope-proxy keys
  (`seedNames`).
- Declarations are rewritten to bare assignments (`let a = 1` → `a = 1`) so
  writes hit the proxy — **only at brace depth 0**, computed by
  `braceDepths()` (an Int32Array of `{`/`}` depth per char, string/comment
  aware via `skipString`). Depth-gating landed in 0.27.12 after a nested
  helper's local leaked into the reactive scope and caused a genuine
  infinite patch loop.
- `$:` reactive statements: `reactiveStatementEnd` finds the true end
  (multi-line aware); each becomes a tracked block re-run when its captured
  deps change.
- ESM `import` statements are parsed (`parseImportStatement`) and replayed as
  dynamic imports hoisted to the top (`importAssign`, `makeImporter`);
  `import.meta` is NOT available.
- `makeScope(rawCode, componentEl, props)` builds the live scope: a Proxy
  whose sets mark dirty keys and schedule patches; `compileScript` runs the
  rewritten body (async supported).

### Reactivity and stores
- `reactify(value, onMutate, cache)` — deep Proxy over plain objects/arrays;
  Map/Set mutator methods (`set/add/delete/clear` — `MUTATORS`) tracked.
  Class instances and `Date` are NOT tracked (reassign to update).
  `REACTIVE_RAW` symbol unwraps.
- `stores` is a **module-scope Map** (name → {state, subscribers}) — this is
  the singleton that the dual-package hazard duplicates. `store(name, init)`,
  `subscribe`, `subscribeStore` (component-bound), `derived(name, deps, fn)`
  (memoized, notifies only on actual key change). Store notifications
  re-render subscribers with a full cheap pass — store reads are NOT tracked
  per key the way component-local state is.
- `persist()` (spark-html-persist) wraps stores with storage; distinct from
  `useStore` — check which one an app means.

### Dependency capture (the most bug-prone code in the org)
Module-scope mutable state around ~L935: `captureSet` (keys the current
binding reads), `captureSink` (an EXTRA set that also receives reads —
accumulates an outer directive's deps while inner work runs), `gDirtyMode`,
`gDirtyKeys` (keys changed this flush), `gDirtyItems` (loop-row objects
deep-mutated this flush).
- `withCapture(node, fn)` — run fn recording reads into the node's dep set.
- `withSink(node, fn)` — 0.27.14 fix: must ACCUMULATE into the outer set, not
  clear-and-replace, or an unrelated sibling change permanently corrupts an
  outer `if`'s recorded deps and a nested `each` stops reconciling forever.
- `shouldEval(node)` / `setsIntersect` — during a dirty pass, a directive
  re-runs only if its dep set intersects `gDirtyKeys`. Failure mode of any
  bug here: SILENT under-reconciliation (UI just stops updating).

### Patch/walk engine
- `patch(el, scope)` → `walkNode` over the component tree; `scheduleRerender`
  batches via microtask.
- Directives are `<template>` anchors: `patchIf` (`ifChain` groups
  if/else-if/else), `patchEach` (positional reuse by default; `key="…"` for
  identity moves; `makeLoopScope` per row), `patchAwait`
  (`parseAwait`/`startAwait`/`applyAwaitState`; `refreshAwait` on dep change).
- `buildElementPlan`/`runElementPlan` — per-element compiled plan of
  attribute/text bindings, event handlers, form bindings
  (`setupFormBinding`, `formStateSnapshot`).
- `leaveNode`/`teardownManaged`/`destroyComponent` — teardown; 0.27.12 fix:
  `leaveNode` must recursively tear down a nested each/if/await anchor's
  rendered rows, not just remove the anchor.
- `bootComponent` — mounts a component el: parse SFC, makeScope, resolve
  imports (`resolveImportNode` — retry-after-ancestor-ready logic for props
  reading enclosing state, 0.27.9), project slots (`projectSlots`), scope CSS,
  first patch, `onMount`.
- Scoped CSS: `scopeCss`/`scopeRules`/`tokenizeSelector` — hand-rolled CSS
  scoping incl. nested at-rules (`NESTED_AT_RULES`).
- Prerender integration: `isPrerender()` checks
  `globalThis.__SPARK_PRERENDER__`; `pushPrerenderWait(p)` registers promises
  prerender must await.
- Dev error overlay: `reportError`/`renderOverlay` (module-level, dev only).

## spark-ssr (`packages/spark-ssr/src/`)

Bun-first server. Files: `index.js` (exports), `server.js` (~2.1k lines —
`serve()` is one ~1.9k-line closure holding nearly everything), `render.js`
(opcode renderer), `parse.js` (page analysis), `hydrate.js` (client-script
generation), `schema.js` (DB inference + diff/push), `sources.js` (data
sources), `db.js`, `config.js`.

### Request model
`scanPages(root)` maps `pages/**.html` (incl. `[param]` routes) →
`matchPage`. `layoutChain` merges nested layouts (`mergeHeads`,
`mergeScripts`). Reserved dirs: components, api, public, pages, uploads, seed.
`middleware.html`, `404.html`, `500.html` are special. Data sources are
declared on templates (table / SQL / query / URL / glob / MODULE); `pageData`
+ `buildScope` assemble the scope per request.

### Opcode renderer (`render.js`, rewritten in 0.7.0)
linkedom parses each page/component ONCE at compile → flat op program
(`static/text/el/each/ifchain/await/import/slot`); requests loop over ops
pushing strings. **Byte-parity discipline**: static chunks are captured FROM
the linkedom DOM (`outerHTML`) so entity/quote normalization matches the old
parse-mutate-serialize pipeline; text escapes `& < >`, attr values escape only
`"`, `EMPTY_ATTRS` serialize bare. `PROGRAMS`/`COMPONENTS` are LRU(256) keyed
by the template STRING. `renderFragment` / `renderFragmentTo(sink,…)`
(streaming). Any change here: re-verify byte parity + run test/bench.js.

### Sessions/auth/flash (in server.js)
HMAC-signed cookies (`signSession`/`readSession`, `timingSafeEqual`),
`spark_session` = `HttpOnly; SameSite=Lax` (NO Secure flag yet — v1 plan
M3.3), read-once signed `spark_flash`. Built-in `/login` `/signup` `/logout`
pages (overridable); `guard="session"`; `isAdmin` checks
`is_admin`/`role==='admin'`. `{session}`/`{path}`/`{flash}` are ambient.

### Data & schema
`inferSchema` (schema.js) infers tables/columns from templates; relations
(`each="c in post.comments"` → comments table + post_id FK, batched to one
`IN (…)` query). `diffSchema` + `db diff`/`db push`(/`--force`) for safe
evolution; startup only creates+seeds. SQLite default
(`sqlite://./dev.db` when no spark.json), Postgres supported.

### Perf layer (0.7.0, all in server.js)
- `sourceCache` = `makeSourceCache({max:500})` LRU + byTable invalidation +
  sweep on the 25s heartbeat.
- Response cache: production anonymous GETs only, gated by `pageCacheable(pd)`
  (no server script, no module sources, no header/body SQL params); any
  `spark_` cookie bypasses; TTL 60s default (`"responseCache"` config; false
  disables). Blind to DB writes not made through the server until TTL.
- Streaming: production list pages split at `SHELL_MARK`
  (`' SPARK_BODY '` — built from escapes; a literal NUL once made
  server.js a binary file). Not used when flash/pager/search/status templates
  or cache-eligible.
- `pd.scriptFn` compile-once; `PROXY_MEMO` WeakMap; glob sources mtime-cached.

### Hydration (`hydrate.js`)
When a page is `analysis.interactive` AND has a render plan, its own
`<script>` becomes the CLIENT component script (0.6.0); non-interactive pages
keep the script as the server escape hatch (gated in `buildScope` via
`!shouldHydrate(pd)`). Injected ambient helpers: `api_create/api_update/
api_delete` (optional leading table-name arg) + universal `refresh()`
(refetches all sources from `/__spark/data/<key>.json`). Handlers referenced
by the template but not defined are synthesized (`auto="…"` narrows).
**Rule: every GENERATED local/param must be `__`-prefixed** (`__body`, `__id`,
…) or it collides with page state via the rewriter (0.6.1 bug).
`{path}` from `location.pathname`, `{session}` from `__init.session`.

### Jobs/mail/API
`<spark-ssr job="x" every="1d">` → `jobs/x.js` on a timer; `on="insert:orders"`
fires post-write with `req.row` (`fireEvent`). `mail` config = module or
`{url}` webhook; injected as `mail()`. OpenAPI 3.1 at `/__spark/openapi.json`
+ generated `/__spark/client.ts`.
