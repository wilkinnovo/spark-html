/**
 * spark-html-sri — Subresource Integrity for spark-html apps.
 *
 * Two halves, one mental model (`<script integrity>` — familiar to every
 * web developer):
 *
 * **Local files** — fully automatic, zero config. The vite plugin
 * (spark-html-sri/vite) hashes every built JS/CSS/component fragment,
 * injects `integrity` + `crossorigin` into `<script>`/`<link>` tags, and
 * bakes a manifest into each page. At runtime `sri()` verifies every
 * component fetch against that manifest before spark-html boots it.
 *
 * **Remote URL imports** (`<div import="https://…">`) — whitelist + TOFU.
 * Only allowed origins may be imported; for those, the first fetch stores
 * the content hash (trust on first use) and every later load must match.
 * A CDN compromised after your first visit serves a component that no
 * longer hashes — it's rejected before it runs.
 *
 *   import { sri } from 'spark-html-sri';
 *   sri();                                     // defaults for everything
 *   sri({ allow: ['esm.sh'], enforce: true }); // tighten
 *
 * Fail open in dev (localhost warns, never blocks), enforce in production.
 * Nothing here touches the spark-html core — apps that don't use SRI pay
 * zero bytes.
 */

/** Remote origins allowed by default for URL-imported components. */
export const DEFAULT_ALLOW = ['cdn.jsdelivr.net', 'unpkg.com', 'esm.sh', 'raw.githubusercontent.com'];

const TOFU_KEY = 'spark-sri:tofu';
const ALGOS = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

function subtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error('[spark-sri] WebCrypto unavailable (secure context required)');
  return s;
}

function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function b64(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * Compute an SRI string — `integrity('hi')` → `"sha384-…"`.
 * @param {string|Uint8Array|ArrayBuffer} data
 * @param {'sha256'|'sha384'|'sha512'} [algo='sha384']
 */
export async function integrity(data, algo = 'sha384') {
  const name = ALGOS[algo];
  if (!name) throw new Error(`[spark-sri] unknown algorithm "${algo}"`);
  const digest = await subtle().digest(name, toBytes(data));
  return `${algo}-${b64(digest)}`;
}

/**
 * Verify data against an SRI string. Like the platform, a space-separated
 * list is accepted and ANY match passes.
 * @returns {Promise<boolean>}
 */
export async function verify(data, integrityString) {
  if (!integrityString) return false;
  for (const token of String(integrityString).trim().split(/\s+/)) {
    const algo = token.slice(0, token.indexOf('-'));
    if (!ALGOS[algo]) continue;
    if ((await integrity(data, algo)) === token) return true;
  }
  return false;
}

// ── runtime fetch guard ─────────────────────────────────────────────────

function readInlineManifest() {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('script[type="application/json"][data-spark-sri]');
  if (!el) return null;
  try { return JSON.parse(el.textContent); } catch { return null; }
}

function loadTofu() {
  try { return JSON.parse(localStorage.getItem(TOFU_KEY)) || {}; } catch { return {}; }
}
function saveTofu(map) {
  try { localStorage.setItem(TOFU_KEY, JSON.stringify(map)); } catch { /* private mode etc. */ }
}

function isLocalhost() {
  if (typeof location === 'undefined') return true;
  return ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
}

function hostAllowed(host, allow) {
  return allow.some((a) => host === a || host.endsWith('.' + a));
}

function blockedResponse(reason) {
  return new Response(`/* blocked by spark-html-sri: ${reason} */`, {
    status: 424,
    statusText: 'integrity check failed',
  });
}

/**
 * Install the integrity guard around `fetch`. Call once from main.js,
 * BEFORE mount()/router() so component fetches flow through it.
 *
 * - Same-origin URLs listed in the manifest are hash-verified.
 * - Cross-origin `.html` component imports must come from an allowed
 *   origin and (after the first load) keep hashing the same (TOFU).
 * - Everything else — your API calls, images, other origins' JSON —
 *   passes through untouched.
 *
 * @param {object} [options]
 * @param {Record<string,string>} [options.manifest] path → SRI string. Default: the
 *   manifest the vite plugin baked into the page (absent in dev — nothing to verify).
 * @param {string[]} [options.allow] Allowed remote hosts for URL imports
 *   (default: jsdelivr/unpkg/esm.sh/raw.githubusercontent — subdomains included).
 * @param {boolean|'auto'} [options.enforce='auto'] Block on failure. 'auto'
 *   enforces everywhere except localhost (fail open in dev).
 * @param {(msg: string, url: string) => void} [options.onViolation] Observe failures.
 * @returns {() => void} restore the original fetch.
 */
export function sri(options = {}) {
  if (typeof globalThis.fetch !== 'function') return () => {};
  const manifest = options.manifest || readInlineManifest() || {};
  const allow = options.allow || DEFAULT_ALLOW;
  const enforce = options.enforce === 'auto' || options.enforce === undefined
    ? !isLocalhost()
    : !!options.enforce;

  const violate = (msg, url) => {
    console[enforce ? 'error' : 'warn'](`[spark-sri] ${msg} — ${url}${enforce ? '' : ' (dev: allowed)'}`);
    if (options.onViolation) { try { options.onViolation(msg, url); } catch { /* observer only */ } }
  };

  const origFetch = globalThis.fetch;
  const tofu = loadTofu();

  const guarded = async function (input, init) {
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const rawUrl = typeof input === 'string' ? input : (input && input.url) || String(input);
    let url;
    try { url = new URL(rawUrl, typeof location !== 'undefined' ? location.href : undefined); } catch { url = null; }
    if (!url || method !== 'GET' || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      return origFetch.call(this, input, init);
    }

    const sameOrigin = typeof location === 'undefined' || url.origin === location.origin;

    // Same-origin: verify only what the build manifest covers.
    if (sameOrigin) {
      const expected = manifest[url.pathname];
      if (!expected) return origFetch.call(this, input, init);
      const res = await origFetch.call(this, input, init);
      if (!res.ok) return res;
      const bytes = new Uint8Array(await res.clone().arrayBuffer());
      if (await verify(bytes, expected)) return res;
      violate('integrity mismatch (build manifest)', url.href);
      return enforce ? blockedResponse('integrity mismatch') : res;
    }

    // Cross-origin: only component imports (.html) are governed.
    if (!url.pathname.endsWith('.html')) return origFetch.call(this, input, init);

    if (!hostAllowed(url.hostname, allow)) {
      violate(`origin "${url.hostname}" is not in the allow list`, url.href);
      if (enforce) return blockedResponse(`origin ${url.hostname} not allowed`);
      return origFetch.call(this, input, init);
    }

    const res = await origFetch.call(this, input, init);
    if (!res.ok) return res;
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    const known = tofu[url.href];
    if (!known) {
      // Trust on first use — remember what this URL looked like.
      tofu[url.href] = await integrity(bytes);
      saveTofu(tofu);
      return res;
    }
    if (await verify(bytes, known)) return res;
    violate('remote component changed since first use (TOFU mismatch)', url.href);
    return enforce ? blockedResponse('TOFU mismatch') : res;
  };

  globalThis.fetch = guarded;
  return () => {
    if (globalThis.fetch === guarded) globalThis.fetch = origFetch;
  };
}

/** Forget every remembered remote-component hash (TOFU store). */
export function resetTofu() {
  try { localStorage.removeItem(TOFU_KEY); } catch { /* ignore */ }
}

export default { sri, integrity, verify, resetTofu, DEFAULT_ALLOW };
