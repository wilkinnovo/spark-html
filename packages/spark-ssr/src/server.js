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
  extractBlocks, analyze, mergeAnalyses, dataPlan, rewriteParams, singleShaped,
  maskComments, extractForms, validateFields, sqlTables, singular,
} from './parse.js';
import { renderFragment, evalExpr } from './render.js';
import { clientComponent, initModule } from './hydrate.js';
import { urlSource, globSource, moduleSource, makeSourceCache } from './sources.js';
import { inferSchema, diffSchema, pushSchema, seedTables } from './schema.js';
// Head semantics live in one place for the whole family: spark-html-head owns
// title/meta on the client (pushState updates); its /ssr module owns them
// here — pages put literal <title>/<meta>/<link> tags in their markup, we
// lift them into the document head with {expr} interpolated per request.
import { liftHead, renderHead } from 'spark-html-head/ssr';

const AsyncFunction = (async () => {}).constructor;
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const dig = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

// Split the page's <script> (the server-side escape hatch) from its markup.
// Client scripts — <script src> and inline <script type="module"> — are NOT
// server code; they stay in the markup and liftHead sends them to the browser.
function splitScript(html) {
  let code = '';
  const { masked, restore } = maskComments(html);
  const out = restore(masked.replace(
    /<script\b(?![^>]*\bsrc=)(?![^>]*\btype\s*=\s*["']module["'])[^>]*>([\s\S]*?)<\/script>/gi,
    (m, body) => {
      code += body + '\n';
      return '';
    },
  ));
  return { html: out, code: code.trim() };
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
  const plan = dataPlan(analysis, blocks);
  const forms = parsed.flatMap((p) => p.forms);
  const head = mergeHeads(parsed.map((p) => p.head));
  const scripts = mergeScripts(parsed.map((p) => p.scripts));

  const data = { files: stamps, blocks, html: body, head, scripts, code, analysis, plan, forms };
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

// ── sessions ───────────────────────────────────────────────────────────
const b64 = (buf) => Buffer.from(buf).toString('base64url');
function signSession(payload, secret) {
  const data = b64(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(data).digest('base64url');
  return data + '.' + mac;
}
function readSession(cookieHeader, secret) {
  const jar = {};
  for (const part of String(cookieHeader || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1);
  }
  const raw = jar.spark_session;
  if (!raw) return null;
  const [data, mac] = raw.split('.');
  if (!data || !mac) return null;
  const expect = createHmac('sha256', secret).update(data).digest('base64url');
  try {
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch { return null; }
}
const SESSION_COOKIE = (value, clear = false) =>
  `spark_session=${clear ? '' : value}; Path=/; HttpOnly; SameSite=Lax${clear ? '; Max-Age=0' : ''}`;

// One-shot flash messages: a signed, read-once cookie. Set on a form's success
// 303 (flash="…") and exposed as ambient {flash} on the very next page, then
// cleared — the "Saved!" / "Signed out" toast every app needs, no state store.
function signFlash(msg, secret) {
  const data = b64(String(msg));
  return data + '.' + createHmac('sha256', secret).update(data).digest('base64url');
}
function readFlash(cookieHeader, secret) {
  const raw = String(cookieHeader || '').split(/;\s*/)
    .map((p) => p.split('=')).find((kv) => kv[0].trim() === 'spark_flash');
  if (!raw || !raw[1]) return null;
  const [data, mac] = raw[1].split('.');
  if (!data || !mac) return null;
  const expect = createHmac('sha256', secret).update(data).digest('base64url');
  try {
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch { return null; }
}
const FLASH_COOKIE = (value, clear = false) =>
  `spark_flash=${clear ? '' : value}; Path=/; SameSite=Lax${clear ? '; Max-Age=0' : ''}`;

// Roles in one column: an is_admin (or role) column on the auth table
// unlocks guard="session.is_admin" and unscoped reads for admins.
const isAdmin = (s) => !!s && (s.is_admin === 1 || s.is_admin === true || s.role === 'admin');

// ── serve ──────────────────────────────────────────────────────────────
export async function serve(options = {}) {
  const root = resolve(options.root || process.cwd());
  const config = { ...loadConfig(root), ...(options.config || {}) };
  const db = await connect(config.db, root);
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
  const broadcastSql = (sql) => {
    const event = /^\s*insert/i.test(sql) ? 'insert'
      : /^\s*update/i.test(sql) ? 'update'
      : /^\s*delete/i.test(sql) ? 'delete' : 'write';
    for (const t of sqlTables(sql)) fireEvent(event, t, null);
  };

  // ── declarative mail (Tier 3.8) ──
  // mail(msg) is ambient in page/api/middleware <script>s and jobs. A msg is
  // { to, subject, text, html, from } (or a bare string → text). The sender is
  // a module ("mail":"./lib/mail.js", default export (msg, ctx)), a webhook
  // ("mail":{ url, from, headers } → POST JSON), or a dev logger — so mail()
  // always resolves, wired or not (the zero-config default is "it logs").
  let mailSender = null;
  async function loadMailSender() {
    const m = config.mail;
    if (typeof m === 'string' && /\.(m?js|ts)$/i.test(m)) {
      const file = resolve(root, m.replace(/^\.\//, ''));
      if (!file.startsWith(root) || !existsSync(file)) return null;
      try {
        const mod = await import(pathToFileURL(file).href);
        return typeof mod.default === 'function' ? mod.default : null;
      } catch (e) { if (!quiet) console.warn(`[spark-ssr] "mail" module ${m} — ${e.message}`); return null; }
    }
    if (m && typeof m === 'object' && m.url) {
      return async (msg) => {
        const res = await fetch(m.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(m.headers || {}) },
          body: JSON.stringify({ from: m.from, ...msg }),
        });
        if (!res.ok) throw new Error(`mail webhook ${res.status}`);
        return { ok: true };
      };
    }
    return null;
  }
  const mail = async (msg = {}) => {
    const message = typeof msg === 'string' ? { text: msg } : (msg || {});
    if (mailSender) return mailSender(message, { db });
    if (!quiet) console.log(`[spark-ssr] mail (no sender configured) → to=${message.to ?? '?'} subject=${message.subject ?? ''}`);
    return { ok: false, logged: true };
  };

  // ── declarative jobs (Tier 3.8) ──
  // <spark-ssr job="digest" every="1d" /> schedules jobs/digest.js; job="onX"
  // on="insert:orders" runs it after every matching write. The job body is a
  // module the same shape as a data source — (req, db) — where `req` carries
  // the trigger (req.event, req.row) plus req.mail / req.fetch.
  const jobTimers = [];
  const jobs = new Set();          // job names whose schedule/hook is wired
  const eventHooks = new Map();    // "insert:orders" | "*:orders" → Set(jobName)
  function parseEvery(s) {
    const em = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
    if (!em) return 0;
    const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[(em[2] || 's').toLowerCase()];
    return Math.round(Number(em[1]) * mult);
  }
  function jobFile(name) {
    for (const rel of [`jobs/${name}.js`, `lib/jobs/${name}.js`]) {
      const f = resolve(root, rel);
      if (f.startsWith(root) && existsSync(f)) return f;
    }
    return null;
  }
  async function runJob(name, event, row) {
    const file = jobFile(name);
    if (!file) { if (!quiet) console.warn(`[spark-ssr] job "${name}" has no module (jobs/${name}.js)`); return; }
    try {
      const bust = live ? '?v=' + statSync(file).mtimeMs : '';
      const mod = await import(pathToFileURL(file).href + bust);
      if (typeof mod.default !== 'function') return;
      const req = {
        job: name, event, row: row || null,
        params: {}, query: {}, headers: {}, session: null,
        mail, fetch: makeAppFetch(null),
      };
      await mod.default(req, db);
    } catch (e) { if (!quiet) console.warn(`[spark-ssr] job "${name}" threw: ${e.message}`); }
  }
  function registerJob(b) {
    if (!b.job || jobs.has(b.job)) return;
    jobs.add(b.job);
    if (b.on) {
      const key = b.on.includes(':') ? b.on.toLowerCase() : '*:' + b.on.toLowerCase();
      (eventHooks.get(key) || eventHooks.set(key, new Set()).get(key)).add(b.job);
    }
    if (b.every) {
      const ms = parseEvery(b.every);
      if (ms) {
        const t = setInterval(() => { runJob(b.job, 'schedule', null); }, ms);
        t.unref?.();
        jobTimers.push(t);
      } else if (!quiet) {
        console.warn(`[spark-ssr] job "${b.job}" has an unparseable every="${b.every}"`);
      }
    }
  }
  // A write went through a table: refresh live/cache AND fire any job hooked to
  // that event. `broadcast` stays the pure live-channel primitive underneath.
  function fireEvent(event, table, row) {
    broadcast(table);
    const t = String(table).toLowerCase();
    for (const key of [event + ':' + t, '*:' + t]) {
      const set = eventHooks.get(key);
      if (set) for (const name of set) runJob(name, event + ':' + table, row);
    }
  }

  // ── the Spark family, wired in ──
  // Companion packages the app depends on get an importmap entry and are
  // served at /@modules/<name>, so client scripts import them bare — the same
  // packages a spark-html-bun/prerender build uses, working here unbundled.
  let familyDeps = [];
  try {
    const pj = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    familyDeps = Object.keys({ ...pj.dependencies, ...pj.devDependencies })
      .filter((n) => /^spark-html-[\w-]+$/.test(n));
  } catch { /* no package.json — single-file project */ }

  // spark-html-theme: inline its no-flash snippet in every <head> (the same
  // one spark-html-theme/bun bakes into prerendered pages) so the saved/OS
  // theme is on <html> before first paint.
  let themeInit = '';
  if (familyDeps.includes('spark-html-theme')) {
    try {
      const { themeInitScript } = await import('spark-html-theme/init');
      themeInit = `<script>${themeInitScript()}</script>`;
    } catch { /* older spark-html-theme without /init — theme() still works, with a flash */ }
  }

  // spark-html-font: `"fonts"` in spark.json renders the same head tags the
  // font/bun pipeline step bakes at build time — preloads, @font-face with a
  // size-adjusted fallback face, --font-<slug> vars.
  let fontTags = '';
  if (config.fonts) {
    try {
      const { fontHtml } = await import('spark-html-font');
      fontTags = fontHtml({ fonts: config.fonts });
    } catch (e) {
      if (!quiet) console.warn(`[spark-ssr] "fonts" configured but spark-html-font is not installed — ${e.message}`);
    }
  }

  // spark-html-image, at write time (Tier 3): uploaded rasters get a webp
  // sibling, and :file.url points at it (original stays as :file.original).
  const uploadWebp = familyDeps.includes('spark-html-image');

  // ── request wrapper ──
  function wrapReq(request, url, params, session, server) {
    const headers = {};
    for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
    let bodyMemo = null;
    const req = {
      raw: request,
      method: request.method,
      url: url.href,
      path: url.pathname,
      params,
      query: Object.fromEntries(url.searchParams),
      headers,
      session,
      ip: server?.requestIP?.(request)?.address || headers['x-forwarded-for'] || '',
      json: () => request.json(),
      text: () => request.text(),
      formData: () => request.formData(),
      body() {
        if (!bodyMemo) bodyMemo = parseBody(request);
        return bodyMemo;
      },
    };
    return req;
  }

  async function parseBody(request) {
    const ct = request.headers.get('content-type') || '';
    try {
      if (ct.includes('application/json')) {
        const fields = await request.json();
        return { fields: fields && typeof fields === 'object' ? fields : {}, file: null };
      }
      if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
        const fd = await request.formData();
        const fields = {};
        let file = null;
        for (const [k, v] of fd.entries()) {
          if (v && typeof v === 'object' && typeof v.arrayBuffer === 'function') {
            const ext = ((v.name || '').match(/\.\w+$/) || [''])[0];
            const name = randomUUID() + ext;
            mkdirSync(uploadsDir, { recursive: true });
            await Bun.write(join(uploadsDir, name), v);
            file = { url: '/uploads/' + name, original: '/uploads/' + name, name: v.name || name, size: v.size, type: v.type };
            if (uploadWebp && /\.(png|jpe?g)$/i.test(name)) {
              try {
                const sharp = (await import('sharp')).default;
                const webpName = name.replace(/\.\w+$/, '.webp');
                await sharp(join(uploadsDir, name)).webp({ quality: 82 }).toFile(join(uploadsDir, webpName));
                file.url = '/uploads/' + webpName;
              } catch { /* sharp unavailable — original serves fine */ }
            }
            fields[k] = file.url;
          } else {
            fields[k] = v;
          }
        }
        return { fields, file };
      }
    } catch { /* malformed body → empty */ }
    return { fields: {}, file: null };
  }

  // ── param injection: resolve one :token from the request ──
  async function resolveToken(tok, req) {
    if (tok.startsWith('body.')) return dig((await req.body()).fields, tok.slice(5)) ?? null;
    if (tok.startsWith('session.')) return dig(req.session || {}, tok.slice(8)) ?? null;
    if (tok.startsWith('header.')) return req.headers[tok.slice(7).toLowerCase()] ?? null;
    if (tok.startsWith('file.')) return dig((await req.body()).file || {}, tok.slice(5)) ?? null;
    if (req.params[tok] !== undefined) return req.params[tok];
    if (req.query[tok] !== undefined) return req.query[tok];
    return null;
  }

  async function runSql(sqlText, req, ttl = 0) {
    const { sql, tokens } = rewriteParams(sqlText);
    const values = [];
    for (const t of tokens) values.push(await resolveToken(t, req));
    if (!ttl) return db.query(sql, values);
    const key = 'q|' + sql + '|' + JSON.stringify(values);
    const hit = sourceCache.get(key);
    if (hit) return hit.value;
    const rows = await db.query(sql, values);
    sourceCache.set(key, rows, ttl, sqlTables(sqlText));
    return rows;
  }

  // ── auto-CRUD for <spark-ssr table="…"> ──
  const apiRoutes = []; // { method, segs: ['api','todos',':id'], handler }
  const on = (method, path, handler) =>
    apiRoutes.push({ method, segs: path.split('/').filter(Boolean), handler });

  // Block attributes per table (limit, search, live) and the form-derived
  // validation rules (§6) — both refreshed with the pages.
  const tableOpts = new Map();
  let validators = new Map();

  async function tableInfo(table) {
    const cols = await db.columns(table);
    const names = cols.map((c) => c.name);
    const scoped = !!config.auth && names.includes('user_id') && config.auth.table !== table;
    return { cols, names, scoped };
  }

  // List conventions (§10): ?page → LIMIT/OFFSET (+ .total/.pages on the
  // array), ?sort=col:dir validated against real columns, ?q across the
  // block's search="…" columns. Admins read unscoped (Tier 3 roles).
  async function tableRows(table, req, opts = {}) {
    const { names, scoped } = await tableInfo(table);
    const where = [];
    const values = [];
    if (scoped) {
      if (!req.session) return [];
      if (!isAdmin(req.session)) { where.push('user_id = ?'); values.push(req.session.id); }
    }
    if (opts.search && req.query.q) {
      const cols = opts.search.filter((c) => names.includes(c));
      if (cols.length) {
        where.push('(' + cols.map((c) => `${c} LIKE ?`).join(' OR ') + ')');
        for (const c of cols) { values.push('%' + req.query.q + '%'); void c; }
      }
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    let sql = `SELECT * FROM ${table}` + whereSql;
    const sm = String(req.query.sort || '').match(/^(\w+)(?::(asc|desc))?$/i);
    if (sm && names.includes(sm[1])) sql += ` ORDER BY ${sm[1]} ${(sm[2] || 'asc').toUpperCase()}`;
    const paged = req.query.page !== undefined || opts.limit;
    if (!paged) return db.query(sql, values);
    const size = opts.limit || 20;
    const pageN = Math.max(1, Number(req.query.page) || 1);
    const totalRows = await db.query(`SELECT COUNT(*) AS n FROM ${table}` + whereSql, values);
    const total = Number(totalRows[0]?.n ?? 0);
    const rows = [...await db.query(sql + ` LIMIT ${size} OFFSET ${(pageN - 1) * size}`, values)];
    rows.total = total;
    rows.pages = Math.max(1, Math.ceil(total / size));
    rows.page = pageN;
    return rows;
  }

  function registerTable(table) {
    const isAuthTable = config.auth && config.auth.table === table;

    on('GET', `api/${table}`, async (req) => {
      const { scoped } = await tableInfo(table);
      if (scoped && !req.session) return json({ error: 'unauthorized' }, 401);
      const rows = await tableRows(table, req, tableOpts.get(table) || {});
      // Password hashes never leave the auth table, not even to a session.
      if (isAuthTable) for (const r of rows) delete r.password;
      return json(isAuthTable ? [...rows] : rows);
    });

    on('POST', `api/${table}`, async (req) => {
      if (isAuthTable && 'auth' in req.query) return login(req);
      const { names, scoped } = await tableInfo(table);
      if (scoped && !req.session) return json({ error: 'unauthorized' }, 401);
      const { fields } = await req.body();
      // The markup's constraint attributes are the validation spec (§6).
      const rules = validators.get(table);
      if (rules) {
        const errors = validateFields(rules, fields);
        if (errors) return json({ errors }, 422);
      }
      const data = {};
      for (const [k, v] of Object.entries(fields)) {
        if (names.includes(k) && k !== 'id' && k !== 'user_id') data[k] = v;
      }
      // Passwords never land in the auth table as plaintext.
      if (isAuthTable && typeof data.password === 'string') {
        data.password = await Bun.password.hash(data.password);
      }
      if (scoped) data.user_id = req.session.id;
      const keys = Object.keys(data);
      if (!keys.length) return json({ error: 'empty body' }, 400);
      const rows = await db.query(
        `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING *`,
        keys.map((k) => data[k]),
      );
      fireEvent('insert', table, rows[0] ?? null);
      const row = rows[0] ?? { ok: true };
      if (isAuthTable && row.password) delete row.password;
      return json(row, 201);
    });

    // Auth-table writes are own-account only: anyone could otherwise reset
    // the author's password or delete their account through the auto CRUD.
    const ownAccountOnly = (req) =>
      isAuthTable && (!req.session || String(req.session.id) !== String(req.params.id));

    on('PATCH', `api/${table}/:id`, async (req) => {
      const { names, scoped } = await tableInfo(table);
      if (scoped && !req.session) return json({ error: 'unauthorized' }, 401);
      if (ownAccountOnly(req)) return json({ error: 'unauthorized' }, 401);
      const { fields } = await req.body();
      const rules = validators.get(table);
      if (rules) {
        const errors = validateFields(rules, fields, { partial: true });
        if (errors) return json({ errors }, 422);
      }
      const data = {};
      for (const [k, v] of Object.entries(fields)) {
        if (names.includes(k) && k !== 'id' && k !== 'user_id') data[k] = v;
      }
      if (isAuthTable && typeof data.password === 'string') {
        data.password = await Bun.password.hash(data.password);
      }
      const keys = Object.keys(data);
      if (!keys.length) return json({ error: 'empty body' }, 400);
      let sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
      const values = [...keys.map((k) => data[k]), req.params.id];
      if (scoped && !isAdmin(req.session)) { sql += ' AND user_id = ?'; values.push(req.session.id); }
      const rows = await db.query(sql + ' RETURNING *', values);
      fireEvent('update', table, rows[0] ?? null);
      const row = rows[0];
      if (isAuthTable && row) delete row.password;
      return row ? json(row) : json({ error: 'not found' }, 404);
    });

    on('DELETE', `api/${table}/:id`, async (req) => {
      const { scoped } = await tableInfo(table);
      if (scoped && !req.session) return json({ error: 'unauthorized' }, 401);
      if (ownAccountOnly(req)) return json({ error: 'unauthorized' }, 401);
      let sql = `DELETE FROM ${table} WHERE id = ?`;
      const values = [req.params.id];
      if (scoped && !isAdmin(req.session)) { sql += ' AND user_id = ?'; values.push(req.session.id); }
      const rows = await db.query(sql + ' RETURNING *', values);
      fireEvent('delete', table, rows[0] ?? null);
      return rows[0] ? json({ ok: true }) : json({ error: 'not found' }, 404);
    });
  }

  // ── auth ──
  async function login(req) {
    const { auth } = config;
    const identity = auth.identity || 'email';
    const { fields } = await req.body();
    const rows = await db.query(`SELECT * FROM ${auth.table} WHERE ${identity} = ?`, [fields[identity] ?? null]);
    const user = rows[0];
    const supplied = String(fields.password ?? '');
    const stored = user ? String(user.password ?? '') : '';
    const ok = user && (stored.startsWith('$')
      ? await Bun.password.verify(supplied, stored).catch(() => false)
      : stored !== '' && stored === supplied);
    if (!ok) return json({ error: 'invalid credentials' }, 401);
    const session = { id: user.id, [identity]: user[identity] };
    // Roles ride in the session: is_admin / role columns, when they exist.
    if ('is_admin' in user) session.is_admin = user.is_admin;
    if ('role' in user) session.role = user.role;
    const safe = { ...user };
    delete safe.password;
    return json(safe, 200, { 'set-cookie': SESSION_COOKIE(signSession(session, secret)) });
  }

  let authPlugin = null;
  if (config.auth && config.auth.plugin) {
    authPlugin = (await import(resolve(root, config.auth.plugin))).default;
    on('POST', 'api/auth', async (req) => {
      const user = await authPlugin.login(req);
      if (!user) return json({ error: 'invalid credentials' }, 401);
      const session = { id: user.id, email: user.email, name: user.name };
      if (user.is_admin !== undefined) session.is_admin = user.is_admin;
      if (user.role !== undefined) session.role = user.role;
      return json(user, 200, { 'set-cookie': SESSION_COOKIE(signSession(session, secret)) });
    });
  }
  if (config.auth) {
    on('POST', 'api/logout', async () => json({ ok: true }, 200, { 'set-cookie': SESSION_COOKIE('', true) }));
  }

  // ── explicit <spark-ssr> query endpoints ──
  // Defs are mutable so an edited page's SQL takes effect without a restart —
  // the registered handler reads def.sql at call time.
  const queryDefs = new Map();
  function registerQuery(route) {
    const key = route.method + ' ' + route.path;
    const existing = queryDefs.get(key);
    if (existing) { existing.sql = route.sql; existing.cache = route.cache || 0; return; }
    const def = { sql: route.sql, cache: route.cache || 0 };
    queryDefs.set(key, def);
    const segs = route.path.split('/').filter(Boolean)
      .map((s) => s.replace(/^\[(\w+)\]$/, ':$1'));
    apiRoutes.push({
      method: route.method,
      segs,
      handler: async (req) => {
        const rows = await runSql(def.sql, req, route.method === 'GET' ? def.cache : 0);
        if (route.method !== 'GET') broadcastSql(def.sql);
        if (route.method === 'GET') return json(singleShaped(def.sql) ? rows[0] ?? null : [...rows]);
        if (Array.isArray(rows) && rows.length) return json(rows.length === 1 ? rows[0] : [...rows]);
        return json({ ok: true, changes: rows.changes ?? 0 });
      },
    });
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
    validators = nextValidators;
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
    schemaDirty = false;
  }
  mailSender = await loadMailSender();
  refreshPages();
  await ensureSchema();

  // ── api/ folder — custom endpoints ──
  function makeAppFetch(req) {
    return (input, init = {}) => {
      let url = String(input);
      if (url.startsWith('/')) url = `http://localhost:${ctx.port}${url}`;
      init = { ...init };
      const b = init.body;
      const isPlainObject = b && typeof b === 'object'
        && !(b instanceof FormData) && !(b instanceof URLSearchParams)
        && !(b instanceof ArrayBuffer) && typeof b.arrayBuffer !== 'function'
        && typeof b.getReader !== 'function';
      if (isPlainObject) {
        init.body = JSON.stringify(b);
        init.headers = { 'content-type': 'application/json', ...(init.headers || {}) };
      }
      if (req && req.headers.cookie) init.headers = { cookie: req.headers.cookie, ...(init.headers || {}) };
      return fetch(url, init);
    };
  }

  // api/ files re-scan per request too; script handlers hold a mutable def so
  // edits take effect, and registration itself happens once per route.
  const apiDefs = new Map(); // route path → { mtime, fn }
  function refreshApi() {
    const apiDir = join(root, 'api');
    if (!existsSync(apiDir)) return;
    (function scanApi(dir, prefix) {
      for (const f of readdirSync(dir)) {
        if (f.startsWith('.')) continue;
        const full = join(dir, f);
        if (statSync(full).isDirectory()) { scanApi(full, prefix + f + '/'); continue; }
        if (!f.endsWith('.html')) continue;
        const route = '/api/' + prefix + f.slice(0, -5);
        const mtime = statSync(full).mtimeMs;
        let def = apiDefs.get(route);
        if (def && def.mtime === mtime) continue;
        if (!def) { def = { mtime: 0, fn: null, registered: false }; apiDefs.set(route, def); }
        def.mtime = mtime;
        const source = readFileSync(full, 'utf8');
        const { blocks, html } = extractBlocks(source);
        const { code } = splitScript(html);
        for (const b of blocks) {
          for (const r of b.routes) registerQuery({ ...r, path: r.path || route, cache: b.cache });
        }
        def.fn = null;
        if (code) {
          try { def.fn = new AsyncFunction('req', 'res', 'db', 'fetch', 'mail', code); }
          catch (e) { if (!quiet) console.warn(`[spark-ssr] ${route} <script> — ${e.message}`); }
        }
        if (def.fn && !def.registered) {
          def.registered = true;
          const segs = route.split('/').filter(Boolean);
          for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
            apiRoutes.push({
              method,
              segs,
              handler: async (req, res) => {
                if (!def.fn) return json({ error: 'not found' }, 404);
                const out = await def.fn(req, res, db, makeAppFetch(req), mail);
                if (out instanceof Response) return out;
                if (out && typeof out === 'object' && 'status' in out && 'body' in out) {
                  return new Response(typeof out.body === 'string' ? out.body : JSON.stringify(out.body), { status: out.status });
                }
                return json(out ?? { ok: true });
              },
            });
          }
        }
      }
    })(apiDir, '');
  }
  refreshApi();

  function matchApi(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    outer: for (const r of apiRoutes) {
      if (r.method !== method || r.segs.length !== parts.length) continue;
      const params = {};
      for (let i = 0; i < parts.length; i++) {
        if (r.segs[i].startsWith(':')) params[r.segs[i].slice(1)] = decodeURIComponent(parts[i]);
        else if (r.segs[i] !== parts[i]) continue outer;
      }
      return { route: r, params };
    }
    return null;
  }

  // ── middleware.html (reloaded when the file changes) ──
  let middleware = null;
  let mwMtime = -1;
  const mwState = { rateLimit: new Map(), state: {} };
  function refreshMiddleware() {
    const mwFile = join(root, 'middleware.html');
    if (!existsSync(mwFile)) { middleware = null; mwMtime = -1; return; }
    const mtime = statSync(mwFile).mtimeMs;
    if (mtime === mwMtime) return;
    mwMtime = mtime;
    middleware = null;
    const { code } = splitScript(readFileSync(mwFile, 'utf8'));
    if (code) {
      try { middleware = new AsyncFunction('req', 'res', 'rateLimit', 'state', 'fetch', 'mail', code); }
      catch (e) { if (!quiet) console.warn(`[spark-ssr] middleware.html — ${e.message}`); }
    }
  }
  refreshMiddleware();

  // ── CORS ──
  function corsHeaders(origin) {
    if (!config.cors) return null;
    const allowed = config.cors === true ? '*'
      : Array.isArray(config.cors) && origin && config.cors.includes(origin) ? origin : null;
    if (!allowed) return null;
    return {
      'access-control-allow-origin': allowed,
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      ...(allowed !== '*' ? { vary: 'origin' } : {}),
    };
  }

  // ── components + static ──
  async function loadComponent(spec) {
    let rel = String(spec).split(/[?#]/)[0].replace(/^\/+/, '');
    if (!rel.endsWith('.html')) rel += '.html';
    for (const base of [root, join(root, 'public'), pagesDir]) {
      const file = resolve(base, rel);
      if (file.startsWith(base) && existsSync(file) && statSync(file).isFile()) {
        return readFileSync(file, 'utf8');
      }
    }
    return null;
  }

  function staticFile(pathname) {
    const rel = pathname.replace(/^\/+/, '');
    if (!rel || rel.includes('..')) return null;
    const candidates = [join(root, 'public', rel)];
    const ext = extname(rel);
    // The root fallback exists for co-located assets (pages/x.css, img/…) —
    // it must never serve project internals: config (may hold secrets),
    // lockfiles, databases, dotfiles, seed data. public/ stays intentional.
    const internal = rel.startsWith('.') || rel.includes('/.')
      || rel.startsWith('seed/')
      || ['spark.json', 'package.json', 'bun.lock', 'bun.lockb', 'package-lock.json'].includes(rel)
      || ['.db', '.sqlite', '.sqlite3'].includes(ext);
    if (!internal && ext && ext !== '.html') {
      candidates.push(join(root, rel), join(pagesDir, rel));
    } else if (!internal && rel.startsWith('components/')) {
      candidates.push(join(root, rel));
    }
    for (const file of candidates) {
      const abs = resolve(file);
      if (!abs.startsWith(root)) continue;
      if (seedFiles.has(abs)) continue;
      if (existsSync(abs) && statSync(abs).isFile()) return Bun.file(abs);
    }
    return null;
  }

  // ── page rendering ──
  const namesOf = (code) =>
    [...String(code).matchAll(/^\s*(?:let|const|var)\s+([a-zA-Z_$][\w$]*)/gm)].map((m) => m[1]);

  async function runPageScript(code, req) {
    const names = namesOf(code);
    const fn = new AsyncFunction('req', 'db', 'fetch', 'mail', code + '\n;return { ' + names.join(', ') + ' };');
    try { return await fn(req, db, makeAppFetch(req), mail); }
    catch (e) {
      if (!quiet) console.warn(`[spark-ssr] page <script> threw: ${e.message}`);
      if (live) e.__sparkPageScript = true;
      return {};
    }
  }

  function shouldHydrate(pd) {
    return pd.analysis.interactive && !pd.analysis.hasScript
      && pd.blocks.some((b) => b.table) && !!db;
  }

  // Open Graph completeness (Tier 3): og:title / og:description derive from
  // the lifted <title> and description unless the page overrides them.
  function withOgTags(head) {
    let out = head;
    const title = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const desc = (head.match(/<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1]
      || (head.match(/<meta\b[^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*\bname\s*=\s*["']description["']/i) || [])[1];
    if (title && !/property\s*=\s*["']og:title/i.test(head)) {
      out += `\n<meta property="og:title" content="${title.trim()}">`;
    }
    if (desc && !/property\s*=\s*["']og:description/i.test(head)) {
      out += `\n<meta property="og:description" content="${desc}">`;
    }
    return out;
  }

  function shell(page, body, { hydrate, mount, headExtra = '', scripts = '' }) {
    const title = page.key === 'index' ? 'Spark' : page.key.split('/').pop().replace(/\[|\]/g, '');
    const cssRel = page.key + '.css';
    const hasCss = existsSync(join(pagesDir, cssRel));
    // The importmap must precede EVERY module script in document order (a
    // later one is ignored), so the whole module story lives in <head>:
    // importmap → the page's own client scripts → mount. Page scripts are
    // the app's bootstrap (store()/theme() setup) and modules execute in
    // document order, so they run before components boot — same contract as
    // a hand-written main.js that ends with mount().
    const needModules = mount || scripts.includes('<script');
    const imports = {};
    for (const dep of ['spark-html', ...familyDeps]) {
      const info = moduleEntry(dep);
      if (info) imports[dep] = `/@modules/${dep}/${info.entry}`;
    }
    const importmap = needModules
      ? `<script type="importmap">${JSON.stringify({ imports })}</script>\n`
      : '';
    const mountJs = mount
      ? `<script type="module">import { mount } from 'spark-html'; mount();</script>\n`
      : '';
    const head =
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      (themeInit ? themeInit + '\n' : '') +
      (/<title\b/i.test(headExtra) ? '' : `<title>${title}</title>\n`) +
      (headExtra ? headExtra + '\n' : '') +
      (fontTags ? fontTags + '\n' : '') +
      importmap +
      (scripts ? scripts + '\n' : '') +
      mountJs +
      (hasCss ? `<link rel="stylesheet" href="/${cssRel}">\n` : '');
    // A hydrating page host carries BOTH `import` and `name` — that is the
    // runtime's flash-free hydrate contract (same as spark-prerender's
    // makeHydratable): the pre-rendered content stays visible while the
    // component is fetched and booted detached, then swaps in atomically.
    // `name` missing would make the runtime treat the rendered HTML as SLOT
    // content and project it next to the fresh render — duplicated live UI.
    const compName = page.key.replace(/.*\//, '');
    const host = hydrate
      ? `<div import="/__spark/page/${page.key}" name="${compName}" data-spark-ssr>${body}</div>`
      : `<div data-spark-ssr>${body}</div>`;
    const reload = live ? RELOAD_CLIENT + '\n' : '';
    return `<!doctype html>\n<html>\n<head>\n${head}</head>\n<body>\n${host}\n${reload}</body>\n</html>\n`;
  }

  // Resolve one plan entry — table, query, named SQL, URL, glob, module —
  // honoring the block's cache="…" TTL.
  async function resolveSource(p, req) {
    const src = p.source;
    const ttl = (src.opts && src.opts.cache) || 0;
    if (src.kind === 'table') {
      if (!ttl) return tableRows(src.table, req, src.opts || {});
      const key = ['t', src.table, req.session?.id ?? '', req.query.q ?? '', req.query.sort ?? '', req.query.page ?? ''].join('|');
      const hit = sourceCache.get(key);
      if (hit) return hit.value;
      const rows = await tableRows(src.table, req, src.opts || {});
      sourceCache.set(key, rows, ttl, new Set([src.table]));
      return rows;
    }
    if (src.kind === 'query' || src.kind === 'sql') {
      const sql = src.kind === 'query' ? src.route.sql : src.binding.sql;
      const rows = await runSql(sql, req, ttl);
      return p.shape === 'list' ? [...rows] : rows[0] ?? null;
    }
    if (src.kind === 'url') {
      const key = 'u|' + src.binding.value + '|' + JSON.stringify(req.params) + '|' + (req.query.q ?? '');
      if (ttl) {
        const hit = sourceCache.get(key);
        if (hit) return hit.value;
      }
      const value = await urlSource(src.binding.value, req);
      if (ttl) sourceCache.set(key, value, ttl);
      return value;
    }
    if (src.kind === 'glob') {
      const key = 'g|' + src.binding.value;
      if (ttl) {
        const hit = sourceCache.get(key);
        if (hit) return hit.value;
      }
      const value = globSource(src.binding.value, root);
      if (ttl) sourceCache.set(key, value, ttl);
      return value;
    }
    if (src.kind === 'module') {
      return moduleSource(src.binding.value, root, req, db, { watch: live });
    }
    return null;
  }

  async function buildScope(pd, req) {
    // `path`, `session` and `flash` are ambient — no query declares them. The
    // layout reads {session} for the signed-in user and {flash} (or the
    // <spark-flash> toast) for the one-shot message from the last redirect.
    const scope = { path: req.path, flash: readFlash(req.headers.cookie, secret), ...req.query, ...req.params, session: req.session };
    if (pd.code) Object.assign(scope, await runPageScript(pd.code, req));
    for (const p of pd.plan) {
      if (scope[p.var] !== undefined) continue; // the page <script> won
      scope[p.var] = await resolveSource(p, req);
    }
    // Relations (§): each="c in post.comments" attaches the child rows onto the
    // parent object(s) via the inferred foreign key — one small query per
    // parent, no JOIN in the template. Identifiers come from the parsed
    // template (word chars only), so they're safe to interpolate.
    for (const r of pd.analysis.relations || []) {
      const parent = scope[r.parent];
      if (parent == null) continue;
      const fk = singular(r.parent) + '_id';
      const attach = async (obj) => {
        if (!obj || obj.id == null || obj[r.rel] !== undefined) return;
        try { obj[r.rel] = await db.query(`SELECT * FROM ${r.rel} WHERE ${fk} = ?`, [obj.id]); }
        catch { obj[r.rel] = []; }
      };
      if (Array.isArray(parent)) { for (const o of parent) await attach(o); }
      else await attach(parent);
    }
    return scope;
  }

  // The dev banner for the silent-blank class of bug: "this page reads
  // {posts} but no source provides it — nearest source: published".
  function unresolvedBanner(unresolved) {
    const items = unresolved.map((u) =>
      `<code>{${escapeHtml(u.name)}}</code>${u.nearest ? ` — nearest source: <code>${escapeHtml(u.nearest)}</code>` : ''}`).join('; ');
    return '<div style="position:fixed;bottom:0;left:0;right:0;background:#7c2d12;color:#fed7aa;'
      + 'font:13px/1.6 monospace;padding:8px 14px;z-index:99999">'
      + `spark-ssr: this page reads ${items} but no source provides it</div>`;
  }

  async function servePage(page, req, extra = null) {
    const pd = pageData(page, cache, pagesDir);
    const scope = await buildScope(pd, req);
    if (extra) Object.assign(scope, extra.scope || {});

    // Declarative guard (§3): <spark-ssr guard="session" redirect="/login" />.
    // With auth configured, a bare `guard="session"` (no redirect, no status)
    // defaults to sending the visitor to /login with a ?next back to here —
    // the built-in login form returns them once they sign in.
    for (const b of pd.blocks) {
      if (!b.guard) continue;
      if (!evalExpr(b.guard, scope)) {
        if (b.redirect) return new Response(null, { status: 303, headers: { location: b.redirect } });
        if (config.auth && !b.status) {
          return new Response(null, { status: 303, headers: { location: '/login?next=' + encodeURIComponent(req.path) } });
        }
        return errorPage(b.status || 403);
      }
    }

    // Auto-404 (§3): a dynamic [param] page that looks up one row and finds
    // nothing IS a 404 — no need to hand-write <template else status="404">.
    // Only fires when the page reads that row as an object ({post.title}); an
    // explicit if/else branch in the page opts out (it renders its own answer),
    // and form re-renders (extra.status) are left alone.
    if (!extra && page.segs.some((s) => s.startsWith('['))
      && !/<template\b[^>]*\b(?:else|else-if)\b/i.test(pd.html)) {
      for (const p of pd.plan) {
        if (p.shape === 'row' && pd.analysis.memberRoots.has(p.var) && scope[p.var] == null) {
          return errorPage(404);
        }
      }
    }

    const hydrate = shouldHydrate(pd);
    // Component imports keep their host (import + name + props) on pages the
    // page host won't rebuild wholesale, so a client mount re-resolves them
    // and their own <script> comes alive (counters, demos, …).
    const hasComponents = /\bimport\s*=\s*"/.test(pd.html);
    const rctx = { loadComponent, keepImports: !hydrate, dev: live };
    let body = await renderFragment(pd.html, scope, rctx);
    // <spark-flash/> — a drop-in styled toast that shows the one-shot {flash}
    // message and nothing when there isn't one. Layout writes it once.
    if (/<spark-flash\b/i.test(body)) {
      body = body.replace(/<spark-flash\b[^>]*>(?:\s*<\/spark-flash>)?/gi, () => flashToast(scope.flash));
    }
    // <spark-pager for="posts"/> and <spark-search/> — the default UI over the
    // list conventions (§10): ?page/?sort links and a ?q search box, no wiring.
    if (/<spark-pager\b/i.test(body)) {
      body = body.replace(/<spark-pager\b([^>]*)>(?:\s*<\/spark-pager>)?/gi, (_m, attrs) => {
        const name = (attrs.match(/\bfor\s*=\s*"([^"]*)"/) || [])[1];
        return pagerHtml(name ? scope[name] : null, req.query);
      });
    }
    if (/<spark-search\b/i.test(body)) {
      body = body.replace(/<spark-search\b([^>]*)>(?:\s*<\/spark-search>)?/gi, (_m, attrs) => {
        const ph = (attrs.match(/\bplaceholder\s*=\s*"([^"]*)"/) || [])[1] || 'Search…';
        return searchHtml(req.query, ph);
      });
    }
    let headExtra = pd.head ? renderHead(pd.head, (e) => evalExpr(e, scope)) : '';
    if (headExtra) headExtra = withOgTags(headExtra);
    let html = shell(page, body, {
      hydrate, mount: hydrate || hasComponents, headExtra, scripts: pd.scripts,
    });
    if (live && pd.plan.unresolved && pd.plan.unresolved.length) {
      html = html.replace('</body>', unresolvedBanner(pd.plan.unresolved) + '\n</body>');
    }
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    // A shown flash is consumed — clear the cookie so it appears exactly once.
    if (scope.flash) headers['set-cookie'] = FLASH_COOKIE('', true);
    return new Response(html, {
      status: (extra && extra.status) || rctx.status || 200,
      headers,
    });
  }

  // The default flash toast (self-contained, design-system styled). Empty when
  // there's no message, so <spark-flash/> can live permanently in the layout.
  function flashToast(msg) {
    if (!msg) return '';
    return '<div role="status" style="position:fixed;left:50%;bottom:1.25rem;transform:translateX(-50%);'
      + 'z-index:9999;max-width:90vw;background:#ffd24a;color:#000;font-weight:700;'
      + 'font-family:inherit;font-size:.85rem;padding:.6rem 1rem;border-radius:10px;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.35)">' + escapeHtml(msg) + '</div>';
  }

  // <spark-pager for="posts"/> — numbered prev/next links over a list source's
  // .page/.pages, preserving the current ?q/?sort. Renders nothing for a single
  // page. Server-side only; a plain <a> nav, so it works with JS disabled.
  function pagerHtml(list, query) {
    if (!list || !(list.pages > 1)) return '';
    const cur = Number(list.page) || 1;
    const last = Number(list.pages);
    const base = { ...query };
    delete base.page;
    const href = (p) => {
      const q = new URLSearchParams(base);
      q.set('page', String(p));
      return '?' + q.toString();
    };
    const cell = 'min-width:2rem;text-align:center;padding:.35rem .55rem;border-radius:8px;'
      + 'border:1px solid #333;font-size:.85rem;text-decoration:none;color:inherit';
    const item = (p, label, { on, off } = {}) => off
      ? `<span style="${cell};opacity:.35">${label}</span>`
      : on
        ? `<span aria-current="page" style="${cell};background:#ffd24a;color:#000;border-color:#ffd24a;font-weight:700">${label}</span>`
        : `<a href="${href(p)}" style="${cell}">${label}</a>`;
    const nums = [];
    for (let p = 1; p <= last; p++) {
      if (p === 1 || p === last || Math.abs(p - cur) <= 1) nums.push(p);
      else if (nums[nums.length - 1] !== '…') nums.push('…');
    }
    const parts = [item(cur - 1, '‹', { off: cur <= 1 })];
    for (const n of nums) {
      parts.push(n === '…' ? `<span style="${cell};border-color:transparent">…</span>` : item(n, String(n), { on: n === cur }));
    }
    parts.push(item(cur + 1, '›', { off: cur >= last }));
    return '<nav class="spark-pager" role="navigation" aria-label="Pagination" '
      + 'style="display:flex;gap:.35rem;justify-content:center;align-items:center;flex-wrap:wrap;margin:1.25rem 0">'
      + parts.join('') + '</nav>';
  }

  // <spark-search placeholder="Search…"/> — a no-JS GET search box bound to ?q,
  // carrying the current ?sort so a search doesn't drop the sort order.
  function searchHtml(query, placeholder) {
    const sort = query.sort ? `<input type="hidden" name="sort" value="${escapeHtml(query.sort)}">` : '';
    return '<form method="get" role="search" class="spark-search" style="margin:0 0 1.25rem">'
      + sort
      + `<input type="search" name="q" value="${escapeHtml(query.q || '')}" placeholder="${escapeHtml(placeholder)}" `
      + 'style="width:100%;font:inherit;color:inherit;background:transparent;border:1px solid #333;'
      + 'border-radius:8px;padding:.5rem .7rem"></form>';
  }

  // Human copy for the built-in default error screen (used when the app ships
  // no <status>.html of its own).
  const STATUS_INFO = {
    400: ['Bad request', 'That request could not be understood.'],
    401: ['Sign in required', 'You need to sign in to view this page.'],
    403: ['Forbidden', "You don't have access to this page."],
    404: ['Page not found', "The page you're looking for doesn't exist — it may have moved."],
    500: ['Server error', 'Something went wrong on our end. Try again in a moment.'],
  };

  // Zero-config error screen: a styled, self-contained page in the Spark design
  // system (dark default, gold ⚡, monospace) — no dependency on the app's
  // layout or data, so it renders even when those are what failed. Apps override
  // it by dropping a <status>.html in pages/ (or the project root).
  function defaultErrorPage(status) {
    const [title, blurb] = STATUS_INFO[status] || ['Error', 'Something went wrong.'];
    const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${status} · ${escapeHtml(title)}</title>
<style>
  :root{color-scheme:dark light}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#000;color:#fff;text-align:center;padding:2rem;
    font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6}
  @media(prefers-color-scheme:light){body{background:#fff;color:#1a1a1a}}
  .bolt{font-size:2.25rem;filter:drop-shadow(0 0 16px rgba(255,210,74,.45))}
  .code{font-size:clamp(3.5rem,14vw,6rem);font-weight:800;letter-spacing:-.04em;margin:.25rem 0 0;
    background:linear-gradient(110deg,currentColor,#ffd24a);-webkit-background-clip:text;background-clip:text;color:transparent}
  h1{font-size:1.15rem;font-weight:700;margin:.25rem 0 .5rem}
  p{color:#888;max-width:32rem;margin:0 auto 1.5rem;font-size:.95rem}
  @media(prefers-color-scheme:light){p{color:#666}}
  a{display:inline-block;color:#000;background:#ffd24a;text-decoration:none;font-weight:700;
    padding:.6rem 1.2rem;border-radius:8px;font-size:.9rem}
  a:active{transform:scale(.97)}
</style></head>
<body><main>
  <div class="bolt">⚡</div>
  <div class="code">${status}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(blurb)}</p>
  <a href="/">← Back home</a>
</main></body></html>`;
    return body;
  }

  function errorPage(status) {
    // Override precedence: pages/<status>.html (filesystem convention) →
    // <root>/<status>.html (back-compat) → the built-in default.
    for (const dir of new Set([pagesDir, root])) {
      const file = join(dir, `${status}.html`);
      if (existsSync(file)) {
        // The reload client rides along so fixing the page un-sticks the browser.
        const custom = readFileSync(file, 'utf8') + (live ? '\n' + RELOAD_CLIENT : '');
        return new Response(custom, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    }
    const body = defaultErrorPage(status) + (live ? '\n' + RELOAD_CLIENT : '');
    return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  // Built-in, overridable auth screens. Configuring `auth` in spark.json is
  // enough to get working /login, /logout and /signup — no page to write. Drop
  // a pages/login.html (etc.) to override; a user page always wins the route.
  // These are self-contained (design system inline) so they render before any
  // layout or data exists — same robustness contract as the error pages.
  function authScreen(kind, { next, error } = {}) {
    const identity = (config.auth && config.auth.identity) || 'email';
    const table = config.auth && config.auth.table;
    const idType = /email/i.test(identity) ? 'email' : 'text';
    const nextField = next && String(next).startsWith('/') ? escapeHtml(next) : '';
    const isSignup = kind === 'signup';
    const action = isSignup ? `/api/${table}` : `/api/${table}?auth`;
    const title = isSignup ? 'Create account' : 'Sign in';
    const errMsg = error
      ? (isSignup ? 'Could not create that account — it may already exist.' : 'Wrong ' + identity + ' or password.')
      : '';
    const alt = isSignup
      ? `Already have an account? <a href="/login${nextField ? '?next=' + encodeURIComponent(nextField) : ''}">Sign in</a>`
      : `Need an account? <a href="/signup${nextField ? '?next=' + encodeURIComponent(nextField) : ''}">Create one</a>`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root{color-scheme:dark light}*{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#000;color:#fff;padding:2rem;
    font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6}
  @media(prefers-color-scheme:light){body{background:#fff;color:#1a1a1a}}
  form{width:100%;max-width:22rem;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:12px;padding:1.75rem}
  @media(prefers-color-scheme:light){form{background:#fafafa;border-color:#ededed}}
  .bolt{font-size:1.5rem;text-align:center;filter:drop-shadow(0 0 14px rgba(255,210,74,.45))}
  h1{font-size:1.15rem;font-weight:700;text-align:center;margin:.25rem 0 1.25rem}
  label{display:block;font-size:.8rem;color:#888;margin:0 0 .9rem}
  @media(prefers-color-scheme:light){label{color:#666}}
  input{width:100%;margin-top:.3rem;font:inherit;color:inherit;background:transparent;
    border:1px solid #333;border-radius:8px;padding:.55rem .7rem}
  @media(prefers-color-scheme:light){input{border-color:#d4d4d4}}
  input:focus{outline:none;border-color:#ffd24a}
  button{width:100%;margin-top:.5rem;font:inherit;font-weight:700;cursor:pointer;color:#000;
    background:#ffd24a;border:0;border-radius:8px;padding:.6rem}
  button:active{transform:scale(.99)}
  .err{background:rgba(255,107,107,.12);border:1px solid #ff6b6b;color:#ff6b6b;
    border-radius:8px;padding:.5rem .7rem;font-size:.82rem;margin:0 0 1rem}
  .alt{text-align:center;font-size:.82rem;color:#888;margin:1rem 0 0}
  .alt a{color:#ffd24a}@media(prefers-color-scheme:light){.alt a{color:#9a6a00}}
</style></head>
<body>
<form method="post" action="${action}">
  <div class="bolt">⚡</div>
  <h1>${title}</h1>
  ${errMsg ? `<p class="err">${escapeHtml(errMsg)}</p>` : ''}
  ${nextField ? `<input type="hidden" name="_redirect" value="${nextField}">` : (isSignup ? '<input type="hidden" name="_redirect" value="/login">' : '')}
  <label>${escapeHtml(identity[0].toUpperCase() + identity.slice(1))}
    <input name="${escapeHtml(identity)}" type="${idType}" autocomplete="username" required autofocus></label>
  <label>Password
    <input name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" required></label>
  <button>${title}</button>
  <p class="alt">${alt}</p>
</form>
${live ? RELOAD_CLIENT : ''}
</body></html>`;
  }

  // Which built-in auth screen a path maps to (only when auth is configured and
  // the app ships no page of its own for it — a user page always wins first).
  function builtinAuthKind(pathname) {
    if (!config.auth) return null;
    if (pathname === '/login') return 'login';
    if (pathname === '/signup') return 'signup';
    return null;
  }

  // Dev-only error overlay (§4): the real error — SQL, file, line — on the
  // page instead of a bare 500. The reload client rides along, so fixing the
  // file un-sticks the browser.
  function devErrorPage(e, pathname) {
    const body = '<!doctype html><html><head><title>spark-ssr error</title></head>'
      + '<body style="background:#1c1917;color:#fafaf9;font:15px/1.6 system-ui;padding:2rem">'
      + `<h1 style="color:#fca5a5">500 — ${escapeHtml(e.message || String(e))}</h1>`
      + `<p style="color:#a8a29e">while serving <code>${escapeHtml(pathname)}</code></p>`
      + `<pre style="background:#292524;padding:1rem;border-radius:8px;overflow:auto;color:#fdba74">${escapeHtml(e.stack || '')}</pre>`
      + RELOAD_CLIENT + '</body></html>';
    return new Response(body, { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  // /__spark/plan (§4): "view source" for the inferred backend — every route,
  // its var → source bindings, tables, endpoints. Dev only.
  function planPage() {
    const esc = escapeHtml;
    const srcLabel = (s) =>
      s.kind === 'table' ? `table ${s.table}`
      : s.kind === 'query' ? `${s.route.method} ${s.route.path} — ${s.route.sql.replace(/\s+/g, ' ')}`
      : s.kind === 'sql' ? `SQL — ${s.binding.sql.replace(/\s+/g, ' ')}`
      : `${s.kind} — ${s.binding.value}`;
    let rows = '';
    for (const page of pages) {
      let pd;
      try { pd = pageData(page, cache, pagesDir); } catch { continue; }
      const vars = pd.plan.map((p) => `<code>${esc(p.var)}</code> ← ${esc(srcLabel(p.source))} <em>(${p.shape})</em>`).join('<br>');
      const un = (pd.plan.unresolved || []).map((u) => `<code>{${esc(u.name)}}</code> unresolved`).join('<br>');
      const guards = pd.blocks.filter((b) => b.guard)
        .map((b) => `guard <code>${esc(b.guard)}</code>${b.redirect ? ` → ${esc(b.redirect)}` : ''}`).join('<br>');
      rows += `<tr><td><code>${esc(page.route)}</code></td><td>${esc(relative(root, page.file))}</td>`
        + `<td>${vars}${un ? '<br><span style="color:#f87171">' + un + '</span>' : ''}${guards ? '<br>' + guards : ''}</td></tr>\n`;
    }
    const endpoints = apiRoutes.map((r) => `<li><code>${esc(r.method)} /${esc(r.segs.join('/'))}</code></li>`).join('\n');
    const tbls = [...tables].map((t) => `<code>${esc(t)}${liveTables.has(t) ? ' (live)' : ''}</code>`).join(', ');
    const body = `<!doctype html><html><head><title>spark-ssr plan</title>
<style>body{font:15px/1.6 system-ui;max-width:70rem;margin:2rem auto;padding:0 1rem;background:#1c1917;color:#fafaf9}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #44403c;padding:.5rem;text-align:left;vertical-align:top}
code{color:#fdba74}em{color:#a8a29e}</style></head><body>
<h1>⚡ The inferred backend</h1>
<p>Tables: ${tbls || '<em>none</em>'}</p>
<table><tr><th>Route</th><th>File</th><th>Data plan</th></tr>${rows}</table>
<h2>Endpoints</h2><ul>${endpoints}</ul>
</body></html>`;
    return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  // ── OpenAPI + typed client (Tier 4.10) ──
  // /__spark/plan already knows every route; emit a standards document and an
  // optional typed fetch client from it, so external consumers and tests get
  // types for free — generated, never authored. Served in production too.
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const opId = (method, segs) =>
    method + segs.map((s) => s.startsWith(':') ? 'By' + cap(s.slice(1)) : cap(s.replace(/\W+/g, ''))).join('');

  function openapiDoc(origin) {
    const paths = {};
    const seen = new Set();
    for (const r of apiRoutes) {
      const path = '/' + r.segs.map((s) => s.startsWith(':') ? `{${s.slice(1)}}` : s).join('/');
      const method = r.method.toLowerCase();
      const sig = method + ' ' + path;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const op = {
        operationId: opId(method, r.segs),
        tags: [r.segs[1] || 'api'],
        responses: { 200: { description: 'OK', content: { 'application/json': {} } } },
      };
      const params = r.segs.filter((s) => s.startsWith(':'))
        .map((s) => ({ name: s.slice(1), in: 'path', required: true, schema: { type: 'string' } }));
      if (params.length) op.parameters = params;
      if (method !== 'get') op.requestBody = { content: { 'application/json': { schema: { type: 'object' } } } };
      (paths[path] ||= {})[method] = op;
    }
    return {
      openapi: '3.1.0',
      info: { title: 'spark-ssr API', version: '1.0.0', description: 'Generated from the inferred backend — never authored.' },
      servers: [{ url: origin }],
      paths,
    };
  }

  function clientTs(origin) {
    const doc = openapiDoc(origin);
    const methods = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const args = (op.parameters || []).map((p) => `${p.name}: string | number`);
        if (method !== 'get') args.push('body?: unknown');
        args.push('init?: RequestInit');
        const tmpl = '`' + path.replace(/\{(\w+)\}/g, '${$1}') + '`';
        const opts = method === 'get'
          ? '{ ...init }'
          : `{ method: '${method.toUpperCase()}', headers: { 'content-type': 'application/json', ...(init?.headers) }, `
            + 'body: body === undefined ? undefined : JSON.stringify(body), ...init }';
        methods.push(
          `  ${op.operationId}(${args.join(', ')}): Promise<Response> {\n`
          + `    return fetch(baseUrl + ${tmpl}, ${opts});\n  },`);
      }
    }
    return `// spark-ssr typed client — generated from the inferred backend. Do not edit.\n`
      + `export function createClient(baseUrl = ${JSON.stringify(origin)}) {\n`
      + `  return {\n${methods.join('\n')}\n  };\n}\n`
      + `export type SparkClient = ReturnType<typeof createClient>;\n`;
  }

  // ── SEO (Tier 3): sitemap.xml + robots.txt, generated when not authored ──
  function indexablePages() {
    const out = [];
    for (const page of pages) {
      let pd;
      try { pd = pageData(page, cache, pagesDir); } catch { continue; }
      const noindex = /<meta\b[^>]*\bname\s*=\s*["']robots["'][^>]*\bcontent\s*=\s*["'][^"']*noindex/i.test(pd.head)
        || /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*noindex[^"']*["'][^>]*\bname\s*=\s*["']robots["']/i.test(pd.head);
      const guarded = pd.blocks.some((b) => b.guard);
      out.push({ page, pd, noindex, guarded });
    }
    return out;
  }

  // Enumerate a [param] route's values by re-running its bound query with the
  // param comparison neutralized (`slug = :slug` → `slug = slug`) and every
  // other token null — spark-prerender's route-enumeration idea, DB-backed.
  async function enumerateParam(sql, param) {
    const cmp = new RegExp(`([a-zA-Z_]\\w*)\\s*=\\s*:${param}\\b`);
    const cm = String(sql).match(cmp);
    if (!cm) return [];
    const col = cm[1];
    const neutral = String(sql).replace(cmp, '$1 = $1').replace(/\blimit\s+\d+\b/i, '');
    const { sql: rewritten, tokens } = rewriteParams(neutral);
    const rows = await db.query(rewritten, tokens.map(() => null));
    return [...new Set([...rows].map((r) => r[col]).filter((v) => v != null))];
  }

  async function sitemapXml(origin) {
    const urls = [];
    for (const { page, pd, noindex, guarded } of indexablePages()) {
      if (noindex || guarded) continue;
      const params = page.segs.filter((s) => s.startsWith('['));
      if (!params.length) { urls.push(page.route); continue; }
      if (params.length > 1) continue;
      const param = params[0].slice(1, -1);
      let vals = [];
      const bound = pd.plan.find((p) =>
        (p.source.kind === 'query' && p.source.route.sql.includes(':' + param))
        || (p.source.kind === 'sql' && p.source.binding.sql.includes(':' + param)));
      if (bound && db) {
        const sql = bound.source.kind === 'query' ? bound.source.route.sql : bound.source.binding.sql;
        try { vals = await enumerateParam(sql, param); } catch { /* dynamic route stays out */ }
      } else {
        const glob = pd.plan.find((p) => p.source.kind === 'glob');
        if (glob) vals = globSource(glob.source.binding.value, root).map((r) => r.slug);
      }
      for (const v of vals) urls.push(page.route.replace(`[${param}]`, encodeURIComponent(String(v))));
    }
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + urls.map((u) => `  <url><loc>${origin}${escapeHtml(u)}</loc></url>`).join('\n')
      + '\n</urlset>\n';
    return new Response(xml, { headers: { 'content-type': 'application/xml' } });
  }

  function robotsTxt(origin) {
    const lines = ['User-agent: *'];
    for (const { page, noindex, guarded } of indexablePages()) {
      if ((noindex || guarded) && !page.segs.some((s) => s.startsWith('['))) {
        lines.push(`Disallow: ${page.route}`);
      }
    }
    if (lines.length === 1) lines.push('Disallow:');
    lines.push(`Sitemap: ${origin}/sitemap.xml`);
    return new Response(lines.join('\n') + '\n', { headers: { 'content-type': 'text/plain' } });
  }

  // spark-html + family packages, served as browser modules. The importmap
  // maps each package name to /@modules/<pkg>/<entry>, and sibling files in
  // the package resolve as relative imports under the same prefix (theme's
  // ./init.js, say). Bun's resolver falls back to its GLOBAL install cache
  // when a dir has no node_modules — that can be a different version than
  // the app's, so cache hits only count when nothing real resolves.
  const moduleInfo = new Map(); // pkg → { dir, entry } | null
  function moduleEntry(pkg) {
    if (moduleInfo.has(pkg)) return moduleInfo.get(pkg);
    let lastResort = null;
    for (const dir of [root, dirname(new URL(import.meta.url).pathname)]) {
      try {
        const file = Bun.resolveSync(pkg, dir);
        if (file.includes('/install/cache/')) { lastResort = lastResort || file; continue; }
        const info = { dir: dirname(file), entry: file.slice(file.lastIndexOf('/') + 1) };
        moduleInfo.set(pkg, info);
        return info;
      } catch { /* next */ }
    }
    const info = lastResort
      ? { dir: dirname(lastResort), entry: lastResort.slice(lastResort.lastIndexOf('/') + 1) }
      : null;
    moduleInfo.set(pkg, info);
    return info;
  }

  // ── the server ──
  const server = Bun.serve({
    port: options.port ?? 3000,
    // SSE channels idle between events (heartbeat every 25 s keeps them
    // alive); slow queries and big uploads get headroom too.
    idleTimeout: 60,
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
        if (middleware) {
          const req = wrapReq(request, url, {}, session, srv);
          const res = { headers: {}, status: null };
          const out = await middleware(req, res, mwState.rateLimit, mwState.state, makeAppFetch(req), mail);
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
          const tableBlock = pd.blocks.find((b) => b.table) || {};
          const table = tableBlock.table || null;
          const cols = table ? await db.columns(table) : [];
          const html = clientComponent({
            html: pd.html, analysis: pd.analysis, plan: pd.plan, table, cols, key,
            live: !!(table && liveTables.has(table)),
          });
          return finish(new Response(html, { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } }));
        }

        if (pathname.startsWith('/__spark/data/')) {
          const key = pathname.slice('/__spark/data/'.length).replace(/\.js$/, '');
          const page = pages.find((p) => p.key === key);
          if (!page) return finish(errorPage(404));
          const pd = pageData(page, cache, pagesDir);
          const req = wrapReq(request, url, {}, session, srv);
          const data = {};
          for (const p of pd.plan) data[p.var] = await resolveSource(p, req);
          return finish(new Response(initModule(data), {
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
            if (typeof fields._redirect === 'string' && fields._redirect.startsWith('/')) back = fields._redirect;
            if (res.status < 400) {
              const headers = new Headers({ location: back });
              const sc = res.headers.get('set-cookie');
              if (sc) headers.set('set-cookie', sc);
              // flash="…" on the form → a one-shot message on the next page.
              if (typeof fields._flash === 'string' && fields._flash) {
                headers.append('set-cookie', FLASH_COOKIE(signFlash(fields._flash, secret)));
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
          return finish(new Response(null, {
            status: 303,
            headers: { location: '/', 'set-cookie': SESSION_COOKIE('', true) },
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
