# Pitfalls — bug history, root causes, and the lessons that must not be relearned

Every entry here cost a real debugging session. Read before touching the
related area.

## The reactivity trilogy (0.27.12–0.27.14) — same root, three bugs

Root: the capture machinery's failure mode is silence. All three shipped to
users and required from-scratch repro + bisect to find.

1. **0.27.12 — infinite reactive loop (real hang).** `analyzeScript`'s
   let/const/var + function-declaration rewrites applied INSIDE nested helper
   function bodies, turning a helper's true local into a write to the reactive
   scope proxy. Read-and-written by the same evaluation = infinite patch
   loop. Fix: `braceDepths()` — rewrites only at depth 0. Lesson: the
   rewriter must never touch anything below the script's own top level.
   Same release: `leaveNode` didn't recursively tear down a nested
   each/if/await anchor's rendered rows — orphaned DOM. And: SSR never runs a
   page's own script (by design — see constraints below).
2. **0.27.13 — whole-value prop stringification.** `<div import>` props went
   through string interpolation, so `items="{results}"` became
   `"[object Object],[object Object]"` and functions became their source
   text. Fix: `evalPropValue` evaluates the whole-value case directly.
   Lesson: props and text interpolation are different operations sharing a
   code path for historical reasons; test non-string props explicitly.
3. **0.27.14 — each-in-if permanently dead.** `withSink` CLEARED the outer
   directive's dep set before every run instead of accumulating, so an
   unrelated sibling change could corrupt an outer `if`'s recorded deps and a
   nested `each` silently stopped reconciling forever. Lesson: dependency
   sets must only grow within a run; any refactor that "cleans up" the
   capture code can reintroduce this class. Dev-mode invariant planned (v1
   M1.2): a dep set that shrinks without explicit reset = loud error.

Earlier related (0.27.9): `<div import>` `{expr}` props reading the enclosing
component's state rendered literal braces on hydrating pages — imports resolve
tree-wide before components boot; fixed via retry-after-ancestor-ready.

## Architectural constraints (unfixed, by design or pending v1)

- **SSR never runs the page's own `<script>`.** Display values computed by
  page-script helpers render blank server-side. Compute them in the MODULE
  data source (tabtube `lib/search.js` is the reference pattern).
- **The scanner cannot parse regex literals containing a quote.** Since the
  M3.1 tail (0.30) it warns loudly naming the fix (`new RegExp()` or an
  imported module) instead of silently misreading the line. Everything else
  is string-aware now — see the historical entry below.

## Fixed at v1-prep (historical — do not re-report as live)

- **1.0.3 (2026-07-08, found via examples/spark-chat): each/if-CLONED
  `[import]` placeholder props were corrupted client-side.** Two compounding
  causes: `buildElementPlan()`'s generic `interp` op ran on the still-
  unresolved clone (patch() walks it synchronously, before async
  `hydrateBlockImports()`), stringifying whole-value `{expr}` props via
  `interpolate()`; then `buildProps()` `coerce()`d the resulting string,
  whose `'' → true` rule (meant for bare `<div disabled>`) promoted a
  legitimate empty-string prop to boolean `true` — so `if="photo"` was
  always truthy for empty avatars. SSR HTML was unaffected, which disguised
  it as a server/client sync bug. Fix: an unresolved `[import]` node returns
  an empty element plan (its attributes belong to the import machinery), and
  `coerce()` only runs on literal attributes or mixed interpolations — a
  whole single `{expr}` result is used exactly as evaluated. Regression:
  `test/repro-bugs.js` `test_bug_1_0_2_empty_string_prop`. Related design
  fact from the same hunt: `name` is a RESERVED import attribute (component
  identity), silently excluded from props like `import`/`data-spark*` —
  rename the prop, don't debug it.

