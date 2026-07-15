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

## San-App port audit (2026-07-14) — 21 reports, 3 real spark-ssr bugs

A real app (`examples/San-App`, a rotating-savings app: auth, uploads,
cross-user notifications, live badges, draw animation, infinite scroll) was
ported and 21 things were logged as "bugs" (`examples/San-App/bugs.md`).
Audited against source, only THREE were real spark-ssr defects. Public
write-up: website blog post `1-3-2-what-looks-like-a-bug`.

**Real spark-ssr fixes (shipped):**
- **ssr 1.3.1 — `live` on raw writes.** A custom `api/*.html` endpoint's
  hand-written `db.query("INSERT …")` never pinged `/__spark/live` (only the
  auto-CRUD route did). Fix: `jobs.js` `liveDb()` wraps the endpoint `db`
  handle — reads pass through, writes fan out to live + cache invalidation +
  job hooks, COALESCED per request (an N-row loop pings each table once).
  Opt-in (only a `live`-declared table broadcasts); `db.raw` stays manual.
- **ssr 1.3.2 — auth table as SSR source scoping (security).**
  `table="<authTable>"` used as a page source ran an UNSCOPED `SELECT` —
  `crud.js` `tableInfo`'s `scoped` deliberately excludes the identity table
  (it self-references by `id`, not `user_id`), and no `id`-based check
  replaced it. So a self-service page iterating it leaked every account. Fix:
  `tableRows` adds `WHERE id = ?` for non-admins on the auth table, matching
  the `/api/<authTable>` GET route. NOTE: behavior change — a "list all users"
  page must now use explicit SQL.
- **ssr 1.3.2 — dev "missing source" false positive.** `each="n in
  Array(k).fill(0)"` flagged `Array` as an unresolved data source. Fix:
  `parse.js` `JS_GLOBALS` set + call-expression guard in the each-source
  branch; the analyzer ignores built-in globals.

