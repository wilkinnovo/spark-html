# ⚡ Spark Blog — a full app on spark-ssr

A complete blog: public posts with SEO titles/meta, dynamic routes, an
about page, and an auth-gated admin panel where the author manages posts —
and a private todo list. All of it is a handful of `.html` files, one SQLite
database, and **zero build steps**.

## Run it

```bash
bun install
bun run dev     # seeds dev.db, serves on :3000, live-reloads on every edit
```

Sign in at [/admin](http://localhost:3000/admin) with
**me@spark-html.com** / **spark**.

## What's demonstrated where

| Feature | Where |
|---|---|
| Filesystem routing | `pages/index.html` → `/`, `pages/about.html` → `/about` |
| Dynamic routes | `pages/blog/[slug].html` → `/blog/:slug` — `:slug` binds into the SQL |
| Per-page `<title>`/`<meta>` | literal tags at the top of each page, `{expr}`-interpolated (spark-html-head/ssr) |
| Declarative data | `<spark-ssr>` blocks — the query names feed the template variables |
| Server → component props | `index.html` passes each whole `post` row into `post-card.html` |
| Pure-UI components | `nav.html`, `post-card.html` — no `<script>`, props are the scope |
| Client components | `login-form`, `post-editor`, `todo-list` — their `<script>` runs in the browser |
| Auth | `spark.json` `"auth"` → sessions, `POST /api/users?auth` login, hashed passwords |
| Auth-scoped CRUD | `posts` and `todos` carry `user_id` → their APIs are session-scoped (401 anonymous) |
| Draft privacy | the `[slug]` query: `published = 1 OR :session.id IS NOT NULL` — authors preview drafts |
| Middleware | `middleware.html` disables public signups (single-author blog) |
| Aggregates | `about.html`'s `COUNT(*)` serves an object → `{stats.n}` |
| Custom error page | `404.html` |
| Dark/light theme | spark-html-theme — `app.js` one-liner + `theme-toggle.html`; no-flash init is auto-inlined |
| Fonts | spark.json `"fonts"` → spark-html-font tags in every `<head>` (preload, no-shift fallback) |
| Images | `bun run build` runs spark-html-image over `dist/` — webp + srcset for every `<img>` |

## The mental model

- A **page**'s plain `<script>` runs on the **server** (it's the escape
  hatch); `<script type="module">`/`src` scripts ship to the browser.
- A **component**'s `<script>` runs in the **browser**. Components are
  otherwise pure UI: they render the props they're given.
- `<spark-ssr>` declares data. A `table="…"` gives you scoped REST CRUD;
  a `GET /api/x → SELECT …` line is both an endpoint and page data.
- Everything hot-reloads — pages, components, queries, middleware — no
  restart, the browser refreshes itself.

## Deploy

```bash
bun run build   # dist/ + compiled binary; images optimized if sharp installs
PORT=3000 ./dist/app
```

Set a fixed session secret in production so logins survive restarts:
`"auth": { …, "secret": "ENV.SESSION_SECRET" }` in spark.json.

Swap SQLite for Postgres by changing one line in spark.json:
`"db": "postgres://…"`.
