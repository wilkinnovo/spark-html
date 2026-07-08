# spark-ssr

**Zero config. No build. SSR the Spark way.**

The framework reads the HTML template and infers everything:

```html
<!-- index.html -->
<h1>Tasks</h1>

<template await="todos">
  <input bind:value="draft" placeholder="New task">
  <button onclick={add}>Add</button>
  <template each="todo in todos">
    <li>
      <input type="checkbox" bind:checked="todo.done" onchange={patch}>
      {todo.title}
      <button onclick={remove}>✕</button>
    </li>
  </template>
</template>

<spark-ssr table="todos" live />
```

```bash
bun spark-ssr
```

That's it — the table is **created for you** (the template is the schema),
the REST API exists, the page is server-rendered and hydrated, and `live`
keeps every open tab in sync.

| The template says                               | The framework knows                          |
| ----------------------------------------------- | -------------------------------------------- |
| `<template each="todo in todos">`               | You need data called `todos`                 |
| `table="todos"`                                 | It's backed by the `todos` table             |
| `{todo.title}` interpolation                    | `title` is a TEXT column                     |
| `bind:checked="todo.done"`                      | `done` is a boolean column                   |
| `onclick={add}` (outside the loop)              | `POST /api/todos` — insert                   |
| `bind:checked` + `onchange={patch}` (in loop)   | `PATCH /api/todos/:id` — update `done`       |
| `onclick={remove}` (inside the loop)            | `DELETE /api/todos/:id` — remove the row     |
| `bind:value="draft"`                            | Local state variable `draft`                 |
| `user_id` column in the table                   | Auth — `WHERE user_id = :session.id`         |
| `required maxlength="120"` on a form input      | The server validates the same rules          |

No `<script>`. No SQL. No ORM. No server file. No setup.js. No build step.

## Config (spark.json)

```json
{
  "db": "postgres://localhost:5432/myapp",
  "auth": { "table": "users", "identity": "email", "secret": "ENV.SESSION_SECRET" },
  "cors": true,
  "fonts": [{ "family": "Inter", "google": true, "weights": [400, 700] }]
}
```

`sqlite://./dev.db` works too (Bun ships both drivers). `ENV.*` values resolve
from the environment at startup. `cors: true` allows all origins on `/api/*`;
an array allows specific ones. `fonts` renders spark-html-font's head tags
(preloads, `@font-face` with a size-adjusted no-shift fallback, a
`--font-<slug>` var) into every page — same shapes as its build-pipeline step.
`mail` wires the sender for jobs and handlers (see below). `maxBodyMb` caps any
request body (default 10) — an over-limit upload is rejected with `413` at the
socket, before it buffers.

**No spark.json at all?** `db` defaults to `sqlite://./dev.db`, so
`bun spark-ssr` runs on a folder holding one `index.html` — zero config to
begin. (A spark.json that *exists* but omits `db` stays deliberately
database-free — the markdown-blog mode.)

## Routing

The filesystem is the router. `pages/index.html` → `/`,
`pages/blog/[slug].html` → `/blog/:slug` (`:slug` binds into queries).
Without a `pages/` folder, `*.html` at the project root serve the same way.

## Layouts — folders own their chrome

`pages/_layout.html` wraps every page in the folder (nested folders nest
their layouts). A layout is a component; `<slot>` is the page:

```html
<!-- pages/_layout.html -->
<link rel="stylesheet" href="/style.css">
<script type="module" src="/app.js"></script>
<div import="/components/nav" blog="{author.name}"></div>
<slot></slot>
<footer>© {author.name}</footer>

<spark-ssr>
  author = SELECT id, name, bio FROM users LIMIT 1
</spark-ssr>
```

The layout's `<spark-ssr>` vars are in scope for every page it wraps. Head
tags lift from layout AND page; the page wins on conflicts.

## Named data — the block says what it feeds

```html
<spark-ssr>
  posts  = SELECT * FROM posts WHERE published = 1 ORDER BY created_at DESC
  author = SELECT id, name, bio FROM users LIMIT 1
</spark-ssr>
```

