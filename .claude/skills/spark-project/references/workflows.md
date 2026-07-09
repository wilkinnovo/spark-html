# Workflows — test, size, bench, release, debug

## Test

- `npm test` (root) — ~45 Node suites chained with `&&`: all
  `packages/spark/test/*.js` (linkedom-based via `dom-shim.js` — no browser),
  prerender, router, every companion, `scripts/test-bun.mjs`, and ends with
  `scripts/size-check.mjs`. A suite is a plain Node script with asserts; add
  new suites to the root `test` script chain or they never run.
- `npm run e2e` — Playwright (`playwright.config.js` projects: `chromium` =
  `e2e/spark.spec.js`, `templates` = the 4 create-spark-html-app templates,
  `relocation` = the I2a relocation gate below).

## The relocation gate (I2a, improvements.md)

The identity's gate 3 ("a page relocates across client/SSR/prerender by
relocation, not rewrite") is mechanically enforced by
`e2e/relocation.spec.js`: ONE page
(`e2e/fixtures/relocation/shared/page.html`) is served three ways via
`scripts/serve-relocation-fixture.mjs <client|ssr|prerender> <port>` (a
throwaway Bun-workspace project per mode, same pattern as
`scripts/serve-template-for-e2e.mjs`), driven through an identical scripted
interaction (click/toggle/add/remove/bind), and the post-interaction DOM is
diffed after normalization (`normalizeInPage` in the spec — strips
`<script>` tags, `<spark-ssr>` bookkeeping, hydration-marker attributes, and
HTML comments; any new normalization rule needs its own justification, per
never-weaken-the-oracle). Verified to actually catch a regression: injecting
a one-line mode-only DOM mutation into the spec makes the gate fail with a
readable diff; removing the injection makes it pass again — confirmed
2026-07-09 before trusting it as a gate rather than decoration.

Fixture/serve-script trap, found 2026-07-09: a tmp project at the repo root
is NOT a workspace member, so `bun install` with `'*'` versions resolves
spark packages from the REGISTRY, not the tree — the gate looked local while
exercising published copies. Both `serve-relocation-fixture.mjs` and
`serve-template-for-e2e.mjs` now pin `file:` paths to `packages/*`; keep it
that way in any new e2e serve script.

Two real findings surfaced building this (both intentionally NOT worked
around — recorded, then FIXED 2026-07-09):
- **`store()`/`derived()` inside a component's own `<script>` broke in a
  PRODUCTION `spark build`** (client or prerender): the built HTML shipped
  no import map for the bare `'spark-html'` specifier inside components
  `mount()` fetches at runtime. FIXED in spark-html-bun 1.1.0: `spark build`
  scans shipped .html for bare imports, copies each used package to
  `assets/modules/<pkg>@<version>/`, emits the dev-parity import map (+
  modulepreload for the core), and marks mapped packages `external` in
  Bun.build so the entry imports the same URL — one module instance, never
  a second inlined core. The relocation fixture now imports store/derived
  in its script, so this gate guards the fix permanently.
- **`<template await>` on a plain script-local `Promise` never updated
  post-hydration on an SSR page**: the server flattened the block to
  then-content with undefined bindings AND the client component unwrapped
  the wrapper structure away. FIXED in spark-ssr 1.2.0, both halves: the
  renderer emits the authored block verbatim when the awaited value is
  undefined on a hydrating page (`op.raw` + `ctx.hydrating` in render.js);
  the client component keeps a block whose root identifier is declared in
  the page's own script (`scriptDeclared()` heuristic in hydrate.js —
  biased to unwrap on a miss, which is the old behavior). Data-source
  awaits keep the resolve-and-flatten path (flash-free hydrate).
  Removal-sensitive test: ssr.js "script-local <template await> …" — each
  half's revert fails its own assertion. Bench flat (before/after medians
  within wobble). The relocation fixture exercises it in all three modes.
- spark-ssr: `packages/spark-ssr/test/ssr.js` (~2k lines, prints
  "N passed, M failed") and `test/bench.js` (NOT in npm test — run manually
  around any render-path change; compares renderFragment 1/100/1000 rows +
  HTTP c=32).
- Repro pattern for runtime bugs: linkedom mount harness (see
  `packages/spark/test/dom-shim.js` and the repro-*.js files) — reproduces
  hydration/reactivity bugs without a browser.

## Size budget

- `npm run size` → `scripts/size-check.mjs`: esbuild bundle+minify of
  `packages/spark/src/index.js`, gzipSync, compare to `LIMIT_KB`.
- The LIMIT_KB comment in that file is the historical ledger of every bump
  and why — **always append the reason when bumping**, never bump silently.
