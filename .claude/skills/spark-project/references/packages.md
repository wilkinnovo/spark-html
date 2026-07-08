# Packages — the full family (versions as of 2026-07-06)

Monorepo workspaces: `packages/*`, `examples/*`, `website`. All published to
npm. Every package README carries a family compatibility table (added in the
0.7.0 docs pass) — regenerate them on version waves.

## Load-bearing six

| Package | Version | Role |
|---|---|---|
| `spark-html` | 0.27.14 | The core runtime. Single file, 0 deps, ships `src/` directly. Gzip-budgeted (scripts/size-check.mjs). |
| `spark-ssr` | 0.7.2 | Bun-first SSR server. Deps: linkedom, spark-html, spark-html-head. |
| `spark-prerender` | 0.7.4 | Static prerendering + hydration. Reads `__spark*` internals. |
| `spark-html-bun` | 0.1.5 | Dev/build/preview (replaced Vite entirely, 2026-07-03). `spark.config.js`. Dev serves bare deps via `/@modules/<pkg>/<entry>` import maps; prod `Bun.build` with a resolve plugin that dedupes nested spark-html copies (0.1.5). Dev and prod resolution semantics differ — audit item. |
| `spark-html-router` | 0.9.3 | Client router (`router()`, `setRoute`, `renderChain`, nested routes, notfound). ⚠ declares spark-html as hard `dependency` — should be peerDependency (v1 plan M3.4). |
| `create-spark-html-app` | 0.15.2 | Scaffolder. Templates: client=counter, ssr=blog (showcase design, jobs+mail demo), prerender=showcase (owns the feature picker). The ssr nodb template inlines its card component because of the loop-row-prop hydration limitation. |

## Companions (spark-html-*)

| Package | Version | Notes |
|---|---|---|
| head | 0.3.0 | `head()` — document head management; dependency of spark-ssr. |
| theme | 0.2.0 | `theme()` — theming/dark mode. |
| persist | 0.1.4 | `persist()` — store persistence. ✅ correctly uses peerDependencies for spark-html — the model for the others. |
| query | 0.1.4 | `query()` — data fetching. |
| motion | 0.1.9 | `motion()` — animations. Candidate home for a future gestures helper (not before v1). |
| devtools | 0.1.9 | Reads `__spark*` internals; natural home for the planned `inspect.deps()/inspect.scope()` API (v1 M1.3). |
| websocket | 0.1.3 | `ws()`. |
| offline | 0.1.5 | Service-worker/offline. SW gotcha: a leftover SW on a reused localhost port causes dev hangs + Cache.put errors (spark-ssr 0.3.3 self-heals). |
| image | 0.1.4 | |
| font | 0.1.4 | |
| manifest | 0.1.5 | |
| sri | 0.1.3 | Subresource integrity. |
| language-server | 1.2.0 | SSR-aware since 0.2.0 (page detection, ssrVars/singular matching, ambient globals, synthesized-handler suppression). 1.1.0: semanticTokens/full for <spark-ssr> bodies (src/semantic.js — SQL/params/sources/routes) + textDocument/formatting delegating to prettier-plugin-spark when resolvable (zero runtime deps kept). 1.2.0: SSR pages detected by PATH (pages//api/ under spark.json, tag optional) — ambient globals apply; bind: targets + [param] route params declared; undefined-binding on SSR pages is a HINT naming the query-param case, never a warning; comments/<spark-ssr> bodies masked from template-ref scanning. editors/vscode 0.3.0 + editors/zed 0.4.0 inject SQL highlighting into <spark-ssr> bodies. |
| prettier-plugin-spark | 1.1.0 | Formats <script>/<style> AND <spark-ssr> bodies (formatSsrBody: aligned bindings, clause-broken SQL, quote/comment-aware; oracle-tested against spark-ssr extractBlocks). Markup untouched. |

Editors: `editors/vscode` extension wraps the language server.

## Dependency-shape rule (dual-package hazard)

Any companion that hard-depends on `spark-html` can get its own nested copy in
`node_modules` on lockfile drift → two module-scope `stores` Maps → "store not
created" warnings **in production only** (dev import maps canonicalize; prod
Bun.build preserves duplication). Verified state: persist=peer (correct),
router+ssr=hard dep (wrong). v1 plan: all companions →
`peerDependencies: { "spark-html": ">=1.0.0 <2" }` at the 1.0 wave, plus a
`globalThis.__SPARK_CORE__` duplicate-load guard in core, plus a
`spark-html doctor` lockfile scanner. Immediate user workaround when hit:
delete node_modules + lockfile, reinstall.

## Examples

- `examples/tabtube` — the flagship real-world app (YouTube-like: infinite
  scroll, seamless tab switching, custom player, drag-to-scroll tab strip).
  Most of the 0.27.12–0.27.14 and hydration bugs were found building it. Its
  workarounds mark known limitations: cards inlined (frozen props),
  viewsFormatted/ago computed in `lib/search.js` MODULE source (SSR doesn't
  run page scripts).
- `examples/pinterest`, `examples/basic`, `examples/no-build`,
  `examples/jsimports` — smaller feature demos; all five must pass e2e on an
  RC (v1 plan §7.5).

## Website

`website/` — built with spark-html-bun (`bun run build` via root
`npm run site:build`). Docs body: `website/public/components/docs-body.html`
(`id="limits"` table around L456 — ON HOLD until v1 ships, see SKILL.md
invariant 7). Deployed to Vercel (vercel.json). NOTE: the repo was renamed
spark → spark-html on GitHub; never recreate a repo named `spark` (kills
redirects).
