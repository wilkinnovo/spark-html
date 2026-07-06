# Bugs and edge cases found while building this app

Discovered while building Pinspire (a Pinterest clone) against `spark-html`
0.27.9 and `spark-ssr` (workspace-local). Ordered roughly by how much they
cost to work around. None of these are hypothetical — each was caught by
actually running the dev server and exercising the page.

## 1. Named `<spark-ssr>` query shape inference conflates array methods with member access

**Where:** `spark-ssr/src/parse.js`, `dataPlan()`'s `shapeOf()`, via
`analysis.memberRoots`.

**What happened:** A named source like:

```sql
savedBoardIds = SELECT board_id FROM saves WHERE pin_id = :id AND user_id = :session.id
```

should resolve as a **list** (zero or more rows) — there's no `LIMIT 1`, no
aggregate. But the template used it as `savedBoardIds.length` and
`savedBoardIds.some(s => s.board_id === b.id)`. The root-finder regex that
builds `analysis.memberFields`/`memberRoots` (`addRoots()` in `parse.js`)
matches ANY `identifier.field` pattern in the template text — it can't tell
"array method call" (`savedBoardIds.some`) from "single-object property
read" (`post.title`). Because `savedBoardIds` showed up as a member root,
`shapeOf()`'s heuristic (`!singleShaped(sql) && !memberRoots.has(name)` →
list) fell through to `'row'`, and the framework handed the client
`rows[0] ?? null` instead of the array. `{savedBoardIds}` was `null` even
with real matching rows in the database — confirmed via
`/__spark/data/<key>.json`, which is what caught it (not a runtime error;
`.length`/`.some` on `null` inside a template expression just render empty
via the `evalExpr` catch-and-swallow, so this fails *silently*).

**Workaround used:** Don't give an array a name and then ask array
questions about it in the template. Instead, push the boolean/exists check
into SQL as a **per-row flag** on a source that's unambiguously a list
(`EXISTS(...) AS already_saved` joined onto `myBoards`, iterated with
`each`), and a **separate single-row scalar** for the "is it saved
anywhere" check (`SELECT EXISTS(...) AS yes`). Both sides then match
`shapeOf()`'s actual heuristic instead of fighting it. See
`pages/pin/[id].html`'s `myBoards`/`savedAnywhere` sources.

**Possible real fix (not applied — out of scope for an app-level change):**
`shapeOf()` could check `analysis.eachRoots` before falling back to
`memberRoots`-based row detection, or the root-finder could distinguish a
member access followed by a call (`x.foo(`) from a plain property read
(`x.foo` not followed by `(`) when building `memberRoots`. Filed for
awareness, not fixed here.

## 2. Hyphenated / camelCase prop names don't survive HTML

**Where:** any `<div import="...">` prop name, `packages/spark`'s
`resolveImportNode`/`renderImport`, effectively an HTML-parsing fact rather
than a spark bug.

**What happened:** `_layout.html` passed `logged-in="{session ? 'yes' :
'no'}"` and `me-name`/`me-username`/`me-avatar` to `components/nav.html`,
which read them back as `{loggedIn}`, `{meName}`, etc. Two independent
failures stacked:

- A prop name with a hyphen (`logged-in`) becomes a scope key literally
  containing a hyphen. `logged-in === 'yes'` inside a spark expression does
  **not** look up that key — it parses as `logged - in === 'yes'` (a
  subtraction), since expressions compile through `new Function` and a
  hyphen is never valid inside a bare identifier.
- Even avoiding hyphens, camelCase in the *source* markup (`meName="…"`)
  doesn't survive HTML5 parsing — attribute names are lowercased on parse
  (linkedom follows the same rule browsers do), so the prop key ends up
  `mename`, not `meName`.

The failure mode was silent and easy to misdiagnose: `compile()` catches
the syntax error and returns `() => undefined`, so the expression just
evaluates to `undefined`/falsy — the nav rendered its **logged-out** branch
for a fully authenticated request, cookie and session and all. Confirmed
correct session server-side (`/__spark/data/...` had `session`/`me`
populated) while the rendered page still showed "Log in" — that mismatch is
what pointed at the prop layer instead of the auth layer.