`var = SELECT …` is page data with no endpoint exposed — what most pages
actually want. Write `GET /api/posts → posts = SELECT …` when you also want
a public endpoint. Name/singular/fallback matching still works for
`table="…"` blocks and unnamed routes — nothing breaks.

`:` params inject automatically: path params (`:slug`), query string (`:q`),
form/JSON body (`:body.title`), session (`:session.id`), headers
(`:header.x-forwarded-for`), uploads (`:file.url`).

## Sources beyond SQL — same block, more worlds

```html
<spark-ssr>
  repo    = https://api.github.com/repos/wilkinnovo/spark-html
  posts   = ./content/posts/*.md
  weather = ./lib/weather.js
</spark-ssr>
```

- **URL** — server-side fetch, JSON parsed; `:slug`-style params interpolate.
- **Glob** — files become rows: front-matter → columns, body → `.body`,
  filename → `.slug`. A blog with no database at all. (`{post.body}` renders
  text; markdown rendering is a companion package's job.)
- **Module** — default export `(req, db) => value`. The escape hatch gets a
  declarative front door.

## Status, redirect, and guard

```html
<!-- blog/[slug].html -->
<template if="post"> … </template>
<template else status="404"><h1>Not found</h1></template>

<!-- admin/index.html -->
<spark-ssr guard="session" redirect="/login" />
```

`status="…"` on a rendered branch sets the response status — crawlers stop
indexing a 200-that-means-404. `guard="expr"`: when falsy, `redirect="…"`
answers 303, `status="401"` sets the code, default 403. An `is_admin` (or
`role`) column on the auth table rides into the session, so
`guard="session.is_admin"` works — and admins read scoped tables unscoped.

**You rarely write the 404, though.** A `[param]` page whose single-row lookup
comes back empty **404s automatically** — the `<template else status="404">`
above is only for a custom message. And every error status renders a **styled
default page** with no file to write; drop a `pages/404.html` (or `500.html`,
any `<status>.html`) to override it. With `auth` configured, a bare
`guard="session"` defaults to redirecting to `/login`.

## Forms without JavaScript

The auto-CRUD endpoints answer a browser like a browser:

```html
<form action="/api/posts" method="post" redirect="/admin">
  <input name="title" required maxlength="120">
  <textarea name="body"></textarea>
  <button>Save draft</button>
</form>
```

A plain form post that succeeds 303s back to the referrer (or the form's
`redirect="…"`); the page re-renders with fresh data. **The app works with
JavaScript disabled.** Login and logout are forms too:

```html
<form action="/api/users?auth" method="post">
  <input type="email" name="email" required>
  <input type="password" name="password" required>
  <button>Sign in</button>
</form>
<form action="/api/logout" method="post"><button>Sign out</button></form>
```

### The form is the validator

`required`, `maxlength`, `min`/`max`, `type="email"`, `pattern` — the
constraint attributes you already wrote for the browser run again on the
server before the matching auto-CRUD write. Violations answer `422` with
`{ errors: { title: "…" } }` (JSON) or re-render the page with `{errors.title}`
and `{values.title}` in scope (form post).

## The template is the schema

```bash
bun spark-ssr db        # show inferred schema vs live DB (a diff)
bun spark-ssr db diff   # the pending plan, spelled out (alias of the above)
bun spark-ssr db push   # apply additive changes (create tables, add columns)
bun spark-ssr db push --force   # …and destructive ones (retype, drop columns)
```

Column inference: `{todo.title}` → TEXT, `bind:checked` → boolean,
`type="number"` inputs → numeric, `id`/`created_at` always, `user_id` when
auth is configured and the page reads the session. Seed rows sharpen types:

```html
<spark-ssr table="todos" seed="./seed/todos.json" live />
```

Seeds apply once, idempotently (only into an empty table; auth-table
passwords hash on the way in). `serve` runs the safe half automatically —
missing tables are created and seeds applied at startup, so a fresh clone
runs on `bun spark-ssr` alone. **Safe evolution:** additive changes (new
tables, new columns) apply freely; a destructive one — dropping a column the
templates no longer name, or a **retype** (a column whose implied type
changed) — is reported by `db diff` and needs `db push --force`. On SQLite a
forced retype rebuilds the table and copies the rows across; it never silently
drops data. Seed files are never served as static assets.

## `live` — HTML that reacts across the wire

```html
<spark-ssr table="todos" live />
```

Every write through the server pings `/__spark/live` (SSE) with the table
name; hydrated pages refetch through their own session — every open tab
updates, scoping intact. No socket code, no pub/sub. spark-html-websocket
stays for custom protocols; `live` is the zero-config 90%.

## Lists — `?page`, `?sort`, `?q`

```html
<spark-ssr table="recipes" limit="20" search="title,ingredients" />
```

- `?page=2` → `LIMIT/OFFSET`, plus `{recipes.total}` and `{recipes.pages}`.
- `?sort=created_at:desc` → validated against real columns, then `ORDER BY`.
- `?q=…` → `LIKE` across the block's `search="…"` columns.

`cache="60"` on any block adds a per-source TTL, invalidated automatically
when a table it reads from changes.

## Background jobs & mail

```html
<spark-ssr job="digest"  every="1d" />              <!-- jobs/digest.js on a schedule -->
<spark-ssr job="onOrder" on="insert:orders" />      <!-- …after every matching write -->
```

A job is a module `jobs/<name>.js` with the same shape as a data source —
`export default (req, db) => …`. `every="…"` (`ms`/`s`/`m`/`h`/`d`) schedules
it; `on="insert:orders"` (or `update:`/`delete:`/`*:`) fires it after a write,
with the affected row on `req.row`.

Mail is one line of config — `"mail"` in spark.json is a module
(`"./lib/mail.js"`, default export `(msg, ctx)`) or a `{ url, from, headers }`
webhook. `mail()` is in scope in every page/api/middleware `<script>` and on
`req.mail` in jobs; with nothing configured it logs, so it always resolves.

```js
// jobs/onOrder.js
export default async (req, db) => {
  await req.mail({ to: 'ops@shop.co', subject: `Order ${req.row.id}`, text: '…' });
};
```

## OpenAPI + a typed client — generated, never authored

- **`/__spark/openapi.json`** — an OpenAPI 3.1 document of every endpoint the
  templates imply, with path params and request/response shapes.
- **`/__spark/client.ts`** — a typed `createClient()` with one method per
  route. External consumers and tests get types for free.

Both derive from the live route table and ship in production too.

## Dev tools

- **Error overlay** — a failing query or throwing page script puts the real
  error (message, stack) on the page instead of a bare 500.
- **Unresolved-var banner** — "this page reads `{posts}` but no source
  provides it — nearest source: `published`". The silent-blank bug becomes
  a sentence.
- **`/__spark/plan`** — every route, table, endpoint, and each page's
  var → source bindings. "View source" for the inferred backend.
- **Live reload** — every edit (pages, layouts, components, queries,
  middleware, css, markdown) refreshes the browser via SSE.

All dev-only; `start` and compiled builds ship none of it.

## The page owns its \<head\> — and SEO comes free

Literal `<title>`/`<meta>`/`<link>` tags at the top of a page lift into the
document head, `{expr}`-interpolated against the page's data
(spark-html-head's `/ssr` module does the lifting):

```html
<title>{post.title} · My Blog</title>
<meta name="description" content="{post.excerpt}">
```

`og:title`/`og:description` derive from those unless overridden.
`/sitemap.xml` is generated from the pages — `[param]` routes enumerate
their bound query. `/robots.txt` honors `<meta name="robots" content="noindex">`
and guards. Author your own files in `public/` to override any of it.

## Client scripts and the family

A page's plain `<script>` runs on the **server** (the escape hatch) — *unless*
the page is interactive (has handlers or `bind:`s) and declares a data source.
Then it becomes the page's **client component** script: the four ambient
helpers below are in scope, your state is seeded from the page's data, any
handler the template references but you didn't write is synthesized, and your
code is appended. `<script type="module">` and `<script src>` are always
**client** scripts — they lift into `<head>` after an auto-generated importmap,
so bare imports of the Spark family just work, no build:

```js
// public/app.js
import { theme } from 'spark-html-theme';
theme();
```

Every `spark-html-*` package in your dependencies is importmap-mapped and
served at `/@modules/<name>/…`. Depend on **spark-html-theme** and the
no-flash init snippet is inlined in every head automatically; depend on
**spark-html-image** and `spark-ssr build` runs its webp/srcset pass over
`dist/` — and uploads get a webp variant at write time (`:file.url` points
at it; `:file.original` keeps the source file).

## Page scripts — ambient helpers, less boilerplate

An interactive page (handlers or `bind:`s) that declares data hydrates, and its
`<script>` becomes the client component. One deliberate limit to know: on a
hydrating page that script runs on the **client only** — the server renders
from the data sources alone and never executes it. Compute display fields
(formatted dates, view counts, derived text) in the **data source** (SQL
expression or a module source), not in the page script, or the first
server-rendered paint won't have them. (A page with no handlers or binds keeps
the classic behavior: its plain `<script>` runs on the server — the escape
hatch.) Four helpers are always in scope — no imports, no `fetch()` plumbing:

| Helper | Does |
|---|---|
| `api_create(body)` | POST to the page's table, returns the row |
| `api_update(id, body)` | PATCH a row by id |
| `api_delete(id)` | DELETE a row by id |
| `refresh()` | Re-run **every** source (table, SQL, URL, glob, module) and reassign the page's vars |

Your state is seeded from the page's data (don't re-declare it), and every
handler the template references is **synthesized if you don't write it** — so an
admin page can be just its custom bits:

