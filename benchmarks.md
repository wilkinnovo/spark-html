# spark-html vs. js-framework-benchmark (krausest)

Date: 2026-07-09 (1.2.0) / 2026-07-08 (1.1.0). Local paired runs; the
upstream submission is PR #2048 (open) — see caveats at the bottom before
citing these numbers anywhere external.

> Environment note (2026-07-09, from the nightly speed-gate's first CI
> runs): the **first-paint** metric is strongly display-regime-dependent.
> On GitHub's ubuntu runners the paired ratio measures ~1.97× (identical
> headless and xvfb-windowed; vanilla itself paints ~96 ms there vs 337 ms
> below). The 0.86× below is real for this table's stated method — paired,
> windowed, real display — and that is the method any re-measure must use.
> CPU geomean transfers cleanly across environments (CI: 1.507–1.515 vs
> 1.496 below). The nightly gate therefore holds CPU at ≤1.65× and
> first-paint at ≤2.30× (CI's own band + headroom), catching regressions;
> the headline first-paint claim is defended by re-running THIS method.

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
> paint BEFORE the vanilla reference (0.86×).** What 1.2.0 changed, all
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