**Fix used:** all-lowercase, no-hyphen prop names throughout —
`loggedin`, `mename`, `meusername`, `meavatar` — matched exactly in both
the parent's attribute and the child's `{expr}`.

**Note for anyone reaching for this pattern:** this cost real debugging
time specifically because the failure was silent (no console error, no
diagnostic) and one layer removed from the actual cause (looked like a
session/auth bug, was actually a template-prop naming bug).

**Fixed in this session:** added a `spark-html-language-server` diagnostic
(`unstable-prop-name`) that flags exactly this — a `<div import>` attribute
name containing `-` or an uppercase letter (excluding `data-*`/`aria-*`,
which are conventionally raw host attributes, never read back as a prop)
— with a suggested lowercase, no-hyphen replacement. Would have caught this
the moment it was typed.

## 3. `onclick={expr}` needs quotes the moment the expression contains ANY whitespace — not just `=`

**Where:** template authoring convention, not a spark-ssr/spark-html bug —
this is standard HTML attribute-parsing behavior, but the framework's own
docs/examples only show unquoted, whitespace-free handlers (`onclick=
{add}`), which sets a trap for the first multi-token expression someone
writes.

**What happened:** `onclick={confirmingDelete = true}` (no quotes) breaks
at the **HTML parsing** stage, before spark ever sees it. I originally
diagnosed this as being about the `=` specifically — it isn't. An
**unquoted** HTML attribute value ends at the first whitespace character,
full stop; `=` was just the character that happened to have spaces around
it in the case I hit. Confirmed directly against linkedom (the parser
spark-ssr uses) with three cases:

```
onclick={doThing(a, b)}      →  onclick="{doThing(a," b)}=""      (BROKEN — the space after the comma)
onclick={doThing(a,b)}       →  onclick="{doThing(a,b)}"          (fine — no internal whitespace)
onclick={confirmingDelete = true}  →  onclick="{confirmingDelete" =="" true}=""   (BROKEN)
```

So `onclick={doThing(a, b)}` is just as broken as the assignment case,
with no `=` in sight — the parser reads the attribute as `onclick=
"{doThing(a,"` and then chokes on the dangling ` b)}` fragment, which
linkedom serializes back out as garbage attributes on the element. The
element still renders, but with a mangled tag and a dead handler — not a
crash, not a warning, just quietly broken markup.

**Fix used:** quote every handler attribute whose expression contains
*any* whitespace: `onclick="{confirmingDelete = true}"`,
`onclick="{doThing(a, b)}"`. Single-token or no-space handlers
(`onclick={remove}`, `onclick={saveToBoard(b.id)}`) are unaffected.

**Fixed in this session:** added a `spark-html-language-server`
diagnostic (`unquoted-handler-whitespace`) that flags exactly this —
an unquoted `on*={…}` attribute whose expression contains whitespace —
with a hint to add quotes. Purely syntactic, zero false positives.

## 4. `spark-ssr`'s per-page auto-404 is defeated by *any* `else`/`else-if` in the merged layout+page text — including in a shared layout, for every page

**Where:** `spark-ssr/src/server.js`, the auto-404 check:
`!/<template\b[^>]*\b(?:else|else-if)\b/i.test(pd.html)`.