```html
<input bind:value="title"><button onclick={create}>Save</button>
<template each="p in posts">
  <button onclick={toggle(p)}>{p.published ? 'Unpublish' : 'Publish'}</button>
  <button onclick={remove(p)}>Delete</button>   <!-- synthesized -->
</template>
<script>
  async function create() {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await api_create({ slug, title });
    title = ''; refresh();
  }
  async function toggle(p) { await api_update(p.id, { published: p.published ? 0 : 1 }); refresh(); }
</script>
<spark-ssr table="posts" />
```

`<spark-ssr auto="create,remove">` narrows which handlers are synthesized;
`auto="none"` keeps only the helpers. Several tables on one page? Pass the table
explicitly: `api_create('posts', {…})`, `api_update('todos', id, {…})`. Want
none of it — write your own `fetch()` and don't set `table=`; that's the
classic escape hatch, untouched.

Hydration is **source-agnostic**: a markdown glob, a JS module (any ORM), a URL
mashup — all hydrate and `refresh()` the same way, no database required.

## Custom endpoints — api/

`api/stats.html` auto-serves as `GET /api/stats`:

```html
<spark-ssr>
  GET → SELECT COUNT(*) AS videos FROM videos
</spark-ssr>
```

Or drop to a `<script>` (runs server-side; `req`, `res`, `db`, `fetch` in
scope; the return value becomes the JSON response).

