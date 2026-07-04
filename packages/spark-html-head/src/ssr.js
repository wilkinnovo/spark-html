/**
 * spark-html-head/ssr — server-side head handling. No DOM, no dependencies.
 *
 * The declarative counterpart to the client `head()` API: a page written for
 * an SSR server (spark-ssr) or a build pipeline puts literal <title>/<meta>/
 * <link> tags — and client <script> tags — in its markup; `liftHead` pulls
 * them out of the body, and `renderHead` interpolates `{expr}` placeholders
 * against the page's data scope, HTML-escaped.
 *
 *   const { head, scripts, body } = liftHead(pageHtml);
 *   const tags = renderHead(head, (expr) => evaluate(expr, scope));
 *
 * `scripts` collects client scripts — `<script src>` and inline
 * `<script type="module">` — verbatim: script bodies are code, never
 * interpolated. The same tags a crawler needs land in the HTML payload; on
 * the client, `head()` (the package root) takes over for pushState
 * navigation.
 */

const CLIENT_SCRIPT =
  /[ \t]*<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>[\s\S]*?<\/script>[ \t]*\r?\n?|[ \t]*<script\b[^>]*\bsrc\s*=[^>]*>[\s\S]*?<\/script>[ \t]*\r?\n?/gi;
const HEAD_TAG =
  /[ \t]*(?:<title\b[^>]*>[\s\S]*?<\/title>|<meta\b[^>]*?\/?>|<link\b[^>]*?\/?>)[ \t]*\r?\n?/gi;

/**
 * Extract <title>/<meta>/<link> tags and client <script> tags from a page's
 * markup.
 * @param {string} html
 * @returns {{ head: string, scripts: string, body: string }}
 */
export function liftHead(html) {
  // Comments are masked first so prose like <!-- set the <title> here -->
  // never lifts (or truncates) anything.
  const comments = [];
  const masked = String(html).replace(/<!--[\s\S]*?-->/g, (m) => {
    comments.push(m);
    return `\u0000c${comments.length - 1}\u0000`;
  });
  let head = '';
  let scripts = '';
  const body = masked
    .replace(CLIENT_SCRIPT, (m) => { scripts += m.trim() + '\n'; return ''; })
    .replace(HEAD_TAG, (m) => { head += m.trim() + '\n'; return ''; })
    .replace(/\u0000c(\d+)\u0000/g, (_, i) => comments[i]);
  return { head: head.trim(), scripts: scripts.trim(), body };
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Interpolate `{expr}` placeholders in lifted head tags. `resolve(expr)`
 * evaluates one expression against the caller's scope; values are stringified
 * (objects as JSON) and HTML-escaped.
 * @param {string} head
 * @param {(expr: string) => unknown} resolve
 * @returns {string}
 */
export function renderHead(head, resolve) {
  return String(head).replace(/\{([^{}]+)\}/g, (_, e) => {
    let v;
    try { v = resolve(e); } catch { v = undefined; }
    return escapeHtml(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  });
}

export default { liftHead, renderHead };
