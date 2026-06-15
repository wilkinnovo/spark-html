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

## Build

```bash
npm run build     # static output → dist/, serve anywhere
npm run preview   # preview the production build locally
```

## How it's wired

```
.
├── index.html              ← <div import="components/app"> + boot script
├── src/main.js             ← mount() + a shared store
├── public/components/      ← your components (plain .html files)
│   ├── app.html            ← theme + shell
│   └── welcome.html        ← the live reactive welcome screen
└── vite.config.js          ← spark-html/vite plugin
```

A component is a `.html` file with optional `<script>` and `<style>`. Top-level
variables are reactive state — assigning to one re-patches that component's DOM.
Derive values with `$:`, share state across components with `useStore(name)`,
and pass props as attributes on the `import` placeholder.

See the [full docs](https://github.com/wilkinnovo/spark#readme) for the
complete template syntax reference.
