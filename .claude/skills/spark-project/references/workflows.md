# Workflows — test, size, bench, release, debug

## Test

- `npm test` (root) — ~45 Node suites chained with `&&`: all
  `packages/spark/test/*.js` (linkedom-based via `dom-shim.js` — no browser),
  prerender, router, every companion, `scripts/test-bun.mjs`, and ends with
  `scripts/size-check.mjs`. A suite is a plain Node script with asserts; add
  new suites to the root `test` script chain or they never run.
- `npm run e2e` — Playwright (`e2e/spark.spec.js`, currently only 3 tests;
  browser config in `playwright.config.js`).
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
