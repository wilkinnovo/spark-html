/**
 * spark-html-manifest — PWA setup from a single config.
 *
 * name, icons, colors, display mode in one place; the bun build step turns it
 * into manifest.webmanifest + resized icons + the <head> tags + (optionally)
 * a minimal app-shell service worker. No manual icon exports, no copy-paste
 * boilerplate.
 *
 *   // spark.config.js
 *   import manifest from 'spark-html-manifest/bun';
 *   plugins: [spark(), prerender(), manifest({
 *     name: 'My App',
 *     themeColor: '#ffd24a',
 *     icon: 'public/icon.png',   // one source image → 192 + 512 (+ maskable)
 *     offline: true,             // minimal cache-first app-shell worker
 *   })]
 *
 * This module is the pure half — config in, JSON/HTML/worker-source out —
 * so it runs anywhere (tests, custom builds, the website playground).
 */

/** Default generated icon sizes (px, square). */
export const ICON_SIZES = [192, 512];

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';

/** File name for a generated icon: icons/<slug>-192.png */
export function iconPath(config, size) {
  return `icons/${slug(config.shortName || config.name || 'app')}-${size}.png`;
}

/**
 * Build the manifest object from one config.
 *
 * @param {object} config
 * @param {string}  config.name           App name (required).
 * @param {string}  [config.shortName]    Home-screen label (default: name).
 * @param {string}  [config.description]
 * @param {string}  [config.themeColor='#ffffff']
 * @param {string}  [config.backgroundColor=themeColor]
 * @param {string}  [config.display='standalone']  'standalone' | 'browser' | 'minimal-ui' | 'fullscreen'
 * @param {string}  [config.startUrl='.']
 * @param {string}  [config.scope]
 * @param {string}  [config.lang]
 * @param {string}  [config.orientation]
 * @param {number[]}[config.sizes]        Generated icon sizes (default [192, 512]).
 * @param {object[]}[config.icons]        Explicit icons array — skips generation entirely.
 * @param {object}  [config.extra]        Merged verbatim into the manifest (shortcuts, screenshots, …).
 */
export function manifestJson(config) {
  if (!config || !config.name) throw new Error('[spark-manifest] config.name is required');
  const theme = config.themeColor || '#ffffff';
  const icons = config.icons || (config.sizes || ICON_SIZES).map((size) => ({
    src: iconPath(config, size),
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose: 'any',
  }));
  const out = {
    name: config.name,
    short_name: config.shortName || config.name,
    start_url: config.startUrl || '.',
    display: config.display || 'standalone',
    theme_color: theme,
    background_color: config.backgroundColor || theme,
    icons,
  };
  if (config.description) out.description = config.description;
  if (config.scope) out.scope = config.scope;
  if (config.lang) out.lang = config.lang;
  if (config.orientation) out.orientation = config.orientation;
  return { ...out, ...(config.extra || {}) };
}

/**
 * The <head> block: manifest link + theme-color meta (+ apple touch icon
 * when icons exist, + worker registration when offline is on). Everything
 * carries data-spark-manifest so injection stays idempotent.
 *
 * @param {object} config  Same config as manifestJson.
 * @param {object} [opts]
 * @param {string} [opts.href='manifest.webmanifest']
 * @param {string} [opts.sw]  Worker URL — emits a registration script when set.
 */
export function manifestHtml(config, opts = {}) {
  const href = opts.href || 'manifest.webmanifest';
  const theme = config.themeColor || '#ffffff';
  const lines = [
    `<link rel="manifest" href="${href}" data-spark-manifest />`,
    `<meta name="theme-color" content="${theme}" data-spark-manifest />`,
  ];
  const icons = config.icons || (config.sizes || ICON_SIZES).map((s) => ({ src: iconPath(config, s), sizes: `${s}x${s}` }));
  const apple = icons.find((i) => /180x180/.test(i.sizes || '')) || icons[icons.length - 1];
  if (apple) lines.push(`<link rel="apple-touch-icon" href="${apple.src}" data-spark-manifest />`);
  if (opts.sw) {
    lines.push(
      `<script data-spark-manifest>if('serviceWorker' in navigator)addEventListener('load',function(){navigator.serviceWorker.register('${opts.sw}')})</script>`,
    );
  }
  return lines.join('\n');
}

/**
 * Minimal app-shell service worker (source string): precaches the shell at
 * install; hash-named assets (immutable) are served cache-first; everything
 * else same-origin is network-first with cache fallback — so the app opens
 * offline but is never a deploy behind while online.
 *
 * @param {object} [options]
 * @param {string[]} [options.shell=['./', 'manifest.webmanifest']] URLs to precache.
 * @param {string}   [options.version='1'] Bump to invalidate old caches.
 */
export function swSource(options = {}) {
  const shell = JSON.stringify(options.shell || ['./', 'manifest.webmanifest']);
  const cache = JSON.stringify(`spark-manifest-v${options.version || '1'}`);
  return `/* generated by spark-html-manifest — offline app shell */
'use strict';
var CACHE = ${cache};
var SHELL = ${shell};

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return cache.addAll(SHELL);
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return k !== CACHE && k.indexOf('spark-manifest-') === 0;
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  // The build's hash-named assets are immutable — cache-first is always correct.
  var immutable = /\\/assets\\/[^/]*[-.][A-Za-z0-9_-]{8,}\\.\\w+$/.test(url.pathname);
  event.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: req.mode === 'navigate' }).then(function (cached) {
      if (cached && immutable) return cached;
      // Network-first keeps pages/components fresh; cache is the offline net.
      return fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () {
        if (cached) return cached;
        if (req.mode === 'navigate') return cache.match('./');
        return new Response('', { status: 504, statusText: 'offline' });
      });
    });
  }));
});
`;
}

export default { manifestJson, manifestHtml, swSource, iconPath, ICON_SIZES };
