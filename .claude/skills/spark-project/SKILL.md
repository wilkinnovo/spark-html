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

Knowledge here is accurate as of 2026-07-08 — **1.1.0 "the speed release"
SHIPPED** (the krausest speed program, spark-speed-up.md, closed same day):
CPU geomean **1.53× vanilla** (paired windowed count=15; was 3.46× at
1.0.0). The core now has: LIS keyed reconciler, per-row identity/ext-key
skip gates, fast no-`with` expression variants (capture-derived destructure
prelude + ReferenceError self-heal), clone recipes (`stampTree` — analysis
cached on the template, static marking at stamp time), **live-node row
recipes** (shallow keyed rows patch a collected dynamic-node list, no tree
descent — `block.live`/`patchLive`), and **shared per-template listeners**
(handler attrs stripped from the template; one listener fn per handler via
`e.currentTarget`; zero per-clone closures). Full document-level event
delegation was REJECTED: +0.232 KB didn't fit the budget (plan ledger §9).
The gzip budget was raised ONCE, 15.0 → 16.0 KB (Wilkin, 2026-07-08,
itemized), to fund the program — now 15.97 used and RE-FROZEN for the life
of 1.x. Internal boolean `__spark*` flags are set as `1`/truthy, never
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
one. The open work sequence is `spark-improvements.md` at repo root (the v1
plan file served its purpose and was deleted 2026-07-07).

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
                             website/public/llms.txt: hand-maintained (2026-07-09) — update it in
                             the same commit as any docs-body.html/ssr.html section add/remove/
                             rename until it's generated at build time (planned, not yet built).
e2e/                         Playwright (thin — 2 spec files / 7 tests)
scripts/size-check.mjs       THE gzip budget gate (part of npm test)
graphify-out/                knowledge graph of this repo — `graphify query "<question>"` works
spark-improvements.md        the post-1.0 improvement program (rewritten 2026-07-07, trusted; untracked
                             like every root .md except README — items re-enter spark-brain §5 gates at
                             execution. The v1 plan spark-from-here-to-v1.md is done and deleted)
```

## Hard invariants — violating any of these has caused real shipped bugs

1. **Gzip budget is law.** `scripts/size-check.mjs` gates the core at
   15.0 KB (raised once at M1, now frozen for the life of 1.x).
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

For the roadmap: read `spark-improvements.md` at repo root — the post-1.0
improvement program (untracked design note, like all root .md except README).
