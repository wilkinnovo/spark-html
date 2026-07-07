# Spark — no build, no install

The whole point of Spark: **the `.html` you write is what runs.** No install, no
bundler, no compiler. This example is three static files:

```
index.html              ← import map → Spark from a CDN, then mount()
components/counter.html  ← a single-file reactive component
components/hello.html    ← another, with a prop
```

`index.html` pulls Spark straight from a CDN with an import map:

```html
<script type="importmap">
  { "imports": { "spark-html": "https://esm.sh/spark-html@0.30" } }
</script>
<script type="module">
  import { mount } from 'spark-html';
  mount();
</script>
```

## Run it

Components are fetched over HTTP, so serve the folder with any static server
(opening the file with `file://` won't work — browsers block `fetch` there):

```bash
bunx serve            # or: python3 -m http.server
```

Then open the printed URL. Edit a component and refresh — no build step in sight.

> Components are just files at a URL, so you can even import one from anywhere:
> `<div import="https://cdn.jsdelivr.net/gh/you/repo/card.html"></div>`.
