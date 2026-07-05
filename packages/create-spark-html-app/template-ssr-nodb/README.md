# ⚡ Spark Notes — a database-free spark-ssr blog

A server-rendered blog with **no database**. Every post is a markdown file in
`content/`, read through spark-ssr's file **sources**:

- `posts = ./content/*.md` — a **glob source** (front matter → columns,
  filename → slug) lists posts on the homepage.
- `post = ./lib/post.js` — a **module source** reads one post by `:slug` for
  each `/blog/:slug` page.

No table, no query, no ORM, no build step.

```bash
bun install
bun run dev       # dev server with live reload
bun run build     # dist/ (a single binary) for production
bun run start     # run the production server
```

## Add a post

Drop a markdown file in `content/` with `title`, `date`, and `excerpt` front
matter. The filename is its URL (`content/my-post.md` → `/blog/my-post`).

## Need a database?

Users, comments, orders, admin CRUD, auth, `live` updates — scaffold the SSR
template **with a database** instead:

```bash
bun create spark-html-app my-app   # choose SSR, then "with database"
```
