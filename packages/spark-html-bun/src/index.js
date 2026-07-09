/**
 * spark-html-bun — dev server, build, and preview for spark-html apps,
 * built entirely on Bun. Replaces Vite with ~400 dependency-free lines.
 *
 *   // package.json scripts (spark-html-bun ships the `spark` bin)
 *   "dev":     "spark dev",
 *   "build":   "spark build",
 *   "preview": "spark preview"
 *
 *   // spark.config.js (optional — everything has a default)
 *   import prerender from 'spark-prerender/bun';
 *   import image from 'spark-html-image/bun';
 *   export default {
 *     base: '/',                 // deploy prefix (GH Pages: '/repo/')
 *     entry: 'index.html',
 *     outDir: 'dist',
 *     publicDir: 'public',
 *     componentsDir: 'components',
 *     pipeline: [prerender({ site: 'https://example.com' }), image()],
 *   };
 *
 * What each command does:
 *  • dev — Bun.serve over the project root + publicDir. Component fragments
 *    get Content-Type + no-cache (same two headers the Vite middleware set).
 *    Bare import specifiers resolve through an injected <script type=
 *    "importmap"> (built from the app's package.json dependencies, served
 *    from /@modules/<name>) — no bundling in dev at all, the browser runs
 *    your ES modules directly. Scoped component HMR rides a plain WebSocket
 *    (/__spark_hmr) + fs.watch: edit a component file and only its instances
 *    re-mount — fresh markup AND fresh scoped CSS — sibling state preserved
 *    (slotted/loop-managed hosts full-reload, always correct; a component not
 *    mounted on the current page is a no-op — fragments are no-cache, the next
 *    mount fetches it fresh). Stylesheet (.css) edits swap the matching <link>
 *    in place, no reload; page HTML / JS module edits full-reload. Broadcasts
 *    are debounced so editor save patterns (temp file + rename) send one update.
 *  • build — empty outDir, copy publicDir verbatim (components ship as
 *    authored), Bun.build the HTML entry (scripts/styles bundled + hashed
 *    under assets/, HTML rewritten, base honored via publicPath), then run
 *    the pipeline steps in order over outDir.
 *  • preview — static server over outDir with the same rewrites the deploy
 *    targets apply: exact file → path + '.html' (the _redirects convention)
 *    → 404.html.
 *
 * Pipeline step contract (what `spark-prerender/bun` etc. return):
 *   { name, run({ outDir, base, projectRoot }),        // build
 *     devRoutes?({ config }) → { '/path': { type, body() } },  // dev serving
 *     transformHtml?(html, { dev }) }                  // dev page injection
 */