- **The rc.3 bugs.md batch (2026-07-07, all test-first):** (1) spark-ssr
  `addRoots()` now treats any `x.foo(` member CALL as list-safe — the
  `ARRAY_LIKE_MEMBERS` allowlist only covers bare property reads; a call
  also never becomes a schema column. (2) Relative `import="components/x"`
  resolves against the app base (`<base href>` else the page URL as FIRST
  loaded, captured pre-navigation), never the client-routed current URL
  (`componentURL()` in core; `test/import-base.js`). **1.0.0 shipped this
  as origin-root and broke subdirectory deployments (the production
  website on GitHub Pages) — never force "/" as the base; fixed in 1.0.1.
  Second half of the same outage: the website hero demo imported
  `import="/components/url-card"` — ABSOLUTE paths bypass the base rule by
  design, so it still 404'd at the origin root after 1.0.1; the demo now
  imports the jsdelivr URL it advertises (which prerenderFetch also matches
  at build). Third episode (1.0.2): the base was captured lazily at the
  FIRST relative import — an app whose entry page imports nothing captured
  it only after a router navigation, resurrecting the "/dash/" 404 for
  lazily-routed content; the base is now frozen at the first mount() call
  (import-base.js case 6, verified failing against 1.0.1).** (3+4) spark-ssr auth CREATE enforces unique
  identity (409) and non-blank identity + non-empty password (422)
  server-side — the synthesized /signup screen is never form-scanned;
  PATCH refuses identity collisions too (`test/security.js`, now 13 cases).
  (5) A **null/undefined `:attr` result removes the attribute** — it used
  to stringify to `attr=""`, which for boolean attributes means TRUE, so
  `:hidden="q.loading || q.error"` (→ null) stuck hidden forever. This was
  a CORE patcher semantic, not a spark-html-query bug.

- **Import props froze at mount** — fixed in 0.29 (M2.1): whole-value
  `{expr}` props re-evaluate on the `$:` capture schedule. Mixed
  string-interpolated props re-evaluate as strings on the same schedule.
- **Loop-row props into components didn't survive hydration re-render** —
  fixed in 0.29 (M2.2) by the same prop plumbing.
- **The rewriter was not string-aware** — fixed in the M3.1 tail (0.30):
  `braceDepths` marks string/comment interiors `~depth`, so all rewrite and
  scan passes (declarations, functions, `export let` props, seed names)
  leave string contents byte-intact. Regression + fuzz coverage lives in
  `packages/spark/test/scanner-fuzz.js` (known-value oracle — the
  convergence oracle can't see scanner corruption).

## Hydration / DOM lifecycle

- **Detached-host rebuild:** hydration can rebuild an imported component's
  host element while detached, then swap it in. A `document.querySelector`
  cached in `onMount` can point at a node that gets discarded — listeners
  attach to garbage, `onMount` "visibly ran," nothing works. Fix pattern:
  delegate from `document`/`window`, resolve the target with
  `e.target.closest()` at event time. (Proved via CDP getEventListeners:
  zero listeners on the live node.)
- **Slot/scope-pending + prerender onMount + default-404 duplication**
  invariants came out of the 0.27.0 bugs batch — if touching slots,
  prerender mount timing, or router notfound, check git history for
  `bugs.md` context first.
- **HMR double-mount:** `[spark] ⚡ ready` logs twice after an HMR edit —
  confirmed harmless (clean restart logs once), but unverified-by-design;
  don't chase it as a bug, but don't let components rely on single-mount
  in dev.

## Generated-code rules (spark-ssr hydrate.js)

- Every generated local/param in client scripts must be `__`-prefixed. The
  rewriter turns ANY bare `x = …` matching a top-level state name into a
  reactive write — a generated `const body` clobbered page `{body}` state
  (0.6.1, "[object Object] in a textarea").
- `SHELL_MARK` is built from escape sequences on purpose — a literal NUL byte
  in source once made git treat server.js as binary.
- **Any name the framework injects ambiently (`refresh`, `navigate`,
  `api_create/update/delete`) must be excluded from `handlerRoles()`'s
  synthesis candidates.** Before 1.1.0 it wasn't: `handlerRoles` picks the
  first not-yet-`defined` bare non-loop handler as the page's "insert" role
  and synthesizes `async function <name>() {...}` for it — purely structural,
  name-blind. A template wiring `onclick={navigate}` to call the new ambient
  helper got a SECOND, synthesized `navigate()` appended right after it
  (same name, different body) — a duplicate declaration that silently
  clobbered the real one. `defined` only tracks names the AUTHOR's own
  `<script>` text declares, so an ambient name is invisible to it. Fixed via
  `AMBIENT_NAMES` (hydrate.js) excluded from the `pick()` candidate pool;
  regression pinned in test/ssr.js ("ambient navigate"). Lesson: any new
  ambient helper name must be added to `AMBIENT_NAMES`, and is only safe to
  pick if it's implausible as an author's own bare handler name — found by
  dogfooding immediately (spark-chat), not by design review; adding a
  helper is not done until it's actually wired into a real page.
- **An imported component's script scope is fully isolated from the page
  that imports it — ambient helpers do NOT leak across `<div import>`
  boundaries.** `makeScope` (packages/spark/src/component.js) builds a
  fresh `raw` per component from its own declared names + explicit
  `prop="value"` attributes only; there is no parent-scope fallback. A
  layout DOES share the page's scope (its vars merge into the page before
  compilation — see "layouts (§2)" in ssr.js), but a `<div import="/components/…">`
  never does. Practical effect: `refresh()`/`navigate()`/any page-ambient
  name is unreachable from a separately-imported component; either move the
  interactive bit into the page/layout itself, or have the component
  re-derive what it needs from real global state (the established idiom —
  see pinterest's `nav.html`, which reads `location.search` directly rather
  than accepting `q` as a prop, precisely to avoid this boundary).

