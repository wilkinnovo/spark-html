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

Knowledge here is accurate as of 2026-07-09 — **1.2.1 current** (a
README-only republish of **1.2.0 "the dispatch release"**). BOTH speed
programs are CLOSED: round 1 (spark-speed-up.md → 1.1.0) took CPU geomean
3.46× → 1.53× vanilla; round 2 (spark-speed-up-max.md → 1.2.0, definitive
paired count=15) landed **1.496× with first-paint 0.86× — beats vanilla**.
The residual is cold-JIT first-run cost — do not reopen without a lever for
that (spark-speed-up-max.md §9). The core now has: LIS keyed reconciler, per-row identity/ext-key
skip gates, fast no-`with` expression variants (capture-derived destructure
prelude + ReferenceError self-heal), clone recipes (`stampTree` — analysis
cached on the template, static marking at stamp time), **live-node row
recipes** (shallow keyed rows patch a collected dynamic-node list, no tree
descent — `block.live`/`patchLive`), and **shared per-template listeners**
(handler attrs stripped from the template; one listener fn per handler via
`e.currentTarget`; zero per-clone closures). The gzip budget was raised
2026-07-08 (15.0 → 16.0, speed program), 2026-07-09 (16.0 → 16.5, F1 stop
rule), and finally to an **ALL-IN 17.25 ceiling covering the whole speed-max
program** (Wilkin, 2026-07-09; exceed ⇒ descope, never fund) — now 17.24
used; frozen for the life of 1.x. **Speed-max F1+F2+F3 shipped in 1.2.0
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
one. The open work sequence is `improvements.md` at repo root (the
"easiest AND fastest" program, written 2026-07-09; its predecessors — the
v1 plan, then `spark-improvements.md` — each completed and were deleted).

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
e2e/                         Playwright (thin — 2 spec files / 7 tests)
scripts/size-check.mjs       THE gzip budget gate (part of npm test)
graphify-out/                knowledge graph of this repo — `graphify query "<question>"` works
improvements.md              the ACTIVE program: "easiest AND fastest", 5 items (written 2026-07-09;
                             untracked like every root .md except README — items re-enter spark-brain
                             §5 gates at execution. Predecessors v1 plan + spark-improvements.md:
                             each completed, deleted)
```

## Hard invariants — violating any of these has caused real shipped bugs

1. **Gzip budget is law.** `scripts/size-check.mjs` gates the core at
   **17.25 KB ALL-IN** (history 13.5 → 15.0 → 16.0 → 16.5 → 17.25, each
   step Wilkin-itemized; 17.24 used — effectively ZERO headroom, frozen for
   the life of 1.x: doesn't fit ⇒ descope or sibling package, never fund).
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

For the roadmap: read `improvements.md` at repo root — the active
"easiest AND fastest" program (untracked design note, like all root .md
except README).
