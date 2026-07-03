# create-spark-html-app

Scaffold a [Spark](https://github.com/wilkinnovo/spark) app in seconds — a Vite
project wired to `spark-html` with live, reactive **Spark** components.

## Usage

```bash
npm create spark-html-app@latest my-app
# or
npx create-spark-html-app my-app
```

Then:

```bash
cd my-app
npm install
npm run dev
```

Run it with no name to be prompted:

```bash
npm create spark-html-app@latest
```

## What you get

The scaffold comes with the **whole Spark ecosystem pre-wired** — you delete
what you don't need instead of wiring what you do:

| Always on | Optional (prompted) |
|-----------|---------------------|
| `spark-html` — the runtime | `spark-html-router` — multi-page SPA *(default yes)* |
| `spark-html-head` — reactive title/meta | `spark-html-theme` — dark/light toggle *(yes)* |
| `spark-html-persist` — localStorage store demo | `spark-html-image` — webp/avif + srcset at build *(yes)* |
| `spark-prerender` — SEO HTML + sitemap/robots | `spark-html-sri` — integrity checks *(yes)* |
| `spark-html-devtools` — dev-only inspector | `spark-html-manifest` — PWA manifest + icons + offline shell *(no)* |

Every included feature ships with a live demo component, ready to run.

Non-interactive? Pass flags instead of answering prompts:

```bash
npx create-spark-html-app my-app --yes       # accept the defaults
npx create-spark-html-app my-app --all       # everything on
npx create-spark-html-app my-app --minimal   # core only
npx create-spark-html-app my-app --pwa --no-image   # per-feature
```

Everything is plain HTML and JavaScript — no compiler, no virtual DOM, no
proprietary file format. Edit a component, save, and the page updates.

## License

MIT
