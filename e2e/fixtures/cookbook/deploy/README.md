# Deploy

**Static (client / prerender):** `bun run build`, then put `dist/` on any
static host. GitHub Pages: set `base: '/repo/'` in spark.config.js.

**spark-ssr (one Bun process):** the Dockerfile in this folder. Persist
`data.db` and `uploads/` on a volume; set `SESSION_SECRET` if auth is on.

```bash
fly launch && fly volumes create data && fly secrets set SESSION_SECRET=$(openssl rand -hex 32) && fly deploy
```
