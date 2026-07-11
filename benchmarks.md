# spark-html vs. js-framework-benchmark (krausest)

Date: 2026-07-11 (1.7.0, 1.6.0) / 2026-07-10 (1.5.0, 1.4.0) / 2026-07-09 (1.2.0) / 2026-07-08 (1.1.0).
Local paired runs; the upstream submission is PR #2048 (open) — see caveats
at the bottom before citing these numbers anywhere external.

> Environment note (2026-07-09, amended 2026-07-10): the **first-paint**
> metric is strongly display-regime-dependent AND, at the harness's one
> iteration per run, single-sample noisy. On GitHub's ubuntu runners the
> paired ratio measures ~1.97× (vanilla itself paints ~96 ms there vs ~300
> below). On this machine's real display (windowed), six same-night paired
> samples spread **0.92–1.61×** — vanilla alone swung 227–353 ms — so no
> single windowed sample supports a headline in either direction; the
> 1.2.0 block's "0.86×" below is retired as exactly that kind of sample.
> First-paint claims are now defended by **A/B against the prior release
> in the stable regime** (headless, alternating builds, medians — see the
> 1.4.0 block) plus the CI-band tripwire (≤2.30). CPU geomean is
> unaffected by all of this: it transfers cleanly across environments
> (CI: 1.507–1.515 vs 1.496; nightly gate holds it at ≤1.65×).

> **CURRENT — speed program 6/7 (spark-html 1.8.0, definitive fired by
> owner's override).** The sixth program (beat-1-20-speed.md, its ledger
> at repo root) parked at receipts per its own pre-registration (standing
> count=8 headless receipt 1.192 > the ≤1.17 fire bar); round 7 went
> terminal (E2 unfundable by arithmetic at the 18 KB ceiling; micros
> measured flat). Wilkin then overrode the firing rule ("FIRE IT") and
> the one-shot definitive ran from the 1.192 receipt — and landed UNDER
> the <1.20 SHIP bar. What shipped: **in-place mutation pinned to scope
> keys** (onMutate routes `rows[1] = x` / `rows[i].label += '!'` /
> `settings.x = y` down the same narrow dirty-key lane as reassignment —
> previously a full component pass; aliases collected; nested/Map/Set
> still full-pass), the krausest impl restyled to that idiomatic
> in-place style, and an S0 funding sprint (terser hoist_funs +
> `subscribers` mangle, message-skeleton tightening with every fix still
> named, MUTATORS Set→object, Reflect.get→t[k], Symbol() descriptions):
> gzip **18,432 → 18,356/18,432 (76 headroom back under the frozen
> ceiling)**. Definitive on the shipped artifact: paired vanilla+spark
> in one session, **count=25, windowed**, Chrome, zero harness errors;
> vanilla control valid (create10k 1127.6 vs prior 1126.8):
>
> | Test | vanilla (ms) | spark (ms) | ratio |
> |---|---:|---:|---:|
> | create 1,000 | 102.1 | 121.5 | 1.19× |
> | replace 1,000 | 110.9 | 131.9 | 1.19× |
> | update 10th (×16) | 51.0 | 57.3 | **1.12×** |
> | select row | 11.6 | 13.7 | 1.18× |
> | swap rows | 60.0 | 75.5 | 1.26× |
> | remove one | 53.7 | 62.4 | 1.16× |
> | create 10,000 | 1127.6 | 1374.5 | 1.22× |
> | append 1,000 | 118.3 | 145.8 | 1.23× |
> | clear | 35.5 | 39.6 | 1.12× |
> | **CPU geomean (01–09)** | | | **1.185×** |
> | ready memory | 0.6 | 1.0 | 1.76× |
> | run memory | 1.9 | 2.7 | 1.46× |
> | run+clear memory | 0.7 | 1.4 | 2.12× |
> | first paint | 325.2 | 310.7 | 0.96× (single sample — NOT a claim; the A/B vs published 1.7.0 is the fp oracle: reversed-order medians 177.8 vs 176.3 ms = parity; forward-order read +18 ms and was diagnosed as first-run order bias) |
>
> Honesty notes: memory reads 1.46/1.76 vs the 1.45/1.75 guardrails =
> ±0.01 rounding band on unchanged allocation behavior (no
> memory-touching change shipped this round; the chunk-prebuild micro
> was reverted after measuring flat). Per-op wobble is real and quoted:
> swap read 1.20–1.38 and update 1.11–1.22 across same-day count=8
> receipts (vanilla-side drift); the geomean is the only currency. The
> update10th script delta vs vanilla fell 18 → 5 ms (regime-independent).
> The receipt-gated firing rule was OVERRIDDEN by the owner for this
> definitive — recorded as an override, and it paid off; the rule stands
> for future programs.