**What happened:** this is documented behavior ("an explicit if/else
branch in the page opts out"), but the check runs against `pd.html`, which
is the **merged layout + page** text, not just the page. A logged-in/
logged-out branch in `_layout.html` written as `<template if="session">…
<template else>…` would have silently disabled auto-404 for **every**
`[param]` page on the whole site, not just pages that intentionally opt
out — because every page shares that one layout.

**Not a bug exactly** (the layout's markup genuinely does contain an
`else`), but a sharp edge worth documenting: a layout is easy to reach for
as "just chrome," and this makes any conditional in it a site-wide,
easy-to-miss opt-out of a feature the README frames as automatic per-page.

**Workaround used:** moved the logged-in/out branch out of `_layout.html`
into its own component (`components/nav.html`). A component's markup is
never text-merged into `pd.html` (it stays a `<div import>` placeholder
until render time), so its internal `else` usage is invisible to the
auto-404 scan. `pages/pin/[id].html` and `pages/u/[username].html` both
rely on real auto-404 (missing pin / missing profile), so this mattered.

**Suggested fix:** scope the `else`/`else-if` scan to the *page's own*
body (before layout merge), not the merged text — a layout's own
conditionals shouldn't affect a page's opt-out decision at all.

## 5. An empty-string prop is coerced to boolean `true` on a non-hydrating page's kept import host

**Where:** `packages/spark/src/index.js`'s `coerce()`, combined with
`render.js`'s "kept host" pattern for non-hydrating pages
(`serializeProp`/`keepHost`).

**What happened:** `_layout.html` passed `q="{q ?? ''}"` to `nav.html` so
the search box could show the current query. On the home page (which does
**not** hydrate — no handlers/binds of its own), the top-level import host
is *kept* (per spark-ssr's flash-free hydrate contract): the server
evaluates the prop and bakes the real value into the host's attribute via
`serializeProp()`, e.g. `q=""` when there's no search term. That's a
perfectly valid, empty **string**.

The browser's `mount()` then re-resolves that kept host and rebuilds
`props` from the (now-plain, brace-free) attribute via `coerce()`:

```js
function coerce(v) {
  if (v === '' || v === 'true') return true; // bare attribute → boolean true
  ...
}
```

`coerce()` can't distinguish "an attribute with no value" (`<input
disabled>`, HTML's bare-attribute-means-true convention, which is what this
line is *for*) from "an attribute explicitly set to the empty string"
(`q=""`, which came from a real `{expr}` that happened to evaluate to
`''`). Both look identical once serialized to an attribute. The result:
`q` became the boolean `true` on the client, and `{q}` in the search
`<input value="{q}">` rendered the literal text **"true"** in the box —
on a real, fully server-rendered production-path page, no error, no
warning.

This is the same underlying gotcha as #2 (`coerce()`/HTML's own
value-coercion rules are lossy at the empty-string boundary) but hits a
completely different code path — no naming mismatch this time, a
correctly-named, correctly-evaluated prop still broke because of what
value it legitimately held.

**Fix used:** stopped passing `q` as a prop entirely. `nav.html` now reads
it directly from `location.search` in its own `<script>` (client-only;
during SSR the component has no `location`, so the search box simply
starts empty and corrects itself once the client boots — no flash of
wrong content, since "empty" and "not-yet-known" render the same way).

**Why this doesn't also bite `mename`/`meusername`/`meavatar`:** those
*can* also be empty strings (logged out), but they're only ever read
inside the `loggedin === 'yes'` branch, which doesn't render when logged
out — so the miscoerced value is unused in the one case where it'd be
wrong. Worth being deliberate about, not something the framework protects
you from.

**Suggested fix:** distinguish "attribute present with an empty string
value" from "bare attribute" at the point props are captured (before
serialization), rather than trying to recover the distinction from the
serialized attribute string — e.g. spark-ssr's `serializeProp()` could
emit a sentinel for empty strings specifically (it already has a
reserved-token convention for `null`), and `coerce()` could special-case
it back to `''` instead of `true`.

## 6. A hydrating `[param]` page loses its own route param on the client — `:id`/`:slug` resolves to `null` on every client-side data fetch

**Where:** `spark-ssr/src/server.js` (`shell()`, the `/__spark/page/` and
`/__spark/data/` handlers) and `spark-ssr/src/hydrate.js` (`clientScript()`).
**Fixed in this session** (in the workspace-local `spark-ssr`, not just
worked around in the app) — this is the most serious bug found, since it
breaks the single most natural spark-ssr pattern for this kind of app: a
detail page (`/pin/:id`) that is *both* dynamic *and* interactive.

**What happened:** every instance of a `[param]` route's client component
is served from the exact same URL — `/__spark/page/pin/[id]` and
`/__spark/data/pin/[id].js`/`.json` are the literal template key, not
`/__spark/page/pin/3`. The generated client script's initial state comes
from a static `import __init from '/__spark/data/pin/[id].js';`, and
`refresh()` re-fetches the same URL plus `location.search`. Both handlers
build their `req` with **`params` hardcoded to `{}`**
(`wrapReq(request, url, {}, session, srv)`), and nothing anywhere
reconstructs `:id` from the actual page the browser is on. Since `:id` is
a **path segment**, not a query-string key, it never appears in
`location.search` either — unlike `?q`/`?sort`/`?page`, which `refresh()`
already carries correctly.

Net effect: `pin = SELECT … WHERE p.id = :id LIMIT 1` resolved `:id` to
`null` on every client-side fetch (both the very first hydration and every
`refresh()` after it), so `pin` hydrated as `null` on **every** pin detail
page, regardless of which pin the user was actually looking at. Confirmed
via a browser CDP session: SSR showed the right pin, then the moment
`mount()` took over, the console filled with `Cannot read properties of
null (reading 'title')` etc. for every field, and an uncaught `TypeError`
the instant a handler (`toggleLike`) tried to read `pin.id`. This is not a
cosmetic bug — it makes any interactive `[param]` detail page's own data
non-functional the moment the client boots, in a way that's invisible from
`curl`/SSR-only testing (this is exactly why: caught this only once the app
was driven in a real browser, not from the many `curl`/`/__spark/data/…`
checks that all looked correct because those hit the SAME endpoints
*with* an explicit `?id=` I'd added by hand for testing, accidentally
masking the exact bug those manual checks would otherwise have caught).

**Fix applied:**
1. `shell()` now computes `routeParamsQS = new URLSearchParams(req.params).toString()` from the real, already-resolved request params, and bakes it onto the hydrating host's own import path: `<div import="/__spark/page/${page.key}?${routeParamsQS}" name="…">`.
2. The `/__spark/page/` handler reads that query string back off its own request URL and threads it into `clientComponent()`/`clientScript()` as `routeParamsQS`.
3. `clientScript()` appends it to both the initial `import __init from '/__spark/data/${key}.js?${routeParamsQS}'` and to `refresh()`'s fetch target (merged with `location.search`'s own params, so `?q`/`?sort`/`?page` still work exactly as before).
4. `/__spark/data/`'s handler needed **no change** — it already builds `req.query` from `url.searchParams`, and `resolveToken()` already falls back to `req.query[tok]` when `req.params[tok]` is absent. Once the query string carries `id=3`, the existing fallback just works.

**A second, smaller bug this uncovered along the way:** `packages/spark`'s
`resolveImportNode` unconditionally appends `.html` to an import path that
doesn't already end with it (`if (!path.endsWith('.html')) path += '.html'`).
Given `/__spark/page/pin/[id]?id=3`, that check looks at the *whole*
string (ends with `3`, not `.html`) and appends anyway, producing
`/__spark/page/pin/[id]?id=3.html` — the `.html` lands **inside the query
value**, not after the path. Fixed alongside (in `packages/spark`, not
`spark-ssr`): split off the query string before the extension check, add
`.html` to the bare path, then reattach the query string.

**Regression coverage:** `packages/spark-ssr/test/ssr.js`, "hydration
(§2): a [param] page keeps its :id on the client, not just SSR" — mounts
the *real* runtime (via `mountHydratedPage`) against three different
`/widget/:id` instances and asserts each hydrates with its **own** row,
not the first one or a blank. Verified this test fails without the fix
(`git stash` the three source files, rerun — assertion fails with `''`
instead of the expected name) and passes with it.

## 7. A named `<spark-ssr>` source referenced only from the page's `<script>` never becomes real — the whole script throws, silently disabling the page

**Where:** app-level footgun (`pages/u/[username].html`), not a spark-ssr
bug — but a sharp, non-obvious edge of how `dataPlan()` decides what
becomes a reactive var.

**What happened:** `u/[username].html` declared a named source,
`amFollowing = SELECT id FROM follows WHERE …`, and used it **only**
inside the page's own `<script>` (`let following = !!amFollowing;`) — never
in the template. `dataPlan()` builds `plan` by walking
`analysis.needs` (identifiers the **template** reads) and matching each
against declared sources; it does not separately scan the script for
identifier references. A source with no matching template need is simply
never added to `plan`, so the framework never emits `let amFollowing =
__init.amFollowing;` for it. My script referenced a name nothing had ever
declared — a plain `ReferenceError`, but since it happens at the top level
of the generated client component's script, the **whole script fails to
run**: not just the one broken line — `toggleFollow`, the tab-switching
handlers, everything on the page. The console message was a real, useful
signal (`script in "[username]" — amFollowing is not defined — the
<script> failed to run — state and handlers are unavailable`), but only
because it happened to be one of the small set of failures spark-html's
error containment explicitly reports; a subtler variant of this (say, a
mistyped plan-var name) would degrade the same way.

**Fix used:** reference the named source directly in the template instead
of introducing a local mirror variable — `:class="amFollowing ? 'on' :
''"` — which both (a) makes it a real need so `dataPlan()` actually wires
it up, and (b) means the SSR-rendered initial paint shows the correct
follow state immediately, rather than a script-only local that could only
ever be right after hydration. `toggleFollow()` calls the already-ambient
`refresh()` afterward instead of hand-toggling a separate boolean —
`amFollowing`, being real plan data, refreshes correctly with everything
else.

**General lesson for anyone hitting this:** a `<spark-ssr>` named source
used to be only "real" (seeded, refreshable, part of `__init`) if the
**template** read it somewhere — reading it only from the script didn't
count, and the failure was a page-wide script crash with no indication
that the named source itself was the unused one.

**Fixed in this session:** `dataPlan()` now also scans the page's own
`<script>` for a plain word-boundary reference to each declared source's
name, in addition to walking the template's needs — so a source used only
from script still gets seeded (`let amFollowing = __init.amFollowing;`)
instead of throwing. A source neither the template nor the script ever
references still stays out of the plan (declaring one doesn't force it
in). The app itself still uses the template-reference pattern (it's the
better practice regardless — it also means the SSR-rendered initial paint
is correct, not just the post-hydration one), but the framework no longer
lets the OTHER way silently degrade into a page-wide crash.

## 8. A `<script>`'s own JS comment mentioning the literal text `<spark-ssr>` corrupts the page — fixed in this session

**Where:** `spark-ssr/src/parse.js`'s `extractBlocks()` and
`spark-ssr/src/render.js`'s `componentProgram()`. **Fixed in this
session.** This is how bug #7 above actually got introduced — I was
writing a doc comment *about* the `amFollowing` footgun, inside the page's
own `<script>`, and used the literal text `<spark-ssr>` in prose to refer
to the tag. That single mention corrupted the whole page.

**What happened:** both functions mask HTML `<!-- -->` comments before
scanning the raw source for `<spark-ssr>` tags — precisely so prose like
"declare data in `<spark-ssr>`" inside an HTML comment can't start a fake
extraction (the file's own header says as much). But neither masks
`<script>` content first. A **JS** comment (`//` or `/* */`, not an HTML
comment) or a string literal inside a real `<script>` mentioning the
literal text `<spark-ssr>` is invisible to that comment-masking pass, so
the regex reads it as a **real tag opening** and consumes everything up
to the next actual `</spark-ssr>` — including the rest of the author's own
script, the `</script>` tag, and the real data block that was supposed to
be there.

The insidious part: the query line inside the accidentally-swallowed span
often **still parses**, because `parseBody()` matches `name = source`
line-by-line regardless of what garbage surrounds it — so the data itself
can come back correct while the surrounding markup is silently mangled
(truncated script, stray literal `</body></html>` text leaking into what
looks like the script's own content, per a real `curl` capture during this
session). This is exactly why it wasn't caught by any of the many
`curl`/`/__spark/data/…` checks earlier in the build — those only ever
look at data, not markup structure.

**Fix applied:** added `maskScripts()` alongside `maskComments()` in
`parse.js` (same token-substitution technique, `<script>…</script>` →
placeholder). `extractBlocks()` now masks comments *and* scripts before
scanning for `<spark-ssr>`, restoring both after. `componentProgram()`
needed the trickier version: comments must stay masked through **both**
the `<spark-ssr>`-strip pass *and* the subsequent `<script>`-extraction
pass (a comment mentioning `<script>` in prose is bug #1's mirror image
and must not confuse the second pass either) — only scripts come back in
between, since that pass needs to see the real tags. Got this ordering
wrong on the first attempt (restored comments too early, which broke the
existing "component comment survives verbatim" test) — the working order is
mask comments → mask scripts → strip `<spark-ssr>` → restore scripts →
strip `<script>` → restore comments.

**Regression coverage:** a new unit test calls `extractBlocks()` directly
(not through the HTTP layer, precisely because the HTTP-level symptom is
misleadingly easy to miss) and asserts three things a corrupted extraction
would get wrong: exactly one real block parsed, the script's own trailing
content survives, and the `</script>` tag itself isn't consumed. Verified
failing without the fix (`git stash` the two source files, rerun — fails
with "the rest of the script survives, not eaten as fake block 'inner'")
and passing with it.

## 9. A regression in bug #6's own fix — over-broad `__sparkPend` marking patched components before their own async imports resolved

**Where:** `packages/spark/src/index.js`'s `buildProps()`/`bootComponent()`
— introduced by the fix for bug #6 earlier in this same round, caught by
running `create-spark-html-app`'s **prerender** template (a completely
separate package, `spark-prerender` — not `spark-ssr`) and seeing a batch
of `[spark] Error evaluating {…}` / `Error in :attr=` warnings on build.

**What happened:** the bug #6 fix needed `bootComponent()` to retry a
top-level import's props once its enclosing component's scope existed,
flagged via `host.__sparkPend = node`. To keep the gzip budget from
growing further, that flag got set **unconditionally** whenever an import
had no `scope` (i.e., for nearly every top-level import in an app, since
only each/if-cloned ones carry one) — "harmless," the reasoning went,
since re-deriving unchanged literal props is a no-op. It wasn't harmless:
setting it made `bootComponent()`'s retry logic run for that component
too, including an unconditional `patch(el, el.__sparkScope)` call. For a
component with **no pending cross-component prop at all** but **its own
async script** (a dynamic `import` — exactly the prerender showcase's
demo components), that retry's sync branch fired the patch immediately,
before the component's own import had resolved — evaluating `{capitalize
(mood)}`, `{todos.length}`, `:disabled="!draft.trim()"` etc. against a
scope still missing the imported function / not-yet-initialized state.
Rendered as empty with a warning per the runtime's error containment, not
a crash, but a build full of them.

A **second, narrower** version of the same mechanism survived the first
patch: a component that legitimately *does* have a pending
cross-component prop (so the retry is real) but *also* has its own async
script could still get patched before ITS OWN import resolved — the retry
only waited on the ANCESTOR's `__sparkScriptReady`, not the component's
own.

**Fix:** `buildProps()` only sets `__sparkPend` when some attribute
actually has an unevaluated `{…}` needing the ancestor's scope (tracked
with one boolean during the existing attribute loop — no new work, just a
narrower condition). And the retry itself now waits on **both**
`__sparkScriptReady`s — the ancestor's and the component's own — before
re-patching.

**Regression coverage:** `packages/spark/test/jsimport.js`, "a pending
cross-component prop retry waits for the CHILD's own async import too" —
a real parent/child pair where the child has both a `{parentState}` prop
and its own `import { capitalize } from './format.js'`. Verified failing
(`parent-state prop still made it across` — the prop is left as the
literal `'{hello}'` string) with just the ancestor-only wait, passing with
both. Also re-verified the ORIGINAL reported symptom directly: built
`create-spark-html-app`'s prerender template against the fixed package —
zero warnings, versus a full page of them before.

**Lesson:** a "harmless no-op" justification for widening a conditional
to save a few bytes needs the same scrutiny as any other correctness
change — the actual cost here wasn't the re-evaluation, it was firing an
extra `patch()` at a time the code hadn't previously needed to reason
about. Also: this shipped in a released patch version
(`spark-html@0.27.10`) before being caught, which is why the very next
patch (`0.27.11`) exists.
