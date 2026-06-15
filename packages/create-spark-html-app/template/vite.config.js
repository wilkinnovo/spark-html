import { defineConfig } from 'vite';
import spark from 'spark-html/vite';

// Spark needs no build step — Vite is just a convenient dev server and
// bundler. The plugin serves component fragments raw and full-reloads
// when one changes. Components live in public/ so they ship verbatim to
// the production build too.
export default defineConfig({
  plugins: [spark()],
});
