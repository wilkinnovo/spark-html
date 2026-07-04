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
import { extractBlocks, analyze, dataPlan, rewriteParams, singleShaped } from './parse.js';
import { renderFragment } from './render.js';
import { clientComponent, initModule } from './hydrate.js';

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
function splitScript(html) {
  let code = '';
  const out = String(html).replace(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, (m, body) => {
    code += body + '\n';
    return '';
  });
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
  const analysis = analyze(markup);
  analysis.hasScript = !!code;
  const plan = dataPlan(analysis, blocks);
  const data = { mtime, source, blocks, html: markup, code, analysis, plan };
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
  const { pagesDir, pages } = scanPages(root);
  const cache = new Map();
  const uploadsDir = join(root, config.uploads);
  const quiet = !!options.quiet;

  const ctx = { root, config, db, secret, pagesDir, pages, cache, uploadsDir, port: 0 };

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
      return json(await tableRows(table, req));
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

    on('PATCH', `api/${table}/:id`, async (req) => {
      const { names, scoped } = await tableInfo(table);
      if (scoped && !req.session) return json({ error: 'unauthorized' }, 401);
      const { fields } = await req.body();
      const data = {};
      for (const [k, v] of Object.entries(fields)) {
        if (names.includes(k) && k !== 'id' && k !== 'user_id') data[k] = v;
      }
      const keys = Object.keys(data);
      if (!keys.length) return json({ error: 'empty body' }, 400);
      let sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
      const values = [...keys.map((k) => data[k]), req.params.id];
      if (scoped) { sql += ' AND user_id = ?'; values.push(req.session.id); }
      const rows = await db.query(sql + ' RETURNING *', values);
      return rows[0] ? json(rows[0]) : json({ error: 'not found' }, 404);
    });

    on('DELETE', `api/${table}/:id`, async (req) => {
      const { scoped } = await tableInfo(table);
      if (scoped && !req.session) return json({ error: 'unauthorized' }, 401);
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
  const registered = new Set();
  function registerQuery(route) {
    const key = route.method + ' ' + route.path;
    if (registered.has(key)) return;
    registered.add(key);
    const segs = route.path.split('/').filter(Boolean)
      .map((s) => s.replace(/^\[(\w+)\]$/, ':$1'));
    apiRoutes.push({
      method: route.method,
      segs,
      handler: async (req) => {
        const rows = await runSql(route.sql, req);
        if (route.method === 'GET') return json(singleShaped(route.sql) ? rows[0] ?? null : [...rows]);
        if (Array.isArray(rows) && rows.length) return json(rows.length === 1 ? rows[0] : [...rows]);
        return json({ ok: true, changes: rows.changes ?? 0 });
      },
    });
  }

  // Register everything the pages declare.
  const tables = new Set();
  for (const page of pages) {
    const pd = pageData(page, cache);
    for (const b of pd.blocks) {
      if (b.table && !tables.has(b.table)) { tables.add(b.table); registerTable(b.table); }
      for (const r of b.routes) {
        if (r.path) registerQuery(r);
      }
    }
  }

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

  const apiDir = join(root, 'api');
  if (existsSync(apiDir)) {
    (function scanApi(dir, prefix) {
      for (const f of readdirSync(dir)) {
        if (f.startsWith('.')) continue;
        const full = join(dir, f);
        if (statSync(full).isDirectory()) { scanApi(full, prefix + f + '/'); continue; }
        if (!f.endsWith('.html')) continue;
        const route = '/api/' + prefix + f.slice(0, -5);
        const source = readFileSync(full, 'utf8');
        const { blocks, html } = extractBlocks(source);
        const { code } = splitScript(html);
        for (const b of blocks) {
          for (const r of b.routes) registerQuery({ ...r, path: r.path || route });
        }
        if (code) {
          const fn = new AsyncFunction('req', 'res', 'db', 'fetch', code);
          const segs = route.split('/').filter(Boolean);
          for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
            apiRoutes.push({
              method,
              segs,
              handler: async (req, res) => {
                const out = await fn(req, res, db, makeAppFetch(req));
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

  // ── middleware.html ──
  let middleware = null;
  const mwState = { rateLimit: new Map(), state: {} };
  const mwFile = join(root, 'middleware.html');
  if (existsSync(mwFile)) {
    const { code } = splitScript(readFileSync(mwFile, 'utf8'));
    if (code) middleware = new AsyncFunction('req', 'res', 'rateLimit', 'state', 'fetch', code);
  }

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
    if (ext && ext !== '.html') {
      candidates.push(join(root, rel), join(pagesDir, rel));
    } else if (rel.startsWith('components/')) {
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

  function shell(page, body, { hydrate }) {
    const title = page.key === 'index' ? 'Spark' : page.key.split('/').pop().replace(/\[|\]/g, '');
    const cssRel = page.key + '.css';
    const hasCss = existsSync(join(pagesDir, cssRel));
    const head =
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      `<title>${title}</title>\n` +
      (hasCss ? `<link rel="stylesheet" href="/${cssRel}">\n` : '');
    const hydration = hydrate
      ? `\n<script type="importmap">{"imports":{"spark-html":"/@modules/spark-html"}}</script>\n` +
        `<script type="module">import { mount } from 'spark-html'; mount();</script>\n`
      : '\n';
    const host = hydrate
      ? `<div import="/__spark/page/${page.key}" data-spark-ssr>${body}</div>`
      : `<div data-spark-ssr>${body}</div>`;
    return `<!doctype html>\n<html>\n<head>\n${head}</head>\n<body>\n${host}${hydration}</body>\n</html>\n`;
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
    const body = await renderFragment(pd.html, scope, { loadComponent });
    return new Response(shell(page, body, { hydrate: shouldHydrate(pd) }), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  function errorPage(status) {
    const file = join(root, `${status}.html`);
    if (existsSync(file)) {
      return new Response(readFileSync(file, 'utf8'), { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response(status === 404 ? 'Not found' : 'Server error', { status });
  }

  // spark-html runtime, served for hydration (importmap target).
  let runtimeJs = null;
  function runtimeFile() {
    if (runtimeJs) return runtimeJs;
    for (const dir of [root, dirname(new URL(import.meta.url).pathname)]) {
      try {
        runtimeJs = readFileSync(Bun.resolveSync('spark-html', dir), 'utf8');
        return runtimeJs;
      } catch { /* next */ }
    }
    return null;
  }

  // ── the server ──
  const server = Bun.serve({
    port: options.port ?? 3000,
    async fetch(request, srv) {
      const url = new URL(request.url);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
      if (pathname.includes('..')) return errorPage(404);
      const session = readSession(request.headers.get('cookie'), secret);
      const extraHeaders = {};

      try {
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

        if (pathname === '/@modules/spark-html') {
          const js = runtimeFile();
          return finish(js
            ? new Response(js, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' } })
            : errorPage(404));
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
    stop(force) { server.stop(force); return db && db.close(); },
  };
}