## Everything else

- **Components** — `<div import="/components/card" title="{post.title}">`
  inlines at render time; components are pure UI.
- **Auth** — built-in email/password sessions (`POST /api/users?auth` logs in,
  passwords hash on insert), or a plugin (`auth.plugin` in spark.json) for
  OAuth/magic-link flows — the plugin answers "who is this person?", the
  framework still does sessions and cookies. Configuring `auth` also gives you
  working **`/login`, `/signup` and `/logout` pages** with zero UI written —
  drop a `pages/login.html` (etc.) to override them.
- **Relations** — `<template each="c in post.comments">` declares a `comments`
  table with a `post_id` foreign key and joins it onto the post. Nested data,
  no SQL join in the template.
- **Flash messages** — `flash="Saved"` on a form sets a one-shot message that
  survives the redirect; render it with `{flash}` or the default `<spark-flash>`
  toast. `{session}` and `{path}` are ambient on every page too.
- **List UI** — `<spark-pager for="posts"/>` and `<spark-search/>` are drop-in,
  no-JS `?page`/`?sort`/`?q` controls over the list conventions below.
- **Middleware** — `middleware.html` runs on every request (`req`, `res`,
  `rateLimit`, `state` in scope; return `{ status, body }` to short-circuit).
- **Uploads** — multipart bodies stream to `uploads/`; `:file.url` binds the
  stored URL into your INSERT.
