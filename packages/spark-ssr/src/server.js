/**
 * spark-ssr server — `bun spark-ssr` and it serves.
 *
 * The filesystem is the router (pages/, api/, public/, 404.html, 500.html,
 * middleware.html), <spark-ssr> blocks declare the data, and everything else
 * is inferred from the template. No route handlers, no controllers, no build.
 */
import { join, resolve, extname, dirname } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { extractBlocks, analyze, dataPlan, rewriteParams, singleShaped, maskComments } from './parse.js';
import { renderFragment, evalExpr } from './render.js';
import { clientComponent, initModule } from './hydrate.js';
// Head semantics live in one place for the whole family: spark-html-head owns
// title/meta on the client (pushState updates); its /ssr module owns them
// here — pages put literal <title>/<meta>/<link> tags in their markup, we
// lift them into the document head with {expr} interpolated per request.
import { liftHead, renderHead } from 'spark-html-head/ssr';

const AsyncFunction = (async () => {}).constructor;
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const dig = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

// ── pages ──────────────────────────────────────────────────────────────
const RESERVED_ROOT_DIRS = new Set(['components', 'api', 'public', 'pages', 'node_modules', 'dist', 'uploads']);
const RESERVED_FILES = new Set(['404.html', '500.html', 'middleware.html']);

