import { defineConfig } from 'vite';
import { resolve } from 'path';
import spark from 'spark-html/vite';
import prerender from 'spark-prerender/vite';

// On GitHub Pages the site is served from /<repo-name>/, not /.
// The deploy workflow sets BASE_PATH; locally it defaults to '/'.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  // `spark()` serves components in dev; `prerender()` rewrites the built
  // pages with fully-rendered HTML so crawlers and AI tools read the docs
  // (the client still hydrates over it). Dogfoods spark-prerender.
  plugins: [spark(), prerender({ pages: ['index.html', 'docs.html'] })],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        docs: resolve(__dirname, 'docs.html'),
      },
    },
  },
});
