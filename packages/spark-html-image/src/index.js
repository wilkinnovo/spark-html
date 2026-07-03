/**
 * spark-html-image — build-time image optimization for spark-html sites.
 *
 * A build step: after the build (and after spark-prerender has written its
 * per-route HTML), it scans every *.html in the out dir — pages AND
 * components — for local raster <img> references, converts each to
 * webp/avif at several widths with sharp, and rewrites the tag:
 *
 *   <img src="/img/hero.png">
 *     →
 *   <img src="/img/hero.png" srcset="/img/hero-640.webp 640w, …"
 *        sizes="100vw" width="1600" height="900"
 *        loading="lazy" decoding="async">
 *
 * The original file stays in place as the src fallback, so nothing breaks in
 * a browser (or crawler) that ignores srcset. Zero config:
 *
 *   // spark.config.js
 *   import image from 'spark-html-image';
 *   export default { pipeline: [prerender(), image()] };
 *
 * With `picture: true` it instead wraps the img in <picture> with one
 * <source> per format (useful when you enable avif).
 *
 * No core involvement — this is the same pattern as spark-prerender:
 * build-time only, optional, nothing added to the runtime. It's a
 * spark-html-bun pipeline step: { name, run({ outDir }) }.
 */
import { join, dirname, extname, posix } from 'node:path';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHTML } from 'linkedom';

const RASTER = new Set(['.png', '.jpg', '.jpeg']);
const MIME = { webp: 'image/webp', avif: 'image/avif' };

// Recursively list *.html under dir.
async function htmlFiles(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...await htmlFiles(full));
    else if (name.endsWith('.html')) out.push(full);
  }
  return out;
}

