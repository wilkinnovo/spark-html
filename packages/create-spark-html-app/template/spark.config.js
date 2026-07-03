import prerender from 'spark-prerender/bun';
// @spark:image
import image from 'spark-html-image/bun';
// @spark:end
// @spark:pwa
import manifest from 'spark-html-manifest/bun';
// @spark:end
// @spark:sri
import sri from 'spark-html-sri/bun';
// @spark:end

// Spark needs no build step — spark-html-bun is just a fast dev server and a
// bundler for your app shell. `spark dev` serves component fragments raw and
// hot-reloads only the edited component; components live in public/ so they
// ship verbatim to the production build too.
//
// The `pipeline` runs in order after `spark build` copies public/ and bundles
// the entry. Order matters: prerender() first (it writes one HTML file per
// route), then the steps that rewrite those pages — sri() must be last so it
// hashes the final bytes.
//
// `prerender()` makes `bun run build` SEO-friendly: it runs your app at build
// time and writes fully-rendered HTML into dist/ (crawlers and AI tools read
// real content; the browser still hydrates over it), plus sitemap.xml +
// robots.txt. Remove it if you don't need SEO.
export default {
  pipeline: [
    prerender({ pages: ['index.html'] }),
    // @spark:image
    // Every <img> in pages and components: converted to webp/avif at multiple
    // widths, srcset + width/height added (no layout shift), loading="lazy".
    // Zero config.
    image(),
    // @spark:end
    // @spark:pwa
    // One config → manifest.webmanifest + resized icons + <head> tags + an
    // offline app-shell service worker (registered automatically).
    manifest({
      name: 'Spark App',
      themeColor: '#ffd24a',
      icon: 'public/icon.png',
      offline: true,
    }),
    // @spark:end
    // @spark:sri
    // Hashes every built asset + component, stamps integrity/crossorigin onto
    // script/link tags, and bakes the verify manifest into each page. Keep it
    // LAST so it sees the final pages.
    sri(),
    // @spark:end
  ],
};
