---
name: spark-project
description: Working knowledge of the Spark monorepo (spark-html reactive runtime, spark-ssr, spark-prerender, and 17 companion packages). Use when doing ANY work in this repo — architecture questions, bug fixes, releases, size-budget decisions, SSR/hydration issues, or planning. Contains the repo map, hard invariants, and pointers to deep references.
---

# Spark project knowledge

Spark ("spark-html" on npm) is a no-build reactive HTML framework: the file
you write is the file that runs — no compiler, no virtual DOM, no build step
for users. **Identity rule: anything that would require a user-side
compilation step is out of scope by definition.** The stated mission (Wilkin,
2026-07-06): be the *simplest* way to write SSR, prerender, and client-only
apps while staying fast — "built for humans who want to code themselves."

Knowledge here is accurate as of 2026-07-11 — **core 1.7.0 current**
(the fifth speed program's release, BY OWNER OVERRIDE over its own <1.20
bar — see the roadmap paragraph at the bottom: definitive count=15
windowed geomean **1.223×** vanilla (was 1.239 — within the run band, so
the geomean is NOT the 1.7.0 claim), **run-memory 1.45×** (held), ready
1.75×; the release's claim is the warm battery running strictly
post-paint AND pre-interaction — rAF→setTimeout(0) slot in index.js —
killing the ~13 ms mid-click tier-up on the first big op, plus E1
path-op call elision, E3 identity pre-trim, swap 1.23/remove 1.13; past
Vue (1.31) and past Angular (1.45) on the reference frame (cross-machine
caveat attaches to every external claim; per-op wobble is real — clear
0.96 at 1.6.0 vs 1.14 at 1.7.0, geomean is the currency); gzip
**18,432/18,432 bytes = 18.00 KB — the ceiling to the byte, ZERO
headroom** under the 18.00 ALL-IN ceiling, frozen for 1.x.
1.6.0 levers (the architecture of record), all self-funded: terser two-pass dist, in-row whitespace
drop, moveBefore reorders, G4 row-pass shortcut, G5 positional stamp
recipes — buildStampRecipe/stampFast in index.js: static row cells
carry ZERO __spark* expandos; push order = preorder = sweepEach's
column invariant — and N4 single-root span unbox (block.nodes is the
bare clone for shallow single-root rows; lastOf/eachOf branch on
.nodeType). The fp A/B oracle vs prior release: fp rides the
`--benchmark 40_` sizes group, never 43_ standalone.) **First-paint
honesty (2026-07-10): the 1.2.0 "0.86× beats vanilla" headline is RETIRED**
— windowed single-sample fp spreads 0.92–1.61× per run; a same-night
headless A/B (published 1.3.0 vs P1-P3 tree, 3 alternating pairs) measured
Δ+0.6 ms = no program regression; fp claims are now defended by A/B vs
prior release in the stable regime + the CI ≤2.30 tripwire (benchmarks.md
environment note is the source). P1 = table-row whitespace drop +
clear-as-one-wipe (`wipeAll`) + ONE shared reactify proxy handler per
(onMutate,cache). P2 = keyed-equality selector index (`classifySel` /
`__sparkKeyMap` in sweepEach: `key === scalar` points patch exactly the
row losing + gaining the value; bail-to-full-sweep on any doubt). P3 =
idle self-warmup (`warmEach`, post-ready rIC, detached template clone,
warm flag silences sinks/lifecycle/warnings; rIC is NOT strictly
post-paint — measured fp-neutral, comment at the site; since 1.5.0 the
battery also runs the reorder passes — far swap and reverse — so
direct-permutation and map+LIS reconciles tier up before first use). 1.3.0 was doctor
v2 (runtime bytes identical to 1.2.x). Companions (registry-verified,
2026-07-09): spark-ssr 1.2.0, spark-html-bun 1.1.0, spark-html-devtools
1.1.0, language-server 1.4.0, test-utils 1.0.1. Speed program history (ALL CLOSED
2026-07-10): round 1 (spark-speed-up.md → 1.1.0) 3.46× → 1.53×; round 2
(spark-speed-up-max.md → 1.2.0 "the dispatch release") → 1.496×; round 3
(spark-speed-up-max-pro.md → 1.4.0 checkpoint 1.313×, then 1.5.0 FINAL
1.286×; deleted per convention, verdict archived in benchmarks.md). 1.5.0
shipped: warm-reorder battery (warmEach also drives a far swap → direct
permutation and a reverse → map+LIS at idle) + P4t1 row diet (shared
loop-scope proto per anchor, box merged into block, shared per-template
handler maps — 1k-row JS heap −18%, run-memory 2.08 → 1.95×). P4t2
flat-live PARKED at the design kill-switch, P5 JIT + P6 split DESCOPED at
the ALL-IN rule; memory residual ~1.9× attributed (per-row span/live
arrays + __spark* expandos — revive parked designs only with funding). The core now has: LIS keyed reconciler, per-row identity/ext-key
skip gates, fast no-`with` expression variants (capture-derived destructure
prelude + ReferenceError self-heal), clone recipes (`stampTree` — analysis
cached on the template, static marking at stamp time), **live-node row
recipes** (shallow keyed rows patch a collected dynamic-node list, no tree
descent — `block.live`/`patchLive`), and **shared per-template listeners**
(handler attrs stripped from the template; one listener fn per handler via
`e.currentTarget`; zero per-clone closures). The gzip budget was raised
2026-07-08 (15.0 → 16.0, speed program), 2026-07-09 (16.0 → 16.5, F1 stop
rule), then to an **ALL-IN 17.25 ceiling covering the whole speed-max
program** (Wilkin, 2026-07-09; exceed ⇒ descope, never fund), and finally
to **18.00 ALL-IN for speed-max-pro** (Wilkin, 2026-07-09 late) — now
18.00 used, ZERO headroom: further core work self-funds via deletions. **Speed-max F1+F2+F3 shipped in 1.2.0
(6f12dd1, 2026-07-09, registry-verified); F4 clear-wipe DESCOPED
(+0.08 KB didn't fit — design recorded in patchEach at the descope site):**
F1 = template dependency dispatch —
shallow keyed rows dispatch dirty keys as column sweeps over live-recipe
points (`sweepEach`/`patchPoint`; no per-row ext Sets, no per-node dep Sets,
rows after the first capture-free; heals re-learn via the runExpr tier-2
`__fast === null` gate); absent attribute ≡ '' in runElementPlan compares;
plan-op kinds numeric (1 bind / 2 attr / 3 interp). F2 = trim-first
reconcile (prefix/suffix trim; windows classify no-op / pure-insert /
≤4-mismatch direct permutation / map+LIS; raw-array scan via
`arr[REACTIVE_RAW]`; `rowFn` key fast-variant with loop vars as real
params) + **document delegation for stamped rows** (supersedes the G5
+0.232 rejection, under the ALL-IN budget): row clones carry `__sparkH` +
ONE document capture listener per event type — zero per-row listeners;
`e.currentTarget` is patched per dispatch; input/change stay direct so
bind write-back ordering is preserved. F3 = chunked creates
(`insertChunk`: pristine ×64 fragment cached per anchor, one clone + one
insert per group; G=64 won the profiler sweep; create1k scripted 68→53 ms).
Count=8 paired headless geomean ~1.47–1.54 (run wobble; F0 baseline
1.531); creates moved −5..−9% absolute; swap/remove/update floors are
cold-JIT (fresh page per iteration), not scan work — see
spark-speed-up-max.md §9.
Internal boolean `__spark*` flags are set as `1`/truthy, never
compared `=== true`. V1-API-FREEZE.md governs semver (stable surface =
fixes only; experimental surfaces may move in minors) per spark-brain
section 8. 1.0.0 shipped 2026-07-07 (all 21 packages, commit 4b26738); the
docs#limits audit shipped post-1.0 (7ba0986). Function names are stable
anchors; line numbers drift.

**spark-ssr 1.1.0 shipped 2026-07-09** (registry-verified, tag `ssr-v1.1.0`,
commit 6e65be6) — unrelated to the core's own 1.1.0 speed release (different
package, same version number, don't conflate). Adds an ambient `navigate()`
helper (hydrate.js): click-delegates same-path `<a>` links through
`history.pushState` + `refresh()` instead of a full reload — docs at
website `#ssr-navigate`. Shipped with a real bug fix found dogfooding it in
examples/spark-chat: `handlerRoles()` was picking ambient names (`refresh`,
`navigate`, `api_*`) as auto-CRUD synthesis candidates and clobbering them
with a duplicate synthesized handler; see pitfalls.md "Generated-code rules"
for the fix and the component-scope-isolation finding that came with it.

**M3 complete (0.30.0 / 0.8.0).** spark-ssr `serve()` decomposed into
`src/{session,jobs,static,screens,request,crud,page,cache,routes}.js` (server.js
807 lines, was 1,870) under byte-parity. Release-gating security pass:
`Secure` cookies over HTTPS (trusted `X-Forwarded-Proto`, `req.secure`),
`localPath()` closes open-redirect + header-injection via `_redirect`/`?next`,
`maxRequestBodySize` (config.maxBodyMb, default 10 MB → 413), per-IP login
rate-limit (429), production fail-hard when auth has no secret, and the static
server never serves server-only trees (`SERVER_DIRS` = node_modules/jobs/lib/
api/dist in `src/static.js`). Posture is documented in
`packages/spark-ssr/SECURITY.md`; pinned by `test/security.js` (13 cases, each
removal-sensitive). Core dual-package guard: `globalThis.__SPARK_CORE__` in
`reactivity.js` warns loud on a second copy (+0.12 KB → 14.39/15.0). New
`npx spark-html doctor` (`packages/spark/bin/cli.js`, `test/doctor.js`):
duplicate-install scan, companion range checks, stale-SW heuristic. The
peerDeps flip shipped in the 1.0 wave (`"spark-html": ">=1.0.0 <2"` —
verified in the tree). M4 and the 1.0.0 release are complete.

This skill holds the **facts**. The judgment layer — value ordering, decision
gates, change protocols — is the `spark-brain` skill; load it alongside this
one. The fourth speed program RELEASED as 1.6.0 (2026-07-11, tag v1.6.0):
`post-spark-speed-pro-max.md` stays at repo root as the ledger of record,
and per Wilkin the speed program **remains OPEN for NEW proposals only**
— every candidate enters through spark-brain §5's new-lever bar, the
identity gates are non-negotiable, the 18 KB ceiling never moves, and
the N5 JIT path is permanently denied (brain §5 records the full
proposed-then-denied arc).

## Repo map

```
packages/spark/              spark-html — THE core runtime; src/ split into modules (index.js + script/css/expr/reactivity/directives/component.js, 0 deps); ships single-file dist/spark.js (scripts/build-dist.mjs)
packages/spark-ssr/          Bun-first SSR server (pages/, sessions, DB inference, jobs, cache, streaming)
packages/spark-prerender/    static-site prerendering + hydration
packages/spark-html-bun/     dev/build/preview tooling (replaced Vite 2026-07-03; spark.config.js)
packages/create-spark-html-app/  scaffolder — templates: client=counter, ssr=blog, prerender=showcase
packages/spark-html-*/       companions: router, head, theme, persist, query, motion, devtools,
                             offline, image, font, manifest, sri, websocket, language-server
packages/prettier-plugin-spark/
examples/                    basic, jsimports, no-build, pinterest, tabtube (tabtube = the big real-world one)
website/                     spark-html.dev site; docs live in website/public/components/docs-body.html
                             (concept/API reference) and components/ssr.html (spark-ssr guide).
                             website/public/llms.txt is comprehensive by design (0345dd9).
e2e/                         Playwright: `chromium` (site) + `templates` (4 scaffolds) +
                             `relocation` (the I2a gate — one page, three modes; now also
                             exercises store/derived-in-component-script and script-local
                             template-await, both fixed 2026-07-09); fixtures/cookbook/ =
                             the 10 runnable recipes (checked by scripts/cookbook-check.mjs)
scripts/size-check.mjs       THE gzip budget gate (part of npm test)
scripts/check-snippets.mjs   doc-snippet syntax gate — every fenced/`<pre>` block in
                             READMEs + website docs (npm test; skip=<reason> is the only opt-out)
scripts/cookbook-check.mjs   runs the 10 cookbook fixtures at declared depth (bun chain)
scripts/ecosystem-check.mjs  21-package coherence gate (peerDeps, tests wired, API freeze)
.github/workflows/speed-gate.yml  nightly krausest ratio gate (1.65/2.30) + fuzz 5000;
                             bench.yml ends with per-push SSR floor gate (bench-gate.mjs)
graphify-out/                knowledge graph of this repo — `graphify query "<question>"` works
benchmarks.md                the committed perf ledger (definitive krausest tables + method +
                             the CI first-paint environment note); tracked alongside README and
                             V1-API-FREEZE.md (the API contract ecosystem-check enforces) —
                             every other root .md is an untracked design note
(no active program doc — improvements.md completed IN FULL 2026-07-09 and was
deleted per convention: I1 debt→0, I2 promise gates (relocation/speed/fuzz/
ssr-floor/size, all red-verified), I3 fail-loud dev layer, I4 snippet harness
+ 10-recipe cookbook, I5 ecosystem coherence + audit. Released that day:
core 1.3.0 (doctor v2), spark-ssr 1.2.0 (script-local await pass-through +
dev events + types), spark-html-bun 1.1.0 (production import map + diagnose
injection), spark-html-devtools 1.1.0 (diagnose), lsp 1.4.0 (directive
typos), test-utils 1.0.1 (types) — all registry-verified. Lineage: v1 plan →
spark-improvements.md → improvements.md, each completed and deleted.)
```

## Hard invariants — violating any of these has caused real shipped bugs

1. **Gzip budget is law.** `scripts/size-check.mjs` gates the core at
   **18.00 KB ALL-IN** (history 13.5 → 15.0 → 16.0 → 16.5 → 17.25 → 18.00,
   each step Wilkin-itemized; 18.00 used — ZERO headroom: doesn't fit ⇒
   descope, delete-to-fund in the same commit, or sibling package — never
   a further ask).
   Dedup is gzip-neutral; *unique entropy* (new identifiers, strings, logic)
   is what costs. Measure every candidate edit empirically (esbuild
   bundle+minify+gzipSync) — intuition is unreliable.
2. **Never rename `__spark*` properties.** They look expensive but compress
   well AND are read by sibling packages (devtools, prerender, ssr).
3. **The script rewriter is a string scanner, not a parser** (that stays
   true until post-1.0). Since the M3.1 tail (0.30) every rewrite/scan pass
   is string- and comment-aware (`braceDepths` marks string interiors
   `~depth`; depth-0 gates reject them) — code-like text in string literals
   stays byte-intact. The one unparseable construct is a regex literal
   containing a quote: it warns loudly naming the fix. Guarded by
   `test/scanner-fuzz.js` (known-value oracle).
4. **Reactivity core changes require the full test suite AND extreme care.**
   The capture machinery (`withCapture`/`withSink`/`gDirtyKeys` in
   `packages/spark/src/index.js` ~L935–1027) produced three shipped bugs in
   one week (0.27.12 infinite loop, 0.27.13 prop stringification, 0.27.14
   each-in-if dead reconciliation). Its failure mode is *silence*.
5. **spark-ssr render-path changes: run `packages/spark-ssr/test/bench.js`**
   before and after. The 0.7.0 numbers to defend: big page ~6,900 req/s,
   1000-row render ~4.4 ms.
6. **Release tags: push ≤3 per `git push`** — more and GitHub silently skips
   ALL tag-triggered publish workflows. Verify the npm registry, not CI green.
7. **Docs row lifecycle:** the long-held docs#limits audit shipped post-1.0
   (7ba0986). From here: a fix that closes a limitation deletes its row in
   the same PR; a newly discovered constraint adds its row immediately
   (spark-brain §6).
8. **The core's full export line is de-facto public API.** `index.js` exports
   `mount, unmount, component, store, derived, subscribe, evaluate,
   interpolate, parseSFC, scopeCss, inspectStores, lifecycle` (single
   `export {}` at file end) — and the website playground imports `parseSFC` +
   `scopeCss` directly (`website/src/playground.js:16`). The M3 core split
   must preserve every name on that line, and the M4.1 freeze review must
   bucket each one (stable/experimental/internal) — none are undocumentable
   internals, something already consumes them.

## Known-but-unfixed (don't rediscover these)

(Fixed in 0.29 and pruned from this list: frozen import props and the
hydrating loop-row prop gap — whole-value `{expr}` props are reactive now.
See pitfalls.md "Fixed at v1-prep".)

- **SSR never runs a page's own `<script>`** — compute display fields in the
  MODULE data source, not the page script.
- **Hydration can rebuild a component's host element while detached** — never
  cache `document.querySelector` results in `onMount` for event targets;
  delegate from `document`/`window` + `e.target.closest()`.
- **Dual-package hazard**: duplicate nested `spark-html` installs (lockfile
  drift) → separate `stores` Maps → "store not created" in prod only.
  spark-html-bun 0.1.5 has a resolve-plugin fix; root cause is that some
  companions declare spark-html as a hard `dependency` (router, ssr) instead
  of `peerDependencies` (persist does it right). Since 0.30.0 the core WARNS
  on a second copy (`globalThis.__SPARK_CORE__` in reactivity.js) and
  `npx spark-html doctor` scans for it; the structural fix (peerDeps flip)
  shipped in the 1.0 wave. The same drift bites the test suite: a stale nested copy
  can mask a failure that a clean CI install exposes (see the release-checklist
  memory) — dedupe before tagging.

## Deep references (load on demand)

- `references/architecture.md` — core runtime internals (expression pipeline,
  script rewriter, reactivity/capture, directives, components, CSS scoping)
  and spark-ssr internals (opcode renderer, server, hydration, schema).
- `references/packages.md` — all 20 packages: role, version, dependency shape.
- `references/workflows.md` — test/e2e/size/bench/release/debugging workflows.
- `references/pitfalls.md` — the full bug history with root causes; what each
  one taught; browser-testing setup on this machine.

For the roadmap: NO ACTIVE PROGRAM — `speed-up-extended.md` (the FIFTH
speed program) closed 2026-07-11 as **core 1.7.0, released by owner
override**: the definitive (count=15 windowed) read **1.223×, OVER the
pre-registered <1.20 SHIP bar**; it parked per beat-or-no-release, then
Wilkin overrode same day for the release's real content — the warm
battery now runs in the rAF→setTimeout(0) slot, strictly post-paint AND
pre-interaction (bare rIC failed the fp A/B +13 ms ×3; rAF→rIC lost the
idle race, update10th 1.37), killing the ~13 ms mid-click tier-up on the
first big op — plus E1 path-op call elision, E3 identity pre-trim, swap
1.23 / remove 1.13. Run-mem holds 1.45×, ready 1.75×, gzip
**18,432/18,432 — the ceiling to the byte, ZERO headroom**. Standing
Wilkin order at close: **the <1.20 bar stays OPEN — new proposals
welcome**, entering via spark-brain §5; the one designed-but-unfunded
lever is E2 inert rows (needs ≥150 gz ⇒ harvest or deletion first; doc
§9). `benchmarks.md` holds the 1.7.0 CURRENT verdict; the geomean is
NOT the 1.7.0 claim (within band of 1.239) — the battery fix is.
