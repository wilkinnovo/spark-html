# ⚡ Spark Static App

A prerendered static site built with
[spark-html](https://github.com/wilkinnovo/spark-html) + `spark-prerender`.
Components stay single-file HTML; the build writes fully-rendered pages into
`dist/` (plus sitemap/robots hooks) and the browser hydrates over them.

```bash
bun install
bun run dev       # dev server with HMR
bun run build     # prerendered static output → dist/, deploy anywhere
bun run preview   # preview the production build
```
