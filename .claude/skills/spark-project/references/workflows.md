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

Two real findings surfaced building this (both intentionally NOT worked
around — recorded in `page.html`'s own NOTE comments and here, not silently
routed around):
- **`store()`/`derived()` (`import { store, derived } from 'spark-html'`
  inside a component's own `<script>`) work in dev and in spark-ssr's
  hydration path, but break in a PRODUCTION `spark build`** (client or
  prerender — same `spark-html-bun` build pipeline): the entry script's bare
  `'spark-html'` specifier gets bundled/rewritten for itself only; components
  `mount()` fetches and evaluates at runtime get no import map in the built
  HTML, so their own bare `from 'spark-html'` 404s in the browser. The
  fixture uses component-local reactive state (`let` + `$:`) instead, which
  needs no import and is unaffected. Not yet triaged into improvements.md as
  its own item — flag it if you're touching `spark-html-bun`'s build path.
- **`<template await>` on a plain script-local `Promise` (not a real
  spark-ssr data source) never updates post-hydration on an SSR page**:
  spark-ssr's server-side renderer statically flattens the block to its
  resolved (`then`) branch's inner content only, discarding the
  `<template await/then/catch>` wrapper structure the client needs to
  reactively track the real promise — so the client-run script's actual
  resolution has nothing left to patch into. `<template await>` tied to a
  real spark-ssr data source is unaffected. Dropped from the shared fixture
  page rather than worked around.
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

## Release (per spark-release-checklist)

1. Bump version in the package's package.json; check sibling dependency
   ranges (companions pin spark-html ranges — a core bump may require range
   bumps + their own patch releases).
2. Update `bun.lock` (run install), keep esbuild as root devDep.
3. Full `npm test` green (includes size gate).
4. Commit; **tag one release per push, ≤3 tags max per `git push`** —
   pushing >3 tags at once makes GitHub silently start ZERO tag-triggered
   publish workflows while other CI looks green.
5. Verify the registry, not CI:
   `curl -s https://registry.npmjs.org/<pkg>/latest | head -c 300`.
6. Recovery if tags didn't trigger publishes:
   `gh workflow run <publish>.yml --ref <tag>` (workflow_dispatch preserves
   the tag-matches-version check).
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