import { join, resolve, dirname, extname, basename, sep } from 'node:path';
import { existsSync, watch, readdirSync, statSync, readFileSync } from 'node:fs';
import { rm, mkdir, cp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Resolve `rel` under `base` and refuse anything that escapes it — a static
// server must never serve outside its root. `..` is normalized away by the URL
// parser, but `decodeURIComponent` can reintroduce it (e.g. `%2e%2e%2f`), so
// the check runs on the final resolved path.
function safeJoin(base, rel) {
  const p = resolve(base, rel);
  return p === base || p.startsWith(base + sep) ? p : null;
}

// URL pathname, decoded — null on malformed percent-encoding (rejected as 400).
function decodePath(pathname) {
  try { return decodeURIComponent(pathname); } catch { return null; }
}

// One stat instead of existsSync + statSync — this runs per request candidate
// on the dev/preview hot path.
function isFile(p) {
  const s = statSync(p, { throwIfNoEntry: false });
  return s !== undefined && s.isFile();
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.txt': 'text/plain', '.xml': 'application/xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
};
const mime = (path) => MIME[extname(path).toLowerCase()] || 'application/octet-stream';

// ── config ──────────────────────────────────────────────────────────────

const DEFAULTS = {
  base: '/', entry: 'index.html', outDir: 'dist',
  publicDir: 'public', componentsDir: 'components', pipeline: [],
};

// Vite-compatible `import.meta.env` — replaced wholesale (object literal) so
// both `import.meta.env.BASE_URL` and the optional-chained `import.meta.env?.DEV`
// resolve. Dev serves raw modules to the browser (where import.meta.env is
// undefined), so we substitute at serve time; the build substitutes via
// Bun.build's `define`. Same object shape Vite exposes.
function envLiteral(config, dev) {
  return JSON.stringify({
    BASE_URL: config.base,
    DEV: dev,
    PROD: !dev,
    MODE: dev ? 'development' : 'production',
    SSR: false,
  });
}

/** Load spark.config.js from `root` (if present) and merge with defaults. */
export async function loadConfig(root = process.cwd(), overrides = {}) {
  let fileConfig = {};
  for (const name of ['spark.config.js', 'spark.config.mjs', 'spark.config.ts']) {
    const file = join(root, name);
    if (existsSync(file)) {
      fileConfig = (await import(file)).default || {};
      break;
    }
  }
  const config = { ...DEFAULTS, ...fileConfig, ...overrides, projectRoot: resolve(root) };
  let base = config.base || '/';
  if (!base.startsWith('/')) base = '/' + base;
  if (!base.endsWith('/')) base += '/';
  config.base = base;
  return config;
}

// ── dev ─────────────────────────────────────────────────────────────────

// The scoped-HMR client. The re-mount logic (unmount host → placeholder →
// re-mount; slotted/managed hosts full-reload) rides a plain WebSocket the
// dev server owns, instead of a bundler's HMR channel. Messages:
//   { name }   component fragment changed → re-mount its instances in place
//   { css }    stylesheet changed → swap the matching <link> (no reload)
//   { reload } page-level file changed → full reload
const HMR_CLIENT = `
import { mount, unmount } from 'spark-html';

// Swap a stylesheet in place: load the cache-busted copy alongside, remove the
// old one when it's ready — no flash of unstyled content.
function swapCss(path) {
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== path) continue;
    url.searchParams.set('t', Date.now());
    const next = link.cloneNode();
    next.href = url.pathname + url.search;
    next.onload = () => link.remove();
    link.after(next);
    console.log('[spark] ⚡ css-updated', path);
  }
}

async function update(name) {
  const hosts = [...document.querySelectorAll('[name="' + name + '"]')];
  // Not mounted right now (e.g. it lives on another route): nothing to do —
  // fragments are served no-cache, so the next mount fetches it fresh anyway.
  if (!hosts.length) return;
  // Scoped HMR only for simple top-level hosts; slotted or loop/if-managed
  // hosts fall back to a full reload so the result is always correct.
  if (hosts.some((h) => h.__sparkHadSlots || h.__sparkManaged)) { location.reload(); return; }
  try {
    // Drop the component's injected style so the re-mount installs the fresh
    // one (bootComponent dedupes by data-spark tag and would keep the stale CSS).
    const style = document.querySelector('style[data-spark="' + name + '"]');
    if (style) style.remove();
    for (const host of hosts) {
      const ph = document.createElement('div');
      ph.setAttribute('import', host.__sparkImportPath || ('components/' + name + '.html'));
      const props = host.__sparkProps || {};
      for (const k in props) {
        const v = props[k];
        try { ph.setAttribute(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) {}
      }
      const cls = host.getAttribute('class'); if (cls) ph.setAttribute('class', cls);
      if (host.id) ph.id = host.id;
      const parent = host.parentNode;
      unmount(host);
      host.replaceWith(ph);
      await mount(parent);
    }
    console.log('[spark] ⚡ hot-updated', name);
  } catch (e) { location.reload(); }
}

function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/__spark_hmr');
  // Updates run strictly one after another — a second save landing while a
  // re-mount is mid-flight must not observe the placeholder (it would find no
  // host and mis-classify the state), so every message queues on the chain.
  let chain = Promise.resolve();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    chain = chain.then(() => {
      if (msg.reload) { location.reload(); return; }
      if (msg.css) { swapCss(msg.css); return; }
      return update(msg.name);
    }).catch(() => {});
  };
  ws.onclose = () => setTimeout(connect, 1000); // server restarted — retry
}
connect();
`;

// Resolve a bare package to the { dir, entry } of its module entry file, so we
// can serve the entry AND its sibling files under one /@modules/<pkg>/ prefix.
// Cached — the resolution doesn't change while the server is up.
const moduleInfoCache = new Map();
function moduleEntry(pkg, projectRoot) {
  const key = projectRoot + '\0' + pkg;
  if (moduleInfoCache.has(key)) return moduleInfoCache.get(key);
  let info = null;
  try {
    const file = Bun.resolveSync(pkg, projectRoot);
    info = { dir: dirname(file), entry: file.slice(file.lastIndexOf('/') + 1) };
  } catch { /* unresolvable — leave null */ }
  moduleInfoCache.set(key, info);
  return info;
}

// A companion package's OWN `import … from 'spark-html'` resolves via Bun's
// normal node_modules algorithm — ITS OWN nearest node_modules/spark-html,
// which CAN be a genuinely different installed copy than the app's own
// (lockfile drift: a companion package's sub-dependency on "spark-html" got
// pinned to an older 0.27.x at some earlier `bun install`, while the app's
// own top-level install is newer — both satisfy a `^0.27.0` range, so
// nothing warns at install time, but each copy is a SEPARATE module with
// its OWN top-level `stores` Map: theme()/ws() creates a store in THEIR
// copy, but a component's ambient useStore() — injected by whichever
// spark-html copy actually booted it — never sees it. Symptom: a
// `useStore("theme")` / `useStore("prices")` "store not created" warning
// for every companion package, in production only.
//
// Dev mode never hits this: buildImportMap() below already maps EVERY bare
// specifier to ONE canonical URL (resolved once, from the PROJECT root)
// regardless of which file imports it, so the browser only ever loads one
// file — accidental, but effective, deduplication. This plugin gives
// Bun.build the same guarantee for the production bundle: `spark-html`,
// wherever it's imported from, always resolves to the app's own top-level
// copy. Falls back to Bun's own default resolution (today's behavior,
// nested duplicates and all) if the app has no top-level `spark-html` of
// its own to canonicalize onto — never a regression, only a fix when it
// can confirm there's one true copy to point everyone at.
//
// (Only used when the build emits NO import map: once `spark-html` is
// import-mapped it is also marked `external`, and a plugin-resolved path
// would defeat the external and inline a second copy — the exact hazard
// this plugin exists to prevent.)
function dedupeSparkHtmlPlugin(projectRoot) {
  let canonical; // undefined = not yet resolved; null = resolution failed
  return {
    name: 'spark-html-single-instance',
    setup(build) {
      build.onResolve({ filter: /^spark-html$/ }, () => {
        if (canonical === undefined) {
          try {
            canonical = Bun.resolveSync('spark-html', projectRoot);
          } catch {
            canonical = null;
          }
        }
        return canonical ? { path: canonical } : null;
      });
    },
  };
}

// Import map for the app's bare specifiers: every dependency in package.json
// maps to /@modules/<name>/<entry-file>. The trailing entry filename matters —
// a package's own relative imports (e.g. spark-html-theme's `./init.js`) resolve
// against that URL, so they land at /@modules/<name>/init.js and stay inside the
// package instead of collapsing to /@modules/init.js (a 404 that blanks the app).
function buildImportMap(projectRoot) {
  const imports = {};
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const info = moduleEntry(dep, projectRoot);
      if (info) imports[dep] = `/@modules/${dep}/${info.entry}`;
    }
  } catch { /* no package.json — no bare imports to map */ }
  return imports;
}

