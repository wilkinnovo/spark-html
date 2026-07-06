# Round 2: bugs found refactoring TabTube toward real component composition

The first pass at TabTube (see `bugs.md`) worked, but kept almost everything in one page's
`<script>` and leaned on two `api/*.html` endpoints (`api/search.html`, `api/suggest.html`)
that duplicated logic already living in `lib/*.js` module sources — flagged as overkill.
This round replaces that with real `<div import="...">` composition (`components/tab-strip.html`,
`components/search-box.html`, `components/video-player.html`) and a shared `useStore('tabtube')`
for cross-component state, following the pattern in the reference app at
`/home/nine/spark-ssr-tabtube`. Building it that way surfaced two previously-unknown, genuine
`spark-html` bugs — both around import-node props — plus one purely app-level CSS mistake.
Ordered by severity.

## 1. A whole-value `{expr}` import prop silently mangles into a stringified/garbage value on the client

**Severity: critical.** **Where:** `packages/spark/src/index.js`, `buildProps()`.

**What happened:** passing a real array as a component prop —
`<div import="/components/video-list" items="{results}">` — worked perfectly at SSR (real
search-result cards rendered), then the instant the page hydrated, the list went blank with a
console warning: `[spark] each="… in items" expected an array but got string. Nothing
rendered.` Introspecting the mounted component's own scope showed why:

```
typeof items === 'string'
String(items).slice(0, 200) === '[object Object],[object Object],[object Object],…'
```

`buildProps()` evaluated EVERY `{expr}` prop attribute through `interpolate()` — which always
builds its result via string concatenation (`out += String(v)`), regardless of whether the
whole attribute value is one bare expression or a mixed template like `class="on-{name}"`. For
an array, `String(array)` is `Array.prototype.toString()` — each element run through its OWN
`toString()` and joined with commas. An array of plain objects becomes `"[object
Object],[object Object],…"`; a **function** prop (`onsearch="{doSearch}"`) would become its own
**source code as a string**, silently breaking any callback prop too. The result then fails
`coerce()`'s `JSON.parse` (neither is valid JSON) and is handed to the component as garbage —
with no error, no warning at the failure site itself, just wrong data one hop away.