**Real, but spark-html CORE (not spark-ssr) — see SKILL.md Known-but-unfixed:**
`:disabled="0"` boolean-attr (#14), `bind:value` in `display:none` (#11),
`<svg>` width/height wiped on hydrate (#1). #20 (phone-photo EXIF orientation)
was a core multipart-upload bug, fixed upstream.

**FALSE CLAIMS — design working as intended. Do NOT "fix" these; a future
model will be tempted to, and shouldn't:**
- **`navigate()` is `onclick` sugar, NOT a programmatic router.** It takes an
  EVENT (`onclick={navigate}`), click-delegates SAME-PATH `<a href="?q=…">`
  links, refetches via `refresh()`. `navigate('/path')` (a string) was never
  its API — it threw on `e.target.closest`. Works in a single-route app
  (`examples/spark-chat`, nav is all `href="/?with=…"`); a no-op across a
  multi-route app's distinct routes BY DESIGN. Cross-route → `location.href`
  or a real link; app-wide client routing → `spark-html-router`. (An attempt
  to add a string form was REVERTED — it grew helper surface and still only
  did `location.href` for the cross-route case. bugs.md #17.)
- **Server-only page-`<script>` top-level-name extraction is a line-anchored
  string SCANNER, not a parser** (`page.js` `namesOf`; same shape in
  `parse.js` `definedNames` + core's rewriter). A `let/const/var` at the start
  of a line INSIDE a callback gets misread and returned from the wrapper →
  `ReferenceError` that discards the whole script. Convention: keep returned
  page-script vars at the top level, or inline the expression. Adding
  bracket-depth cleverness was tried and REVERTED (still a scanner — can't do
  template literals / block comments / regex; adds risk to capture code). If
  ever addressed, the identity-aligned move is a loud fix-naming warning, not a
  smarter regex. bugs.md #3.
- **`table="X"` means THE X table as a source** — want a subset/join, write the
  SQL. (#7's fix is the ONE exception: the auth table is scoped for security.)
- **An interactive page's `<script>` is the CLIENT component and never runs
  server-side** — compute display fields (dates, counts) in the DATA SOURCE.
  A non-interactive page keeps its script server-side. Same tag, opposite
  runtime. (#5; and the layout-`{session}` breakage #8 is the same boundary.)
- **A server-only script's scope is exactly `req`/`db`/`fetch`/`mail`** — it
  can't see a sibling `<spark-ssr>` source by name; re-run `db.query(...)`.
  Same no-implicit-cross-scope rule as component scope. (#4.)
- **`spark-ignore` is SYMMETRIC** — it disables server AND client
  interpolation (so a code sample renders identically both sides). (#9.) Also
  the blog-post authoring lesson: wrap `<pre>`/inline `<code>` containing
  `{…}` in `spark-ignore` or the braces render empty (`render.js:162` pushes
  `outerHTML` verbatim for any `spark-ignore` element).
- **Components declare their own prop defaults** via `export let name = …`
  (#2). **Interactive pages own their form submits** — `redirect=`/`flash=`
  are the no-JS mechanism; on a hydrating page drive the outcome from a
  `fetch` handler (#12, #15). **`onclick={fn(arg)}` / `onclick={() => fn(arg)}`
  are the correct arg-passing patterns** (#16). Auto-CRUD takes form fields
  as-is (no type coercion — cast in SQL) (#19); an empty file input still
  creates a zero-byte upload (guard it) (#10) — both deliberate "raw and
  predictable" boundaries.

## Meta

- Program-doc lineage (deletion on completion is the convention): the v1
  plan (deleted 2026-07-07) → `spark-improvements.md` (completed, deleted)
  → **`improvements.md`** (written 2026-07-09, the trusted program doc).
  Speed history stays in `spark-speed-up.md` + `spark-speed-up-max.md`,
  both CLOSED at 1.2.0.
- The docs#limits audit SHIPPED post-1.0 (7ba0986) — the old "don't touch
  until v1" deferral is over; the row lifecycle in spark-brain §6 governs.

## Known-issues sweep (2026-07-15) — core 1.8.2, ssr 1.3.4/1.3.5

Root causes for the swept bugs (match symptoms here before re-debugging):

- **Nested-block import double-resolve** (was "loop var not defined on
  hydration"): an `each` inside a `template if` renders rows during the if's
  walkNode; the if's own `hydrateBlockImports` sweep (`querySelectorAll
  ('[import]')`) then found the rows' still-unresolved placeholders and
  resolved them AGAIN with the if scope — which lacks the loop var. Fix:
  claim-once gate at the top of `resolveImportNode` riding
  `__sparkImportPath` (truthy on resolved hosts, never on fresh
  placeholders; expandos don't survive cloning). First resolver wins =
  innermost block wins, because inner blocks render during the outer walk.
- **Eager literal-`{expr}` fetch**: an `<img src="{url}">` in imported
  markup fires a real request (`/%7Burl%7D`) once a task boundary passes
  after `host.innerHTML = markup` — even detached. Fix in
  `resolveImportNode`: pre-build the element's plan (`buildElementPlan`
  caches the brace template), then `removeAttribute` src/poster until the
  first patch writes the real value. Microtask-poll regression test in
  `repro-bugs.js` — a revert fails loudly.
- **Boolean attrs**: `BOOL_ATTRS` in `runElementPlan` + the same regex in
  ssr `render.js` — the two lists MUST stay identical or SSR and hydrated
  client disagree. Deliberately falsy-only (truthy strings pass through so
  `hidden="until-found"` works). DOM-prop sniffing (`typeof el[name]`) was
  rejected: wrong for draggable/spellcheck and impossible server-side.

Harness/measurement traps paid for this session:

- **The size gate gzips at zlib DEFAULT level (6), not 9.** Measuring
  `dist/spark.js` with `gzip -9`/python level 9 reads ~70 bytes UNDER the
  gate. Only `node scripts/size-check.mjs` is the admissible number.
- **test/dom-shim.js does NOT support `[attr*=val]` substring selectors**
  (returns empty, silently). A runtime fix relying on one no-ops in the
  suite while working in real browsers — the eager-src fix was rewritten to
  plain `[src],[poster]` + a JS `.includes('{')` check for exactly this.
- **dom-shim parseHTML eats unquoted handler braces**: `onclick={fn}`
  parses to `fn` (no braces) → handler never wired → clicks silently dead
  in tests. Always quote in test markup: `onclick="{fn}"`.
- Test `fire()` helpers must ALSO dispatch document-level delegates
  (`document.__listeners`) — many handlers are document-delegated.

ssr 1.3.5 — jobs and live: `runJob` handed jobs the UNWRAPPED db, so job
writes (San-App's notify-payout) never pinged live/cache. Jobs now get
`liveDb(db)` with a HOOKLESS flush (`flushLive(1)` = broadcast+invalidate
only, never chains job hooks) — a job writing its own trigger table would
otherwise loop; pinned by a test whose job does exactly that.

San-App is now the live regression vehicle (2026-07-15, on disk only —
examples/San-App is gitignored): all bug workarounds removed (imported
avatar with loop-var props on 3 pages, svg sized directly, wizard cuota
input submits from inside its display:none container) and the app is
live-only — post-write `refresh()` calls deleted (a live SSE ping already
triggers a full client `refresh()`; see hydrate.js `__openLive`), dead
`fetchChat` calls deleted, `sans` declared live on dashboard + san/[id].
The ONLY legitimate manual `refresh()` left is after a QUERY-PARAM change
(dashboard selectSan, discover onFilterChange) — live can't refire those.
Verified over real SSE: chat send → `san_chats` ping → message renders;
mark-all-read → `notifications` ping → unread clears. Rule of thumb it
pinned: on a live-declared table, write-then-refresh() is a double fetch —
delete the refresh; on param-driven sources, refresh() is required and is
not polling.
