# Bugs and edge cases found while building this app

Discovered while building TabTube (a YouTube search/watch app — `create-spark-html-app ssr`,
no database) against workspace-local `spark-html`/`spark-ssr`/`spark-html-language-server`.
Ordered roughly by severity. None of these are hypothetical — each was caught by actually
running the dev server, exercising the page in a real browser (Chrome via CDP), or writing
a minimal reproduction against the bare `spark-html` runtime when the app-level symptom
needed isolating from spark-ssr/hydration to find the real cause.

## 1. A helper function's own local variable can turn into an infinite patch loop — a real hang, not just a stale value

**Severity: critical.** **Where:** `packages/spark/src/index.js`, `analyzeScript()`'s
`let`/`const`/`var`-stripping and function-declaration rewriting.

**What happened:** the time-range filter pills ("Today" / "This week" / "This month") froze
the entire page — not just a stale render, a genuine hang. Chrome's DevTools Protocol
couldn't even get a response to `1+1` afterward; the tab was fully unresponsive. Bisecting
down from the real app to a minimal `spark-html`-only reproduction (no spark-ssr involved
at all) found the exact trigger:

```html
<template each="v in items" key="v.id">
  <div :hidden="!matchesFilter(v, activeFilter)">{v.name}</div>
</template>
<script>
  let activeFilter = 'all';
  function agoDays(ago) {
    const m = String(ago || '').match(/(\d+)\s*(day|year)/);   // ← this line
    if (!m) return Infinity;
    const n = Number(m[1]);
    ...
  }
  function matchesFilter(v, filter) { ... agoDays(v.ago) ... }
</script>
```

`analyzeScript()` exposes a component's TOP-LEVEL `let`/`const`/`var` declarations as
reactive scope properties by literally stripping the keyword (`let x = 1` → `x = 1`, so the
assignment hits the scope proxy). That regex-based rewrite runs over the **entire script
text as a flat string** — it has no concept of brace nesting, so it ALSO stripped the `const
m = ...` inside `agoDays`, a plain helper function nested two levels deep. `const m = …`
became a bare `m = …` — an **implicit write to the component's reactive scope**, not a true
local variable anymore.

Every write to a scope key that's *also read* during the same expression evaluation gets
that key added to the expression's own tracked dependency set (that's how targeted,
O(changed)-not-O(all) re-patching works at all). Since `agoDays` both **writes** `m` (via the
stripped `const`) and **reads** it (`m[1]`, `m[2]`) in the same call, `:hidden`'s dependency
set picked up `m` as something it depends on. And since evaluating `:hidden` is exactly what
*writes* `m` in the first place — every patch cycle re-triggered another patch cycle,
forever. `queueMicrotask`-scheduled flushes starve the event loop before any `setTimeout`
based safety net gets a turn, which is why this manifests as a genuine, unrecoverable hang
rather than a slow loop you could observe from outside.

**Confirmed NOT about**: regex literals specifically (`new RegExp(...)`, `.test()` without
ever building a match array, and a completely unrelated `String(ago)` all reproduced it
identically), "hidden" the attribute name specifically (`:disabled`/`:class` calling the
exact same function do NOT hang — only a genuinely re-triggering `:hidden` boolean write-path
does, and only because the helper's own local got corrupted first). The actual, sole trigger:
**a nested helper function's own `let`/`const`/`var` local variable, declared anywhere inside
a function body (any nesting depth), that is both read and written within one call from a
template expression.**

**Fixed in this session:** added `braceDepths()` — a comment/string-aware `{`/`}` nesting
depth scan — and gated both rewrites (the function-declaration rewrite and the
`let`/`const`/`var`-stripping) so they apply **only at the script's own top level (depth
0)**. A nested declaration, at any depth, is now left completely untouched, exactly as
JS itself would scope it. Regression test in `packages/spark/test/deps.js` (bisects the
exact repro above, guarded with a 2s timeout so a future regression at least fails loudly
instead of hanging the whole suite — though see the caveat above about microtask
starvation defeating `setTimeout`-based safety nets). Bumped the gzip budget 13.3 → 13.4KB.

**Lesson for anyone hitting something like this:** if a page becomes completely
unresponsive (not slow — actually frozen, unrecoverable even via devtools) right after a
state change, and the state change feeds an each-loop's `:attr` binding, suspect a helper
function with its own local variable of the same pattern (declare something, use it,
return). This is an extremely common, completely innocent code shape — there's nothing
unusual about `agoDays`'s implementation. The bug is 100% in the framework's script
rewriting, not in anything an app author did differently from normal.

