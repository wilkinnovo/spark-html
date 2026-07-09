# Spark v1 — API freeze review (M4.1)

The 1.0 promise is semver: everything **stable** below is supported for the
life of 1.x; **experimental** may change in a 1.x *minor* (documented as such);
**internal** is not API even when a sibling package reads it. This document is
the freeze decision and the written semver policy (plan §7.4).

Written 2026-07-07 against spark-html 0.30.0 / spark-ssr 0.8.0, by reading the
export lines and every cross-package consumer. Decisions marked **⟶ Wilkin**
are the owner's call before RC; everything else is a maintainer decision
recorded here.

## Method

- **Public core surface = the `index.js` `export {}` line only.** Every other
  `export` in `packages/spark/src/*.js` (patchIf, reactify, withCapture,
  bootComponent, compileScript, braceDepths, …) is bundle-internal — it exists
  so the modules can import each other; `dist/spark.js` re-exports only the
  index line. None are public.
- **`__spark*` DOM properties are internal**, even though devtools/prerender/
  ssr read them — those siblings pin exact-ish core versions. A `__spark*`
  rename is not a breaking change; a documented-behavior change is.
- Every name below was checked for real consumers before bucketing.

## Core (`spark-html`) — the `export {}` line

| Export | Bucket | Consumer / note |
|---|---|---|
| `mount(root?)` | **stable** | documented; every app |
| `unmount(el)` | **stable** | documented |
| `component(name, source)` | **stable** | documented; tests, inline components |
| `store(name, initial?)` | **stable** | documented; head, router, persist, … |
| `derived(name, deps, compute)` | **stable** | documented |
| `subscribe(name, fn)` | **stable** | head, router build on it — **undocumented, add a docs row (M4.2)** |
| `evaluate(expr, scope)` | **stable** | documented ("low-level, for testing") |
| `interpolate(tpl, scope)` | **stable** | documented ("low-level, for testing") |
| `parseSFC(source)` | **stable** | documented; website playground |
| `scopeCss(css, tag)` | **stable** | website playground — **undocumented, add a docs row** |
| `inspectStores()` | **stable** | spark-html-devtools — **undocumented, add a docs row** |
| `inspect` (`.deps(node)`, `.scope(el)`) | **experimental** | M1.3 API, no consumer yet; test-utils (M4.3) will be the first. Shape is a week old — ship documented-but-unstable, promote to stable in a 1.x minor once test-utils exercises it. **⟶ Wilkin** |
| `lifecycle(hooks)` | **stable** | spark-html-motion; the if/each enter/leave seam |
| `default { mount, unmount, component, store, derived }` | **stable** | the convenience default |

Component-script builtins `useStore(name)` and `props` (documented): **stable**.

## Template surface — all **stable**

`{expr}` interpolation · literal `{{`/`}}` (documented) · `$:` reactive
statements · directives `import`, `each`/`each…as key`, `if`/`else`/`else-if`,
`await`/`then`/`catch`, `bind:*`, `on*` handlers, `<template>`, `<slot>` · props
(now reactive for whole-value `{expr}` since 0.29) · scoped `<style>` · scoped
`<script>` with top-level `let/const` as component state. These are the concept
count the whole pitch rests on — frozen.

## spark-ssr — conventions (the real surface) vs JS exports

**Stable conventions** (what a user writes): filesystem routing under `pages/`,
`_layout.html` nesting, `[param]` routes, `<spark-ssr>` blocks
(`table=`, `guard=`, `redirect=`, `status=`, `cache=`, `search=`, `limit=`,
`live=`, and explicit `GET/POST … → SQL` routes with `:token` params), auto
CRUD, no-JS forms (`_redirect`, `_flash`, `flash=`), ambient `{session}` /
`{path}` / `{flash}` / query+params, sessions/auth, relations
(`each="c in post.comments"` FK inference), config keys `db`, `auth`, `cors`,
`uploads`, `maxBodyMb`, `responseCache`.

**Experimental** (documented as unstable; may change in a 1.x minor — all are
days-to-weeks old):
- **Jobs** — `on="insert:table"` → `jobs/*.js`, and the **mail** config shape
  (`config.mail` module/webhook/null). ⟶ Wilkin
- **OpenAPI + typed client** — `/__spark/openapi.json`, `/__spark/client.ts`
  output shape. ⟶ Wilkin
- **`auto=` synthesis rules** — `auto="none"` and the handler-synthesis
  defaults. ⟶ Wilkin
- **`config.fonts` / `config.images`** — companion-driven build config (mirror
  spark-html-font / spark-html-image option shapes, which are themselves young).

**Internal (not public spark-ssr API)** — the JS exports beyond `serve`,
`loadConfig`, `connect`: `scanPages`, `projectSchema`, `renderFragment`,
`evalExpr`, `clientComponent`, `clientScript`, `initModule`, `handlerRoles`,
`primaryColumn`, `urlSource`, `globSource`, `moduleSource`, `parseFrontMatter`,
`makeSourceCache`, `inferSchema`, `diffSchema`, `pushSchema`, `seedTables`,
plus all `parse.js` helpers. They exist for the CLI, tests, and the render
pipeline — not documented, not promised. `serve()` + the template conventions
+ the config keys are the spark-ssr contract.

## Companion packages

Each companion's default export / documented options are **stable** at their
1.0.0. The `__spark*` internals they read are **not** (they pin core versions).
The one packaging change at 1.0: **all companions move spark-html from
`dependency`/loose ranges to `peerDependencies: ">=1.0.0 <2"`** (§5.4) — this
is why the flip happens *at* 1.0, not after (it's breaking-ish). Current
offenders using a hard `dependency`: theme, motion, ssr, prerender, router,
devtools, head. persist/query/websocket already use peer `>=`.

## Nothing is removed before RC

Every export has a live consumer (verified). The only pre-RC surface changes
are: (1) document the three stable-but-undocumented core exports (`subscribe`,
`scopeCss`, `inspectStores`) — M4.2; (2) mark the experimental buckets as such
in the docs — M4.2; (3) the peerDeps flip — M4.4. No breaking removals.

## Semver policy (the written promise for 1.x)

1. Everything in **stable** above and everything in the published docs is
   semver-stable API. A behavior change to any of it is a breaking change no
   matter how small the diff.
2. `__spark*` internals and every non-`index.js`-re-exported function are **not**
   API. Siblings that read them pin core versions.
3. **experimental** surfaces may change in a 1.x *minor*, and each must say so
   at its doc site. Promotion to stable is a minor; a breaking change to a
   still-experimental surface is a minor, not a major.
4. The 15.0 KB gzip budget is frozen for the life of 1.x. "It doesn't fit" is
   answered by a sibling package, never a budget bump.
