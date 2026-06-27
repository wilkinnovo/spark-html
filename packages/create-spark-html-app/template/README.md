# ⚡ Spark App

A starter built with [spark-html](https://github.com/wilkinnovo/spark) — single-file
HTML components with built-in reactivity. No compiler, no virtual DOM, no build step.

## Develop

```bash
npm install
npm run dev
```

Open the dev server and edit `public/components/welcome.html`. Save, and the
page reloads instantly.

## Build (SEO-ready)

```bash
npm run build     # static output → dist/, serve anywhere
npm run preview   # preview the production build locally
```

`npm run build` is **SEO-friendly out of the box**: the `spark-prerender`
Vite plugin runs your app at build time and writes fully-rendered HTML into
`dist/` — so crawlers and AI tools read real content (headings, text, links),
not empty placeholders. The browser still hydrates over it for full
interactivity. Set page metadata as plain component state:

```html
<script>
  let pageTitle = 'My App — does a thing';
  let pageDescription = 'A short, crawlable description of the page.';
</script>
```

Don't need SEO? Remove the `prerender(...)` plugin from `vite.config.js`.

## How it's wired

```
.
├── index.html              ← <div import="components/app"> + boot script
├── src/main.js             ← mount() + a shared store
├── public/components/      ← your components (plain .html files)
│   ├── app.html            ← theme + shell
│   └── welcome.html        ← the live reactive welcome screen
└── vite.config.js          ← spark-html/vite + spark-prerender/vite (SEO)
```

A component is a `.html` file with optional `<script>` and `<style>`. Top-level
variables are reactive state — assigning to one re-patches that component's DOM.
Derive values with `$:`, share state across components with `useStore(name)`,
and pass props as attributes on the `import` placeholder.

See the [full docs](https://github.com/wilkinnovo/spark#readme) for the
complete template syntax reference.
