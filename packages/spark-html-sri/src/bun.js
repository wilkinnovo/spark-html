/**
 * spark-html-sri/bun — hash the build, stamp the pages, as a spark-html-bun
 * pipeline step. Put it LAST in the pipeline: it must see the final bytes of
 * every asset and fragment (prerender/image/font all rewrite HTML).
 *
 *  1. hashes every .js/.css in the output and adds `integrity` +
 *     `crossorigin="anonymous"` to the <script src> / <link rel=stylesheet>
 *     tags that reference them — the browser enforces these natively;
 *  2. hashes every component fragment (.html without <head>) into a
 *     manifest and bakes it into the page as
 *     <script type="application/json" data-spark-sri>…</script> — the
 *     sri() runtime picks it up with zero config.
 *
 *   import sri from 'spark-html-sri/bun';
 *   export default { pipeline: [prerender(), image(), sri()] };
 */
import { join, resolve, relative, sep } from 'node:path';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

function sriHash(buf, algo) {
  return `${algo}-${createHash(algo).update(buf).digest('base64')}`;
}

// Attribute-order-agnostic tag rewriting: find <script src>/<link stylesheet>
// tags, resolve their URL against the manifest, splice the attributes in.
function stampTags(html, lookup) {
  return html
    .replace(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*>/g, (tag, src) => stamp(tag, src, lookup))
    .replace(/<link\b[^>]*\brel\s*=\s*"stylesheet"[^>]*>/g, (tag) => {
      const href = (tag.match(/\bhref\s*=\s*"([^"]+)"/) || [])[1];
      return href ? stamp(tag, href, lookup) : tag;
    });
}

function stamp(tag, url, lookup) {
  if (/\bintegrity\s*=/.test(tag)) return tag;           // already stamped
  if (/^(https?:)?\/\//.test(url)) return tag;           // remote — not ours to hash
  const hash = lookup(url.split(/[?#]/)[0]);
  if (!hash) return tag;
  const attrs = ` integrity="${hash}"` + (/\bcrossorigin\b/.test(tag) ? '' : ' crossorigin="anonymous"');
  return tag.replace(/\s*\/?>$/, (end) => `${attrs}${end}`);
}

/**
 * @param {object} [options]
 * @param {'sha256'|'sha384'|'sha512'} [options.algorithm='sha384']
 */
export default function sparkSri(options = {}) {
  const algo = options.algorithm || 'sha384';
  return {
    name: 'spark-html-sri',
    async run({ outDir, base = '/' }) {
      const root = resolve(outDir);
      if (!existsSync(root)) return;
      const baseDir = base.endsWith('/') ? base : base + '/';

      const files = await walk(root);
      const manifest = {};   // served pathname → sri string
      const pages = [];
      for (const file of files) {
        const pathname = baseDir + relative(root, file).split(sep).join('/');
        if (/\.(js|css)$/.test(file)) {
          manifest[pathname] = sriHash(await readFile(file), algo);
        } else if (file.endsWith('.html')) {
          const html = await readFile(file, 'utf8');
          if (/<\/head>/i.test(html)) pages.push({ file, html });
          else manifest[pathname] = sriHash(Buffer.from(html), algo); // component fragment
        }
      }

      const json = JSON.stringify(manifest);
      let stamped = 0;
      for (const { file, html } of pages) {
        if (html.includes('data-spark-sri')) continue;  // idempotent
        // Resolve a tag's URL to a manifest key: absolute pathnames match
        // directly; relative ones resolve against the page's directory.
        const pageDir = baseDir + relative(root, join(file, '..')).split(sep).join('/');
        const lookup = (url) => {
          if (url.startsWith('/')) return manifest[url] || manifest[baseDir.replace(/\/$/, '') + url];
          const dir = pageDir === baseDir + '.' ? baseDir : pageDir + '/';
          return manifest[dir.replace(/\/\.\//, '/') + url.replace(/^\.\//, '')];
        };
        let out = stampTags(html, lookup);
        out = out.replace(/<\/head>/i, `<script type="application/json" data-spark-sri>${json}</script>\n</head>`);
        await writeFile(file, out, 'utf8');
        stamped++;
      }
      if (stamped) {
        console.log(`[spark-html-sri] ${Object.keys(manifest).length} asset(s) hashed, ${stamped} page(s) stamped`);
      }
    },
  };
}