- **Same disease, second instance (fixed, spark-ssr 1.2.1): invented
  source names are also name-blind.** `table="files"` pushes an auto
  list-source named `files` into `dataPlan`'s sources FIRST, so it
  shadowed a same-named DECLARED source (`files = SELECT … WHERE …`) —
  the field-reported "my filtered list became the raw table". Rule now
  enforced in `dataPlan` (parse.js): a `named:` source always outranks an
  invented one for the same variable (ranked resolution), and the pair is
  reported on `plan.shadowed` → server.js warns naming both origins.
  General law for ALL synthesis in spark-ssr: anything that invents a
  name must check what the author (or an ambient helper) already owns —
  silent override is the forbidden outcome. Sibling fix in the same
  release: the `/__spark/data/` endpoint now rebuilds `req.params`/path/
  query from the page's own `[param]` segments (request parity — module
  sources reading `req.params` were silently getting `{}` after hydrate).

## Environment / packaging

- **Dual-package hazard** (the big one): see packages.md. Symptom: "store not
  created" warnings, production only. Cause: nested duplicate spark-html.
  Diagnosis order: check lockfile for two spark-html versions FIRST.
- **Stale service worker on a reused dev port:** dev hang + Cache.put error.
  The SSR template ships no SW — it's a leftover from a previous app on that
  port. spark-ssr 0.3.3+ self-heals; manual unregister unblocks immediately.
- **`/@modules` dev serving:** bare dependency specifiers must map to
  `/@modules/<pkg>/<entry>` (or sibling-relative imports 404 → blank dev
  page). Fixed in spark-html-bun 0.1.4; remember when adding deps to
  companions.
- **Dev vs prod resolution differ** in spark-html-bun (import maps vs
  Bun.build). "Works in dev, breaks in prod" bugs: suspect resolution first.

## 1.1.0 speed-release invariants (2026-07-08)

- **Row handlers read `e.currentTarget`, not a closed-over element.** One
  listener function per handler per TEMPLATE is shared by every clone
  (wireElement, `h.l`). Any test helper that fires synthetic events MUST set
  `currentTarget` per bubble level (all `fire()` helpers were updated; the
  dom-shim's `document.addEventListener` is a real registry now, plus
  `matches()` and comma selector lists). A handler that "does nothing" in a
  test is usually a fire() without currentTarget.
- **Internal `__spark*` boolean flags are set as `1`, read by truthiness.**
  Never compare them `=== true` (size golf; test/perf.js asserts were
  changed to `assert.ok`). Sibling packages verified to do truthy reads.
