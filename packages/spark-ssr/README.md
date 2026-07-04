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

<spark-ssr table="todos" />
```

```bash
bun spark-ssr
```

That's it.

| The template says                               | The framework knows                          |
| ----------------------------------------------- | -------------------------------------------- |
| `<template each="todo in todos">`               | You need data called `todos`                 |
| `table="todos"`                                 | It's backed by the `todos` table             |
| `onclick={add}` (outside the loop)              | `POST /api/todos` — insert                   |
| `bind:checked="todo.done"` + `onchange={patch}` | `PATCH /api/todos/:id` — update `done`       |
| `onclick={remove}` (inside the loop)            | `DELETE /api/todos/:id` — remove the row     |
| `bind:value="draft"`                            | Local state variable `draft`                 |
| `user_id` column in the table                   | Auth — `WHERE user_id = :session.id`         |

No `<script>`. No SQL. No ORM. No server file. No build step.

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

## Routing

The filesystem is the router. `pages/index.html` → `/`,
`pages/blog/[slug].html` → `/blog/:slug` (`:slug` binds into queries).
Without a `pages/` folder, `*.html` at the project root serve the same way.

## Explicit queries

```html
<!-- pages/search.html -->
<h1>Results for "{q}"</h1>
<template each="result in results">
  <p>{result.title}</p>
</template>

<spark-ssr>
  GET /api/search → SELECT * FROM posts WHERE title LIKE '%' || :q || '%' LIMIT 20
</spark-ssr>
```

`:` params inject automatically: path params (`:slug`), query string (`:q`),
JSON body (`:body.title`), session (`:session.id`), headers
(`:header.x-forwarded-for`), uploads (`:file.url`).

## The page owns its \<head\>

Literal `<title>`/`<meta>`/`<link>` tags at the top of a page lift into the
document head, `{expr}`-interpolated against the page's data
(spark-html-head's `/ssr` module does the lifting):

```html
<!-- pages/blog/[slug].html -->
<title>{post.title} · My Blog</title>
<meta name="description" content="{post.excerpt}">
```

## Client scripts and the family

A page's plain `<script>` runs on the **server** (the escape hatch).
`<script type="module">` and `<script src>` are **client** scripts — they lift
into `<head>` after an auto-generated importmap, so bare imports of the Spark
family just work, no build:

```html
<script type="module" src="/app.js"></script>
```

```js
// public/app.js
import { theme } from 'spark-html-theme';
theme();
```

Every `spark-html-*` package in your dependencies is importmap-mapped and
served at `/@modules/<name>/…`. Depend on **spark-html-theme** and the
no-flash init snippet is inlined in every head automatically; depend on
**spark-html-image** and `spark-ssr build` runs its webp/srcset pass over
`dist/` (options: `"images"` in spark.json).

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
  passwords hash on insert), or a plugin (`auth.plugin` in spark.json).
- **Middleware** — `middleware.html` runs on every request (`req`, `res`,
  `rateLimit`, `state` in scope; return `{ status, body }` to short-circuit).
- **Uploads** — multipart bodies stream to `uploads/`; `:file.url` binds the
  stored URL into your INSERT.
- **Error pages** — `404.html` / `500.html` at the project root.
- **Static assets** — `public/` plus co-located page assets, served as-is.
  Project internals (spark.json, package.json, `*.db`, dotfiles) are never
  served.
- **Hydration** — interactive pages ship fully-rendered HTML plus a generated
  client component; `mount()` takes over with the same spark-html runtime.
- **Live reload** — in dev, every edit (pages, components, queries,
  middleware, css) refreshes the browser via SSE. No restart, no flags.
- **Auth-table hygiene** — the auth table's auto CRUD never returns password
  hashes, and PATCH/DELETE are own-account only. Configuring `auth` registers
  the table (login/signup endpoints) without any page declaring it; disable
  public signup in `middleware.html` if the app is invite-only.

## Deploy

```bash
bun spark-ssr build   # dist/ with a compiled single binary (public/ flattens into dist root)
bun spark-ssr start   # run in production (watch + live reload off)
```

MIT