// Resolve an <img src> to a file inside the out dir, or null when it isn't a
// local raster image we should touch (external URL, data:, svg, missing file).
function localImagePath(src, htmlFile, outRoot) {
  if (!src || /^[a-z]+:/i.test(src) || src.startsWith('//')) return null; // external / data:
  const clean = src.split(/[?#]/)[0];
  if (!RASTER.has(extname(clean).toLowerCase())) return null;
  const file = clean.startsWith('/')
    ? join(outRoot, clean.slice(1))
    : join(dirname(htmlFile), clean);
  return existsSync(file) ? file : null;
}

// "/img/hero.png" + 640 + webp → "/img/hero-640.webp"; no width → "/img/hero.webp"
function variantUrl(src, width, format) {
  const clean = src.split(/[?#]/)[0];
  const q = src.slice(clean.length);
  const ext = posix.extname(clean);
  const stem = clean.slice(0, -ext.length);
  return `${stem}${width ? `-${width}` : ''}.${format}${q}`;
}

/**
 * @param {object} [options]
 * @param {number[]} [options.widths=[640, 960, 1280, 1920]] srcset widths (capped at the image's intrinsic width).
 * @param {('webp'|'avif')[]} [options.formats=['webp']] Output formats, in <source> order when picture=true.
 * @param {number}  [options.quality=80] Encoder quality for every format.
 * @param {string}  [options.sizes='100vw'] The sizes attribute written alongside srcset (when the img has none).
 * @param {boolean} [options.picture=false] Wrap in <picture> with one <source> per format instead of img srcset.
 * @param {boolean} [options.lazy=true] Add loading="lazy" + decoding="async" when absent.
 */
export default function sparkImage(options = {}) {
  const widths = options.widths || [640, 960, 1280, 1920];
  const formats = options.formats || ['webp'];
  const quality = options.quality ?? 80;
  const sizes = options.sizes || '100vw';
  const picture = options.picture === true;
  const lazy = options.lazy !== false;

  return {
    name: 'spark-html-image',
    // Put it after prerender() in the pipeline so per-route HTML is rewritten too.
    async run({ outDir }) {
        // sharp is imported lazily so merely having the plugin installed
        // never loads the native module until a build actually runs.
        let sharp;
        try {
          sharp = (await import('sharp')).default;
        } catch (e) {
          console.warn(`[spark-html-image] sharp unavailable — skipped (${e.message})`);
          return;
        }

        const root = resolve(outDir);
        if (!existsSync(root)) return;

        // One conversion per (file, width, format) even when many pages
        // reference the same image; metadata is read once per file.
        const meta = new Map();      // file → { width, height }
        const converted = new Map(); // file|width|format → url written
        let images = 0;
        let files = 0;

        const variantsFor = async (file, src) => {
          let m = meta.get(file);
          if (!m) {
            const info = await sharp(file).metadata();
            // EXIF orientations 5–8 display the image rotated 90° — the
            // metadata reports the SENSOR dimensions, so swap to get the
            // dimensions the page actually renders (and that the rotated
            // variants below will have).
            const swap = (info.orientation || 1) >= 5;
            m = {
              width: (swap ? info.height : info.width) || 0,
              height: (swap ? info.width : info.height) || 0,
            };
            meta.set(file, m);
          }
          // Widths strictly below the intrinsic width, plus the intrinsic
          // itself (as the un-suffixed variant) — never upscale.
          const targets = widths.filter((w) => w < m.width).concat(m.width ? [null] : []);
          const out = {};
          for (const format of formats) {
            const entries = [];
            for (const w of targets) {
              const url = variantUrl(src, w, format);
              const key = `${file}|${w || ''}|${format}`;
              if (!converted.has(key)) {
                const destUrl = url.split(/[?#]/)[0];
                const dest = destUrl.startsWith('/')
                  ? join(root, destUrl.slice(1))
                  : join(dirname(file), posix.basename(destUrl));
                // .rotate() with no args bakes the EXIF orientation into the
                // pixels — webp/avif output drops the EXIF tag, so without
                // this every phone photo would render sideways.
                let img = sharp(file).rotate();
                if (w) img = img.resize({ width: w });
                await img[format]({ quality }).toFile(dest);
                converted.set(key, url);
              }
              entries.push(`${url} ${w || m.width}w`);
            }
            out[format] = entries.join(', ');
          }
          return { srcsets: out, ...m };
        };

        for (const htmlFile of await htmlFiles(root)) {
          const source = await readFile(htmlFile, 'utf8');
          if (!/<img\s/i.test(source)) continue;
          const { document } = parseHTML(source);
          let changed = false;

          for (const img of [...document.querySelectorAll('img[src]')]) {
            const src = img.getAttribute('src');
            const file = localImagePath(src, htmlFile, root);
            if (!file) continue;
            if (img.hasAttribute('srcset') || img.closest('picture')) continue; // author knows best
            try {
              const v = await variantsFor(file, src);
              if (!v.width) continue; // unreadable metadata — leave the tag alone
              if (picture) {
                const pic = document.createElement('picture');
                img.replaceWith(pic);
                for (const format of formats) {
                  const s = document.createElement('source');
                  s.setAttribute('type', MIME[format]);
                  s.setAttribute('srcset', v.srcsets[format]);
                  s.setAttribute('sizes', img.getAttribute('sizes') || sizes);
                  pic.appendChild(s);
                }
                pic.appendChild(img);
              } else {
                // srcset straight on the img — every srcset-capable browser
                // also decodes webp; `src` stays the original as the fallback.
                img.setAttribute('srcset', v.srcsets[formats[0]]);
                if (!img.hasAttribute('sizes')) img.setAttribute('sizes', sizes);
              }
              if (!img.hasAttribute('width')) img.setAttribute('width', String(v.width));
              if (!img.hasAttribute('height')) img.setAttribute('height', String(v.height));
              if (lazy && !img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
              if (lazy && !img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
              changed = true;
              images++;
            } catch (e) {
              console.warn(`[spark-html-image] skipped ${src} — ${e.message}`);
            }
          }

          if (changed) {
            await writeFile(htmlFile, document.toString(), 'utf8');
            files++;
          }
        }

        if (images) {
          console.log(`[spark-html-image] optimized ${images} image reference(s) across ${files} file(s) (${formats.join('+')})`);
        }
    },
  };
}