- Technique when over budget: remove unique entropy (novel identifiers,
  one-off strings, speculative branches), NOT repetition — dedup is
  gzip-neutral or negative. Measure each candidate edit; keep ≥25 bytes
  headroom minimum. Companion packages have no budget gate; features that
  don't fit core go to a sibling package.
- **The gate is the single source of truth for the size number quoted
  anywhere** (fixed 2026-07-09 after three different figures shipped at
  once). Two measurement traps, both hit: `Bun.build` minifies looser than
  esbuild, AND Bun's `gzipSync` compresses the *identical* bundle
  differently than Node's (17.4 vs 17.24 KB) — so any size computed under
  Bun disagrees with the gate. `website/scripts/gen-stats.js` therefore
  spawns `node scripts/size-check.mjs` and parses its output for the
  website's stats chip; never "reimplement the same metric" there.
- The exact figure (e.g. `17.24 kB`) is also hand-quoted in prose: root
  README (static shields badge + 3 mentions), packages/spark/README (2),
  website `banner.svg`, `llms.txt`, docs-body ecosystem row. When the gate
  number changes at a release, re-sync all of them (`grep -rn` the old
  number finds the set). The README badge is a static shields.io badge by
  design — the bundlephobia badge it replaced measures with its own
  bundler and showed 14.2k; don't reintroduce it.

## Ecosystem coherence gate (I5a, improvements.md)

`scripts/ecosystem-check.mjs`, last step of `npm test` before the size gate.
For every `packages/*`: spark-html must be a peerDependency `">=1 <2"`
(never a hard `dependency` — the dual-package hazard); README.md exists with
≥1 fenced code block; ≥1 test file exists AND is wired into the root chain
or `scripts/test-bun.mjs` (a test file sitting unwired never runs — this is
the same invariant the awaiting-test-runner already relies on, mechanized);
`license`/`repository` present in package.json; and the core's
`export {...}` line in `packages/spark/src/index.js` matches exactly the
names in `V1-API-FREEZE.md`'s Core table — a rename/removal fails this
before it can ship as an accidental breaking change. Verified red-then-green
2026-07-09 (renamed an export, confirmed the gate caught it, reverted).

While building this, two real test files were found sitting in
`packages/spark/test/` unwired and never running in CI:
`await-as.js` (10 assertions, `<template await … as="name">`) and
`loop-imports.js` (5 assertions, imports inside each/if blocks) — both now
wired into the root chain. `repro.js` and `repro-debug.js` in the same
directory are scratch debugging scripts (console.log dumps, no pass/fail)
and are intentionally excluded from the "unwired test file" check; don't
wire them as-is.

## Nightly gates (I2b/I2c, improvements.md)

Every published speed/convergence claim has a red gate; all verified
red-then-green 2026-07-09 before being trusted:

- **Krausest ratio gate** — `.github/workflows/speed-gate.yml` (nightly cron
  + workflow_dispatch) runs `bench/krausest/run.sh --count 8 --gate 1.65
  1.00` on ubuntu-latest (`CHROME=/usr/bin/google-chrome`,
  `JFB_DIR=$RUNNER_TEMP/jfb`). `table.mjs --gate <cpuMax> <fpMax>` exits 1
  if CPU geomean (01–09) > cpuMax, `43_first-paint` ratio > fpMax, or either
  metric is missing/incomplete. Thresholds: 1.65 (achieved 1.496, wobble
  ~1.47–1.54 — catches regressions, not noise) and 1.00 ("beats vanilla" is
  published). Tighten only after ≥5 consecutive green nights establish the
  CI runner's band. Red-verified against the real 1.2.0 ledger results with
  inverted thresholds. `run.sh` now clears `webdriver-ts/results/` before
  each run — table.mjs pools every json in the dir, so stale runs would
  silently dilute ratios.
- **SSR floor gate** — `bench.yml` (per-push) now ends with
  `bun test/bench-gate.mjs test/bench-output.txt`
  (`packages/spark-ssr/test/`). Floors calibrated from the last 3 CI
  artifacts at ~half the worst observed (catch 2× regressions, not runner
  wobble): 1000-row p50 ≤ 9 ms; todo ≥ 7,000 / big ≥ 4,400 / blog ≥ 5,300
  req/s. The dev-box ledger (big ~6,900 req/s, ~4.4 ms) stays a local
  `test/bench.js` discipline; the CI gate is the backstop. Missing metric =
  fail. Red-verified on a doctored and an empty output file.
