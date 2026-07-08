# sparkShare

A Dropbox-style file sharing app built entirely on `spark-ssr` — no build
step, no external storage, no client-side framework beyond spark-html
itself. Scaffolded in the shape of `create-spark-html-app`'s `template-ssr`.

## Features

- Email/password auth (signup, login, logout) via spark-ssr's built-in auth table
- Profile with avatar upload, name/bio editing (`/settings`)
- Public profile pages (`/u/:id`) showing a user's public files
- Upload any file type (documents, images, video, audio, spreadsheets, archives)
- Per-file visibility: **private** (link only) or **public** (also listed on your profile)
- Unique share links (`/s/:token`) with an inline viewer for images, video, audio and PDFs
- Homepage discovery feed of recently shared public files
- Dummy data: 4 seeded users and 11 seeded documents (see `seed/`)

## Run it

```sh
bun install
bun run dev      # http://localhost:3000
```

Seeded accounts (password `spark` for all): `ava@sparkshare.dev`,
`ben@sparkshare.dev`, `cleo@sparkshare.dev`, `drew@sparkshare.dev`.

## How it's built

- `pages/_layout.html` — nav + footer; `me` (the signed-in user, NOT the raw
  session) is a layout-level data source ambient on every page.
- `pages/dashboard.html` — upload form (plain multipart `<form>`, works with
  JS disabled) + file list with visibility toggle / copy-link / delete.
- `pages/settings.html` — profile edit + avatar upload (goes straight to the
  auth table's own-account-only `PATCH`, bypassing the JSON-only ambient
  helper since it needs to send a file).
- `pages/u/[id].html` — public profile grid.
- `pages/s/[token].html` — the share-link viewer. The token is the entire
  access control, same as Dropbox: `visibility` only decides whether a file
  is *listed* on a profile, never whether the link itself resolves.
- `lib/*.js` — module data sources (`<spark-ssr>foo = ./lib/foo.js</spark-ssr>`).
  Used wherever a query needs computed display fields (human file sizes,
  pretty dates, file-type icons) — computed server-side so the first
  SSR paint already has them, since a hydrating page's own `<script>` never
  runs on the server.
- `middleware.html` — closes `GET /api/users` entirely. spark-ssr's auto-CRUD
  used to serve it unauthenticated for any configured auth table (a real leak
  for a multi-user app — fixed framework-side in spark-ssr 1.0.1, bugs.md #7:
  anon → 401, session → own row, admin → all); kept as defense-in-depth since
  nothing in this app reads that endpoint.
