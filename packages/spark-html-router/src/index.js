/**
 * spark-router — declarative client routing for spark-html.
 *
 * Author routes as inert <template route> blocks (the core runtime ignores
 * them — querySelectorAll('[import]') doesn't descend into <template> content),
 * then call router() once. It mounts the page chrome, renders the route that
 * matches the URL, intercepts same-origin <a> clicks for SPA navigation, and
 * tracks Back/Forward.
 *
 *   <template route="/">       <div import="components/home"></div>   </template>
 *   <template route="/about">  <div import="components/about"></div>  </template>
 *   <template route="*">       <div import="components/not-found"></div></template>
 *
 *   import { router } from 'spark-router';
 *   router();                       // that's it
 */
import { mount, unmount } from 'spark-html';

let base = '';
let rootEl = null;
let active = null;     // the live outlet element for the current route
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

// Find the <template route> that matches `path`: exact match first, then a
// `route="*"` catch-all (404) if present.
function matchTemplate(path) {
  const templates = [...rootEl.querySelectorAll('template[route]')];
  let fallback = null;
  for (const t of templates) {
    const r = t.getAttribute('route');
    if (r === '*') { fallback = t; continue; }
    if (normalize(r) === path) return t;
  }
  return fallback;
}

// Render the route matching the current URL. Adopts prerendered route content
// in place (no flash) when it's already there; otherwise clones the template
// into a fresh outlet and mounts it.
async function render() {
  const path = currentPath();

  // Prerendered output marks the active route's content with data-spark-route.
  const prerendered = rootEl.querySelector(`[data-spark-route="${cssEscape(path)}"]`);
  if (prerendered && active === prerendered) return; // already showing it

  if (active && active !== prerendered) {
    unmount(active);
    active.remove();
    active = null;
  }

  if (prerendered) {
    // Adopt: the content is already in the DOM from prerender — just (re)boot
    // its components in place. The runtime hydrates over them without a flash.
    active = prerendered;
    await mount(prerendered);
    return;
  }

  const t = matchTemplate(path);
  if (!t) return; // no route + no catch-all → render nothing
  const outlet = document.createElement('div');
  outlet.setAttribute('data-spark-route', path);
  // Clone the template's children in (appendChild of a DocumentFragment is
  // unreliable across DOM impls).
  for (const child of [...t.content.childNodes]) outlet.appendChild(child.cloneNode(true));
  t.after(outlet);
  active = outlet;
  await mount(outlet);
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
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
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return;
  e.preventDefault();
  history.pushState({}, '', url.pathname + url.search + url.hash);
  render();
}

/**
 * Start the router: mount the page and show the route matching the URL.
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
  if (typeof window !== 'undefined') window.addEventListener('popstate', () => render());

  await mount(rootEl);   // boot the chrome (route templates stay inert)
  await render();        // show the active route
}

export default { router, navigate };