## 2. Server-side render never runs the page's own `<script>` at all — not even a plain `let` initializer

**Severity: high (architectural surprise).** **Where:** how spark-ssr's template render pass
works, in general — not a defect exactly, but a completely undocumented (from what's visible
in templates/examples) constraint that silently breaks a very natural-looking pattern.

**What happened:** the results list used `each="v in filteredResults"` where
`filteredResults` was declared as a `$: filteredResults = results.filter(...)` reactive
derivation, and `activeFilter`/`tabs`/`suggestions` were declared as plain `let` state with
literal initializers. On the very first SSR-rendered response for `/?q=lofi`, **every single
one of these rendered as empty** — not just `filteredResults`, but even `tabs.length === 0`
(a boolean check against a `let tabs = []`) failed to render its "no tabs yet" message.

The server's render pass evaluates every `{expr}`/`:attr`/`if=`/`each=` in the template
directly against `scope` — which is built purely from declared `<spark-ssr>` sources plus
ambient values (`path`, `session`, `flash`, the current request's `req.query`/`req.params`).
It **never executes the page's own `<script>` at all** — not a `$:` derivation, not a plain
`let` initializer, not even a helper function declaration. Calling an undeclared name in a
template expression (`filteredResults`, or a function like `matchesFilter(...)`) either
evaluates to `undefined` (silently rendering empty for `{expr}` interpolations and `each=`
loops) or throws internally, caught by the runtime's per-attribute error containment —
which, depending on the attribute kind, fails in OPPOSITE directions (see #3).

This is a real, sharp edge: `<script>`-declared state and logic are 100% real and correct
once the page **hydrates** (the client fetches `/__spark/page/<key>`, which contains the
same script, and DOES run it) — but the very first, server-rendered paint of an interactive
page can only ever reflect `<spark-ssr>` sources and ambient scope. Anything computed in
script — derived filters, formatted strings, helper-function calls — is simply invisible
until JS boots.

**Fix used:**
- Loop directly over the real named source (`each="v in results"`), never over a
  script-only derived array.
- Push per-row **formatting** into the data layer itself (`lib/search.js`'s `simplify()`
  computes `viewsFormatted` server-side) rather than relying on a client helper function
  (`{formatViews(v.views)}` rendered blank at SSR time for exactly this reason).
- For **filtering** (which genuinely needs a helper function + local UI state), use
  `:hidden="!matchesFilter(v, activeFilter)"` instead of wrapping the row in
  `<template if="matchesFilter(...)">` — see #3 for why that distinction matters.

**Lesson:** a hydrating page's *first* paint is not "the same template evaluated once
client-side would produce" — it's evaluated against a strictly smaller scope. Anything a
script computes needs either a matching named source, or a template expression shaped so
that "undeclared → undefined/throws" degrades toward the CORRECT pre-hydration default,
not away from it.

## 3. `<template if="…">` and `:hidden="…"` fail in OPPOSITE directions when the expression throws

**Severity: medium, but easy to get backwards.** **Where:** app-level consequence of #2 —
worth its own entry since the FIX for #2 specifically depends on this asymmetry.

**What happened:** the first attempt at making the results list SSR-safe wrapped each row in
`<template if="matchesFilter(v, activeFilter)">…</template>`. Since `matchesFilter` is a
script-only function (unavailable at SSR — see #2), this expression throws during the
server's render pass. A `<template if=…>` whose condition throws (or is falsy) **omits the
element entirely** — so every single row vanished from the SSR output, not just the ones
that would have failed the filter.

Switching to `:hidden="!matchesFilter(v, activeFilter)"` on the row itself fixed it
immediately: a throwing/falsy `:attr` expression **leaves the attribute untouched** (per the
runtime's own contract: "Attribute left unchanged"), which for `hidden` means it's simply
never added — the row stays visible. That happens to be exactly the desired pre-hydration
default (no filter applied yet, "All" is the real default), and it turns into correct
per-row filtering the moment hydration runs and `matchesFilter` becomes real.

**Lesson:** `<template if>` and `:attr` (`:hidden`, `:disabled`, `:class`, …) are not
interchangeable ways to conditionally show/hide something — they fail in opposite
directions when their expression can't be evaluated. `if=` fails CLOSED (hides), `:attr`
fails OPEN (leaves as-is). Pick based on which failure mode you want as the pre-hydration
default, not just which reads more naturally.

## 4. `bind:value="name"` local state isn't seeded from a live `?name=` query string on hydration

**Severity: high.** **Where:** `packages/spark-ssr/src/hydrate.js`, the `topBinds` seeding
in `clientScript()`.

**What happened:** the search box (`<input bind:value="q">`) correctly showed the SSR-time
value for a shared `/?q=lofi` URL — but the instant hydration completed, it reset to empty,
and the results list reset to nothing (see #6 below for the related data half of this).
Traced to `hydrate.js` hardcoding `let q = '';` for any `bind:value` target the author
doesn't declare themselves, **regardless of what the actual query string said** — since the
generated client script is static and shared by every visit to this route (one
`/__spark/page/<key>` URL for ALL requests), it can't bake a per-request value in
server-side the way SSR can.

**Reproduced even in `create-spark-html-app`'s own official `ssr-nodb` template** (its
`bind:value="q"` filter box on the markdown-blog homepage): visiting `/?q=spark` renders the
filtered list correctly at SSR, then the client hydrates and silently resets the filter —
the search box goes visibly blank and the full unfiltered list reappears. This is the
demonstrated, documented idiom in the framework's own starter template, so it's not an
unusual app-level pattern; it's the textbook one.

**Fixed in this session:** the generated client script now seeds `bind:value` locals from
`new URLSearchParams(location.search)` — read live, on the client, matching the same pattern
already used for `{path}` (`location.pathname`) — instead of a hardcoded empty default.
Regression test in `packages/spark-ssr/test/ssr.js` ("a bind:value=\"q\" local var is seeded
from a LIVE ?q=, not reset to ''"), which required teaching the test harness's
`mountHydratedPage()` helper to set a real `location` global at all (it previously had none,
so `{path}`'s own live-seeding was ALSO silently never exercised by any existing test).

## 5. A client-side data source's OWN initial hydration fetch never carries the page's query string either

**Severity: high — the other half of #4.** **Where:** `packages/spark-ssr/src/server.js`,
`routeParamsQS` construction in the main page-serving handler.

**What happened:** even after fixing #4 (so the search box correctly showed "lofi" after
hydration), the results list was still empty post-hydration. `results` comes from a MODULE
source (`results = ./lib/search.js`, reading `req.query.q` directly) — correct at SSR time,
but the client's own `import __init from '/__spark/data/index.js'` fetch (which re-seeds
`results` for the hydrated component) carries **no query string at all**, since
`routeParamsQS` — the mechanism that bakes context onto this fetch — was built purely from
`req.params` (a `[param]` route's `:id`, which genuinely never appears in the query string).
`req.query` was never folded in, so a source that reads the query string directly got `q: ''`
on its VERY FIRST client-side fetch, before any later `refresh()` (which DOES read
`location.search` live) ever gets a chance to run.

**Fixed in this session:** `routeParamsQS` now merges `req.query` alongside `req.params`
(params winning on any key collision, preserving the tested `[param]` behavior exactly).
Regression test: "a MODULE source reading req.query gets the live ?q= on its OWN initial
fetch, not just refresh()".

## 6. `leaveNode()` only removes the (invisible) each/if/await anchor tag — not the rows/branches it rendered as siblings

**Severity: critical, and completely general — not spark-ssr-specific.** **Where:**
`packages/spark/src/index.js`, `leaveNode()`.

**What happened:** the "My Lists" view toggle (`showMyLists`, a plain local boolean) visibly
flipped its own button's `:class` correctly on click — proving the underlying reactive write
DID happen — but the sibling `<template if="!showMyLists">`/`<template if="showMyLists">`
blocks (each wrapping its own `each=` loop) never actually swapped content. The search
results view kept showing regardless of which button was active.

`<template each>`/`<template if>`/`<template await>` are, visually, empty anchor tags —
everything they "render" lives in tracked SIBLING nodes they insert themselves
(`__sparkEachBlocks`' per-row nodes, `__sparkIfRendered`, `__sparkAwaitRendered`).
`leaveNode(n)` — called by `patchIf`'s branch-teardown, `patchEach`'s stale-row cleanup, AND
`applyAwaitState`'s branch-switch cleanup — only ever called `n.remove()` on the anchor
clone itself. If that anchor's OWN content was, say, a nested `<template each>` (my case: an
if-block's content WAS an each-loop), removing the (already-invisible) anchor tag left every
row it had rendered as siblings **orphaned**: still in the DOM, and any component inside
those rows never got its `onDestroy`/store-unsubscribe cleanup run either — a real memory/
subscription leak, not just a visual glitch.

**Fixed in this session:** `leaveNode()` now recursively tears down whatever a node it's
removing had ITSELF rendered (checking `__sparkEachBlocks`/`__sparkIfRendered`/
`__sparkAwaitRendered` before removing), and `applyAwaitState`'s own inline duplicate of the
same (narrower, equally-buggy) cleanup now routes through the fixed `leaveNode()` too.
Regression test in `packages/spark/test/loops.js`: an if-block's each-loop rows correctly
disappear (not orphaned) when the if goes false, AND a child component inside those rows
gets its own `onDestroy` called exactly once (not zero times).

## 7. `dataPlan()`'s "unresolved" dev banner false-positives on ordinary script-declared local state

**Severity: medium (a false alarm, not silent breakage) — but was actively misleading while
debugging #2/#4/#5.** **Where:** `packages/spark-ssr/src/parse.js`, `dataPlan()`.

**What happened:** while chasing #2, the dev-mode banner "this page reads {tabs}; {suggestions};
{filteredResults}; {savedList}; {activeTab} — nearest source: results — but no source
provides it" appeared on every page load — even though ALL FIVE were completely ordinary,
correctly-declared local reactive state (`let tabs = []`, a `$: activeTab = …` derivation, a
`persist()`-backed store), none of them missing anything. `dataPlan()`'s "unresolved"
computation (the mechanism behind this banner) only checked whether a template need had a
matching **data source** — it never checked whether the need was something the page's own
script already declares. Any `each=`/member-accessed name used ONLY in script (never also
independently matched to a source) tripped the banner, purely because of HOW it was used in
the template, regardless of it being entirely legitimate local state.

**Fixed in this session:** moved `definedNames()` (previously private to `hydrate.js`, used
there to avoid double-declaring an author's own state) into `parse.js` and reused it in
`dataPlan()`'s unresolved-need computation — extended to also recognize `$: name = …`
reactive declarations (which the original only used for hydrate.js's narrower purpose and
didn't need). A name the script itself declares is now correctly excluded from the "did you
forget a source" banner.

## 8. A dynamic `import()` of a relative PROJECT file from an `api/*.html` script resolves against spark-ssr's own installed location, not the project

**Severity: medium — a documented workaround exists, but it's a sharp, non-obvious trap.**
**Where:** app-level footgun in `api/search.html`, not a spark-ssr bug — a consequence of how
`api/*.html` scripts are compiled (`new Function(...)`).

**What happened:** wanted `api/search.html` to `import('../lib/search.js')` to share the
exact same yt-search-calling logic as the page's own `results = ./lib/search.js` module
source (DRY). A dynamic `import()`'s **relative** specifier resolves against the importing
MODULE's own location — but an `api/*.html` script is compiled via `new Function(...)`,
whose "importer" for module-resolution purposes is spark-ssr's own installed package
location, not this project. `'../lib/search.js'` would silently resolve to a nonexistent
path inside `node_modules/spark-ssr/...`, not this project's real sibling file — a 404 at
runtime with no obvious clue why, since the SAME import specifier works perfectly for the
page's OWN `<spark-ssr>` module source (which uses `moduleSource()`'s explicit
`pathToFileURL(file)` absolute-path resolution, a completely different mechanism).

A **bare package specifier** (`import('yt-search')`) resolves fine from the exact same
`api/*.html` script — Node's bare-specifier algorithm walks UP the directory tree looking for
`node_modules`, and eventually reaches this project's, regardless of the nominal
"importer"'s own location.

**Fix used:** don't try to share code via a relative import from an `api/*.html` script.
Either duplicate the (small) logic directly in the endpoint script (what this app does —
see the comment in `api/search.html`), or only import real npm packages by bare specifier
from there.

## 9. `persist()`'s own return value isn't itself subscribed to a component's re-render cycle — you still need `useStore()`

**Severity: high, app-level (my own mistake, not a framework bug) — but a very easy
mistake to make given the package's own docs.** **Where:** app-level, `pages/index.html`;
`spark-html-persist`'s API is working exactly as documented, just easy to misread.

**What happened:** "My Lists" (save/unsave a video) was written as
`const savedList = persist('tabtube-saved', { items: [] });` directly inside the page
component, then read/written via `savedList.items` throughout. The save button's own
`{isSaved(v) ? '★' : '☆'}` text never updated after clicking — but the underlying data WAS
correct: switching to the "My Lists" view (a completely unrelated `showMyLists` toggle, a
plain local boolean) DID show the saved item, because clicking THAT button triggers ITS OWN
full re-render, which incidentally re-reads the by-then-correct `savedList.items` along the
way. Direct scope introspection confirmed it precisely: calling `scope.toggleSaved(v)` (or a
real click) correctly updated `scope.savedList.items` and `scope.isSaved(v)` every time — the
data layer was never wrong — but the DOM never repainted on its own.

`persist(name, initial)` creates the store (`store(name, initial)`, hydrated from
localStorage) and returns its proxy — but a component only gets notified of FUTURE changes
to a store by separately calling `useStore(name)`, which wires a subscription callback tied
to THAT component's own patch-scheduling (`subscribeStore`). Calling `persist()` directly and
using its own return value skips that subscription entirely — reads and writes both work
completely correctly (it's the same underlying reactive proxy either way), the store's data
is never wrong, it's specifically THIS component's re-render that never gets triggered by a
change to it.

The package's own README does show the correct pattern — `persist(name, initial)` once
(typically at app startup), then `const s = useStore(name)` separately inside any component
that wants it — but "Returns the same store as `store(name)`" reads, at a glance, like the
returned value should behave identically to `useStore()`'s result for all purposes,
including reactivity. It doesn't.

**Fix used:**
```js
persist('tabtube-saved', { items: [] });      // creates + hydrates from localStorage
const savedList = useStore('tabtube-saved');  // THIS component's subscribed reference
```

**Lesson:** if a store's DATA is provably correct (confirmed via direct scope
introspection) but the UI showing it never updates on its own — and especially if an
UNRELATED state change's re-render incidentally "fixes" it — suspect a missing
`useStore()` subscription, not a reactivity bug in the store itself.

## 10. Unquoted `on*={expr}` handlers with internal whitespace corrupt the page — my own repeat of an already-documented footgun

**Severity: high impact, zero framework blame — purely a reminder to actually apply lessons
already written down.** **Where:** app-level, several spots in `pages/index.html` on the
first pass.

**What happened:** `onfocus={showSuggestions = suggestions.length > 0}` and four instances
of `onclick={someHandler(v, event)}` (all UNQUOTED, all containing a space) corrupted the
served HTML so badly that the page's entire `<script>` tag vanished from the response and
every subsequent handler attribute was silently dropped. This is the EXACT SAME bug already
documented (and fixed with an LSP diagnostic!) while building the Pinterest example earlier
this session — an unquoted HTML attribute value ends at the first whitespace character, full
stop, regardless of whether that whitespace is next to an `=` or just a comma-separated
argument list.

**Fix used:** quote every handler attribute whose expression contains any whitespace —
`onfocus="{showSuggestions = suggestions.length > 0}"`,
`onclick="{closeTab(t.videoId, event)}"`, etc. Single-token/no-space handlers
(`onclick={doSearch}`, `onclick={switchTab(t.videoId)}`) are unaffected.

**Lesson:** the `spark-html-language-server`'s `unquoted-handler-whitespace` diagnostic
(added earlier this session specifically because of this exact mistake) would have caught
every one of these the moment they were typed, if the editor session had the language server
wired up. Worth actually running the LSP against a new project rather than relying on
"I already know this rule" — evidently, knowing the rule and applying it under normal
typing speed are not the same thing.

---

## Summary: what's a framework bug vs. an app-level lesson

**Framework bugs found and fixed this session** (in `packages/spark` and
`packages/spark-ssr`, all with regression tests, none yet committed/released — see below):
- #1 (critical): nested helper function locals leaking into reactive scope → infinite
  patch loop / real hang.
- #4: `bind:value` locals not seeded from a live query string on hydration.
- #5: a query-string-reading data source's own initial client fetch missing the query
  string entirely.
- #6 (critical): `leaveNode()` orphaning nested each/if/await content and its subscriptions.
- #7: `dataPlan()`'s dev banner false-positiving on ordinary script-declared local state.

**Documented architectural constraints** (not bugs — genuinely how the system is designed,
just non-obvious from the templates/docs alone): #2 (SSR never runs the page's own script),
#3 (if= vs :attr fail in opposite directions on a throwing expression), #8 (relative
dynamic import from an api/*.html script resolves against the wrong base).

**App-level mistakes** (mine, not the framework's): #9 (persist() vs useStore()), #10
(unquoted handler whitespace — a repeat of an already-known lesson).

None of the above have been committed. The framework fixes live in the same
workspace-local `packages/spark` and `packages/spark-ssr` this app depends on, so this
app itself already reflects all of them.
