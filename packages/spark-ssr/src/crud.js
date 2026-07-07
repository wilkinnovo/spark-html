/**
 * Auto-CRUD (<spark-ssr table="…">), the list conventions (?page/?sort/?q),
 * the built-in login, and explicit <spark-ssr> query endpoints.
 *
 * makeCrud(app) closes over the serve() context bag and owns the API route
 * table (apiRoutes/on), per-table options + validators, the PRAGMA column
 * cache, and queryDefs. app.fireEvent and app.runSql are late-bound slots
 * (jobs and request plumbing wire them) read at call time.
 */
import { json } from './request.js';
import { validateFields, singleShaped } from './parse.js';
import { signSession, SESSION_COOKIE, isAdmin } from './session.js';

export function makeCrud(app) {
  const { config, db, secret } = app;

  // ── auto-CRUD for <spark-ssr table="…"> ──
  const apiRoutes = []; // { method, segs: ['api','todos',':id'], handler }
  const on = (method, path, handler) =>
    apiRoutes.push({ method, segs: path.split('/').filter(Boolean), handler });

  // Block attributes per table (limit, search, live) and the form-derived
  // validation rules (§6) — both refreshed with the pages.
  const tableOpts = new Map();
  let validators = new Map();
  const setValidators = (v) => { validators = v; };

  // db.columns runs a PRAGMA / information_schema query — cached per table
  // (§10), cleared whenever the schema might have moved (ensureSchema, or any
  // file change in dev, where a `db push --force` usually rides along).
  const columnsCache = new Map(); // table → [{ name, type }]
  async function columnsOf(table) {
    let cols = columnsCache.get(table);
    if (!cols) {
      cols = await db.columns(table);
      if (cols.length) columnsCache.set(table, cols);
    }
    return cols;
  }
  const clearColumnsCache = () => columnsCache.clear();

  async function tableInfo(table) {
    const cols = await columnsOf(table);
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
      // The auth table is an identity store, not ordinary CRUD. Its built-in
      // /signup screen is synthesized (never scanned by extractForms), so its
      // `required` fields are re-checked here — a row with a null password
      // could never log in (timingSafeEqual against nothing). And the
      // identity must be unique: login matches the first row, so a duplicate
      // would be a dead account with no error explaining why.
      if (isAuthTable) {
        const identity = config.auth.identity || 'email';
        const errors = {};
        if (!String(fields[identity] ?? '').trim()) errors[identity] = `${identity} is required`;
        if (!String(fields.password ?? '')) errors.password = 'password is required';
        if (Object.keys(errors).length) return json({ errors }, 422);
        const dup = await db.query(`SELECT id FROM ${table} WHERE ${identity} = ?`, [fields[identity]]);
        if (dup.length) {
          return json({ errors: { [identity]: `that ${identity} is already registered — log in instead` } }, 409);
        }
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
      app.fireEvent('insert', table, rows[0] ?? null);
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
      // Changing the identity column to one another account holds would
      // create the same dead-login ambiguity as a duplicate signup.
      if (isAuthTable) {
        const identity = config.auth.identity || 'email';
        if (typeof fields[identity] === 'string') {
          const dup = await db.query(`SELECT id FROM ${table} WHERE ${identity} = ? AND id != ?`, [fields[identity], req.params.id]);
          if (dup.length) {
            return json({ errors: { [identity]: `that ${identity} is already registered` } }, 409);
          }
        }
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
      app.fireEvent('update', table, rows[0] ?? null);
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
      app.fireEvent('delete', table, rows[0] ?? null);
      return rows[0] ? json({ ok: true }) : json({ error: 'not found' }, 404);
    });
  }

  // ── auth ──
  // We ship the login endpoint, so we ship its brute-force limiter: a naive
  // in-memory sliding window per client IP (10 attempts / 60 s). Enough to
  // blunt credential stuffing without a dependency; an app fronted by a real
  // WAF/proxy limiter loses nothing. Keyed by req.ip (X-Forwarded-For aware).
  const loginHits = new Map(); // ip → number[] (attempt timestamps in window)
  const LOGIN_WINDOW_MS = 60_000;
  const LOGIN_MAX = 10;
  function loginRateLimited(ip) {
    const now = Date.now();
    const hits = (loginHits.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    hits.push(now);
    loginHits.set(ip, hits);
    if (loginHits.size > 5000) for (const [k, v] of loginHits) if (!v.some((t) => now - t < LOGIN_WINDOW_MS)) loginHits.delete(k);
    return hits.length > LOGIN_MAX;
  }

  async function login(req) {
    const { auth } = config;
    if (loginRateLimited(req.ip || '')) {
      return json({ error: 'too many attempts — try again in a minute' }, 429, { 'retry-after': '60' });
    }
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
    return json(safe, 200, { 'set-cookie': SESSION_COOKIE(signSession(session, secret), { secure: req.secure }) });
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
        const rows = await app.runSql(def.sql, req, route.method === 'GET' ? def.cache : 0);
        if (route.method !== 'GET') app.broadcastSql(def.sql);
        if (route.method === 'GET') return json(singleShaped(def.sql) ? rows[0] ?? null : [...rows]);
        if (Array.isArray(rows) && rows.length) return json(rows.length === 1 ? rows[0] : [...rows]);
        return json({ ok: true, changes: rows.changes ?? 0 });
      },
    });
  }

  return {
    apiRoutes, on, tableOpts, setValidators, columnsOf, clearColumnsCache,
    tableInfo, tableRows, registerTable, login, registerQuery,
  };
}