// ── build-time import map (production parity with dev's /@modules) ──────
//
// Component fragments (and any non-entry HTML page) ship as authored and are
// fetched + evaluated at RUNTIME — their bare `import { store } from
// 'spark-html'` resolves through the page's import map in dev, but a built
// page had no map, so the exact same component worked in dev and 404'd in
// production (`spark build`, client or prerender). Build parity: scan every
// shipped .html for bare specifiers, copy each used package's entry
// directory (the same tree dev serves under /@modules/<pkg>/) into
// assets/modules/<pkg>@<version>/, and emit the same import map into the
// built page. Every mapped package is ALSO marked `external` in Bun.build,
// so the entry bundle imports the identical URL — one module instance
// everywhere (two copies = two `stores` Maps = "store not created").
//
// Scanner posture matches the core's script rewriter: regex, not a parser.
// A code-looking string inside a <script> can false-positive — that copies
// an unused package into assets/modules/ (dead bytes), never breaks the
// build. Only plain package names (optionally @scoped) are mapped; subpath
// specifiers ('pkg/sub') pass through untouched, exactly as they do today.
const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const BARE_SPEC_RE = /\bimport\s*(?:\(\s*['"]([^'"]+)['"]|(?:[^'"()]*?\bfrom\s*)?['"]([^'"]+)['"])/g;
const isBarePkg = (s) => /^(?:@[\w.-]+\/)?[\w.-]+$/.test(s);
function bareSpecs(code, into) {
  for (const m of code.matchAll(BARE_SPEC_RE)) {
    const spec = m[1] || m[2];
    if (spec && isBarePkg(spec)) into.add(spec);
  }
}
function bareSpecsInHtml(html, into) {
  for (const s of html.matchAll(SCRIPT_BLOCK_RE)) bareSpecs(s[1], into);
}

// Copy each package (plus, transitively, the bare packages ITS files import —
// a companion's own `import 'spark-html'`) into assets/modules/ and return
// the { specifier → URL } import map. The copied files are not content-
// hashed (relative sibling imports must keep their names), so the package
// version goes into the directory name to keep deploys cache-safe.
async function materializeModules(seed, projectRoot, outDir, base) {
  const imports = {};
  const queue = [...seed];
  const seen = new Set();
  while (queue.length) {
    const pkg = queue.shift();
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    const info = moduleEntry(pkg, projectRoot);
    if (!info) continue; // not installed — leave it; the browser error names the specifier
    let version = '';
    for (const p of [join(info.dir, 'package.json'), join(info.dir, '..', 'package.json')]) {
      try { version = JSON.parse(readFileSync(p, 'utf8')).version || ''; break; } catch { /* keep looking */ }
    }
    const slug = pkg.replace('/', '__') + (version ? '@' + version : '');
    const dest = join(outDir, 'assets', 'modules', slug);
    await cp(info.dir, dest, { recursive: true, filter: (src) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(src) });
    imports[pkg] = `${base}assets/modules/${slug}/${info.entry}`;
    for (const f of readdirSync(dest, { recursive: true })) {
      if (!/\.(js|mjs)$/.test(String(f))) continue;
      try {
        const specs = new Set();
        bareSpecs(readFileSync(join(dest, String(f)), 'utf8'), specs);
        for (const s of specs) if (!seen.has(s)) queue.push(s);
      } catch { /* unreadable — skip */ }
    }
  }
  return imports;
}

// Inject markup at the very start of <head> (before every module script —
// import maps must precede the first import). `<head(\s…)?>` never matches
// a page's <header> element.
function injectHead(html, inject) {
  if (/<head(\s[^>]*)?>/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n${inject}`);
  return inject + html;
}

// Watch a directory tree for component edits. fs.watch({recursive}) works on
// Bun/Linux, but fall back to per-directory watchers if it ever throws.
function watchTree(dir, onChange) {
  const watchers = [];
  try {
    watchers.push(watch(dir, { recursive: true }, onChange));
  } catch {
    const walk = (d) => {
      watchers.push(watch(d, onChange));
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        try { if (statSync(full).isDirectory()) walk(full); } catch { /* raced */ }
      }
    };
    walk(dir);
  }
  return () => watchers.forEach((w) => w.close());
}

async function transformPage(html, config, { dev }) {
  let out = html;
  for (const step of config.pipeline) {
    if (typeof step.transformHtml === 'function') {
      out = (await step.transformHtml(out, { dev })) || out;
    }
  }
  if (!dev) return out;
  const importMap = JSON.stringify({ imports: buildImportMap(config.projectRoot) });
  return injectHead(out,
    `<script type="importmap">${importMap}</script>\n` +
    `<script type="module">${HMR_CLIENT}</script>\n` +
    // The fail-loud dev diagnostics (spark-html-devtools/diagnose): directive
    // typos, hydration drift, duplicate-core banner. Dev serve only — build()
    // never injects it, so production output is untouched.
    `<script type="module" src="/@spark/diagnose.js"></script>\n`);
}

// Resolve the diagnose module from THIS package's own dependency (the app
// doesn't need spark-html-devtools installed itself).
function diagnoseFile() {
  try { return Bun.resolveSync('spark-html-devtools/diagnose', dirname(fileURLToPath(import.meta.url))); }
  catch { return null; }
}

/**
 * Start the dev server. Returns the Bun server (call .stop() to shut down).
 */
export async function dev(overrides = {}) {
  const config = await loadConfig(overrides.root || process.cwd(), overrides);
  const { projectRoot, publicDir, componentsDir } = config;
  const pub = join(projectRoot, publicDir);

  // Collect dev routes from pipeline steps (manifest/offline serve workers).
  const stepRoutes = {};
  for (const step of config.pipeline) {
    if (typeof step.devRoutes === 'function') Object.assign(stepRoutes, step.devRoutes({ config }));
  }

  const server = Bun.serve({
    port: overrides.port ?? config.port ?? 3000,
    development: true,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = decodePath(url.pathname);
      if (path === null) return new Response('Bad request', { status: 400 });

      // WebSocket channel for scoped component HMR.
      if (path === '/__spark_hmr') {
        return srv.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 });
      }

      // Pipeline dev routes (e.g. /manifest.webmanifest, service workers).
      const route = stepRoutes[path];
      if (route) {
        return new Response(await route.body(), { headers: { 'Content-Type': route.type } });
      }

      // The injected diagnostics module (see transformPage).
      if (path === '/@spark/diagnose.js') {
        const f = diagnoseFile();
        return new Response(f ? Bun.file(f) : '/* spark-html-devtools not resolvable — diagnostics off */',
          { headers: { 'Content-Type': 'text/javascript' } });
      }

      // Bare-specifier modules: /@modules/<name>/<file> → the package's entry
      // (or a sibling file it imports relatively), served from the entry's dir.
      if (path.startsWith('/@modules/')) {
        const rest = path.slice('/@modules/'.length);
        const slash = rest.indexOf('/');
        const pkg = slash === -1 ? rest : rest.slice(0, slash);
        const subpath = slash === -1 ? '' : rest.slice(slash + 1);
        const info = moduleEntry(pkg, projectRoot);
        if (info) {
          const file = resolve(info.dir, subpath || info.entry);
          // Guard against escaping the package dir via a crafted subpath.
          if (file.startsWith(info.dir + sep) && isFile(file)) {
            return new Response(Bun.file(file), { headers: { 'Content-Type': 'text/javascript' } });
          }
        }
        return new Response(`/* cannot resolve "${rest}" */`, { status: 404, headers: { 'Content-Type': 'text/javascript' } });
      }

      // Static lookup: project root first (index.html, src/…), then publicDir.
      // Each candidate is guarded against escaping its own base (path traversal).
      const rel = path.replace(/^\/+/, '');
      let file = null;
      for (const b of [projectRoot, pub]) {
        const c = safeJoin(b, rel);
        if (c && isFile(c)) { file = c; break; }
      }

      // SPA fallback: extensionless paths serve the app shell (the router
      // resolves the route client-side — same behavior as Vite dev).
      if (!file && !extname(path)) file = join(projectRoot, config.entry);
      if (!file || !existsSync(file)) return new Response('Not found', { status: 404 });

      const headers = { 'Content-Type': mime(file) };
      const isFragment = path.includes(`/${componentsDir}/`) && path.endsWith('.html');
      if (isFragment) {
        // Always re-fetch fresh on HMR — the two headers the Vite middleware set.
        headers['Cache-Control'] = 'no-cache';
        return new Response(Bun.file(file), { headers });
      }
      if (file.endsWith('.html')) {
        const html = await readFile(file, 'utf8');
        return new Response(await transformPage(html, config, { dev: true }), { headers });
      }
      // App source modules: substitute import.meta.env (Vite-compatible) so
      // BASE_URL / DEV / PROD work in dev without a bundler. node_modules are
      // served via /@modules/ above and never reach here.
      if (/\.(js|mjs)$/.test(file)) {
        const code = (await readFile(file, 'utf8')).replaceAll('import.meta.env', envLiteral(config, true));
        return new Response(code, { headers });
      }
      return new Response(Bun.file(file), { headers });
    },
    websocket: {
      open(ws) { ws.subscribe('spark-hmr'); },
      message() { /* client never sends */ },
    },
  });

  // Watch the whole project for dev edits and broadcast the right HMR message:
  // component fragments → scoped re-mount, stylesheets → in-place <link> swap,
  // page HTML (the entry, or any other served page) → full reload. Broadcasts
  // are debounced per key — editors save via temp-file + rename and emit
  // several fs events per keystroke, and a duplicate message arriving while
  // the client is mid-re-mount would mis-read the DOM.
  const componentsRoot = existsSync(join(pub, componentsDir)) ? join(pub, componentsDir) : join(projectRoot, componentsDir);
  const outAbs = resolve(projectRoot, config.outDir);
  const timers = new Map();
  const broadcast = (key, msg) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      server.publish('spark-hmr', JSON.stringify(msg));
    }, 50));
  };
  const onChange = (base) => (_event, filename) => {
    if (!filename) return;
    const rel = String(filename);
    // Never react to build output, deps, or VCS internals.
    if (/(^|\/)(node_modules|\.git)(\/|$)/.test(rel)) return;
    const abs = join(base, rel);
    if (abs === outAbs || abs.startsWith(outAbs + sep)) return;
    if (rel.endsWith('.css')) {
      // The URL the page loads this file under: public/ files are served from
      // the site root, project files from their project-relative path.
      const underPub = abs.startsWith(pub + sep);
      const urlPath = '/' + (underPub ? abs.slice(pub.length + 1) : abs.slice(projectRoot.length + 1)).split(sep).join('/');
      broadcast(urlPath, { css: urlPath });
      return;
    }
    // App modules are served raw — an edit only takes effect on a fresh page.
    if (/\.(js|mjs)$/.test(rel)) { broadcast('/', { reload: true }); return; }
    if (!rel.endsWith('.html')) return;
    if (abs.startsWith(componentsRoot + sep)) {
      const name = rel.split('/').pop().replace(/\.html$/, '');
      broadcast(name, { name });
      return;
    }
    // A page (the entry or any other top-level HTML) — only a reload is correct.
    broadcast('/', { reload: true });
  };
  let unwatch = () => {};
  {
    const stops = [watchTree(projectRoot, onChange(projectRoot))];
    // publicDir outside the project root (unusual, but configurable).
    if (existsSync(pub) && !pub.startsWith(projectRoot + sep) && pub !== projectRoot) {
      stops.push(watchTree(pub, onChange(pub)));
    }
    unwatch = () => stops.forEach((s) => s());
  }

  const stop = server.stop.bind(server);
  server.stop = (...args) => { unwatch(); return stop(...args); };
  if (!overrides.quiet) {
    console.log(`[spark] ⚡ dev server — http://localhost:${server.port}/`);
  }
  return server;
}

// ── build ───────────────────────────────────────────────────────────────

/**
 * Build the app: copy publicDir, bundle the HTML entry with Bun.build, run
 * the pipeline over outDir. Returns { outDir }.
 */
export async function build(overrides = {}) {
  const config = await loadConfig(overrides.root || process.cwd(), overrides);
  const { projectRoot, base } = config;
  const outDir = resolve(projectRoot, config.outDir);
  const pub = join(projectRoot, config.publicDir);
  const entry = join(projectRoot, config.entry);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Components (and everything else in public/) ship exactly as authored.
  if (existsSync(pub)) await cp(pub, outDir, { recursive: true });

  // Production import map: scan everything that ships as authored (public/
  // fragments and pages, plus the entry's inline scripts) for bare import
  // specifiers, and materialize the used packages under assets/modules/ —
  // see the block comment above materializeModules for why.
  const bare = new Set();
  for (const f of readdirSync(outDir, { recursive: true })) {
    if (!String(f).endsWith('.html')) continue;
    try { bareSpecsInHtml(readFileSync(join(outDir, String(f)), 'utf8'), bare); } catch { /* unreadable */ }
  }
  let entryHtml = existsSync(entry) ? await readFile(entry, 'utf8') : null;
  if (entryHtml !== null) bareSpecsInHtml(entryHtml, bare);
  const mappedImports = await materializeModules(bare, projectRoot, outDir, base);
  const mapSnippet = Object.keys(mappedImports).length
    ? `<script type="importmap">${JSON.stringify({ imports: mappedImports })}</script>\n`
      + (mappedImports['spark-html'] ? `<link rel="modulepreload" href="${mappedImports['spark-html']}">\n` : '')
    : '';

  // Bundle the app shell — but never hand Bun the HTML itself (it hard-fails
  // on refs it can't resolve, and pages legitimately reference public/ files
  // that only exist in the output). Instead: find the module scripts and
  // stylesheet links that resolve to PROJECT files, bundle those, splice the
  // hashed asset URLs back in, and ship every other byte of HTML as authored.
  if (entryHtml !== null) {
    const entryDir = join(entry, '..');
    let html = entryHtml;

    const tagRe = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*><\/script>|<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
    const found = []; // { url, file }
    for (const m of html.matchAll(tagRe)) {
      const url = m[1] || m[2];
      if (!url || /^[a-z]+:|^\/\//i.test(url)) continue; // remote — leave alone
      const clean = url.split(/[?#]/)[0];
      const file = clean.startsWith('/') ? join(projectRoot, clean.slice(1)) : join(entryDir, clean);
      // Only bundle files that live in the PROJECT (src/…) — anything served
      // from publicDir ships verbatim and its URL already works.
      if (existsSync(file) && !file.startsWith(pub + sep)) found.push({ url, file });
    }

    if (found.length) {
      // Bun.build DEDUPES duplicate entrypoints (the same file listed twice —
      // or reached via two URL spellings — yields ONE output), so bundle the
      // UNIQUE files and map file → hashed name; never map outputs back by
      // found-index, which would splice the wrong asset URL into the page.
      const files = [...new Set(found.map((f) => f.file))];
      const result = await Bun.build({
        entrypoints: files,
        outdir: join(outDir, 'assets'),
        minify: true,
        splitting: true,
        format: 'esm',
        publicPath: `${base}assets/`,
        define: { 'import.meta.env': envLiteral(config, false) },
        naming: { entry: '[name]-[hash].[ext]', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
        // Mapped packages stay external so the entry imports the same URL the
        // component scripts do (one instance). The dedupe plugin only runs
        // when there is no map — a plugin-resolved path would defeat external.
        external: Object.keys(mappedImports),
        plugins: mappedImports['spark-html'] ? [] : [dedupeSparkHtmlPlugin(projectRoot)],
      });
      if (!result.success) {
        const msgs = (result.logs || []).map((l) => l.message || String(l)).join('\n');
        throw new Error(`[spark] build failed:\n${msgs}`);
      }
      // Map each unique input file to its hashed output name. Outputs do NOT
      // reliably come back in entrypoint order: a CSS entrypoint bundled
      // alongside JS entrypoints comes back with kind 'asset', not
      // 'entry-point' — filtering to entry-point-only then zipping by index
      // silently mispairs every tag once a project has both a script and a
      // stylesheet entry (the common case). Match by the `[name]-[hash].ext`
      // naming pattern instead, which is kind-agnostic and input-order-
      // independent. Two different entrypoints that share a basename+ext
      // (e.g. src/main.js and src/components/main.js) are a real but rare
      // ambiguity; fall back to encounter order between the tied candidates.
      const candidatesByKey = new Map(); // "name.ext" → [output paths, in result.outputs order]
      for (const o of result.outputs) {
        if (o.kind !== 'entry-point' && o.kind !== 'asset') continue;
        const b = basename(o.path);
        const m = b.match(/^(.+)-[^.-]+(\.[^.]+)$/);
        if (!m) continue;
        const key = m[1] + m[2];
        if (!candidatesByKey.has(key)) candidatesByKey.set(key, []);
        candidatesByKey.get(key).push(b);
      }
      const outName = new Map();
      for (const file of files) {
        const key = basename(file, extname(file)) + extname(file);
        const list = candidatesByKey.get(key);
        outName.set(file, list && list.length ? list.shift() : undefined);
      }
      for (const f of found) {
        const name = outName.get(f.file);
        if (!name) continue;
        const to = `${base}assets/${name}`;
        // Replace only the quoted attribute value, so a longer URL that ends
        // with this one (e.g. /lib/app.js vs /app.js) is never corrupted the
        // way a bare replaceAll(url) would corrupt it.
        for (const q of ['"', "'"]) html = html.split(`${q}${f.url}${q}`).join(`${q}${to}${q}`);
      }
    }
    if (mapSnippet) html = injectHead(html, mapSnippet);
    await Bun.write(join(outDir, config.entry.split('/').pop()), html);
  }

  // Non-entry pages (multi-page apps) need the same map — dev injects it
  // into every served page; fragments (componentsDir) are consumed by
  // mount() and never get page-level injection.
  if (mapSnippet) {
    const compSeg = sep + config.componentsDir + sep;
    const entryOut = join(outDir, config.entry.split('/').pop());
    for (const f of readdirSync(outDir, { recursive: true })) {
      const rel = String(f);
      if (!rel.endsWith('.html') || (sep + rel).includes(compSeg)) continue;
      const abs = join(outDir, rel);
      if (abs === entryOut || !isFile(abs)) continue; // entry already injected above
      await Bun.write(abs, injectHead(readFileSync(abs, 'utf8'), mapSnippet));
    }
  }

  for (const step of config.pipeline) {
    if (typeof step.run === 'function') await step.run({ outDir, base, projectRoot });
  }

  if (!overrides.quiet) console.log(`[spark] ⚡ built → ${config.outDir}/`);
  return { outDir };
}

// ── preview ─────────────────────────────────────────────────────────────

/**
 * Serve the built outDir the way the deploy targets do: exact file →
 * `path + '.html'` (the _redirects convention prerender emits) → 404.html.
 */
export async function preview(overrides = {}) {
  const config = await loadConfig(overrides.root || process.cwd(), overrides);
  const outDir = resolve(config.projectRoot, config.outDir);
  const base = config.base;

  const server = Bun.serve({
    port: overrides.port ?? config.port ?? 4173,
    fetch(req) {
      const url = new URL(req.url);
      let path = decodePath(url.pathname);
      if (path === null) return new Response('Bad request', { status: 400 });
      if (base !== '/' && path.startsWith(base)) path = '/' + path.slice(base.length);
      const rel = path.replace(/^\/+/, '');
      // Guard every candidate against escaping outDir (path traversal).
      const tryFiles = [
        safeJoin(outDir, rel === '' ? 'index.html' : rel),
        safeJoin(outDir, rel + '.html'),
        rel !== '' && rel.endsWith('/') ? safeJoin(outDir, join(rel, 'index.html')) : null,
      ].filter(Boolean);
      for (const f of tryFiles) {
        if (isFile(f)) {
          return new Response(Bun.file(f), { headers: { 'Content-Type': mime(f) } });
        }
      }
      const notFound = join(outDir, '404.html');
      if (existsSync(notFound)) {
        return new Response(Bun.file(notFound), { status: 404, headers: { 'Content-Type': 'text/html' } });
      }
      return new Response('Not found', { status: 404 });
    },
  });
  if (!overrides.quiet) {
    console.log(`[spark] ⚡ preview — http://localhost:${server.port}${base}`);
  }
  return server;
}

export default { dev, build, preview, loadConfig };
