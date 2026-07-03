import { defineConfig } from 'vite';
import spark from 'spark-html/vite';
import prerender from 'spark-prerender/vite';
// @spark:image
import image from 'spark-html-image/vite';
// @spark:end
// @spark:pwa
import manifest from 'spark-html-manifest/vite';
// @spark:end
// @spark:sri
import sri from 'spark-html-sri/vite';
// @spark:end

// Spark needs no build step — Vite is just a convenient dev server and
// bundler. The plugin serves component fragments raw and full-reloads
// when one changes. Components live in public/ so they ship verbatim to
// the production build too.
//
// `prerender()` makes `npm run build` SEO-friendly: it runs your app at
// build time and writes fully-rendered HTML into dist/ (crawlers and AI
// tools read real content; the browser still hydrates over it), plus
// sitemap.xml + robots.txt. Remove it if you don't need SEO.
export default defineConfig({
  optimizeDeps: {
    // Ensure spark-html is pre-bundled so all modules share the same stores Map.
    // Without this, file: references can create duplicate runtime instances.
    include: ['spark-html'],
  },
  plugins: [
    spark(),
    // @spark:image
    // Every <img> in pages and components: converted to webp/avif at
    // multiple widths, wrapped in <picture> with srcset, width/height
    // added (no layout shift), loading="lazy". Zero config.
    image(),
    // @spark:end
    prerender({ pages: ['index.html'] }),
    // @spark:pwa
    // One config → manifest.webmanifest + resized icons + <head> tags +
    // an offline app-shell service worker (registered automatically).
    manifest({
      name: 'Spark App',
      themeColor: '#ffd24a',
      icon: 'public/icon.png',
      offline: true,
    }),
    // @spark:end
    // @spark:sri
    // Hashes every built asset + component, stamps integrity/crossorigin
    // onto script/link tags, and bakes the verify manifest into each page.
    // Keep it AFTER prerender() so it sees the final pages.
    sri(),
    // @spark:end
  ],
});