- **Nightly fuzz** — `speed-gate.yml` job `fuzz-5000` runs
  `node packages/spark/test/fuzz.js 5000` (the per-PR chain keeps 500).
  Iteration count is fuzz.js's existing argv knob — improvements.md I2c
  suggested a `FUZZ_N` env var, but argv already existed; trust the tree.

Single-source rule for SPEED numbers (I2d, mirrors the size rule above):
`benchmarks.md` at repo root is the committed perf ledger (definitive 1.2.0
+ 1.1.0 paired count=15 windowed tables, method, caveats) — it is the ONE
root .md besides README that is tracked, because README/website/docs cite
it. Any re-measure updates benchmarks.md first, prose second; no hand-typed
perf number anywhere the ledger can be the source.

## Release (per spark-release-checklist)

0. **Before tagging, run a CLEAN-INSTALL check** — a stale nested copy can
   mask a real failure. 2026-07-07 (spark-html 0.30.0 / spark-ssr 0.8.0):
   `npm test` was green locally but the publish workflow's clean install
   failed, because a leftover nested `node_modules/spark-html` (stale from
   an older `^range`) resolved locally and masked a real mismatch that a
   fresh install exposed. `rm -rf` any nested `spark-html` under a sibling
   and reinstall before tagging, or run `npx spark-html doctor` (flags this
   exact hazard since 0.30.0).
1. Bump version in the package's package.json; check sibling dependency
   ranges (companions pin spark-html ranges — a core bump may require range
   bumps + their own patch releases).
2. Update `bun.lock` (run install), keep esbuild as root devDep.
3. Full `npm test` green (includes size gate).
4. Commit; **tag one release per push, ≤3 tags max per `git push`** —
   pushing >3 tags at once makes GitHub silently start ZERO tag-triggered
   publish workflows while other CI looks green. **Tag prefixes** (each
   publish workflow verifies tag == package.json version): core `v*`,
   `bun-v*`, `prerender-v*`, `create-v*`, `router-v*`, `theme-v*`,
   `motion-v*`, `devtools-v*`, `head-v*`, `persist-v*`, `query-v*`,
   `prettier-plugin-v*`, `image-v*`, `websocket-v*`, `font-v*`,
   `manifest-v*`, `offline-v*`, `sri-v*`, `lsp-v*`, `ssr-v*` — note `ssr-v*`
   and `sri-v*` are distinct packages, easy to typo one for the other.
5. Verify the registry, not CI:
   `curl -s https://registry.npmjs.org/<pkg>/latest | head -c 300`.
6. Recovery if tags didn't trigger publishes:
   `gh workflow run <publish>.yml --ref <tag>` (workflow_dispatch preserves
   the tag-matches-version check). If a publish failed and the fix landed
   in a new commit, move the tag: `git tag -f <tag> <new-commit>` then
   force-push it alone (a tag update re-triggers the workflow).
7. No AI co-author trailers in commits, no "Generated with" lines in PRs
   (repo owner's global rule).

## Dev servers

- `npm run dev` → examples/basic via spark-html-bun; `npm run site` → website.
- spark-ssr apps: `bun run dev` in the app dir (watch mode); production is
  `serve({ watch: false })` (that flag also enables response cache +
  streaming).
- Stale-state gotcha: if a dev server on a reused localhost port hangs or
  throws Cache.put errors, it's a leftover service worker from a previous app
  on that port — unregister via DevTools or use a fresh port.

## Debugging in a real browser (this machine: GNOME Wayland, Chromium snap)

- Playwright MCP is broken here (wants Chrome). Use a plain Node/Bun CDP
  script: launch `/snap/bin/chromium --user-data-dir=$(mktemp -d)
  --ozone-platform=x11 --enable-unsafe-swiftshader --remote-debugging-port=9222`
  (DISPLAY=:0 GDK_BACKEND=x11), connect with Bun's native WebSocket (NOT the
  `ws` npm package — it hangs), `Runtime.enable`, drive via
  `Runtime.evaluate`, collect `Runtime.consoleAPICalled` +
  `Runtime.exceptionThrown`.
- Screenshots: `import -window <id>` after finding the window via
  `xwininfo -root -tree` (grab the mutter-x11-frames wrapper). Sanity-check
  the PNG isn't one flat color.
- `pkill` footgun: a `pkill -f` pattern can match your own wrapper shell —
  be specific.
- Component state inspection: `document.querySelector(sel).__sparkScope`
  (internal/undocumented today; a stable `inspect` API is planned, v1 M1.3).
  Event-listener truth: CDP `DOMDebugger.getEventListeners` — the tool that
  proved the detached-host hydration bug.

## Knowledge graph

`graphify-out/` at repo root is current-ish. `graphify query "<question>"`
for architecture questions; `graphify <path> --update` after big changes.
