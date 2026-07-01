/**
 * spark-prerender — a friendly SEO interface for spark-html.
 *
 * Build-time prerender: make a client-rendered Spark page indexable by
 * crawlers with no rewrite, no SSR server, and no app-code changes.
 *
 * The one important idea (see spark-prerender-design.md §2): this is NOT a
 * second renderer. We set up a server DOM (linkedom) + the few globals the
 * runtime expects, run the REAL `mount()`, let the component tree settle,
 * then serialize `document`. One renderer, one source of truth, zero drift.
 */
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { parseHTML } from 'linkedom';

// A component request is a relative `*.html` (the runtime always appends
// `.html`); an absolute URL is a DATA request and is delegated elsewhere.
function isComponentRequest(reqPath) {
  const p = String(reqPath).split(/[?#]/)[0];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return false; // http(s)://, etc.
  return p.endsWith('.html');
}

// Spark fetches a component as `fetch("components/x.html")`; on the server we
// read that from disk. Try each configured root; return its text, or null.
async function tryReadComponentFile(reqPath, roots) {
  let rel = String(reqPath).split(/[?#]/)[0].replace(/^\/+/, '');
  for (const root of roots) {
    const file = join(root, rel);
    try {
      await access(file);
      return await readFile(file, 'utf8');
    } catch {
      /* try the next root */
    }
  }
  return null;
}

// Run `fn` with `globalThis[k] = values[k]`, restoring the previous values
// after — so prerendering many pages in one process doesn't leak globals.
async function withGlobals(values, fn) {
  const keys = Object.keys(values);
  const prev = {};
  const had = {};
  for (const k of keys) { had[k] = k in globalThis; prev[k] = globalThis[k]; globalThis[k] = values[k]; }
  try {
    return await fn();
  } finally {
    for (const k of keys) { if (had[k]) globalThis[k] = prev[k]; else delete globalThis[k]; }
  }
}

// A microtask turn — lets queued patches (queueMicrotask(flush)) run.
const microtaskTurn = () => new Promise((r) => queueMicrotask(r));

// Components often touch browser-only globals at script top level
// (matchMedia, localStorage, IntersectionObserver…). On the server those are
// absent, so the script would throw and the component would degrade to empty.
// Stub the common ones (no-ops / in-memory) so more components prerender.
// Opt out with `stubBrowserGlobals: false`, or extend via `stubs`.
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => void m.set(String(k), String(v)),
    removeItem: (k) => void m.delete(String(k)),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}
function makeBrowserStubs() {
  const NoopObserver = class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  return {
    matchMedia: (q) => ({
      matches: false, media: String(q || ''), onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    }),
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    IntersectionObserver: NoopObserver,
    ResizeObserver: NoopObserver,
    requestIdleCallback: (fn) => { try { fn({ didTimeout: false, timeRemaining: () => 0 }); } catch { /* ignore */ } return 0; },
    cancelIdleCallback: () => {},
    scrollTo: () => {}, scroll: () => {},
  };
}

// Default metadata convention: read these off component scopes, write them
// into <head>. `kind:'title'` → <title>; `name`/`property` → a <meta>.
const DEFAULT_META = [
  { var: 'pageTitle', kind: 'title' },
  { var: 'pageDescription', name: 'description' },
  { var: 'ogTitle', property: 'og:title' },
  { var: 'ogDescription', property: 'og:description' },
  { var: 'ogImage', property: 'og:image' },
];

function upsertMeta(document, attr, key, value) {
  let el = document.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', value);
}

// Read designated vars off every booted component's scope (first defined
// wins, in DOM order) and inject them into <head>. No export, no special API.
function injectMetadata(document, metaMap) {
  const hosts = [...document.querySelectorAll('[name]')].filter((h) => h.__sparkScope);
  const read = (varName) => {
    for (const h of hosts) {
      let v;
      try { v = h.__sparkScope[varName]; } catch { v = undefined; }
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };
  for (const m of metaMap) {
    const value = read(m.var);
    if (value === undefined) continue;
    const str = String(value);
    if (m.kind === 'title') {
      let title = document.querySelector('title');
      if (!title) { title = document.createElement('title'); document.head.appendChild(title); }
      title.textContent = str;
    } else if (m.name) {
      upsertMeta(document, 'name', m.name, str);
    } else if (m.property) {
      upsertMeta(document, 'property', m.property, str);
    }
  }
}

// Make the prerendered DOM re-resolvable by a client `mount()`: write the
// import path back onto each TOP-LEVEL component host (keeping its `name` and
// rendered content). On the client, `resolveImports` finds the `[import]`,
// re-fetches the component, and renders over the prerendered markup — so a
// real browser takes over cleanly instead of finding a script-less host and
// blanking. Nested hosts are left alone: they're rebuilt when their parent
// re-resolves. Disable with `hydratable: false` for pure-static output.
// Serialize a coerced prop value back to an attribute string that round-trips
// through the runtime's coerce(): '' = true, JSON for objects/arrays, etc.
function serializeProp(v) {
  if (v === true) return '';
  if (v === false) return 'false';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

function makeHydratable(document) {
  const hosts = [...document.querySelectorAll('[name]')].filter((h) => h.__sparkImportPath);
  for (const host of hosts) {
    let p = host.parentNode;
    let nested = false;
    while (p) { if (p.__sparkImportPath) { nested = true; break; } p = p.parentNode; }
    if (nested) continue;

    host.setAttribute('import', host.__sparkImportPath);

    // Props: write them back as attributes so the client re-resolve gets them
    // (class/id are already real attributes on the host).
    const props = host.__sparkProps;
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class' || k === 'id') continue;
        try { host.setAttribute(k, serializeProp(v)); } catch { /* skip bad name */ }
      }
    }

    // Slots: re-emit the caller's original slot content (stashed by the runtime
    // during prerender) into an inert <template> the client reads on hydration.
    const slotted = host.__sparkSlotted;
    if (slotted && slotted.length) {
      const tpl = document.createElement('template');
      tpl.setAttribute('data-spark-slots', '');
      tpl.innerHTML = slotted.map((n) => n.outerHTML ?? n.textContent ?? '').join('');
      host.appendChild(tpl);
    }
  }
}

function serialize(document) {
  let html = document.toString();
  if (!/^\s*<!doctype/i.test(html)) html = '<!DOCTYPE html>\n' + html;
  return html;
}

/**
 * Prerender a single entry HTML file to a fully-rendered HTML string.
 *
 * @param {string} entryPath  Path to the entry .html (e.g. dist/index.html).
 * @param {object} [options]
 * @param {string} [options.root]            Base dir for resolving components.
 *                                           Defaults to the entry file's dir.
 * @param {string[]} [options.componentRoots] Explicit dirs to resolve
 *                                           `import="components/x"` against.
 * @param {Array} [options.meta]             Metadata mapping (see DEFAULT_META).
 * @param {number} [options.maxPasses]       Settle-loop safety cap (default 100).
 * @param {boolean} [options.hydratable=true] Write the import path back onto
 *                                           top-level hosts so a client mount
 *                                           re-renders over the output (no
 *                                           blank). Set false for pure-static.
 * @param {Function} [options.fetch]         Fetch used for NON-component (data)
 *                                           requests a `load()` hook makes —
 *                                           point it at fixtures or a local API.
 *                                           Defaults to the real global fetch.
 * @param {boolean} [options.stubBrowserGlobals=true] Stub matchMedia,
 *                                           localStorage, IntersectionObserver,
 *                                           etc. so components that touch them
 *                                           prerender instead of degrading.
 * @param {object} [options.stubs]           Extra/override global stubs.
 * @returns {Promise<string>} the prerendered HTML.
 */
export async function prerender(entryPath, options = {}) {
  const entryAbs = resolve(entryPath);
  const baseRoot = options.root ? resolve(options.root) : dirname(entryAbs);
  const roots = (options.componentRoots || [
    baseRoot,
    join(baseRoot, 'public'),
    join(baseRoot, 'dist'),
    dirname(entryAbs),
  ]).filter((v, i, a) => a.indexOf(v) === i);
  const metaMap = options.meta || DEFAULT_META;
  const maxPasses = options.maxPasses ?? 100;
  // For data requests a load() hook makes (not component files).
  const dataFetch = options.fetch || globalThis.fetch;

  const source = await readFile(entryAbs, 'utf8');
  const { window, document } = parseHTML(source);
  // mount() awaits DOMContentLoaded only when readyState === 'loading'.
  try { if (document.readyState === 'loading') document.readyState = 'complete'; } catch { /* read-only is fine */ }

  // Routed page (spark-html-router): activate the requested route by cloning
  // the matching <template route> content into an outlet the client adopts
  // (data-spark-route → no flash). mount() below resolves its imports.
  if (options.route != null) {
    const want = normalizeRoute(options.route);
    const templates = [...document.querySelectorAll('template[route]')];
    let matched = null;
    let fallback = null;
    for (const t of templates) {
      const r = t.getAttribute('route');
      if (r === '*') { fallback = t; continue; }
      if (normalizeRoute(r) === want) { matched = t; break; }
    }
    matched = matched || fallback;
    if (matched) {
      const outlet = document.createElement('div');
      outlet.setAttribute('data-spark-route', want);
      for (const child of [...matched.content.childNodes]) {
        outlet.appendChild(child.cloneNode(true));
      }
      matched.after(outlet);
    }
  }

  // Isolate every <template route> while we mount. Real browsers never let
  // querySelectorAll('[import]') descend into <template> content, but linkedom
  // versions differ — and an un-isolated template would have its imports
  // resolved, leaking other routes' content into this file (about.html showing
  // the home page). Swap each template for a comment marker now (positions
  // preserved), then restore it before serialize so the client router can
  // still clone it for SPA navigation.
  const parkedTemplates = [];
  for (const t of [...document.querySelectorAll('template[route]')]) {
    const marker = document.createComment('spark-route');
    t.replaceWith(marker);
    parkedTemplates.push([marker, t]);
  }
  const restoreTemplates = () => {
    for (const [marker, t] of parkedTemplates) marker.replaceWith(t);
    parkedTemplates.length = 0;
  };

  // Timer handling during prerender. A component that starts a repeating
  // setInterval in onMount would keep the build process alive forever, so we
  // no-op intervals (they're live-only — no value at build time). But
  // setTimeout is left REAL: undici (Node's fetch/WebSocket) drives its own
  // timeouts through setTimeout and expects a real Timer back — an earlier
  // stub that returned `0` crashed it (`fastNowTimeout?.unref is not a
  // function`). We just `.unref()` each timeout so a component's pending
  // setTimeout can't hold the process open past serialization.
  const realSetTimeout = globalThis.setTimeout;
  const fakeTimer = {
    ref() { return this; }, unref() { return this; },
    hasRef() { return false; }, refresh() { return this; }, close() {},
    [Symbol.toPrimitive]() { return 0; },
  };
  const timerStubs = {
    setInterval: () => fakeTimer,
    clearInterval: () => {},
    setTimeout: (fn, ms, ...args) => {
      const t = realSetTimeout(fn, ms, ...args);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    },
    // clearTimeout stays real (left off the stub list so undici can clear).
  };
  // Browser-feature stubs (matchMedia, localStorage, …) — only fill what's
  // absent so any real linkedom implementation is preserved.
  const featureStubs = options.stubBrowserGlobals === false
    ? {}
    : { ...makeBrowserStubs(), ...(options.stubs || {}) };
  // Only force feature stubs onto `window` — NOT the timer stubs. linkedom's
  // window writes timer setters straight through to globalThis, so setting
  // window.setTimeout here (before withGlobals captures the real one) would
  // make withGlobals stash the stub as "previous" and never restore the real
  // setTimeout — breaking all timers (and undici) after a prerender. The
  // timer stubs reach both bare and window.* calls via withGlobals + that same
  // write-through, and are correctly restored.
  for (const [k, v] of Object.entries(featureStubs)) {
    if (window[k] === undefined) { try { window[k] = v; } catch { /* read-only */ } }
  }
  const stubs = { ...featureStubs, ...timerStubs };

  // ── Drainable rAF: bootComponent defers its reveal + onMount here. We run
  //    these synchronously between settle passes instead of on a frame timer.
  let rafQueue = [];
  const requestAnimationFrame = (fn) => rafQueue.push(fn);
  const drainRaf = () => {
    const q = rafQueue; rafQueue = [];
    for (const fn of q) { try { fn(); } catch (e) { console.warn('[spark-prerender] rAF callback threw:', e.message); } }
    return q.length;
  };

  // ── fetch override. Component imports (relative *.html) are read from disk;
  //    anything else is a DATA request (from a load() hook) and is delegated
  //    to options.fetch / the real fetch. In-flight reads are tracked so the
  //    settle loop knows when work has drained.
  const pending = new Set();
  const fetch = (reqPath, init) => {
    const p = (async () => {
      if (isComponentRequest(reqPath)) {
        const text = await tryReadComponentFile(reqPath, roots);
        return text != null
          ? { ok: true, status: 200, text: async () => text }
          : { ok: false, status: 404, text: async () => '' };
      }
      if (typeof dataFetch !== 'function') return { ok: false, status: 404, text: async () => '' };
      return dataFetch(reqPath, init);
    })();
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  };

  // Collector for <template await> promises. The runtime pushes each pending
  // promise here during prerender; the settle loop drains + awaits them (like
  // load()) so :then content lands in the serialized HTML.
  const awaits = [];

  return withGlobals(
    { window, document, Node: window.Node, requestAnimationFrame, fetch, __SPARK_PRERENDER__: true, __SPARK_AWAITS__: awaits, ...stubs },
    async () => {
      // Import the runtime FRESH per page (cache-busted) so its module-load
      // cloak + caches bind to THIS document, and pages stay isolated.
      const url = import.meta.resolve('spark-html');
      const spark = await import(url + '?prerender=' + Math.random().toString(36).slice(2));

      // ── Settle loop (design §5): the tree expands in waves — rAF reveals,
      //    and imports inside each/if resolve asynchronously, fetching more
      //    children, AND an import inside a template if/each boots in a `.then`
      //    callback after its fetch. If we stop while one of those is still
      //    queued, it would run after withGlobals tears the globals down
      //    (document/requestAnimationFrame undefined). So drain microtasks
      //    thoroughly and require TWO consecutive fully-idle passes before
      //    declaring the tree quiet.
      const settle = async () => {
        let idle = 0;
        for (let pass = 0; pass < maxPasses; pass++) {
          const drained = drainRaf();
          const hadPending = pending.size > 0;
          if (hadPending) await Promise.all([...pending]);
          // Drain <template await> promises: wait for the batch to settle so
          // their :then/:catch content renders (settles may queue more rAF /
          // fetches / awaits, which the next pass picks up).
          const hadAwaits = awaits.length > 0;
          if (hadAwaits) await Promise.allSettled(awaits.splice(0));
          for (let t = 0; t < 4; t++) await microtaskTurn();
          const quiet = drained === 0 && !hadPending && !hadAwaits
            && pending.size === 0 && rafQueue.length === 0 && awaits.length === 0;
          if (quiet) { if (++idle >= 2) break; } else { idle = 0; }
        }
      };

      await spark.mount(document.body);
      await settle();

      // ── Phase 2: awaitable data hook. A component may declare an async
      //    `load()` that fetches API data and assigns it to state. We call
      //    every load() (data fetches go through the delegate above), await
      //    them, then re-settle so the loaded content renders into the HTML.
      //    Phase 1 is unchanged — components without load() never run extra
      //    work, and load() is a plain function, not a special API.
      const loaders = [];
      for (const host of document.querySelectorAll('[name]')) {
        const fn = host.__sparkScope && host.__sparkScope.load;
        if (typeof fn === 'function') loaders.push(fn);
      }
      if (loaders.length) {
        await Promise.all(
          loaders.map(async (fn) => {
            try { await fn(); } catch (e) { console.warn('[spark-prerender] load() threw:', e.message); }
          }),
        );
        await settle();
      }

      // Restore the parked <template route> blocks so the client router can
      // clone them for SPA navigation to the other routes.
      restoreTemplates();

      injectMetadata(document, metaMap);
      if (options.hydratable !== false) makeHydratable(document);
      return serialize(document);
    },
  );
}

// ─── Routes (spark-html-router) ────────────────────────────────────────

// Normalize a route to a no-trailing-slash key ("/" stays "/").
function normalizeRoute(p) {
  let s = String(p || '/');
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s || '/';
}

// The concrete routes declared by <template route> in an entry's HTML
// (the catch-all "*" is excluded — it has no own URL to prerender).
export function routesOf(html) {
  const { document } = parseHTML(html);
  return [...document.querySelectorAll('template[route]')]
    .map((t) => t.getAttribute('route'))
    // Skip the catch-all and DYNAMIC routes (`/blog/:id`) — their params aren't
    // known at build time, so they're rendered on the client (the SPA fallback
    // / catch-all serves them). Concrete routes prerender as usual.
    .filter((r) => r && r !== '*' && !r.includes(':'))
    .map(normalizeRoute);
}

// Map a route to the static file it should be written as.
//   "/" -> "index.html", "/about" -> "about.html", "/a/b" -> "a/b.html"
export function routeToFile(route) {
  const r = normalizeRoute(route);
  if (r === '/') return 'index.html';
  return r.replace(/^\//, '') + '.html';
}

// Host rewrite rules so /about serves about.html, with an index.html SPA
// fallback for anything unmatched (the client router shows the catch-all).
export function redirectsFor(routes) {
  const lines = routes
    .filter((r) => normalizeRoute(r) !== '/')
    .map((r) => `${normalizeRoute(r)}  ${'/' + routeToFile(r)}  200`);
  lines.push('/*  /index.html  200');
  return lines.join('\n') + '\n';
}

export function vercelConfigFor(routes) {
  const rewrites = routes
    .filter((r) => normalizeRoute(r) !== '/')
    .map((r) => ({ source: normalizeRoute(r), destination: '/' + routeToFile(r) }));
  rewrites.push({ source: '/(.*)', destination: '/index.html' });
  return JSON.stringify({ rewrites }, null, 2) + '\n';
}

export default { prerender, routesOf, routeToFile, redirectsFor, vercelConfigFor };
