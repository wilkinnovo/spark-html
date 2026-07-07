/**
 * spark-ssr server — `bun spark-ssr` and it serves.
 *
 * The filesystem is the router (pages/, _layout.html, api/, public/,
 * 404.html, 500.html, middleware.html), <spark-ssr> blocks declare the data
 * (SQL, URLs, file globs, modules — named or inferred), and everything else
 * is read from the template: auto CRUD, guards, form validation, schema,
 * seeds, live updates. No route handlers, no controllers, no build.
 */
import { join, resolve, extname, dirname, relative, sep } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import {
  extractBlocks, analyze, mergeAnalyses, dataPlan, rewriteParams,
  maskComments, extractForms, splitScript,
} from './parse.js';
import { renderFragment, renderFragmentTo, evalExpr } from './render.js';
import { clientComponent, initModule } from './hydrate.js';
import { urlSource, globSource, moduleSource, makeSourceCache } from './sources.js';
import { makeJobs } from './jobs.js';
import { makeStatic } from './static.js';
import { makeScreens, escapeHtml } from './screens.js';
import { makeRequest, json, localPath } from './request.js';
import { makeCrud } from './crud.js';
import { makePage } from './page.js';
import { makeRoutes } from './routes.js';
import { inferSchema, diffSchema, pushSchema, seedTables } from './schema.js';
// Head semantics live in one place for the whole family: spark-html-head owns
// title/meta on the client (pushState updates); its /ssr module owns them
// here — pages put literal <title>/<meta>/<link> tags in their markup, we
// lift them into the document head with {expr} interpolated per request.
import { liftHead, renderHead } from 'spark-html-head/ssr';

const AsyncFunction = (async () => {}).constructor;
const dig = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

// ── pages ──────────────────────────────────────────────────────────────
const RESERVED_ROOT_DIRS = new Set(['components', 'api', 'public', 'pages', 'node_modules', 'dist', 'uploads', 'seed']);
const RESERVED_FILES = new Set(['404.html', '500.html', 'middleware.html']);

export function scanPages(root) {
  const pagesDir = existsSync(join(root, 'pages')) ? join(root, 'pages') : root;
  const pages = [];
  (function scan(dir, prefix) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      // `_`-prefixed files are structure, not pages: _layout.html wraps the
      // folder's pages instead of serving as one.
      if (f.startsWith('.') || f.startsWith('_')) continue;
      const full = join(dir, f);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (pagesDir === root && RESERVED_ROOT_DIRS.has(f)) continue;
        scan(full, prefix + f + '/');
      } else if (f.endsWith('.html') && !(prefix === '' && RESERVED_FILES.has(f))) {
        const key = prefix + f.slice(0, -5); // blog/[slug]
        const route = key === 'index' ? '/' : '/' + key.replace(/\/index$/, '');
        pages.push({ key, file: full, route, segs: route.split('/').filter(Boolean) });
      }
    }
  })(pagesDir, '');
  // Static routes match before dynamic ones.
  pages.sort((a, b) => a.segs.filter((s) => s.startsWith('[')).length - b.segs.filter((s) => s.startsWith('[')).length);
  return { pagesDir, pages };
}

function matchPage(pages, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  outer: for (const p of pages) {
    if (p.segs.length !== parts.length) continue;
    const params = {};
    for (let i = 0; i < parts.length; i++) {
      const dm = p.segs[i].match(/^\[(\w+)\]$/);
      if (dm) params[dm[1]] = decodeURIComponent(parts[i]);
      else if (p.segs[i] !== parts[i]) continue outer;
    }
    return { page: p, params };
  }
  return null;
}

// One page-or-layout file, parsed. Analyze BEFORE lifting the head, so a
// {var} used only in <title>/<meta> still registers as a data need.
function parseFile(source) {
  const { blocks, html } = extractBlocks(source);
  const { html: markup, code } = splitScript(html);
  const analysis = analyze(markup);
  const forms = extractForms(markup);
  const { head, scripts, body } = liftHead(markup);
  return { blocks, code, analysis, forms, head, scripts, body };
}

// Layouts: every _layout.html from the pages root down to the page's folder,
// outermost first. A layout is a component the folder wraps around its pages;
// <slot> is the page.
function layoutChain(pageFile, pagesDir) {
  const rel = relative(pagesDir, dirname(pageFile));
  const parts = rel === '' || rel === '.' ? [] : rel.split(sep);
  const chain = [];
  let dir = pagesDir;
  const rootLayout = join(dir, '_layout.html');
  if (existsSync(rootLayout)) chain.push(rootLayout);
  for (const p of parts) {
    dir = join(dir, p);
    const f = join(dir, '_layout.html');
    if (existsSync(f)) chain.push(f);
  }
  return chain;
}