function scanPages(root) {
  const pagesDir = existsSync(join(root, 'pages')) ? join(root, 'pages') : root;
  const pages = [];
  (function scan(dir, prefix) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.')) continue;
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

// Parsed-page cache, invalidated by mtime.
function pageData(page, cache) {
  const mtime = statSync(page.file).mtimeMs;
  const hit = cache.get(page.file);
  if (hit && hit.mtime === mtime) return hit;
  const source = readFileSync(page.file, 'utf8');
  const { blocks, html } = extractBlocks(source);
  const { html: markup, code } = splitScript(html);
  // Analyze BEFORE lifting the head, so a {var} used only in <title>/<meta>
  // still registers as a data need.
  const analysis = analyze(markup);
  analysis.hasScript = !!code;
  const plan = dataPlan(analysis, blocks);
  const { head, scripts, body } = liftHead(markup);
  const data = { mtime, source, blocks, html: body, head, scripts, code, analysis, plan };
  cache.set(page.file, data);
  return data;
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

// ── serve ──────────────────────────────────────────────────────────────
export async function serve(options = {}) {
  const root = resolve(options.root || process.cwd());
  const config = { ...loadConfig(root), ...(options.config || {}) };
  const db = await connect(config.db);
  const secret = (config.auth && config.auth.secret) || randomBytes(32).toString('hex');
  const cache = new Map();
  const pages = [];
  let pagesDir = root;
  const uploadsDir = join(root, config.uploads);
  const quiet = !!options.quiet;

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
          if (!/\.(html|css|js|json)$/.test(f)) continue;
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
  const RELOAD_CLIENT = '<script>(()=>{const e=new EventSource("/__spark/reload");let d=0;'
    + 'e.onmessage=()=>location.reload();e.onerror=()=>{d=1};e.onopen=()=>{if(d)location.reload()}})()</script>';

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
            file = { url: '/uploads/' + name, name: v.name || name, size: v.size, type: v.type };
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

  async function runSql(sqlText, req) {
    const { sql, tokens } = rewriteParams(sqlText);
    const values = [];
    for (const t of tokens) values.push(await resolveToken(t, req));
    return db.query(sql, values);
  }

  // ── auto-CRUD for <spark-ssr table="…"> ──
  const apiRoutes = []; // { method, segs: ['api','todos',':id'], handler }
  const on = (method, path, handler) =>
    apiRoutes.push({ method, segs: path.split('/').filter(Boolean), handler });

  async function tableInfo(table) {
    const cols = await db.columns(table);
    const names = cols.map((c) => c.name);
    const scoped = !!config.auth && names.includes('user_id') && config.auth.table !== table;
    return { cols, names, scoped };
  }

  async function tableRows(table, req) {
    const { scoped } = await tableInfo(table);
    if (scoped) {
      if (!req.session) return [];
      return db.query(`SELECT * FROM ${table} WHERE user_id = ?`, [req.session.id]);
    }
    return db.query(`SELECT * FROM ${table}`);
  }

  function registerTable(table) {
    const isAuthTable = config.auth && config.auth.table === table;

    on('GET', `api/${table}`, async (req) => {
      const { scoped } = await tableInfo(table);
      if (scoped && !req.session) return json({ error: 'unauthorized' }, 401);
      const rows = await tableRows(table, req);
      // Password hashes never leave the auth table, not even to a session.
      if (isAuthTable) for (const r of rows) delete r.password;
      return json(isAuthTable ? [...rows] : rows);
    });

    on('POST', `api/${table}`, async (req) => {
      if (isAuthTable && 'auth' in req.query) return login(req);
      const { names, scoped } = await tableInfo(table);
      if (scoped && !req.session) return json({ error: 'unauthorized' }, 401);
      const { fields } = await req.body();
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
      if (scoped) { sql += ' AND user_id = ?'; values.push(req.session.id); }
      const rows = await db.query(sql + ' RETURNING *', values);
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
      if (scoped) { sql += ' AND user_id = ?'; values.push(req.session.id); }
      const rows = await db.query(sql + ' RETURNING *', values);
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
    if (existing) { existing.sql = route.sql; return; }
    const def = { sql: route.sql };
    queryDefs.set(key, def);
    const segs = route.path.split('/').filter(Boolean)
      .map((s) => s.replace(/^\[(\w+)\]$/, ':$1'));
    apiRoutes.push({
      method: route.method,
      segs,
      handler: async (req) => {
        const rows = await runSql(def.sql, req);
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
    for (const page of pages) {
      let pd;
      try { pd = pageData(page, cache); } catch { continue; }
      for (const b of pd.blocks) {
        if (b.table && !tables.has(b.table)) { tables.add(b.table); registerTable(b.table); }
        for (const r of b.routes) {
          if (r.path) registerQuery(r);
        }
      }
    }
  }
  refreshPages();

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
          for (const r of b.routes) registerQuery({ ...r, path: r.path || route });
        }
        def.fn = null;
        if (code) {
          try { def.fn = new AsyncFunction('req', 'res', 'db', 'fetch', code); }
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
                const out = await def.fn(req, res, db, makeAppFetch(req));
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
      try { middleware = new AsyncFunction('req', 'res', 'rateLimit', 'state', 'fetch', code); }
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
    // lockfiles, databases, dotfiles. public/ stays the intentional space.
    const internal = rel.startsWith('.') || rel.includes('/.')
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
      if (existsSync(abs) && statSync(abs).isFile()) return Bun.file(abs);
    }
    return null;
  }

  // ── page rendering ──
  const namesOf = (code) =>
    [...String(code).matchAll(/^\s*(?:let|const|var)\s+([a-zA-Z_$][\w$]*)/gm)].map((m) => m[1]);

  async function runPageScript(code, req) {
    const names = namesOf(code);
    const fn = new AsyncFunction('req', 'db', 'fetch', code + '\n;return { ' + names.join(', ') + ' };');
    try { return await fn(req, db, makeAppFetch(req)); }
    catch (e) {
      if (!quiet) console.warn(`[spark-ssr] page <script> threw: ${e.message}`);
      return {};
    }
  }

  function shouldHydrate(pd) {
    return pd.analysis.interactive && !pd.analysis.hasScript
      && pd.blocks.some((b) => b.table) && !!db;
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

  async function buildScope(pd, req) {
    const scope = { ...req.query, ...req.params, session: req.session };
    if (pd.code) Object.assign(scope, await runPageScript(pd.code, req));
    for (const p of pd.plan) {
      if (scope[p.var] !== undefined) continue; // the page <script> won
      if (p.source.kind === 'table') {
        scope[p.var] = await tableRows(p.source.table, req);
      } else {
        const rows = await runSql(p.source.route.sql, req);
        scope[p.var] = p.shape === 'list' ? [...rows] : rows[0] ?? null;
      }
    }
    return scope;
  }

  async function servePage(page, req) {
    const pd = pageData(page, cache);
    const scope = await buildScope(pd, req);
    const hydrate = shouldHydrate(pd);
    // Component imports keep their host (import + name + props) on pages the
    // page host won't rebuild wholesale, so a client mount re-resolves them
    // and their own <script> comes alive (counters, demos, …).
    const hasComponents = /\bimport\s*=\s*"/.test(pd.html);
    const body = await renderFragment(pd.html, scope, { loadComponent, keepImports: !hydrate });
    const headExtra = pd.head ? renderHead(pd.head, (e) => evalExpr(e, scope)) : '';
    return new Response(shell(page, body, {
      hydrate, mount: hydrate || hasComponents, headExtra, scripts: pd.scripts,
    }), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  function errorPage(status) {
    const file = join(root, `${status}.html`);
    if (existsSync(file)) {
      // The reload client rides along so fixing the page un-sticks the browser.
      const body = readFileSync(file, 'utf8') + (live ? '\n' + RELOAD_CLIENT : '');
      return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response(status === 404 ? 'Not found' : 'Server error', { status });
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

      const session = readSession(request.headers.get('cookie'), secret);
      const extraHeaders = {};

      try {
        // Pick up new/edited pages, api files, and middleware without a
        // restart (readdir walk + mtime-cached parses — cheap).
        if (options.watch !== false) { refreshPages(); refreshApi(); refreshMiddleware(); }

        // middleware.html runs first, on every request.
        if (middleware) {
          const req = wrapReq(request, url, {}, session, srv);
          const res = { headers: {}, status: null };
          const out = await middleware(req, res, mwState.rateLimit, mwState.state, makeAppFetch(req));
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
          const pd = pageData(page, cache);
          const table = (pd.blocks.find((b) => b.table) || {}).table || null;
          const cols = table ? await db.columns(table) : [];
          const html = clientComponent({ html: pd.html, analysis: pd.analysis, plan: pd.plan, table, cols, key });
          return finish(new Response(html, { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } }));
        }

        if (pathname.startsWith('/__spark/data/')) {
          const key = pathname.slice('/__spark/data/'.length).replace(/\.js$/, '');
          const page = pages.find((p) => p.key === key);
          if (!page) return finish(errorPage(404));
          const pd = pageData(page, cache);
          const req = wrapReq(request, url, {}, session, srv);
          const data = {};
          for (const p of pd.plan) {
            if (p.source.kind === 'table') data[p.var] = await tableRows(p.source.table, req);
            else {
              const rows = await runSql(p.source.route.sql, req);
              data[p.var] = p.shape === 'list' ? [...rows] : rows[0] ?? null;
            }
          }
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
          if (cors) for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
          return finish(res);
        }

        const file = staticFile(pathname);
        if (file) return finish(new Response(file));

        const hit = matchPage(pages, pathname);
        if (hit) {
          const req = wrapReq(request, url, hit.params, session, srv);
          return finish(await servePage(hit.page, req));
        }

        return finish(errorPage(404));
      } catch (e) {
        if (!quiet) console.error(`[spark-ssr] ${request.method} ${pathname} — ${e.stack || e.message}`);
        const res = errorPage(500);
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
      for (const c of sseClients) { try { c.close(); } catch { /* gone */ } }
      sseClients.clear();
      server.stop(force);
      return db && db.close();
    },
  };
}
