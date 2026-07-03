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
 *    re-mount, sibling state preserved (slotted/loop-managed hosts full-reload,
 *    always correct — the exact semantics of the Vite plugin).
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
import { join, resolve, extname } from 'node:path';
import { existsSync, watch, readdirSync, statSync, readFileSync } from 'node:fs';
import { rm, mkdir, cp, readFile } from 'node:fs/promises';

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
// dev server owns, instead of a bundler's HMR channel.
const HMR_CLIENT = `
import { mount, unmount } from 'spark-html';
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/__spark_hmr');
  ws.onmessage = async (ev) => {
    const { name } = JSON.parse(ev.data);
    const hosts = [...document.querySelectorAll('[name="' + name + '"]')];
    if (!hosts.length) { location.reload(); return; }
    // Scoped HMR only for simple top-level hosts; slotted or loop/if-managed
    // hosts fall back to a full reload so the result is always correct.
    if (hosts.some((h) => h.__sparkHadSlots || h.__sparkManaged)) { location.reload(); return; }
    try {
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
  };
  ws.onclose = () => setTimeout(connect, 1000); // server restarted — retry
}
connect();
`;

// Import map for the app's bare specifiers: every dependency in package.json
// maps to /@modules/<name>, which the dev server resolves with Bun's resolver.
// Spark packages are single-file modules whose only bare import is
// 'spark-html' (also in the map), so no rewriting is needed anywhere.
function buildImportMap(projectRoot) {
  const imports = {};
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      imports[dep] = `/@modules/${dep}`;
    }
  } catch { /* no package.json — no bare imports to map */ }
  return imports;
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
  // The import map must precede every module script — inject at head start.
  const inject =
    `<script type="importmap">${importMap}</script>\n` +
    `<script type="module">${HMR_CLIENT}</script>\n`;
  if (/<head[^>]*>/i.test(out)) return out.replace(/<head[^>]*>/i, (m) => `${m}\n${inject}`);
  return inject + out;
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
      let path = decodeURIComponent(url.pathname);

      // WebSocket channel for scoped component HMR.
      if (path === '/__spark_hmr') {
        return srv.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 });
      }

      // Pipeline dev routes (e.g. /manifest.webmanifest, service workers).
      const route = stepRoutes[path];
      if (route) {
        return new Response(await route.body(), { headers: { 'Content-Type': route.type } });
      }

      // Bare-specifier modules: /@modules/<name> → Bun-resolved entry file.
      if (path.startsWith('/@modules/')) {
        const spec = path.slice('/@modules/'.length);
        try {
          const file = Bun.resolveSync(spec, projectRoot);
          return new Response(Bun.file(file), { headers: { 'Content-Type': 'text/javascript' } });
        } catch {
          return new Response(`/* cannot resolve "${spec}" */`, { status: 404, headers: { 'Content-Type': 'text/javascript' } });
        }
      }

      // Static lookup: project root first (index.html, src/…), then publicDir.
      const rel = path.replace(/^\/+/, '');
      const candidates = [join(projectRoot, rel), join(pub, rel)];
      let file = null;
      for (const c of candidates) {
        if (existsSync(c) && statSync(c).isFile()) { file = c; break; }
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

  // Watch component fragments; broadcast the component name on change.
  const componentsRoot = existsSync(join(pub, componentsDir)) ? join(pub, componentsDir) : join(projectRoot, componentsDir);
  let unwatch = () => {};
  if (existsSync(componentsRoot)) {
    unwatch = watchTree(componentsRoot, (_event, filename) => {
      if (!filename || !String(filename).endsWith('.html')) return;
      const name = String(filename).split('/').pop().replace(/\.html$/, '');
      server.publish('spark-hmr', JSON.stringify({ name }));
    });
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

  // Bundle the app shell — but never hand Bun the HTML itself (it hard-fails
  // on refs it can't resolve, and pages legitimately reference public/ files
  // that only exist in the output). Instead: find the module scripts and
  // stylesheet links that resolve to PROJECT files, bundle those, splice the
  // hashed asset URLs back in, and ship every other byte of HTML as authored.
  if (existsSync(entry)) {
    const entryDir = join(entry, '..');
    let html = await readFile(entry, 'utf8');

    const tagRe = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*><\/script>|<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
    const found = []; // { url, file }
    for (const m of html.matchAll(tagRe)) {
      const url = m[1] || m[2];
      if (!url || /^[a-z]+:|^\/\//i.test(url)) continue; // remote — leave alone
      const clean = url.split(/[?#]/)[0];
      const file = clean.startsWith('/') ? join(projectRoot, clean.slice(1)) : join(entryDir, clean);
      // Only bundle files that live in the PROJECT (src/…) — anything served
      // from publicDir ships verbatim and its URL already works.
      if (existsSync(file) && !file.startsWith(pub + '/')) found.push({ url, file });
    }

    if (found.length) {
      const result = await Bun.build({
        entrypoints: found.map((f) => f.file),
        outdir: join(outDir, 'assets'),
        minify: true,
        splitting: true,
        format: 'esm',
        publicPath: `${base}assets/`,
        define: { 'import.meta.env': envLiteral(config, false) },
        naming: { entry: '[name]-[hash].[ext]', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
      });
      if (!result.success) {
        const msgs = (result.logs || []).map((l) => l.message || String(l)).join('\n');
        throw new Error(`[spark] build failed:\n${msgs}`);
      }
      // Entry outputs come back in entrypoint order — map each to its URL.
      const entryOuts = result.outputs.filter((o) => o.kind === 'entry-point');
      found.forEach((f, i) => {
        const name = entryOuts[i] && entryOuts[i].path.split('/').pop();
        if (name) html = html.replaceAll(f.url, `${base}assets/${name}`);
      });
    }
    await Bun.write(join(outDir, config.entry.split('/').pop()), html);
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
      let path = decodeURIComponent(url.pathname);
      if (base !== '/' && path.startsWith(base)) path = '/' + path.slice(base.length);
      const rel = path.replace(/^\/+/, '');
      const tryFiles = [
        join(outDir, rel === '' ? 'index.html' : rel),
        join(outDir, rel + '.html'),
        rel !== '' && rel.endsWith('/') ? join(outDir, rel, 'index.html') : null,
      ].filter(Boolean);
      for (const f of tryFiles) {
        if (existsSync(f) && statSync(f).isFile()) {
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