- **Shallow keyed rows patch via `block.live` (stamp-time dynamic-node
  list), not a DOM walk.** `patchLive` runs patchText/patchElement over the
  collected nodes; correctness depends on the shallow guarantee
  (`__sparkEachDeepRows` — no anchors/components/imports anywhere in the
  template). Content injected into a row by user JS at runtime is NOT
  picked up by row refreshes — same class of limitation as manual DOM edits
  elsewhere.
- **Handler attributes are stripped from the TEMPLATE at analysis**
  (analyzeElement) — clones are born without on* attrs; the one clone made
  before analysis is stripped in stampTree. If a row inexplicably keeps a
  raw `onclick="{…}"` attr, that pipeline broke.
- **Full document-level event delegation was REJECTED at +0.232 KB gzip**
  (budget outranks perf, spark-brain §2) — and later SUPERSEDED: it landed
  in 1.2.0 for stamped row clones under the 17.25 ALL-IN ceiling (owner
  decision, 2026-07-09). See the 1.2.0 section below for its invariants.

## 1.2.0 speed-max invariants (2026-07-09)

- **Stamped row clones own NO listeners.** Bubbling handlers ride
  `el.__sparkH` + ONE document-level CAPTURE delegate per event type
  (wireElement `del` param; `gDelegated`). Three rules keep it correct —
  each is load-bearing:
  (a) `delegate()` shadows `e.currentTarget` per dispatch via a
  configurable own property and DELETES it after the walk — removing that
  delete corrupts currentTarget for every later listener in the same
  propagation (the own property would shadow the prototype getter).
  (b) `input`/`change` are NEVER delegated (they're in NO_BUBBLE despite
  bubbling): `bind:` write-backs are direct listeners, and a delegated
  ancestor handler would otherwise run BEFORE the write-back that updates
  the bound state it reads.
  (c) DevTools `getEventListeners(row)` now shows nothing — look at the
  document. The dom-shim's `fire()` dispatches `document.__listeners`
  capture delegates FIRST; keep that seam or delegated handlers silently
  never fire in tests.
- **The ≤4-mismatch direct-permutation path must never assign one block to
  two slots** — duplicate new-side keys (user error) are consumption-guarded
  and degrade to the windowed map+LIS path (reuse once + create). Weakening
  the guard turns a user mistake into shared-DOM corruption.
- **The reconcile scans the RAW array** (`arr[REACTIVE_RAW]`), and
  `block.raw` identity is always `rawOf(...)` of the item — users can store
  previously-wrapped values back into state, so the backing array may hold
  proxies. Rows still receive WRAPPED values (`box.item`); raw is for the
  scan only.
- **Chunked creates (`insertChunk`, G=64)** stamp rows inside a cached
  pristine fragment and patch initial values BEFORE insertion — legal only
  because shallow rows are position-independent. Anything that makes a
  chunked row position-DEPENDENT (an anchor, an if/else follower) must
  keep it off the chunk path (the `__sparkEachDeepRows` guard does today).
  The seed row (anchor's first ever) always renders capturing via the
  single path.
- **Fuzz-corpus seeds replay by seed number through the CURRENT template
  library** — adding a template shifts what every historical seed
  generates, so corpus files' recorded state/mutations are documentation of
  what they caught, not what they now replay. A future improvement: pin the
  template index in the file. Never let a failing run's writeFileSync
  clobber tracked seeds without checking what it overwrote.

## Meta

- Program-doc lineage (deletion on completion is the convention): the v1
  plan (deleted 2026-07-07) → `spark-improvements.md` (completed, deleted)
  → **`improvements.md`** (written 2026-07-09, the trusted program doc).
  Speed history stays in `spark-speed-up.md` + `spark-speed-up-max.md`,
  both CLOSED at 1.2.0.
- The docs#limits audit SHIPPED post-1.0 (7ba0986) — the old "don't touch
  until v1" deferral is over; the row lifecycle in spark-brain §6 governs.
