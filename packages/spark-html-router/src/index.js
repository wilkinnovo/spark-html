/**
 * spark-html-router — declarative client routing for spark-html.
 *
 * Author routes as inert <template route> blocks (the runtime never descends
 * into <template> content, so they're invisible to mount()), then call
 * router() once. It:
 *
 *   • mounts the page (chrome + the active route) a SINGLE time — no flash,
 *     no double-boot, onMount fires exactly once per component;
 *   • adopts a prerendered route outlet in place (spark-prerender bakes the
 *     active route as <div data-spark-route> — the runtime hydrates over it);
 *   • intercepts same-origin <a> clicks for SPA navigation and tracks
 *     Back/Forward;
 *   • exposes a reactive `route` store ({ path }) so nav links, titles, and
 *     analytics can react to the current route with `useStore('route')`.
 *
 *   <template route="/">       <div import="components/home"></div>   </template>
 *   <template route="/about">  <div import="components/about"></div>  </template>
 *   <template route="*">       <div import="components/not-found"></div></template>
 *
 *   import { router } from 'spark-html-router';
 *   router();                       // that's it
 *
 *   // anywhere, to highlight the active link:
 *   const route = useStore('route');
 *   $: active = route.path === '/about';
 */
import { mount, unmount, store } from 'spark-html';

let base = '';
let rootEl = null;
let chain = [];        // outlet chain (outer→inner) for nested routes/layouts
let routeProxy = null; // the reactive `route` store proxy
let started = false;

