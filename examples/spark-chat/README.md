# ⚡ spark chat — a WhatsApp-style clone on spark-ssr

Realtime 1:1 messaging, auth, profiles with a photo, and a master-detail
chat screen — all server-rendered, live-updating, and built from a handful
of `.html` files plus one SQLite database. **No build step. No setup
script. No client-side routing library. No socket code.**

## Run it

```bash
bun install
bun run dev     # creates + seeds the DB from the templates, serves on :3000
```

Sign in at [/login](http://localhost:3000/login) with
**milo@spark-html.com** / **spark** (any seeded user works, same password),
or [create a new account](http://localhost:3000/signup). Open two browser
tabs signed in as different users to see `live` push messages across them
with zero socket code.

## What's demonstrated where

| Feature | Where |
|---|---|
| Auth (login/signup/logout) | `spark.json` `"auth"` → sessions; `pages/login.html` + `pages/signup.html` are plain forms, work with JS disabled |
| Master-detail chat | `pages/index.html` — contacts sidebar (`aside.sidebar`) + thread pane, selected via `?with=<id>` |
| Realtime messaging | `<spark-ssr table="messages" … live />` — every send pings every open tab, which refetches through its own session |
| Profile + settings | `pages/profile.html` — name/bio via `api_update`, avatar via upload, theme toggle, sign out |
| Profile photo upload | `pages/profile.html` posts multipart to `api/avatar.html`, a custom endpoint using the `req`/`db` escape hatch (JSON-only `api_update` can't carry a file) |
| Users list | `contacts` named query in `pages/index.html` — every other user, clickable |
| Dummy data | `seed/users.json` (6 users) + `seed/messages.json` (a starter conversation), applied once at first run |
| Session-scoped reads | `thread` query filters by `:session.id`/`:with` — you only ever see your own conversations |
| Guards | every real page: `<spark-ssr guard="session" redirect="/login" />` |
| No-JS forms | login, signup, avatar upload, logout — plain forms, 303 back |
| Reusable component | `components/avatar.html` — initials-on-hashed-color fallback when no photo is set, used on every page |
| Same design system as spark-html.dev | JetBrains Mono, `--spark` gold accent (`#ffd24a`), dark-by-default theme via spark-html-theme |

## The mental model

- `pages/_layout.html` wraps every page; here it's just the stylesheet +
  `app.js` boot script, since the chat/auth screens each own their full
  layout (a sidebar isn't meaningful on `/login`).
- `pages/index.html`'s `<script>` is the client component (the page has
  binds + handlers + a data source): `api_create` and `refresh()` come free,
  no `fetch()` written by hand.
- `components/avatar.html`'s `<script>` runs in the browser like any Spark
  component — it's pure UI with a small derived value (initials + color),
  nothing DOM-manipulated by hand; every visual update goes through Spark's
  own directives (`bind:`, `onclick`, `each`, `if`, stores).
- `<spark-ssr>` declares data: `table="messages" … live` gives schema +
  seed + a scoped REST API + cross-tab push; the second `<spark-ssr>` block
  on the same page runs named, session-scoped `SELECT`s (`me`, `contacts`,
  `peer`, `thread`) with no public endpoint.
- `middleware.html` is intentionally empty here — spark-chat allows public
  signup, unlike the single-author blog this template started from.

## Deploy

```bash
bun run build            # dist/ + compiled binary
bun spark-ssr build --docker   # …plus a Dockerfile
PORT=3000 ./dist/app
```

Set a fixed session secret in production so logins survive restarts:
`"auth": { …, "secret": "ENV.SESSION_SECRET" }` in spark.json. Swap SQLite
for Postgres by changing one line: `"db": "postgres://…"`.