- **Error pages** — a styled default for every status out of the box; override
  with `pages/404.html` / `500.html` (any `<status>.html`), or one at the
  project root.
- **Static assets** — `public/` plus co-located page assets, served as-is.
  Project internals (spark.json, package.json, `*.db`, seeds, dotfiles) are
  never served.
- **Hydration** — interactive pages (any data source) ship fully-rendered HTML
  plus a generated client component; `mount()` takes over with the same
  spark-html runtime, and your page `<script>` rides along with the ambient
  helpers above.
- **Auth-table hygiene** — the auth table's auto CRUD never returns password
  hashes, and PATCH/DELETE are own-account only. Configuring `auth` registers
  the table (login/signup endpoints) without any page declaring it; disable
  public signup in `middleware.html` if the app is invite-only.

## Performance — fast by default, nothing to configure

The request path allocates almost nothing:

- **Precompiled templates.** Every page and component is parsed **once**
  (mtime-invalidated) and compiled into a flat render program; a request is a
  loop that emits strings. No DOM is built, no HTML is re-parsed, no
  serializer runs per request. A 1,000-row table renders ~6× faster than the
  0.6 renderer and RSS stays flat under load.
- **Full-page response cache.** In production, anonymous GETs of pages whose
  output is a pure function of `(path, query)` are served straight from
  memory — auto-detected (no per-request `<script>`, no module sources, no
  header/body-reading SQL; requests carrying a session or flash cookie always
  bypass it) and invalidated by the same write hooks that power `live`.
  `"responseCache"` in spark.json: a number overrides the 60 s TTL, `false`
  disables. A public blog page serves at in-memory-string speed.
- **Streaming.** Production list pages flush the `<head>` immediately and
  stream rows as they render — first byte before the first row.
- **Batched relations.** `each="c in post.comments"` over a 50-post list is
  one `WHERE post_id IN (…)` query, not 50.
- **Bounded caches.** Per-source `cache="…"` entries live in an LRU indexed
  by table (writes invalidate exactly the affected keys); glob sources re-read
  only files whose mtime moved; page/handler scripts compile once; column
  metadata is cached per table.

`test/bench.js` measures all of it (p50/p99 latency + RSS) — run it around
any render-path change.

## Security

spark-ssr ships auth, sessions, SQL, uploads, and file serving — a security
product with a framework attached. The audited posture lives in
[`SECURITY.md`](SECURITY.md), and every item is pinned by a test in
`test/security.js` that fails if the protection is removed:

- **Sessions** — HMAC-signed, `HttpOnly; SameSite=Lax`, `timingSafeEqual`
  verify; `Secure` added over HTTPS (trusted `X-Forwarded-Proto`). Production
  refuses to start if `auth` is configured without `auth.secret`.
- **No open redirect / header injection** — `_redirect` and `?next` must stay
  on-origin (no `//host`, no CRLF).
- **SQL** — all values parameterized; `?sort` is allowlisted against real
  columns, never interpolated from input.
- **Files** — no `..` traversal, and the static server never serves the
  server-only trees (`node_modules/`, `jobs/`, `lib/`, `api/`, `dist/`).
- **Uploads/DoS** — `maxBodyMb` cap (413 at the socket). **Login** —
  per-IP rate limit (429).

CSRF stance: `SameSite=Lax` (no token by default) — a documented decision, see
`SECURITY.md`.

## Deploy

```bash
bun spark-ssr build            # dist/ with a compiled single binary
bun spark-ssr build --docker   # …plus a Dockerfile: copy, run
bun spark-ssr start            # run in production (watch + live reload off)
```

MIT
