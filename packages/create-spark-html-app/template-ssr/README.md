# ⚡ Spark Blog — a full app on spark-ssr

A complete blog: public posts with SEO titles/meta, dynamic routes, an
about page, and an auth-gated admin panel where the author manages posts —
and a live-updating private todo list. All of it is a handful of `.html`
files and one SQLite database. **No build step. No setup script. No fetch
calls for the basics.**

## Run it

```bash
bun install
bun run dev     # creates + seeds the DB from the templates, serves on :3000
```

Sign in at [/login](http://localhost:3000/login) with
**me@spark-html.com** / **spark** — a plain form; it works with JavaScript
disabled.

## What's demonstrated where

| Feature | Where |
|---|---|
| Layouts | `pages/_layout.html` — nav, styles, `app.js` and the `author` query, once for every page |
| Filesystem routing | `pages/index.html` → `/`, `pages/about.html` → `/about` |
| Dynamic routes | `pages/blog/[slug].html` → `/blog/:slug` — `:slug` binds into the SQL |
| Named page data | `posts = SELECT …` — the variable is named in the block, no endpoint exposed |
| Real 404s | `<template else status="404">` on the missing-post branch |
| Guards | `/admin`: `<spark-ssr guard="session" redirect="/login" />` — one line |
| No-JS forms | `pages/login.html` and the logout button — plain forms, 303 back |
| Form validation | the login form's `required`/`type="email"` run server-side too |
| The template is the schema | `seed/*.json` + `<spark-ssr table="…" seed="…">` — tables created and seeded at startup; `bun run db` shows the diff |
| Live updates | `<spark-ssr table="todos" … live />` — open /admin in two tabs |
| Per-page `<title>`/`<meta>` | literal tags at the top of each page, `{expr}`-interpolated |
| SEO | og:title/og:description derive from the head; `/sitemap.xml` enumerates `/blog/:slug` from its query; `/robots.txt` honors the admin page's `noindex` |
| Server → component props | `index.html` passes each whole `post` row into `post-card.html` |
| Ambient CRUD helpers | `/admin`'s page `<script>` gets `api_create/api_update/api_delete` + `refresh()` — no `fetch()` boilerplate, the tables are inferred |
| Auth | `spark.json` `"auth"` → sessions, `POST /api/users?auth` login, hashed passwords |
| Auth-scoped CRUD | `posts` and `todos` carry `user_id` → their APIs are session-scoped (401 anonymous) |
| Draft privacy | the `[slug]` query: `published = 1 OR :session.id IS NOT NULL` — authors preview drafts |
| Middleware | `middleware.html` disables public signups (single-author blog) |
| Background jobs | `<spark-ssr job="notify-author" on="insert:posts" />` runs `jobs/notify-author.js` after every new post |
| Declarative mail | `spark.json` `"mail": "./lib/mail.js"` — `req.mail(…)` from a job/handler; the default logs, swap for your provider |
| OpenAPI + typed client | `/__spark/openapi.json` and `/__spark/client.ts` — generated from the inferred backend, never authored |
| Safe schema evolution | `bun run db` (diff) applies additive changes; a destructive retype/drop needs `bun spark-ssr db push --force` |
| Aggregates | `about.html`'s `COUNT(*)` serves an object → `{stats.n}` |
| Dark/light theme | spark-html-theme — `app.js` one-liner + `theme-toggle.html`; no-flash init is auto-inlined |
| Fonts | spark.json `"fonts"` → spark-html-font tags in every `<head>` |
| Images | `bun run build` runs spark-html-image over `dist/` — webp + srcset |

## The mental model

- `pages/_layout.html` wraps every page in the folder; `<slot>` is the page.
  Its `<spark-ssr>` vars are in scope everywhere it wraps.
- A **page**'s plain `<script>` runs on the **server** (the escape hatch) —
  unless the page is interactive with data (handlers/binds + a `<spark-ssr>`
  source). Then it's the **client** component's script: the framework injects
  `api_create/api_update/api_delete` + `refresh()`, seeds your state from the
  data, synthesizes any handler you leave out, and appends your code. See
  `/admin` — the whole posts+todos UI is a handful of handlers.
  `<script type="module">`/`src` scripts always ship to the browser as-is.
- A **component**'s `<script>` runs in the **browser**. Components are
  otherwise pure UI: they render the props they're given.
- **Any data source hydrates** — a table, a `SELECT`, a URL, a markdown glob,
  a JS module. Interactivity isn't gated on a database (the no-DB blog
  template filters markdown posts live on the client).
- `<spark-ssr>` declares data. `var = SELECT …` names page data;
  `table="…"` gives you scoped REST CRUD (+ `seed`, `live`, `limit`,
  `search`); `guard="…"` protects the page.
- Plain forms to `/api/*` work without JavaScript — success 303s back,
  the markup's constraint attributes validate on the server.
- `job="…"` on a `<spark-ssr>` runs `jobs/<name>.js` on a schedule
  (`every="1d"`) or after a write (`on="insert:posts"`); `mail()` is wired
  from `spark.json` `"mail"`. External consumers get a generated
  [`/__spark/openapi.json`](http://localhost:3000/__spark/openapi.json) and a
  typed `/__spark/client.ts` for free.
- Everything hot-reloads — pages, layouts, components, queries, middleware
  — and dev errors land on the page, not in a bare 500. Open
  [/__spark/plan](http://localhost:3000/__spark/plan) to see the inferred
  backend.

## Deploy

```bash
bun run build            # dist/ + compiled binary; images optimized
bun spark-ssr build --docker   # …plus a Dockerfile
PORT=3000 ./dist/app
```

Set a fixed session secret in production so logins survive restarts:
`"auth": { …, "secret": "ENV.SESSION_SECRET" }` in spark.json.

Swap SQLite for Postgres by changing one line in spark.json:
`"db": "postgres://…"`.
