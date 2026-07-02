/**
 * spark-html-font — font loading in one place, layout shift in none.
 *
 * Configure every font once; get back the whole loading story:
 *
 *   • @font-face declarations with the right `font-display` (swap default)
 *   • <link rel="preload"> for self-hosted woff2 (fetch starts with the HTML)
 *   • a size-adjusted local FALLBACK face per family (ascent/descent/
 *     size-adjust overrides on Arial) so the swap doesn't move the page —
 *     built-in approximate metrics for popular families, overridable
 *   • Google Fonts: preconnect + the css2 stylesheet URL, no build-time network
 *   • a :root CSS var per family — `font-family: var(--font-inter)` — whose
 *     stack is real font → fallback face → your generic fallbacks
 *
 * Two ways to apply it:
 *
 *   // at runtime (main.js) — injects <style>/<link> into <head>
 *   import { fonts } from 'spark-html-font';
 *   fonts({ fonts: [{ family: 'Inter', src: '/fonts/inter-var.woff2', weight: '100 900' }] });
 *
 *   // at build (vite.config.js) — bakes the same tags into every built page
 *   import font from 'spark-html-font/vite';
 *   plugins: [spark(), prerender(), font({ fonts: [...] })]
 *
 * Zero dependencies; pure string generation plus a little DOM.
 */

// Approximate Arial-adjusted fallback metrics (fontaine-style) for popular
// families. Percentages; good enough to keep the swap from moving the page.
// Override per font with `metrics: { sizeAdjust, ascent, descent, lineGap }`.
const METRICS = {
  'inter':            { sizeAdjust: 107.4, ascent: 90.2,  descent: 22.5, lineGap: 0 },
  'roboto':           { sizeAdjust: 100.3, ascent: 92.8,  descent: 24.4, lineGap: 0 },
  'open sans':        { sizeAdjust: 105.4, ascent: 101.3, descent: 27.8, lineGap: 0 },
  'lato':             { sizeAdjust: 97.4,  ascent: 101.3, descent: 21.9, lineGap: 0 },
  'montserrat':       { sizeAdjust: 112.5, ascent: 86.1,  descent: 22.3, lineGap: 0 },
  'poppins':          { sizeAdjust: 112.2, ascent: 93.8,  descent: 31.3, lineGap: 0 },
  'nunito':           { sizeAdjust: 101.9, ascent: 99.4,  descent: 34.7, lineGap: 0 },
  'source sans pro':  { sizeAdjust: 94.1,  ascent: 104.6, descent: 29.0, lineGap: 0 },
};

const slug = (family) => family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function formatOf(src) {
  const ext = String(src).split(/[?#]/)[0].split('.').pop().toLowerCase();
  return { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' }[ext] || 'woff2';
}

// css2 URL for a Google-hosted family: Inter + [400,700] →
// https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap
function googleUrl(font) {
  const fam = font.family.replace(/ /g, '+');
  const weights = [].concat(font.weights || font.weight || []).filter((w) => w !== undefined);
  const axis = weights.length ? `:wght@${weights.join(';')}` : '';
  return `https://fonts.googleapis.com/css2?family=${fam}${axis}&display=${font.display || 'swap'}`;
}

/**
 * The full CSS block for a config: @font-face per self-hosted font, a
 * size-adjusted "<Family> Fallback" face per family with known/provided
 * metrics, and one `--font-<slug>` var per family on :root.
 */
export function fontCss(config = {}) {
  const list = config.fonts || [];
  const generic = config.fallback || ['system-ui', 'sans-serif'];
  const rules = [];
  const vars = [];

  for (const font of list) {
    const fam = font.family;
    if (!fam) continue;

    if (!font.google && font.src) {
      const srcs = [].concat(font.src)
        .map((s) => `url("${s}") format("${font.format || formatOf(s)}")`)
        .join(', ');
      rules.push(
        `@font-face { font-family: "${fam}"; src: ${srcs};` +
        ` font-weight: ${font.weight || font.weights?.join(' ') || 400};` +
        ` font-style: ${font.style || 'normal'};` +
        ` font-display: ${font.display || 'swap'}; }`,
      );
    }

    // The CLS killer: a local()-based stand-in sized like the real font, so
    // text set in the fallback occupies the same space before the swap.
    const m = font.metrics || METRICS[fam.toLowerCase()];
    const stack = [`"${fam}"`];
    if (m && font.adjust !== false) {
      const local = font.adjustFrom || 'Arial';
      rules.push(
        `@font-face { font-family: "${fam} Fallback"; src: local("${local}");` +
        ` size-adjust: ${m.sizeAdjust}%; ascent-override: ${m.ascent}%;` +
        ` descent-override: ${m.descent}%; line-gap-override: ${m.lineGap ?? 0}%; }`,
      );
      stack.push(`"${fam} Fallback"`);
    }
    vars.push(`--font-${slug(fam)}: ${stack.concat(generic).join(', ')};`);
  }

  if (vars.length) rules.push(`:root { ${vars.join(' ')} }`);
  return rules.join('\n');
}

/**
 * The <link> tags for a config, as { rel, href, ...attrs } descriptors:
 * preload for self-hosted files (unless preload:false), preconnect + the
 * css2 stylesheet for Google-hosted families.
 */
export function fontLinks(config = {}) {
  const links = [];
  let google = false;
  for (const font of config.fonts || []) {
    if (font.google) {
      if (!google) {
        google = true;
        links.push({ rel: 'preconnect', href: 'https://fonts.googleapis.com' });
        links.push({ rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' });
      }
      links.push({ rel: 'stylesheet', href: googleUrl(font) });
    } else if (font.src && config.preload !== false && font.preload !== false) {
      for (const s of [].concat(font.src)) {
        links.push({ rel: 'preload', href: s, as: 'font', type: `font/${formatOf(s)}`, crossorigin: '' });
      }
    }
  }
  return links;
}

// Serialize the links + style as an HTML block (used by the vite plugin; the
// data-spark-font marker makes injection idempotent).
export function fontHtml(config = {}) {
  const attrs = (l) => Object.entries(l)
    .map(([k, v]) => (v === '' ? k : `${k}="${v}"`))
    .join(' ');
  const links = fontLinks(config)
    .map((l) => `<link data-spark-font ${attrs(l)}>`);
  const css = fontCss(config);
  if (css) links.push(`<style data-spark-font>\n${css}\n</style>`);
  return links.join('\n');
}

/**
 * Runtime form: inject the <link>/<style> tags into document.head now.
 * Idempotent (a second call is a no-op); returns a stop() that removes them.
 */
export function fonts(config = {}) {
  if (typeof document === 'undefined' || !document.head) return () => {};
  if (document.head.querySelector('[data-spark-font]')) return () => {};
  const nodes = [];
  for (const l of fontLinks(config)) {
    const el = document.createElement('link');
    el.setAttribute('data-spark-font', '');
    for (const [k, v] of Object.entries(l)) el.setAttribute(k, v);
    document.head.appendChild(el);
    nodes.push(el);
  }
  const css = fontCss(config);
  if (css) {
    const style = document.createElement('style');
    style.setAttribute('data-spark-font', '');
    style.textContent = css;
    document.head.appendChild(style);
    nodes.push(style);
  }
  return () => nodes.forEach((n) => n.remove());
}

export default { fonts, fontCss, fontLinks, fontHtml };
