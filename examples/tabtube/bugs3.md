# Round 3: infinite scroll, seamless tab switching, a custom player, one clear icon

Adding infinite scroll, pause-previous/resume-current tab switching with a custom-chrome
YouTube player, a fix for a duplicate clear-icon in the search box, and a switch from
`yt-search` to `youtubei.js` (yt-search's own pagination turned out to be silently broken).
One of these surfaced a genuinely critical, previously-unknown `spark-html` reactivity bug —
general, not specific to this app — plus a test-environment limitation worth recording so it
isn't mistaken for a code defect later.

## 1. An each-loop wrapped in `<template if>` permanently stops reconciling after ONE unrelated sibling change

**Severity: critical, and completely general — not specific to spark-ssr, infinite scroll, or
this app.** **Where:** `packages/spark/src/index.js`, `withSink()`.

**What happened:** infinite scroll's `loadMore()` correctly grew the page's `results` array
(confirmed directly: the component's own `__sparkScope.results.length` went from 18 to 37) —
but the DOM stayed stuck at 18 `.result-card` rows, silently, no warning, no error. Once stuck,
it never recovered — every SUBSEQUENT scroll grew `results` further (confirmed via direct
server queries: page 2 → 38 results, page 3 → 56) but the rendered list never changed again for
the rest of the session.

Bisected with an isolated `spark-html`-only reproduction (no spark-ssr involved) down to a
precise, minimal trigger — reproduced with THREE separate, unrelated top-level writes in one
async flow:

```html
<template if="!tabtube?.showMyLists">      <!-- outer if: reads tabtube AND (transitively) searching -->
  <template each="v in results" key="v.videoId">...</template>
  <template if="searching">Searching…</template>   <!-- SIBLING if, same parent -->
</template>
<script>
  async function loadMore() {
    searching = true;                       // pass 1: only `searching` changes
    await refresh();                        // (an await boundary)
    // inside refresh(): results = newBiggerArray;  — pass 2: only `results` changes
    searching = false;                      // pass 3: only `searching` changes again
  }
</script>
```

**Root cause:** `withSink()` records, on an each/if/await anchor's own `__sparkReadKeys`,
every scope key read anywhere in its content — including nested each/if/await — so the WHOLE
block can be gated as one unit in a dirty (targeted) patch pass (skip re-evaluating a block
none of whose dependencies changed). It used to `.clear()` that recorded set before every
re-run, to rebuild it fresh from whatever gets read THIS pass.

That rebuild is unsound the moment a block's content contains a NESTED each/if/await, because
nested anchors are gated by this SAME mechanism, independently. Walk through the sequence
above:

- **Pass 1** (`searching` changed): the OUTER `<template if="!tabtube?.showMyLists">`'s deps
  happen to already include `searching` (in the real app, the outer if is itself gated on a
  store read that transitively touches it — reproduced exactly with a minimal component where
  the outer if's own condition explicitly reads both keys) — so the outer if'S OWN gate
  passes, and it runs. But the INNER each's deps are just `{results}` — doesn't intersect
  `{searching}` — so the inner each is SKIPPED this pass. Skipped means its array expression
  is never evaluated, meaning `results` is never actually READ this pass.
- The outer if's `withSink()` wrapper, having just `.clear()`'d its set before this run, only
  captures whatever WAS actually read during this specific pass — `tabtube`, `searching` — and
  overwrites its own recorded deps with exactly that. `results` — a real, structural dependency
  of its content (the inner each is always there) — is silently DROPPED, because it simply
  wasn't touched during this particular pass.
- **Pass 2** (`results` changed): the outer if's now-corrupted deps are `{tabtube, searching}` —
  doesn't include `results` anymore — so the outer if's OWN gate now FAILS, and the ENTIRE
  block, outer if AND the inner each buried inside it, is skipped without ever being walked.
  The inner each never gets a chance to reconcile, despite `results` — the exact thing it
  loops over — being what just changed.
- Once corrupted this way, it never self-heals: the outer if only ever runs again for passes
  matching its (now permanently too-narrow) recorded set, and each such run re-`.clear()`s and
  rebuilds from only what's touched THAT time, perpetuating the amnesia indefinitely.

**Fixed in this session:** `withSink()` no longer clears the set before each run — it
accumulates. A dependency, once seen, is never forgotten; the recorded set only ever grows,
never falsely shrinks. This matches the "never stale, at worst redundant work" philosophy
already used elsewhere in the same dependency-tracking system (an untracked binding always
re-evaluates rather than risk a stale one). The cost is purely extra, safe re-evaluations after
a large structural change permanently stops touching some field a row used to reference — a
performance nit, not a correctness one. Regression test added to `packages/spark/test/deps.js`
("an each wrapped in `<template if>` keeps reconciling after an unrelated sibling change") —
verified it actually catches the bug by reverting the fix locally and confirming the new test
fails (`2 !== 3`), then restoring it.

**Lesson:** any bug report describing "a reactive array update silently stops reaching the DOM,
and once it happens it never recovers, even though later updates to the SAME array also fail"
is a strong signature of this class of bug — dependency-set corruption via a nested,
independently-gated anchor, not a one-off missed patch. Worth specifically checking whether the
affected each/if/await is nested inside ANOTHER each/if/await that itself sometimes runs for
unrelated reasons.

## 2. `yt-search`'s own pagination silently no-ops — switched to `youtubei.js`

**Severity: high (a dead-end dependency for this feature), app-level — not a spark-html/
spark-ssr issue.** **Where:** `lib/search.js`.

**What happened:** implementing infinite scroll via `yt-search`'s documented `{ pages: N }`
option produced IDENTICAL results regardless of `N` — `pages: 1` and `pages: 5` both returned
the same ~18 videos, and `pages: 5` finished suspiciously fast (should walk 5 pages ~2.5s
apart per the library's own source, ~10s+; it returned in under 2s). Traced into
`yt-search`'s own `getSearchResults()`: continuing to the next page requires a `_sp`
continuation token extracted from the CURRENT page's scraped HTML
(`results._sp`); if that extraction fails (silently — no error, no warning), `getMoreResults &&
results._sp` is falsy and the walk silently stops after page 1, no matter what `pages` was
requested. Likely broken by a YouTube markup change since the library was last updated —
scraping-based libraries have no SLA.

**Fix used:** switched to `youtubei.js` (wraps YouTube's own InnerTube API, not HTML scraping —
the SAME library the reference app at `/home/nine/spark-ssr-tabtube` depends on, alongside
`ytsr`, which was ALSO tested and found broken — `ytsr` 3.8.4 throws `type gridShelfViewModel
is not known` against current YouTube markup, degrading to 18 results with `continuation:
false`). Verified `youtubei.js`'s `search.getContinuation()` genuinely advances with zero
overlap between combined pages (checked directly: 5 combined pages via raw continuation-walking
= 98/98 unique video IDs). `?page=` is now the number of continuation-walked pages to combine,
capped (`MAX_PAGES = 6` in `lib/search.js`) since each hop is a real, if fast (~1s), network
round trip with no per-session token cache across requests.

**Lesson:** "the option is documented and doesn't throw" is not the same as "the option works" —
scraping-based YouTube libraries can silently degrade to page-1-only behavior with zero
indication. Verify pagination by checking for ACTUAL overlap/growth in returned data, not just
absence of an error.

## 3. `:hidden` combined with `:class` on the same row, inside a `<template if>`-wrapped each — the exact shape that trips #1

Not a separate bug — recorded here because it's the precise shape `examples/tabtube` already
had (`.result-card :class="…tabtube.activeId…" :hidden="!matchesFilter(v, tabtube.activeFilter)"`,
inside `<template if="!tabtube?.showMyLists">`) that made bug #1 immediately reachable by
adding infinite scroll's `searching`-gated sibling. If you're adding a feature that toggles a
SIBLING `<template if>` next to an EXISTING each-loop that's itself inside an outer
`<template if>`, and the each-loop's rows read a store (as ordinary per-row `:class`/`:hidden`
bindings, nothing unusual), you have exactly the shape that reproduces #1 — worth specifically
retesting "does the list still grow" after such a change, not just "does it render once."

## 4. The custom YouTube player never actually starts playback in this test environment

**Severity: none as a code defect — a test-environment limitation, recorded so it isn't
mistaken for one later.** **Where:** browser/sandbox environment (snap-packaged Chromium,
`--enable-unsafe-swiftshader` software rendering, X11-over-Wayland), not
`components/video-player.html`.

**What happened:** the custom player (`YT.Player` with `playerVars.controls: 0`, custom
play/pause/seek/mute/fullscreen chrome built with `:hidden`-toggled always-mounted elements so
ONE player instance survives tab switches) loads the correct video, title, and channel — but
`onStateChange` never fires `PLAYING`, `getPlayerState()` stays `-1` (UNSTARTED) indefinitely,
and the iframe falls back to YouTube's OWN default chrome (native scrubber, center play button,
"Watch on YouTube" — ignoring `controls: 0` entirely). Reproduced identically with a bare,
minimal test page — no spark-html involved at all, straight from the IFrame Player API's own
documented usage — ruling out an app-level mistake. Tried both a totally normal, definitely-
embeddable video (Rick Astley's official upload) and a live-stream rebroadcast; identical
result either way, ruling out a per-video embedding restriction too.

**Not fixed — not a code bug.** This points to something this specific sandboxed browser can't
do (most likely a missing proprietary codec or Widevine CDM in the snap Chromium build, or a
software-rendering/media-pipeline limitation) rather than anything wrong with the component.
The rest of the player's behavior — state bookkeeping (`currentVideoId`, per-tab `savedTime`),
control visibility (`:hidden` toggling shown/hidden correctly), and the reactive
switch-tabs-saves-and-resumes logic — all execute without error; only actual video decoding
never starts. Verify real playback in a normal desktop/mobile browser outside this sandbox.