> **FINAL — speed program 5 (spark-html 1.7.0, released by owner's
> call).** The fifth program (speed-up-extended.md — 3× idle warm-reorder
> battery, now scheduled rAF→setTimeout so it runs strictly after first
> paint AND before the first interaction · E1 path-op call elision — bare
> loop-var dot-path text points patch by a raw property read, no fast-fn
> call, no interpolate · E3 identity pre-trim — same raw object at the
> same position reconciles by one pointer compare, keys fill per-window
> only · funding: curated internal-prop terser mangle,
> scripts/terser-opts.mjs; gzip 18,344 → **18,432/18,432 — the ceiling to
> the byte, zero headroom**) missed its pre-registered <1.20 SHIP bar and
> initially PARKED per beat-or-no-release; Wilkin overrode same day
> ("go release v1.7.0") for the warm-battery first-interaction fix +
> swap/remove gains, with **<1.20 remaining the open bar for new
> proposals**. Definitive on the shipped artifact: paired vanilla+spark
> in one session, **count=15, windowed**, Chrome, zero harness errors:
>
> | Test | vanilla (ms) | spark (ms) | ratio |
> |---|---:|---:|---:|
> | create 1,000 | 92.6 | 124.6 | 1.35× |
> | replace 1,000 | 102.9 | 131.5 | 1.28× |
> | update 10th (×16) | 49.4 | 67.4 | 1.36× |
> | select row | 11.3 | 13.3 | 1.18× |
> | swap rows | 59.2 | 72.8 | 1.23× |
> | remove one | 54.5 | 61.8 | 1.13× |
> | create 10,000 | 1126.8 | 1348.1 | 1.20× |
> | append 1,000 | 117.9 | 137.5 | 1.17× |
> | clear (×8) | 34.4 | 39.3 | 1.14× |
> | *ready memory* | *0.6 MB* | *1.0 MB* | *1.75×* |
> | *run memory (1k rows)* | *1.9 MB* | *2.7 MB* | *1.45×* |
>
> **CPU geomean 1.223× (was 1.239 at 1.6.0 — within the run band, so the
> geomean is NOT this release's claim). Run-memory holds 1.45×; ready
> 1.75×.** The release's real content: the warm battery now reliably
> beats the first interaction (1.6.0's single bare-rIC cycle left ~13 ms
> of optimizing-tier compilation on the first real 1000-row op), plus
> swap 1.34 → 1.23 and remove 1.30 → 1.13. The scheduling story, for the
> record: three warm-slot variants, one definitive each, no re-rolling —
> bare rIC read **1.192** but failed the fp guardrail (can fire before
> first paint; A/B vs 1.6.0: +13 ms in all 3 pairs, NOT citable);
> rAF→rIC fixed fp but the browser may hold the idle slot past the first
> interaction (update10th 1.30 → 1.37); rAF→setTimeout passed fp (A/B
> medians 180.3 → 171.3 ms, 2 of 3 pairs improve) and read 1.223. The
> timed-op code is identical across the three — the 1.192↔1.223 spread
> is the same-tree run band. Per-op wobble stays real (clear 0.96 at
> 1.6.0, 1.14 here; remove 1.05–1.33 on record). The <1.20 geomean floor
> without E2 (inert rows, funding-parked: needs ≥150 gz at zero headroom)
> was §7's projection and held. First-paint A/B vs published 1.6.0:
> headless alternating, 3 pairs — parity, tree faster by medians. On the
> reference frame: **past Vue (1.31) and Angular (1.45); approaching —
> not reaching — Svelte 5 (~1.13)**; reference ratios remain
> cross-machine extrapolations and that caveat attaches to every
> external claim.

> **FINAL — speed program 4 (spark-html 1.6.0).** The fourth program's
> definitive run (levers, all self-funded under the untouched 18.00 KB
> ceiling: G1 terser two-pass on the dist · G2 in-row whitespace drop ·
> G3 `moveBefore` reorders · G4 row-pass shortcut · G5 positional stamp
> recipes · N4 single-root span unbox; gzip 18,427 → 18,344/18,432):
> paired vanilla+spark in one session, **count=15, windowed**, Chrome,
> zero harness errors:
>
> | Test | vanilla (ms) | spark (ms) | ratio |
> |---|---:|---:|---:|
> | create 1,000 | 97.9 | 127.1 | 1.30× |
> | replace 1,000 | 112.5 | 147.0 | 1.31× |
> | update 10th (×16) | 57.9 | 77.5 | 1.34× |
> | select row | 12.5 | 15.1 | 1.21× |
> | swap rows | 63.4 | 84.9 | 1.34× |
> | remove one | 54.4 | 70.8 | 1.30× |
> | create 10,000 | 1173.0 | 1424.5 | 1.21× |
> | append 1,000 | 121.0 | 149.6 | 1.24× |
> | clear (×8) | 41.2 | 39.4 | 0.96× |
> | *ready memory* | *0.6 MB* | *1.0 MB* | *1.73×* |
> | *run memory (1k rows)* | *1.9 MB* | *2.7 MB* | ***1.45×*** |
>
> **CPU geomean 1.239× (was 1.286 at 1.5.0). Run-memory 1.95 → 1.45×**
> (G5 deleted the per-static-cell `__spark*` expandos; N4 the per-row
> span arrays). Honesty notes, same discipline as the fp lesson above:
> clear's 0.96 is one run's per-op median, NOT a "faster than vanilla"
> claim; remove's 1.30 (1.16 at 1.5.0) is the same per-op wobble in the
> other direction — the geomean is the only currency. First-paint A/B
> vs published 1.5.0 (headless, alternating builds, 3 pairs, medians):
> 184.4 → 180.1 ms, Δ−4.3 ms = no regression; parity-within-noise
> stands. Ready memory reads 1.73 vs 1.71 (one-decimal granularity).
> On the reference frame: **past Vue (1.31) with clearer margin than
> 1.5.0, past Angular (1.45), approaching Svelte 5 (~1.13)** — reference
> ratios remain cross-machine extrapolations; the caveat attaches to
> every external claim.

> **FINAL — speed-max-pro program complete (spark-html 1.5.0).** The
> third speed program's definitive run: paired vanilla+spark in one
> session, **count=15, windowed**, Chrome, quiet machine, zero harness
> errors:
>
> | Test | vanilla (ms) | spark (ms) | ratio |
> |---|---:|---:|---:|
> | create 1,000 | 96.2 | 128.9 | 1.34× |
> | replace 1,000 | 111.3 | 156.4 | 1.41× |
> | update 10th (×16) | 53.7 | 74.5 | **1.39×** |
> | select row | 12.0 | 14.8 | 1.23× |
> | swap rows | 60.4 | 79.7 | **1.32×** |
> | remove one | 55.4 | 64.2 | 1.16× |
> | create 10,000 | 1125.2 | 1452.3 | 1.29× |
> | append 1,000 | 121.7 | 158.2 | 1.30× |
> | clear (×8) | 35.1 | 40.9 | 1.17× |
> | *ready memory* | *0.6 MB* | *1.0 MB* | *1.71×* |
> | *run memory (1k rows)* | *1.9 MB* | *3.6 MB* | *1.95×* |
>
> **CPU geomean 1.286× (was 1.313 at 1.4.0, 1.496 at 1.2.0, 3.46 before
> the programs).** On the solidjs.com reference frame that is past
> Angular (1.45) and past Vue (1.31) — at the margin: 1.29 vs 1.31 sits
> at the edge of cross-run separation, and reference ratios are
> cross-machine extrapolations via the shared vanilla baseline (Vue was
> never paired on this machine). The honest sentence: **faster than Vue
> on the reference frame, with no build step, in 18.00 KB gzip.** What
> 1.5.0 changed, all internal, zero new concepts: the idle self-warmup
> battery now also exercises the REORDER reconcile paths (a far swap →
> the direct-permutation path, a reverse → the map+LIS window), so
> swap/update interactions run warm from the first click (update10th
> 1.48 → 1.39, swap 1.41 → 1.32 — the two ops the lever targeted moved
> most); plus the P4 row-structure diet (one shared loop-scope prototype
> per list instead of per-row closure triplets, one shared handler map
> per template element) — 1k-row JS heap −18%, run memory 2.08× → 1.95×.
> The program is CLOSED at its pre-registered SHIP target (≤1.30).
> Stretch (≤1.20) honestly not reached: the residual is clone+stamp+
> layout physics plus the interpretive floor of the no-build identity —
> reopening requires a genuinely new lever against that residual, not a
> re-run of these. Remaining memory mass is attributed (per-row span/live
> arrays + `__spark*` expandos, designs parked at their sites with
> funding preconditions).

> **speed-max-pro CHECKPOINT (spark-html 1.4.0).** The third speed
> program's P1+P2+P3 verdict: paired vanilla+spark in one session,
> **count=15, windowed**, Chrome, quiet machine, zero harness errors:
>
> | Test | vanilla (ms) | spark (ms) | ratio |
> |---|---:|---:|---:|
> | create 1,000 | 100.7 | 136.6 | 1.36× |
> | replace 1,000 | 113.8 | 159.9 | 1.41× |
> | update 10th (×16) | 56.5 | 83.9 | 1.48× |
> | select row | 12.7 | 15.4 | **1.21×** |
> | swap rows | 61.9 | 87.3 | 1.41× |
> | remove one | 58.3 | 65.1 | 1.12× |
> | create 10,000 | 1130.4 | 1488.1 | 1.32× |
> | append 1,000 | 117.6 | 159.6 | 1.36× |
> | clear (×8) | 34.5 | 41.5 | 1.20× |
> | *ready memory* | *0.6 MB* | *0.9 MB* | *1.63×* |
> | *run memory (1k rows)* | *1.9 MB* | *3.9 MB* | *2.08×* |
>
> **CPU geomean 1.313× (was 1.496 at 1.2.0).** On the solidjs.com
> reference frame that passes Angular (1.45) and statistically ties Vue
> (1.31) — a tie, not a pass; the program continues. What 1.4.0 changed,
> all internal, zero new concepts: (P1) table-structural row templates
> drop render-inert whitespace text nodes (a 2-row swap now moves exactly
> 2 rows), clear-as-one-wipe, one shared reactive-proxy handler per store
> root; (P2) a keyed-equality selector index — `key === scalar` bindings
> patch exactly the row losing and the row gaining the value instead of
> sweeping all N (select 2.02× → 1.21×); (P3) idle self-warmup — after
> mount the runtime exercises its own row pipeline against a detached
> template at idle, so the first real interaction runs warm instead of
> paying cold-JIT cost (the residual both prior programs named).
> **First-paint**: no regression — same-night A/B, published 1.3.0 vs
> this tree, headless stable regime, 3 alternating pairs: spark fp median
> 163.9 → 164.5 ms (Δ+0.6 ms, within ±19 ms pair noise). Windowed fp is
> parity-within-noise (see environment note); the old 0.86× headline is
> retired, not because fp got slower but because one sample never
> supported it. Core is 18.00 KB gzip (was 17.24) under the program's
> 18.00 ALL-IN ceiling.

> **FINAL — speed-max program complete (spark-html 1.2.0, "the dispatch
> release").** The definitive run: paired vanilla+spark in one session,
> **count=15, windowed** (headless can skip paints, so windowed is the
> honest mode), Chrome 150, quiet machine, zero harness errors:
>
> | Test | vanilla (ms) | spark (ms) | ratio |
> |---|---:|---:|---:|
> | create 1,000 | 98.2 | 138.0 | 1.41× |
> | replace 1,000 | 105.8 | 169.8 | 1.60× |
> | update 10th (×16) | 48.5 | 74.7 | 1.54× |
> | select row | 11.6 | 23.4 | 2.02× |
> | swap rows | 57.3 | 92.5 | 1.61× |
> | remove one | 53.9 | 64.0 | 1.19× |
> | create 10,000 | 1105.8 | 1524.3 | 1.38× |
> | append 1,000 | 114.1 | 162.3 | 1.42× |
> | clear (×8) | 37.4 | 53.3 | 1.43× |
> | *ready memory* | *0.6 MB* | *0.9 MB* | *1.49×* |
> | *run memory (1k rows)* | *1.9 MB* | *4.2 MB* | *2.26×* |
> | *first paint* | *337.2* | *291.3* | ***0.86×*** |
>
> **CPU geomean 1.496× (was 1.531 at 1.1.0) — and spark now reaches first
> paint BEFORE the vanilla reference (0.86×).** *[2026-07-10: the fp half
> of this headline is retired — it was a single windowed sample of a
> metric later shown to spread 0.92–1.61× per sample; see the environment
> note and the 1.4.0 block's A/B method. The CPU half stands.]* What 1.2.0 changed, all
> internal: template-dependency column dispatch for keyed rows, trim-first
> reconcile over the raw array, document-level event delegation for stamped
> rows (zero listeners per row), and chunked creates (64 rows per native
> clone+insert). Absolute spark times vs the 1.1.0 session: select 43→23 ms,
> swap 132→93, create1k 197→138, update 106→75. Honesty notes: the
> update/replace/swap RATIOS rose slightly while their absolute times
> halved — the remaining gap is dominated by first-run (cold-JIT) script
> cost on a fresh page per iteration, which shrinks in absolute terms but
> not relative to an ever-faster vanilla; run-memory (2.26×) did not move —
> its planned lever was descoped at the size budget. Core is 17.24 KB gzip
> (was 15.97), still zero build steps, zero new user-facing concepts.
>
> The 1.1.0 definitive run below is kept for the record.

> **Speed program 1 complete (spark-html 1.1.0), 2026-07-08.** Paired
> count=15, windowed, Chrome 150, zero harness errors:
>
> | Test | vanilla (ms) | spark (ms) | ratio |
> |---|---:|---:|---:|
> | create 1,000 | 122.2 | 197.3 | 1.61× |
> | replace 1,000 | 140.8 | 205.2 | 1.46× |
> | update 10th (×16) | 78.9 | 105.7 | 1.34× |
> | select row | 18.1 | 42.9 | 2.37× |
> | swap rows | 87.5 | 131.5 | 1.50× |
> | remove one | 77.4 | 93.4 | 1.21× |
> | create 10,000 | 1343.6 | 1942.1 | 1.45× |
> | append 1,000 | 136.9 | 215.6 | 1.57× |
> | clear (×8) | 47.9 | 71.6 | 1.49× |
> | *ready memory* | *0.6 MB* | *0.9 MB* | *1.47×* |
> | *run memory (1k rows)* | *1.9 MB* | *4.4 MB* | *2.33×* |
> | *first paint* | *399.5* | *415.6* | *1.04×* |
>
> **CPU geomean 1.53× — between Angular (1.45) and React Hooks (1.61) on
> the solidjs.com table, up from 3.46× (below Ember) at the program
> baseline.** Every single-row outlier is fixed: select 11.85→2.37,
> swap 12.03→1.50, remove 6.87→1.21. All internal — zero new user-facing
> concepts, zero build steps, core still 15.97 KB gzip.
>
> Earlier G1–G4 checkpoint (count=10, headless): geomean 1.64×. The tables
> below are the pre-program baseline, kept for the record.

## Method

- Cloned krausest/js-framework-benchmark fresh (not vendored into this repo).
- Wrote a real keyed implementation at `frameworks/keyed/spark-html/` in that
  clone (not committed here — lives only in the benchmark clone), following
  the project's rules: byte-identical markup to the `vanillajs` reference
  (including `aria-hidden`), `each`/`key` on a `<template>` for keyed
  reconciliation, row markup inlined in the parent (not a child component —
  sidesteps spark's known frozen-props-on-child-components limitation),
  build via `spark build` (`spark-html-bun`) with an explicit `--base` so
  absolute asset paths resolve when served nested under the benchmark
  server's `frameworks/keyed/spark-html/dist/` path.
- Ran the actual webdriver-ts harness: real headless Chrome 150 +
  matching chromedriver, official benchmark ops, Chrome-timeline-based
  timing (not manual instrumentation).
- Verified interaction correctness first by hand over CDP (create, select,
  swap, update every-10th, remove, clear) before trusting the timed run.

## Results (median of 3 iterations, this machine)

| Test | vanillajs (ms) | spark-html (ms) | ratio |
|---|---:|---:|---:|
| 01 create 1,000 rows | 101.2 | 194.9 | 1.93× |
| 02 replace 1,000 rows | 118.5 | 211.2 | 1.78× |
| 03 update every 10th row (×16) | 55.5 | 167.3 | 3.01× |
| 04 select row | 11.6 | 137.5 | **11.85×** |
| 05 swap rows | 58.2 | 700.3 | **12.03×** |
| 06 remove one row | 50.5 | 347.0 | 6.87× |
| 07 create 10,000 rows | 1179.7 | 2348.3 | 1.99× |
| 08 append 1,000 to 1,000 | 130.5 | 265.0 | 2.03× |
| 09 clear 1,000 rows (×8) | 44.5 | 77.8 | 1.75× |

**Geometric mean ratio (spark-html / vanillajs): 3.46×**

Mapped onto the solidjs.com table's scale (vanilla = 1.00), spark-html would
land around **~3.5** — slower than every framework on that list, including
Ember (2.09).

## The interesting signal

Bulk-render ops (create/replace/append/clear) cluster at a reasonable
1.75–2× vanilla — in line with a general-purpose reactive runtime with no
compile step. But **select, swap, and remove are disproportionately worse
(6.9–12×)** — these are single-row mutations that shouldn't require touching
the other 999 rows. That gap looks like real reconciler overhead on
localized updates, not measurement noise, and is a concrete, likely-fixable
lead if pursued (per spark-brain: profile with `test/bench.js`-style
discipline — measure, don't guess — before touching the capture/reconciliation
core).

## Caveats

- **3 iterations**, not the ~15+ the official project uses for stable
  medians/stddev.
- **One machine, headless Chromium (snap, v150)**, not the project's
  dedicated benchmark server / real Chrome.
- Only spark-html vs. vanillajs was actually run here — Solid/Svelte/etc.
  ratios are taken from the public solidjs.com table as reference points,
  not re-measured on this machine in this session. The "~3.5 on their scale"
  placement is an extrapolation via the shared vanilla baseline, not a
  same-machine apples-to-apples measurement against those frameworks.
- Upstream submission: PR #2048 (open, not yet merged/registered). Until it
  lands on the official table, treat these as directional local numbers,
  not authoritative.

## Reference: solidjs.com published table (the numbers to beat)

Published on solidjs.com's own benchmark page (Chrome 130 dataset per their
site, geomean-relative-to-vanilla scale, lower is better). Snapshot as of
2026-07-08 — not re-measured by us, quoted as given:

| Framework | Score |
|---|---:|
| Vanilla | 1.00 |
| Solid 1.8.15 | 1.11 |
| Svelte 5.0.5 | 1.13 |
| Inferno 8.2.2 | 1.15 |
| Vue 3.5.3 | 1.31 |
| Preact Classes 10.19.3 | 1.43 |
| Angular 18.0.1 | 1.45 |
| React Hooks 18.2.0 | 1.61 |
| Ember 5.3.0 | 2.09 |

spark-html's measured ~3.46 (this session, different machine/Chrome version/
iteration count — see caveats) sits well past the bottom of this list. The
target isn't "beat vanilla" — it's closing the gap to Ember first, which
means chasing the select/swap/remove outliers above before the bulk-render
ops, since those are the ops furthest from parity.
