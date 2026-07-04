# ⚡ Spark SSR App

SSR the Spark way — zero config, no build. The HTML template infers
everything: `<template each="todo in todos">` means you need `todos`,
`<spark-ssr table="todos" />` backs it with a table and the REST endpoints
the handlers imply.

## Develop

```bash
bun install
bun run dev     # creates + seeds dev.db, then serves on :3000
```

## The three-tier pattern

- **Page** — `pages/index.html` declares its data with `<spark-ssr>`
- **Component** — `components/nav.html` is pure UI via `<div import>`
- **Config** — `spark.json` holds the DB connection (swap sqlite → postgres
  by changing one line)

Add a page by adding a file: `pages/about.html` → `/about`,
`pages/blog/[slug].html` → `/blog/:slug` (`:slug` binds into your queries).

## Deploy

```bash
bun run build   # dist/ with a compiled single binary
```