// Normalize a pathname to a base-stripped, no-trailing-slash route key.
function normalize(pathname) {
  let p = String(pathname || '/');
  if (base && p.startsWith(base)) p = p.slice(base.length);
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

function currentPath() {
  return normalize((typeof location !== 'undefined' && location.pathname) || '/');
}

// Publish the active path + params to the reactive `route` store so any
// component can `useStore('route')` and react (nav highlight, title, params…).
// Created here BEFORE the first mount so components find it on boot.
function setRoute(path, params) {
  if (!routeProxy) routeProxy = store('route', { path, params: params || {} });
  routeProxy.path = path;
  routeProxy.params = params || {};
}

// Reflect the active route onto same-origin <a> links: set aria-current="page"
// on links whose href matches the current path, clear it on the rest. Lets a
// nav highlight the active link with pure CSS — `a[aria-current="page"]` — and
// no per-link `useStore('route')` wiring. Runs after each render.
function markActiveLinks() {
  if (!rootEl || !rootEl.querySelectorAll) return;
  const path = currentPath();
  for (const a of rootEl.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    let match = false;
    // Skip external schemes and in-page anchors (#hash, or same-route + hash) —
    // those aren't route links and shouldn't be marked aria-current.
    if (href && !/^[a-z]+:/i.test(href) && href[0] !== '#') {
      try {
        const u = new URL(href, location.href);
        if (u.origin === location.origin && !(u.hash && normalize(u.pathname) === path)) {
          match = normalize(u.pathname) === path;
        }
      } catch { /* malformed href — not active */ }
    }
    if (match) a.setAttribute('aria-current', 'page');
    else if (a.getAttribute('aria-current') === 'page') a.removeAttribute('aria-current');
  }
}

// ── Matching (supports nested routes) ─────────────────────────────────
// The <template route> at a nesting level: route templates of `container` whose
// nearest enclosing outlet IS that container — so a rendered child outlet's
// (cloned) templates don't leak up to the parent level.
function closestOutlet(el) {
  let n = el.parentNode;
  while (n && n !== rootEl) {
    if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-spark-route')) return n;
    n = n.parentNode;
  }
  return null;
}
function templatesAt(container) {
  const owner = container === rootEl ? null : container;
  return [...container.querySelectorAll('template[route]')].filter((t) => closestOutlet(t) === owner);
}

// Resolve the best <template route> for `path` at ONE level (inside `container`).
// Precedence: exact > dynamic (`:param`, full match) > longest LAYOUT prefix (a
// route that's an ancestor of the path AND contains nested routes) > catch-all.
// Returns { tpl, params } or null.
function resolveIn(container, path) {
  const templates = templatesAt(container);
  const segs = path.split('/').filter(Boolean);
  let dynamic = null, prefix = null, prefixLen = -1, fallback = null;
  for (const t of templates) {
    const r = t.getAttribute('route');
    if (r === '*') { if (!fallback) fallback = t; continue; }
    const rp = normalize(r);
    if (rp === path) return { tpl: t, params: {} }; // exact — wins
    if (rp.includes(':') && !dynamic) {
      const rsegs = rp.split('/').filter(Boolean);
      if (rsegs.length === segs.length) {
        const params = {}; let ok = true;
        for (let i = 0; i < rsegs.length; i++) {
          if (rsegs[i][0] === ':') {
            try { params[rsegs[i].slice(1)] = decodeURIComponent(segs[i]); }
            catch { params[rsegs[i].slice(1)] = segs[i]; }
          } else if (rsegs[i] !== segs[i]) { ok = false; break; }
        }
        if (ok) dynamic = { tpl: t, params };
      }
    }
    // Layout prefix: an ancestor route that itself contains nested routes.
    if (rp !== '/' && rp !== path && path.startsWith(rp + '/') && rp.length > prefixLen
        && t.content && t.content.querySelector && t.content.querySelector('template[route]')) {
      prefix = { tpl: t, params: {} }; prefixLen = rp.length;
    }
  }
  return dynamic || prefix || (fallback ? { tpl: fallback, params: {} } : null);
}

function sameParams(a, b) {
  const ak = Object.keys(a || {}), bk = Object.keys(b || {});
  return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
}

// Build/adopt the outlet chain for `path`. Parent layouts that still match are
// REUSED (kept-alive — their state survives child navigation); the chain is
// rebuilt from the first level that diverges. Returns the shallowest newly-built
// outlet to mount (or null if everything was reused / adopted).
function renderChain(path, adopt) {
  let container = rootEl;
  const next = [];
  const allParams = {};
  let diverged = false;
  let firstNew = null;

  for (let depth = 0; ; depth++) {
    const m = resolveIn(container, path);
    if (!m) break;
    Object.assign(allParams, m.params);

    const prev = diverged ? null : chain[depth];
    if (prev && prev.tpl === m.tpl && sameParams(prev.params, m.params) && prev.outlet.isConnected) {
      next.push(prev);
      container = prev.outlet;
      continue;
    }

    // Divergence — tear down the old chain from this depth down (deepest first).
    if (!diverged) {
      for (let i = chain.length - 1; i >= depth; i--) {
        const o = chain[i] && chain[i].outlet;
        if (o && o.parentNode) { unmount(o); o.remove(); }
      }
      diverged = true;
    }

    let outlet = null;
    if (depth === 0 && adopt) {
      const baked = rootEl.querySelector('[data-spark-route]');
      if (baked && normalize(baked.getAttribute('data-spark-route')) === path) outlet = baked; // adopt prerender
      else if (baked) baked.remove();
    }
    if (!outlet) {
      outlet = document.createElement('div');
      outlet.setAttribute('data-spark-route', path);
      for (const c of [...m.tpl.content.childNodes]) outlet.appendChild(c.cloneNode(true));
      m.tpl.after(outlet);
      if (!firstNew) firstNew = outlet;
    }
    next.push({ tpl: m.tpl, params: m.params, outlet });
    container = outlet;
  }

  // Nothing diverged but the new chain is shorter → drop trailing old outlets.
  if (!diverged) {
    for (let i = chain.length - 1; i >= next.length; i--) {
      const o = chain[i] && chain[i].outlet;
      if (o && o.parentNode) { unmount(o); o.remove(); }
    }
  }

  chain = next;
  setRoute(path, allParams);
  return firstNew;
}

// Initial render — build/adopt the chain in the DOM; the single mount(rootEl) in
// router() boots it (an adopted top outlet hydrates; built outlets resolve).
function prepareInitial() {
  renderChain(currentPath(), true);
}

// SPA navigation — rebuild only the diverging part of the chain, then mount the
// shallowest new outlet (which cascades to any nested new outlets). Reused
// parent layouts keep their state.
async function render(opts = {}) {
  const firstNew = renderChain(currentPath(), false);
  if (firstNew) await mount(firstNew, { quiet: true });
  markActiveLinks();
  // Back/Forward (popstate) restores scroll itself and shouldn't yank focus;
  // only a forward navigation resets scroll + moves focus to the new view.
  if (!opts.isPop) afterNav(firstNew);
}

// a11y on navigation: send focus to the new view so screen readers announce it
// and keyboard users resume inside it (not stuck at the top of the old page),
// and reset scroll (to the #hash target if the URL has one, else to the top).
// Mark a custom focus target with [data-router-focus] (or [autofocus]).
function afterNav(firstNew) {
  if (typeof document === 'undefined') return;
  const view = firstNew || (chain.length ? chain[chain.length - 1].outlet : null);
  const hash = location.hash && location.hash.length > 1 ? location.hash : '';
  const hashEl = hash && document.querySelector ? document.querySelector(hash) : null;

  if (hashEl && hashEl.scrollIntoView) hashEl.scrollIntoView();
  else if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo(0, 0);

  const target =
    hashEl ||
    (view && view.querySelector && view.querySelector('[data-router-focus], [autofocus]')) ||
    view;
  if (!target || typeof target.focus !== 'function') return;
  // Make it programmatically focusable without adding it to the tab order, then
  // drop the temporary tabindex once focus leaves so the DOM stays clean.
  if (target.hasAttribute && !target.hasAttribute('tabindex')) {
    target.setAttribute('tabindex', '-1');
    if (target.addEventListener) {
      const clean = () => {
        target.removeAttribute && target.removeAttribute('tabindex');
        target.removeEventListener('blur', clean);
      };
      target.addEventListener('blur', clean);
    }
  }
  try {
    target.focus({ preventScroll: true }); // we already handled scroll above
  } catch {
    target.focus();
  }
}

// Navigate to a route programmatically (path is route-relative; base is added).
export function navigate(to) {
  const url = base + normalize(to);
  if (typeof history !== 'undefined') history.pushState({}, '', url);
  return render();
}

function onClick(e) {
  if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  let el = e.target;
  while (el && el.tagName !== 'A') el = el.parentNode;
  if (!el) return;
  const href = el.getAttribute('href');
  const target = el.getAttribute('target');
  if (!href || (target && target !== '_self') || el.hasAttribute('download') || /^[a-z]+:/i.test(href)) {
    return; // external scheme, new tab, or download — let the browser handle it
  }
  if (href[0] === '#') return; // in-page anchor (e.g. a docs TOC link) — native scroll
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return;
  // Same route + a hash → an in-page anchor on the current page; let the browser
  // scroll to it natively instead of hijacking it as a route navigation.
  if (url.hash && normalize(url.pathname) === currentPath()) return;
  e.preventDefault();
  history.pushState({}, '', url.pathname + url.search + url.hash);
  render();
}

/**
 * Start the router: mount the page (chrome + active route, once) and show the
 * route matching the URL, intercept same-origin <a> clicks for SPA navigation,
 * and track Back/Forward. Call it once instead of mount().
 *
 * @param {object} [options]
 * @param {string} [options.base]  Path prefix the app is served under (e.g.
 *                                 "/spark" on GitHub Pages). Stripped before
 *                                 matching; added back when navigating.
 * @param {string|Element} [options.root]  Mount root (default document.body).
 * @returns {Promise<void>}
 */
export async function router(options = {}) {
  if (started) return;
  started = true;
  base = options.base || '';
  if (base.length > 1 && base.endsWith('/')) base = base.slice(0, -1);
  rootEl = typeof options.root === 'string'
    ? document.querySelector(options.root)
    : options.root || document.body;

  if (typeof document !== 'undefined') document.addEventListener('click', onClick);
  if (typeof window !== 'undefined') window.addEventListener('popstate', () => render({ isPop: true }));

  prepareInitial();      // put the active route's outlet in the DOM (adopt/clone)
  await mount(rootEl, options);   // ONE mount: chrome + the active route, booted once
  markActiveLinks();     // highlight the matching <a> (aria-current="page")
}

export default { router, navigate };