// Head merge: layout tags first, page tags after — and the page wins on
// conflicts (<title>, <meta> with the same name/property). <link>s stack.
function mergeHeads(parts) {
  const out = new Map();
  let n = 0;
  for (const part of parts) {
    for (const line of String(part || '').split('\n')) {
      const tag = line.trim();
      if (!tag) continue;
      let key = null;
      if (/^<title\b/i.test(tag)) key = 'title';
      else {
        const nm = tag.match(/\b(?:name|property|http-equiv)\s*=\s*["']([^"']+)["']/i);
        if (/^<meta\b/i.test(tag) && nm) key = 'meta:' + nm[1].toLowerCase();
      }
      out.set(key || 'x' + n++, tag);
    }
  }
  return [...out.values()].join('\n');
}

// Client scripts merge: a layout and a page may both pull the same module —
// ship it once.
function mergeScripts(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    for (const tag of String(part || '').split('\n')) {
      const t = tag.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out.join('\n');
}

// Parsed-page cache, invalidated by mtime — the page's AND its layouts'.
function pageData(page, cache, pagesDir) {
  const files = [...layoutChain(page.file, pagesDir), page.file];
  const stamps = files.map((f) => ({ file: f, mtime: statSync(f).mtimeMs }));
  const hit = cache.get(page.file);
  if (hit && hit.files.length === stamps.length
    && hit.files.every((s, i) => s.file === stamps[i].file && s.mtime === stamps[i].mtime)) return hit;

  const parsed = files.map((f) => parseFile(readFileSync(f, 'utf8')));
  const pageP = parsed[parsed.length - 1];

  // Compose bodies innermost-out: the page replaces each layout's <slot>.
  // Comments are masked first so a literal <slot> written inside a layout
  // comment (the template's own explainer text does this) isn't mistaken for
  // the real slot — which would inject the whole page inside the comment.
  let body = pageP.body;
  for (let i = parsed.length - 2; i >= 0; i--) {
    const lay = parsed[i].body;
    const SLOT = /<slot\b[^>]*>(?:\s*<\/slot>)?/i;
    const { masked, restore } = maskComments(lay);
    const m = masked.match(SLOT);
    body = m
      ? restore(masked.slice(0, m.index)) + body + restore(masked.slice(m.index + m[0].length))
      : lay + body;
  }

  const blocks = parsed.flatMap((p) => p.blocks);
  const code = parsed.map((p) => p.code).filter(Boolean).join('\n');
  const analysis = mergeAnalyses(parsed.map((p) => p.analysis));
  analysis.hasScript = !!code;
  const plan = dataPlan(analysis, blocks, code);
  const forms = parsed.flatMap((p) => p.forms);
  const head = mergeHeads(parsed.map((p) => p.head));
  const scripts = mergeScripts(parsed.map((p) => p.scripts));

  // Kept separate from the merged `html`: auto-404 (§3) must only look at
  // what the PAGE itself wrote, not a shared layout's own if/else — a
  // layout's conditional (nav's logged-in/out branch, say) sharing an
  // `else` with the page's merged text used to opt every [param] page on
  // the whole site out of auto-404, not just pages that actually wrote one.
  const data = { files: stamps, blocks, html: body, ownBody: pageP.body, head, scripts, code, analysis, plan, forms };
  cache.set(page.file, data);
  return data;
}

// The schema/CLI entry: scan a project the same way serve() does and infer
// its schema — `bun spark-ssr db` runs on this.
export async function projectSchema(root) {
  const config = loadConfig(root);
  const db = await connect(config.db, root);
  const { pagesDir, pages } = scanPages(root);
  const cache = new Map();
  const pds = [];
  for (const p of pages) {
    try { pds.push(pageData(p, cache, pagesDir)); } catch { /* broken page — skip */ }
  }
  const schema = inferSchema(pds, config, root);
  return { config, db, schema };
}

// ── sessions (split to src/session.js) ─────────────────────────────────
// HMAC-signed session + flash cookies and the isAdmin role check — pure
// functions of (cookie header, secret), no server state.
import {
  signSession, readSession, SESSION_COOKIE,
  signFlash, readFlash, FLASH_COOKIE, isAdmin, isHttps,
} from './session.js';

// ── serve ──────────────────────────────────────────────────────────────
export async function serve(options = {}) {
  const root = resolve(options.root || process.cwd());
  const config = { ...loadConfig(root), ...(options.config || {}) };
  const db = await connect(config.db, root);
  // A production server (watch:false) with auth configured MUST carry an
  // explicit secret — an ephemeral random key silently invalidates every
  // session on restart and can't be shared across instances. Fail loud at
  // startup rather than ship a subtly broken login. Dev keeps the random key.
  if (options.watch === false && config.auth && !config.auth.secret) {
    throw new Error(
      '[spark-ssr] auth is configured but auth.secret is unset — a production '
      + 'server needs a stable secret. Set it in spark.json, e.g. '
      + '"auth": { …, "secret": "ENV.SESSION_SECRET" }.',
    );
  }
  const secret = (config.auth && config.auth.secret) || randomBytes(32).toString('hex');
  const cache = new Map();
  const pages = [];
  let pagesDir = root;
  const uploadsDir = join(root, config.uploads);
  const quiet = !!options.quiet;
  const log = quiet ? () => {} : (m) => console.log(`[spark-ssr] ${m}`);

  const ctx = { port: 0 };

  // ── dev live reload ──
  // The server side already re-reads files per request; this closes the loop
  // on the browser side. A cheap mtime sweep (same walk refreshPages does)
  // feeds an SSE channel, and every HTML response carries a two-line client
  // that reloads the page on a ping. Production (`start` / dist) runs with
  // watch:false and ships none of it.
  const live = options.watch !== false;
  const sseClients = new Set();
  const sseEnc = new TextEncoder();
  let watchTimer = null;
  if (live) {
    const IGNORE = new Set(['node_modules', 'dist', 'uploads']);
    const mtimes = new Map();
    const sweep = () => {
      const seen = new Set();
      let changed = false;
      (function walk(dir) {
        let names;
        try { names = readdirSync(dir); } catch { return; }
        for (const f of names) {
          if (f.startsWith('.') || IGNORE.has(f)) continue;
          const full = join(dir, f);
          let st;
          try { st = statSync(full); } catch { continue; }
          if (st.isDirectory()) { walk(full); continue; }
          if (!/\.(html|css|js|json|md)$/.test(f)) continue;
          seen.add(full);
          if (mtimes.get(full) !== st.mtimeMs) { mtimes.set(full, st.mtimeMs); changed = true; }
        }
      })(root);
      for (const k of mtimes.keys()) if (!seen.has(k)) { mtimes.delete(k); changed = true; }
      return changed;
    };
    sweep(); // baseline — the first pass records, it doesn't reload anyone
    watchTimer = setInterval(() => {
      if (!sweep()) return;
      clearColumnsCache(); // a file changed — a `db push` may have too (§10)
      for (const c of sseClients) {
        try { c.enqueue(sseEnc.encode('data: reload\n\n')); } catch { sseClients.delete(c); }
      }
    }, 250);
    watchTimer.unref?.();
  }
  // Reconnect-then-reload: after a server restart the EventSource reconnects,
  // and a fresh open following an error means "the server came back" — reload.
  // Close on pagehide: a live EventSource holds one of the browser's ~6
  // per-host HTTP/1.1 sockets, and one that outlives its page starves the
  // next navigation — rapid link-clicking (or a service worker that keeps a
  // controlled client's sockets around) piles them up until the tab hangs
  // loading. Freeing the socket the instant we leave keeps the pool clear;
  // reopen if the page is restored from the back/forward cache.
  // A service worker must never control a spark-ssr dev page: the dev server
  // ships none, so a controller is always a leftover from a PREVIOUS project on
  // this same localhost port. A stale caching worker serves old HTML (so fixes
  // never appear), holds the per-host sockets live reload needs, and throws
  // Cache.put() errors on aborted navigations — the tab hangs and no amount of
  // rescaffolding helps, because deleting files never unregisters a worker.
  // Unregister it, drop its caches, reload once (a session flag stops any loop).
  const RELOAD_CLIENT = '<script>(()=>{'
    + 'if(navigator.serviceWorker&&navigator.serviceWorker.controller&&!sessionStorage.getItem("__spark_sw")){'
    + 'sessionStorage.setItem("__spark_sw","1");'
    + 'console.warn("[spark-ssr] a stale service worker was controlling this dev page — unregistering it and clearing its caches");'
    + 'navigator.serviceWorker.getRegistrations().then(r=>Promise.all(r.map(x=>x.unregister())))'
    + '.then(()=>window.caches?caches.keys().then(k=>Promise.all(k.map(x=>caches.delete(x)))):0)'
    + '.then(()=>location.reload());return}'
    + 'let e,d=0;const open=()=>{e=new EventSource("/__spark/reload");'
    + 'e.onmessage=()=>location.reload();e.onerror=()=>{d=1};e.onopen=()=>{if(d)location.reload()}};open();'
    + 'addEventListener("pagehide",()=>{if(e)e.close()});'
    + 'addEventListener("pageshow",v=>{if(v.persisted)open()})})()</script>';

  // Heartbeats keep every SSE socket outside Bun's idleTimeout (the default
  // would kill them at 10 s — and a killed reload socket reconnects, which
  // the client reads as "the server came back": a spurious reload). The ping
  // also flushes dead clients (enqueue throws → drop).
  const heartbeat = setInterval(() => {
    for (const set of [sseClients, liveClients]) {
      for (const c of set) {
        try { c.enqueue(sseEnc.encode(': ping\n\n')); } catch { set.delete(c); }
      }
    }
    sourceCache.sweep(); // expired cache entries freed eagerly (§5)
  }, 25000);
  heartbeat.unref?.();

  // ── live data channel (§9) — a production feature, unlike dev reload ──
  // Any write through the server pings /__spark/live with the table name;
  // hydrated pages refetch through their own session (scoping intact) and
  // the source cache drops entries that read the table.
  const liveTables = new Set();
  const liveClients = new Set();
  const sourceCache = makeSourceCache();
  function broadcast(table) {
    sourceCache.invalidate(table);
    if (!liveTables.has(table)) return;
    for (const c of liveClients) {
      try { c.enqueue(sseEnc.encode('data: ' + table + '\n\n')); } catch { liveClients.delete(c); }
    }
  }
  // ── shared context for the extracted modules (M3.2 split) ──
  // Fixed fields are startup constants; `broadcast` is bound above and
  // `makeAppFetch` below (the request plumbing) — modules read late-bound
  // slots at call time, never at import time.
  const app = {
    root, config, db, secret, quiet, live, log, ctx,
    pages, cache, liveTables, RELOAD_CLIENT, uploadsDir, sourceCache, sseEnc,
    broadcast, makeAppFetch: null, uploadWebp: false,
    pageData: (page) => pageData(page, cache, pagesDir),
    // Mutable serve() state, exposed as getters so the modules always read
    // the current value (refreshPages reassigns pagesDir on every scan;
    // tables/apiRoutes are declared further down in serve()).
    get pagesDir() { return pagesDir; },
    get seedFiles() { return seedFiles; },
    get tables() { return tables; },
    get apiRoutes() { return apiRoutes; },
  };

  // Declarative mail + jobs + the write-event fan-out (split to src/jobs.js):
  // mail() ambient sender, jobs/<name>.js on schedules and write hooks,
  // fireEvent as the single "a write went through table X" path.
  const { mail, initMail, registerJob, fireEvent, broadcastSql, jobTimers } = makeJobs(app);
  app.fireEvent = fireEvent;
  app.broadcastSql = broadcastSql;
  app.mail = mail;

  // Component + static + /@modules file serving (split to src/static.js).
  const { loadComponent, staticFile, moduleEntry } = makeStatic(app);
  app.loadComponent = loadComponent;
  app.moduleEntry = moduleEntry;

  // Built-in screens + generated documents (split to src/screens.js):
  // error/auth pages, /__spark/plan, OpenAPI + client.ts, sitemap/robots.
  const {
    errorPage, authScreen, builtinAuthKind, devErrorPage,
    planPage, openapiDoc, clientTs, sitemapXml, robotsTxt,
  } = makeScreens(app);

  // Request plumbing (split to src/request.js): the req wrapper, body/upload
  // parsing, :token resolution, runSql (+source-cache TTL), the app-relative
  // fetch, CORS. makeAppFetch is the late-bound slot jobs read at call time.
  const { wrapReq, runSql, makeAppFetch, corsHeaders } = makeRequest(app);
  app.makeAppFetch = makeAppFetch;
  app.runSql = runSql;
  app.errorPage = errorPage;

  // Auto-CRUD + login + explicit query endpoints (split to src/crud.js):
  // owns the API route table, per-table options/validators, the PRAGMA
  // column cache, and queryDefs.
  const {
    apiRoutes, on, tableOpts, setValidators, columnsOf, clearColumnsCache,
    tableRows, registerTable, registerQuery,
  } = makeCrud(app);
  app.tableRows = tableRows;
  app.registerQuery = registerQuery;

  // The page render pipeline (split to src/page.js; response-cache policy in
  // src/cache.js): servePage end to end, plus resolveSource for the
  // /__spark/data endpoints.
  const { servePage, resolveSource } = makePage(app);

  // api/ folder endpoints, API matching, middleware.html (split to
  // src/routes.js). routes.middleware is the compiled per-mtime function.
  const routes = makeRoutes(app);
  const { refreshApi, matchApi, refreshMiddleware, mwState } = routes;

  // ── the Spark family, wired in ──
  // Companion packages the app depends on get an importmap entry and are
  // served at /@modules/<name>, so client scripts import them bare — the same
  // packages a spark-html-bun/prerender build uses, working here unbundled.
  app.familyDeps = [];
  try {
    const pj = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    app.familyDeps = Object.keys({ ...pj.dependencies, ...pj.devDependencies })
      .filter((n) => /^spark-html-[\w-]+$/.test(n));
  } catch { /* no package.json — single-file project */ }

  // spark-html-theme: inline its no-flash snippet in every <head> (the same
  // one spark-html-theme/bun bakes into prerendered pages) so the saved/OS
  // theme is on <html> before first paint.
  app.themeInit = '';
  if (app.familyDeps.includes('spark-html-theme')) {
    try {
      const { themeInitScript } = await import('spark-html-theme/init');
      app.themeInit = `<script>${themeInitScript()}</script>`;
    } catch { /* older spark-html-theme without /init — theme() still works, with a flash */ }
  }

  // spark-html-font: `"fonts"` in spark.json renders the same head tags the
  // font/bun pipeline step bakes at build time — preloads, @font-face with a
  // size-adjusted fallback face, --font-<slug> vars.
  app.fontTags = '';
  if (config.fonts) {
    try {
      const { fontHtml } = await import('spark-html-font');
      app.fontTags = fontHtml({ fonts: config.fonts });
    } catch (e) {
      if (!quiet) console.warn(`[spark-ssr] "fonts" configured but spark-html-font is not installed — ${e.message}`);
    }
  }

  // spark-html-image, at write time (Tier 3): uploaded rasters get a webp
  // sibling, and :file.url points at it (original stays as :file.original).
  app.uploadWebp = app.familyDeps.includes('spark-html-image');

  // ── auth plugin + logout wiring ──
  let authPlugin = null;
  if (config.auth && config.auth.plugin) {
    authPlugin = (await import(resolve(root, config.auth.plugin))).default;
    on('POST', 'api/auth', async (req) => {
      const user = await authPlugin.login(req);
      if (!user) return json({ error: 'invalid credentials' }, 401);
      const session = { id: user.id, email: user.email, name: user.name };
      if (user.is_admin !== undefined) session.is_admin = user.is_admin;
      if (user.role !== undefined) session.role = user.role;
      return json(user, 200, { 'set-cookie': SESSION_COOKIE(signSession(session, secret), { secure: req.secure }) });
    });
  }
  if (config.auth) {
    on('POST', 'api/logout', async (req) => json({ ok: true }, 200, { 'set-cookie': SESSION_COOKIE('', { clear: true, secure: req.secure }) }));
  }

  // (Re)scan pages/ and register everything they declare. Runs per request —
  // a plain readdir walk plus mtime-cached parses — so new pages, new tables,
  // and edited queries appear without restarting the server.
  const tables = new Set();
  const seedFiles = new Set(); // never served as static assets
  let schemaDirty = false;
  // Configuring auth IS declaring its table: the login endpoint
  // (POST /api/<table>?auth) and signup exist without any page mentioning
  // them. Single-account apps can turn signup off in middleware.html.
  if (config.auth && config.auth.table && db) {
    tables.add(config.auth.table);
    registerTable(config.auth.table);
  }
  function refreshPages() {
    const scanned = scanPages(root);
    pagesDir = scanned.pagesDir;
    pages.splice(0, pages.length, ...scanned.pages);
    const nextValidators = new Map();
    for (const page of pages) {
      let pd;
      try { pd = pageData(page, cache, pagesDir); } catch { continue; }
      for (const b of pd.blocks) {
        if (b.table) {
          if (!tables.has(b.table)) { tables.add(b.table); registerTable(b.table); schemaDirty = true; }
          if (b.live) liveTables.add(b.table);
          if (b.seed) {
            seedFiles.add(resolve(root, b.seed.replace(/^\.\//, '')));
            schemaDirty = schemaDirty || !seededOnce.has(b.table);
          }
          const opts = tableOpts.get(b.table) || {};
          if (b.limit) opts.limit = b.limit;
          if (b.search) opts.search = b.search;
          if (b.cache) opts.cache = b.cache;
          tableOpts.set(b.table, opts);
        }
        for (const r of b.routes) {
          if (r.path) registerQuery({ ...r, cache: b.cache });
        }
        if (b.job) registerJob(b);
      }
      for (const form of pd.forms) {
        if (!form.table) continue;
        const rules = nextValidators.get(form.table) || {};
        Object.assign(rules, form.fields);
        nextValidators.set(form.table, rules);
      }
    }
    setValidators(nextValidators);
  }
  // The template is the schema (§7): at startup (and whenever a new table
  // appears in dev) missing tables are created and seeds applied — a fresh
  // clone runs on `bun spark-ssr` alone. Alters stay explicit: `db push`.
  const seededOnce = new Set();
  async function ensureSchema() {
    if (!db) { schemaDirty = false; return; }
    const pds = [];
    for (const p of pages) {
      try { pds.push(pageData(p, cache, pagesDir)); } catch { /* skip */ }
    }
    const schema = inferSchema(pds, config, root);
    try {
      await pushSchema(db, schema, { createOnly: true, log: (m) => log(`db: ${m}`) });
      await seedTables(db, schema, config, root, (m) => log(`db: ${m}`));
      for (const t of Object.keys(schema)) seededOnce.add(t);
    } catch (e) {
      if (!quiet) console.warn(`[spark-ssr] schema: ${e.message}`);
    }
    clearColumnsCache(); // tables may have gained columns (§10)
    schemaDirty = false;
  }
  await initMail();
  refreshPages();
  await ensureSchema();

  refreshApi();

  refreshMiddleware();

  // ── the server ──
  const server = Bun.serve({
    port: options.port ?? 3000,
    // SSE channels idle between events (heartbeat every 25 s keeps them
    // alive); slow queries and big uploads get headroom too.
    idleTimeout: 60,
    // Reject an over-large body at the socket (413) before it is buffered —
    // the upload/DoS ceiling (config.maxBodyMb, default 10 MB).
    maxRequestBodySize: Math.max(1024, config.maxBodyMb * 1024 * 1024),
    async fetch(request, srv) {
      const url = new URL(request.url);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
      if (pathname.includes('..')) return errorPage(404);

      // Dev reload channel — before middleware; it's the harness, not the app.
      if (live && pathname === '/__spark/reload') {
        let ctrl;
        const stream = new ReadableStream({
          start(c) { ctrl = c; c.enqueue(sseEnc.encode(': connected\n\n')); sseClients.add(c); },
          cancel() { sseClients.delete(ctrl); },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
        });
      }

      // The live data channel (§9) ships in production too — it's the app.
      if (pathname === '/__spark/live') {
        let ctrl;
        const stream = new ReadableStream({
          start(c) { ctrl = c; c.enqueue(sseEnc.encode(': connected\n\n')); liveClients.add(c); },
          cancel() { liveClients.delete(ctrl); },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
        });
      }

      const session = readSession(request.headers.get('cookie'), secret);
      const extraHeaders = {};

      try {
        // Pick up new/edited pages, api files, and middleware without a
        // restart (readdir walk + mtime-cached parses — cheap).
        if (options.watch !== false) {
          refreshPages(); refreshApi(); refreshMiddleware();
          if (schemaDirty) await ensureSchema();
        }

        if (live && pathname === '/__spark/plan') return planPage();

        // The generated API contract — served in production too (before
        // middleware, like /__spark/plan), so external consumers and tests get
        // types for free.
        if (pathname === '/__spark/openapi.json') return json(openapiDoc(url.origin));
        if (pathname === '/__spark/client.ts') {
          return new Response(clientTs(url.origin), {
            headers: { 'content-type': 'text/typescript; charset=utf-8', 'cache-control': 'no-cache' },
          });
        }

        // middleware.html runs first, on every request.
        if (routes.middleware) {
          const req = wrapReq(request, url, {}, session, srv);
          const res = { headers: {}, status: null };
          const out = await routes.middleware(req, res, mwState.rateLimit, mwState.state, makeAppFetch(req), mail);
          Object.assign(extraHeaders, res.headers);
          if (out && typeof out === 'object' && out.status) {
            return new Response(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? ''), {
              status: out.status, headers: extraHeaders,
            });
          }
        }
        const finish = (res) => {
          for (const [k, v] of Object.entries(extraHeaders)) res.headers.set(k, v);
          return res;
        };

        if (pathname.startsWith('/@modules/')) {
          const rest = pathname.slice('/@modules/'.length);
          const slash = rest.indexOf('/');
          const pkg = slash === -1 ? rest : rest.slice(0, slash);
          const subpath = slash === -1 ? '' : rest.slice(slash + 1);
          let mod = null;
          if (/^spark-html(-[\w-]+)?$/.test(pkg)) {
            const info = moduleEntry(pkg);
            if (info) {
              const file = resolve(info.dir, subpath || info.entry);
              if (file.startsWith(info.dir + '/') && existsSync(file) && statSync(file).isFile()) {
                mod = new Response(readFileSync(file, 'utf8'), {
                  headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' },
                });
              }
            }
          }
          return finish(mod || errorPage(404));
        }

        if (pathname.startsWith('/__spark/page/')) {
          const key = pathname.slice('/__spark/page/'.length).replace(/\.html$/, '');
          const page = pages.find((p) => p.key === key);
          if (!page) return finish(errorPage(404));
          const pd = pageData(page, cache, pagesDir);
          const tables = [...new Set(pd.blocks.filter((b) => b.table).map((b) => b.table))];
          const colsByTable = {};
          if (db) for (const t of tables) colsByTable[t] = await columnsOf(t);
          const autoBlock = pd.blocks.find((b) => b.table && b.auto !== undefined);
          // The host div's import path carries the route's :id/:slug forward
          // as a query string (see shell()) — every instance of this [param]
          // route shares the same /__spark/page/<key> URL, so without it the
          // generated component would have no way to know which row it's for.
          const routeParamsQS = url.search.slice(1);
          const html = clientComponent({
            html: pd.html, analysis: pd.analysis, plan: pd.plan, key,
            tables, colsByTable,
            liveTables: tables.filter((t) => liveTables.has(t)),
            authorScript: pd.code, auto: autoBlock ? autoBlock.auto : undefined,
            routeParamsQS,
          });
          return finish(new Response(html, { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } }));
        }

        // Per-request data: the .js module seeds the hydration component's
        // initial state; the .json mirror is what refresh() refetches. Both
        // re-run every declared source (table, SQL, URL, glob, module).
        if (pathname.startsWith('/__spark/data/')) {
          const json = pathname.endsWith('.json');
          const key = pathname.slice('/__spark/data/'.length).replace(/\.(js|json)$/, '');
          const page = pages.find((p) => p.key === key);
          if (!page) return finish(errorPage(404));
          const pd = pageData(page, cache, pagesDir);
          const req = wrapReq(request, url, {}, session, srv);
          const data = {};
          for (const p of pd.plan) data[p.var] = await resolveSource(p, req);
          // {session} the hydration component may read ({path} it derives from
          // location — the init module's own path is the data URL, not the page).
          if (pd.analysis.needs.has('session')) data.session = req.session;
          return finish(json
            ? new Response(JSON.stringify(data), {
                headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
              })
            : new Response(initModule(data), {
                headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' },
              }));
        }

        if (pathname.startsWith('/uploads/')) {
          const abs = resolve(join(uploadsDir, pathname.slice('/uploads/'.length)));
          if (abs.startsWith(uploadsDir) && existsSync(abs) && statSync(abs).isFile()) {
            return finish(new Response(Bun.file(abs)));
          }
          return finish(errorPage(404));
        }

        if (pathname.startsWith('/api/')) {
          const cors = corsHeaders(request.headers.get('origin'));
          if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: { ...(cors || {}), ...extraHeaders } });
          }
          const hit = matchApi(request.method, pathname);
          if (!hit) return finish(json({ error: 'not found' }, 404, cors || {}));
          const req = wrapReq(request, url, hit.params, session, srv);
          const res = await hit.route.handler(req, { headers: {} });

          // Answer a browser like a browser (§5): a plain form post that
          // succeeded 303s back (the _redirect field or the referrer) — the
          // app works with JavaScript disabled. A failed one re-renders the
          // referring page with {errors} (and {values}) in scope.
          const ct = request.headers.get('content-type') || '';
          const isForm = request.method !== 'GET'
            && (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data'));
          const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
          if (isForm && wantsHtml) {
            const { fields } = await req.body();
            const referer = request.headers.get('referer');
            let back = '/';
            try { if (referer) { const r = new URL(referer); back = r.pathname + r.search; } } catch { /* keep / */ }
            if (localPath(fields._redirect)) back = fields._redirect;
            if (res.status < 400) {
              const headers = new Headers({ location: back });
              const sc = res.headers.get('set-cookie');
              if (sc) headers.set('set-cookie', sc);
              // flash="…" on the form → a one-shot message on the next page.
              if (typeof fields._flash === 'string' && fields._flash) {
                headers.append('set-cookie', FLASH_COOKIE(signFlash(fields._flash, secret), { secure: req.secure }));
              }
              return finish(new Response(null, { status: 303, headers }));
            }
            let errors = null;
            try {
              const j = await res.clone().json();
              errors = j.errors || (j.error ? { _: j.error } : null);
            } catch { /* non-JSON error */ }
            if (errors && referer) {
              try {
                const r = new URL(referer);
                const rp = matchPage(pages, decodeURIComponent(r.pathname));
                if (rp) {
                  const rreq = wrapReq(request, r, rp.params, session, srv);
                  return finish(await servePage(rp.page, rreq, {
                    scope: { errors, values: fields }, status: res.status,
                  }));
                }
                // No page owns the referer — but a built-in auth screen might.
                // Bounce back to it with ?error so the form shows the message.
                const kind = builtinAuthKind(r.pathname);
                if (kind) {
                  const nx = r.searchParams.get('next');
                  const q = 'error=1' + (nx ? '&next=' + encodeURIComponent(nx) : '');
                  return finish(new Response(null, { status: 303, headers: { location: `${r.pathname}?${q}` } }));
                }
              } catch { /* fall through to the raw response */ }
            }
          }

          if (cors) for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
          return finish(res);
        }

        const file = staticFile(pathname);
        if (file) return finish(new Response(file));

        if (pathname === '/sitemap.xml') return finish(await sitemapXml(url.origin));
        if (pathname === '/robots.txt') return finish(robotsTxt(url.origin));

        const hit = matchPage(pages, pathname);
        if (hit) {
          const req = wrapReq(request, url, hit.params, session, srv);
          return finish(await servePage(hit.page, req));
        }

        // Built-in auth screens (only if auth is configured and no user page
        // claimed the route above). /logout clears the session and 303s home.
        if (config.auth && (pathname === '/logout')) {
          const secure = isHttps(url.protocol, request.headers.get('x-forwarded-proto'));
          return finish(new Response(null, {
            status: 303,
            headers: { location: '/', 'set-cookie': SESSION_COOKIE('', { clear: true, secure }) },
          }));
        }
        const authKind = builtinAuthKind(pathname);
        if (authKind && request.method === 'GET') {
          // A signed-in visitor never needs the login/signup form.
          if (session) return finish(new Response(null, { status: 303, headers: { location: '/' } }));
          return finish(new Response(authScreen(authKind, { next: url.searchParams.get('next'), error: url.searchParams.get('error') }),
            { headers: { 'content-type': 'text/html; charset=utf-8' } }));
        }

        return finish(errorPage(404));
      } catch (e) {
        if (!quiet) console.error(`[spark-ssr] ${request.method} ${pathname} — ${e.stack || e.message}`);
        const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
        const res = live && wantsHtml ? devErrorPage(e, pathname) : errorPage(500);
        for (const [k, v] of Object.entries(extraHeaders)) res.headers.set(k, v);
        return res;
      }
    },
  });

  ctx.port = server.port;
  if (!quiet) console.log(`⚡ spark-ssr serving ${root} on http://localhost:${server.port}`);
  return {
    port: server.port,
    root,
    config,
    db,
    stop(force) {
      if (watchTimer) clearInterval(watchTimer);
      for (const t of jobTimers) clearInterval(t);
      clearInterval(heartbeat);
      for (const c of sseClients) { try { c.close(); } catch { /* gone */ } }
      sseClients.clear();
      for (const c of liveClients) { try { c.close(); } catch { /* gone */ } }
      liveClients.clear();
      server.stop(force);
      return db && db.close();
    },
  };
}