This is a fully general bug, not spark-ssr-specific: it breaks passing an array of rows, an
object, or a callback function as a prop to ANY imported component — arguably the single most
ordinary thing "component composition" is for. It went unnoticed until now because neither
existing example (`examples/pinterest`, `examples/blog`, the reference app this round was
modeled on) passes anything but scalars as import props — SSR's OWN prop-passing path is a
real in-process JS value assignment (`render.js`'s `Object.assign(..., props)`), so this bug is
invisible at SSR and only bites the CLIENT's separate `buildProps()`/`interpolate()` path.

**Fixed in this session:** added `evalPropValue()` — when a prop attribute's ENTIRE value is
one `{expr}` with no surrounding literal text (detected via the existing cached
`parseTemplate()` segments: exactly one segment, and it's the compiled-expression kind, not a
string), it evaluates that expression directly via `runExpr()` and uses the REAL result —
array, object, function, number, or boolean stay themselves. A mixed literal+expr template
(where stringifying is exactly what's wanted) still goes through `interpolate()` unchanged.
`class`/`id` (always real HTML attributes) are untouched, always stringified. Only genuine
STRING results still go through `coerce()`'s "true"/"false"/number/JSON handling — a value
that's already a real array/object/function skips it entirely, passed through as-is.
Regression tests in `packages/spark/test/composition.js`: a whole-array prop stays
`Array.isArray() === true` (not a stringified `[object Object],...`), and a whole-function prop
stays callable (not its own source text). Bumped the gzip budget 13.4 → 13.5KB.

## 2. An import node's props are evaluated ONCE at mount and never revisited — a prop fed by data that changes later is frozen forever

**Severity: critical, architectural.** **Where:** how `<div import>` composition works, in
general — `buildProps()` only runs from `resolveImportNode()` (initial mount) and one narrow
"ancestor wasn't ready yet" retry path (`bootComponent`'s `__sparkPend` handling). There is no
mechanism that re-runs it when the PARENT's own state — the value an `{expr}` prop reads —
changes afterward.

**What happened:** after fixing #1, `items="{results}"` correctly received the real array at
mount — but a live, in-browser test of an actual NEW search (typing "guitar" after the page
loaded with "?q=piano", clicking Search) showed the sidebar never updated: the OLD ("piano")
results kept showing even though `refresh()` had genuinely re-fetched, and the PAGE's own
`results` variable had genuinely changed (confirmed by reading the page component's own
`__sparkScope.results` directly — new titles, correct length). The CHILD component's `items`
prop, however, stayed exactly as it was at the moment of the first mount. `:attr`/`{expr}`
bindings INSIDE a component's own template are tracked for reactive re-patching on every
dependency change (that's the whole point of the framework); an import node's prop attributes
are not part of that system at all — they're a one-shot template resolution that happens once,
then the placeholder is gone (replaced by the booted host), never revisited.

This is a much deeper architectural gap than #1: it means passing ANY parent-owned, evolving
piece of state to a child as a prop only ever gives that child a snapshot of whatever the value
was when the child was first created — not a live binding. No existing example app in this
repo passes a prop whose value is expected to change post-mount (only ever scalars/callbacks
that don't need to), so this had never surfaced.

**Not fixed this session** — making import props fully reactive would mean folding import
nodes into the same dependency-tracking re-patch system as `:attr`/`{expr}` bindings (tracking
which prop expressions depend on what, re-running `buildProps()` and pushing new values into
the already-booted child's own scope on every relevant parent state change), which is a real
feature addition, not a targeted bug fix — out of scope for "simplify this example app."

**Worked around at the app level:** anything that (a) must render for REAL at SSR (a shareable
`/?q=...` URL, no JS required) and/or (b) needs to reflect a value that changes after mount via
something like `refresh()` cannot be handed to a child as a prop. `results` needs BOTH — a
store can't give it SSR-reality either (a store is only ever populated by a component's own
`<script>`, which never runs at SSR at all — see `bugs.md` #2) — so the results list, filters,
and "My Lists" toggle are inlined directly in `pages/index.html`'s own template, reading the
REAL `<spark-ssr>` plan var `results` directly, patched normally like any other reactive
template binding (no import boundary in the way at all). `suggestions` has neither constraint
(autocomplete is inherently client-only, never needs to be SSR-real) so it's fine living in the
`tabtube` store, updated by the page's `doSearch()` after every `refresh()`, read reactively by
`components/search-box.html` via `useStore('tabtube')` — stores ARE fully reactive across
components; it's specifically import-node PROPS that are frozen.

**Lesson for anyone doing component composition here:** extract a piece of UI into its own
`components/*.html` file when its OWN state is either genuinely local, or lives in a
`useStore()`-backed store (both fully reactive, proven working for `tabtube.tabs`/`activeId`/
`activeFilter`/`showMyLists`/`suggestions` and the `tabtube-saved` persisted store in this app —
opening a tab, saving a video, and switching filters all correctly update every component that
reads them). Do NOT extract a piece of UI into its own component if it needs to keep showing a
PARENT-owned value that changes over time via a prop — inline it in the parent instead, or
route the value through a store update the parent writes to explicitly (as done here for
`suggestions`), never through the import's own prop attribute.

## 3. `:hidden="…"` silently has no visual effect when the SAME element also sets an explicit `display`

**Severity: medium, purely app-level — not a spark-html/spark-ssr bug.** **Where:**
app-level, `public/style.css`'s original `.result-card { display: flex; … }` combined with the
template's `:hidden="!matchesFilter(v, activeFilter)"` on that same element.

**What happened:** clicking a time-range filter pill ("Today") correctly set the real `hidden`
HTML attribute on every non-matching `.result-card` (confirmed directly:
`document.querySelectorAll('.result-card[hidden]').length` matched the expected count) — but
every card stayed FULLY VISIBLE on screen regardless, filter pill correctly highlighted as
active, underlying data correctly filtered, only the actual show/hide never happened visually.

The browser's own default stylesheet has `[hidden] { display: none; }` — but CSS origin
priority is author-stylesheet-always-wins-over-user-agent-stylesheet, REGARDLESS of selector
specificity being equal or not. `.result-card { display: flex; … }` (an ordinary, unrelated
layout rule, needed for the card's own internal flex layout) is an AUTHOR rule, so it silently
overrides the user-agent's `[hidden]` default — the `hidden` attribute keeps getting set
correctly by the framework's `:hidden="…"` binding (this part was never broken), it just has
zero effect on an element whose own stylesheet already pins its `display`.

**Fix used:** `.result-card[hidden] { display: none; }` — a MORE specific selector
(`.result-card` + `[hidden]`, specificity (0,0,2,0)) than the bare `.result-card` rule
(0,0,1,0), so it wins regardless of source order, restoring the intended hide behavior.

**Lesson:** any element that both (a) sets its own explicit `display` in CSS and (b) is ever
toggled via the framework's `:hidden="…"` binding needs its own `[selector][hidden] { display:
none; }` override — the native `hidden` attribute's default behavior is NOT guaranteed once an
author stylesheet touches that element's `display` at all, which is an extremely common thing
for any element to do. This is a general CSS gotcha, not specific to this framework, but easy
to miss precisely because the underlying data/attribute IS correct — only the pixels lie.

---

## Summary: what's a framework bug vs. an app-level lesson

**Framework bugs found and fixed this session** (in `packages/spark`, with regression tests):
- #1 (critical): a whole-value `{expr}` import prop stringified arrays/functions into garbage
  instead of preserving their real type.

**Framework limitation found, documented, NOT fixed** (too large in scope for this session):
- #2 (critical, architectural): import-node props are a one-shot snapshot at mount, never
  reactively updated — a real feature gap, not a quick patch. Worked around at the app level by
  inlining SSR-critical/refresh()-driven state in the page itself instead of passing it as
  props to a child.

**App-level mistake** (mine, not the framework's):
- #3: `:hidden` silently no-ops on an element with its own explicit `display` in CSS, unless
  given a more-specific `[hidden]` override.

None of the framework changes above have been released yet — `packages/spark`'s fix for #1
lives in this same workspace, so this app already reflects it.
