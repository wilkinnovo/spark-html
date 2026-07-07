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

## Meta

- `spark-improvements.md` (repo root) is a decent diagnosis doc but its §7 is
  stale (claims streaming/response-cache unshipped; they're in 0.7.0). The
  trusted plan is `spark-from-here-to-v1.md`.
- The website docs#limits table has an outdated Block-scoping row (pre-0.27.12
  behavior) and is missing frozen-props + SSR-page-script rows — audited in
  the v1 plan appendix. **Do not update it until v1 ships** (owner's call,
  2026-07-06).
