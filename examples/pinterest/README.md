# Pinspire

A Pinterest-style app — boards, pins, photo upload, likes, saves, comments,
follows, search — built entirely on `spark-ssr` (SSR-with-database) and its
companion packages. No framework outside the spark family, no manual DOM
manipulation anywhere: every interactive bit is template directives
(`bind:`, `onclick={}`, `each`, `if`, `await`) plus a page `<script>`'s own
state, exactly the spark-ssr way.

## Run it

```bash
bun install   # from the repo root — this is a workspace package
cd examples/pinterest
bun spark-ssr
```

Then open `http://localhost:3000`. Seeded accounts (password for all:
`password123`):

| Email | Username |
|---|---|
| ada@pinspire.dev | @ada |
| nova@pinspire.dev | @nova |
| kai@pinspire.dev | @kai |
| mira@pinspire.dev | @mira |

`bun spark-ssr db` shows the inferred schema; `bun spark-ssr build` produces
a production build.

## What's here

- **Auth** — signup/login/logout (`pages/login.html`, `pages/signup.html`),
  extra profile fields (`name`, `username`, `bio`, `avatar`) inferred as real
  columns straight from the signup form.
- **Photo upload** — `pages/create.html`, a plain `<input type="file">` in a
  multipart form; spark-ssr streams it to `uploads/` and hands the URL to
  the same auto-CRUD write as any other field.
- **Boards** — `pages/boards/new.html` (auto-CRUD), a default board created
  for every new signup via `jobs/createDefaultBoard.js`
  (`<spark-ssr job="…" on="insert:users" />`).
- **Home feed** — `pages/index.html`, a CSS-columns masonry grid, `?q=`
  search across title/description, no `<script>` at all (a response-cache
  candidate in production).
- **Pin detail** — `pages/pin/[id].html`: like (toggle), save-to-board (with
  inline "create a new board" — `api/save.html`), comments (auto-CRUD via
  the ambient `api_create`), delete-your-own-pin. A missing pin 404s
  automatically.
- **Boards & profiles** — `pages/board/[id].html` (a board's own pins UNION
  pins saved there from elsewhere), `pages/u/[username].html` (created
  pins / boards tabs, follower/following counts, follow toggle via
  `api/follow.html`).

See **`bugs.md`** for every bug and edge case found (and mostly fixed, in
`spark-ssr`/`spark-html` themselves) while building this — several were
real framework bugs, not app mistakes, verified with regression tests in
each package's own suite.
