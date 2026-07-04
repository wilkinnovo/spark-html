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
  "cors": true
}
```

`sqlite://./dev.db` works too (Bun ships both drivers). `ENV.*` values resolve
from the environment at startup. `cors: true` allows all origins on `/api/*`;
an array allows specific ones.

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
- **Hydration** — interactive pages ship fully-rendered HTML plus a generated
  client component; `mount()` takes over with the same spark-html runtime.

## Deploy

```bash
bun spark-ssr build   # dist/ with a compiled single binary
bun spark-ssr start   # run in production
```

MIT
