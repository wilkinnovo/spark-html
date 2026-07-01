import { defineConfig } from 'vite';
import spark from 'spark-html/vite';
import prerender from 'spark-prerender/vite';

// Spark needs no build step — Vite is just a convenient dev server and
// bundler. The plugin serves component fragments raw and full-reloads
// when one changes. Components live in public/ so they ship verbatim to
// the production build too.
//
// `prerender()` makes `npm run build` SEO-friendly: it runs your app at
// build time and writes fully-rendered HTML into dist/ (crawlers and AI
// tools read real content; the browser still hydrates over it). Remove it
// if you don't need SEO. List every page you ship in `pages`.
export default defineConfig({
  plugins: [
    spark(),
    prerender({ pages: ['index.html'] }),
  ],
});
