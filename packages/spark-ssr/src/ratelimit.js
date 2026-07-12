/**
 * Declarative rate limiting — off by default. `config.rateLimit` (spark.json)
 * sets the cross-cutting policy; a block's inline `rate="100/1m"` attribute
 * throttles just that route. Both feed ONE fixed-window counter, in memory,
 * per process (documented boundary — behind N instances, limits are per
 * instance; a distributed limiter is a middleware.html hook, not core).
 *
 * Resolution, narrowest wins, unset fields inherit upward:
 *   1. routes["<METHOD> <path>"]   exact endpoint (config)
 *   2. inline rate= on the block    (registered per route by the caller)
 *   3. tables[<t>].methods[<M>]     a table's verb
 *   4. tables[<t>]                   a whole resource
 *   5. roles[<role>]                the caller's session role (or "anon")
 *   6. methods[<M>]                  verb class
 *   7. top-level max/window/key     global default
 * `false` at any level ⇒ no limit there.
 */

const WINDOW_UNITS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };

// "100/1m" → { max:100, window:60000 } ; "1m" → ms ; number → ms passthrough.
export function parseWindow(w) {
  if (typeof w === 'number') return w;
  const m = String(w).trim().match(/^(\d+)\s*([smhd])$/i);
  return m ? Number(m[1]) * WINDOW_UNITS[m[2].toLowerCase()] : 0;
}
export function parseRate(str) {
  const m = String(str).match(/^\s*(\d+)\s*\/\s*(\d+[smhd])\s*$/i);
  if (!m) return null;
  return { max: Number(m[1]), window: parseWindow(m[2]) };
}

// A block spec ({max,window,key} | number-as-max shorthand | false) merged
// onto a base. `false` short-circuits to "unlimited".
function merge(base, spec) {
  if (spec === false) return false;
  if (spec == null) return base;
  if (base === false) base = {};
  if (typeof spec === 'number') spec = { max: spec };
  return { ...base, ...spec };
}

export function makeRateLimiter(config) {
  const cfg = config.rateLimit;
  if (!cfg) return null;
  // `true` → a one-word sane default: 120 req / min / IP.
  const global = cfg === true
    ? { max: 120, window: 6e4, key: 'ip' }
    : { max: cfg.max ?? 0, window: parseWindow(cfg.window ?? '1m') || 6e4, key: cfg.key ?? 'ip' };
  const methods = cfg === true ? {} : (cfg.methods || {});
  const tables = cfg === true ? {} : (cfg.tables || {});
  const roles = cfg === true ? {} : (cfg.roles || {});
  const routes = cfg === true ? {} : (cfg.routes || {});
  // Inline rate= specs the caller registers: "<METHOD> <pathPrefix>" → {max,window,key}.
  const inline = new Map();

  // Fixed-window counters: bucketKey → { count, resetAt }.
  const buckets = new Map();
  let lastSweep = 0;

  function tableOf(pathname) {
    const m = pathname.match(/^\/api\/([A-Za-z_]\w*)/);
    return m ? m[1] : null;
  }
  function routeGlobMatch(method, pathname) {
    // exact "<METHOD> <path>" first, then "<METHOD> <glob*>".
    const exact = `${method} ${pathname}`;
    if (routes[exact] !== undefined) return routes[exact];
    for (const k of Object.keys(routes)) {
      if (!k.includes('*')) continue;
      const [mk, pk] = k.split(/\s+/);
      if (mk !== method && mk !== '*') continue;
      const re = new RegExp('^' + pk.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      if (re.test(pathname)) return routes[k];
    }
    return undefined;
  }
  function inlineMatch(method, pathname) {
    for (const [k, spec] of inline) {
      const [mk, pk] = k.split(/\s+/);
      if (mk !== method && mk !== '*') continue;
      if (pathname === pk || pathname.startsWith(pk + '/')) return spec;
    }
    return undefined;
  }

  // Resolve the effective { max, window, key } (or false) for one request.
  function resolve(method, pathname, role) {
    let eff = merge({}, global);
    if (methods[method] !== undefined) eff = merge(eff, methods[method]);
    if (role && roles[role] !== undefined) eff = merge(eff, roles[role]);
    const table = tableOf(pathname);
    if (table && tables[table] !== undefined) {
      const t = tables[table];
      eff = merge(eff, typeof t === 'object' && t && 'methods' in t ? { ...t, methods: undefined } : t);
      if (t && typeof t === 'object' && t.methods && t.methods[method] !== undefined) eff = merge(eff, t.methods[method]);
    }
    const inl = inlineMatch(method, pathname);
    if (inl !== undefined) eff = merge(eff, inl);
    const rt = routeGlobMatch(method, pathname);
    if (rt !== undefined) eff = merge(eff, rt);
    return eff;
  }

  function bucketKeyFor(key, req) {
    if (key === 'session') return 's:' + (req.session ? req.session.id : req.ip);
    if (key === 'ip+path') return 'ip+p:' + req.ip + ':' + req.path;
    if (typeof key === 'string' && key.startsWith('header:')) return 'h:' + (req.headers[key.slice(7).toLowerCase()] || req.ip);
    return 'ip:' + req.ip;
  }

  return {
    // Register an inline block spec against a route (method + path prefix).
    addInline(method, pathPrefix, spec) { inline.set(`${method} ${pathPrefix}`, spec); },
    // Returns null to allow, or { retryAfter } (seconds) when the request is
    // over its window. `role` is the caller's auth role (or "anon").
    check(req, role) {
      const now = Date.now();
      if (now - lastSweep > 6e4) { // periodic sweep of expired buckets
        for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
        lastSweep = now;
      }
      const method = req.method;
      const pathname = req.path;
      const eff = resolve(method, pathname, role);
      if (eff === false || !eff.max) return null; // unlimited here
      const bk = bucketKeyFor(eff.key, req) + '|' + method + '|' + (routeGlobMatch(method, pathname) !== undefined || inlineMatch(method, pathname) !== undefined ? pathname : '*');
      let b = buckets.get(bk);
      if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + eff.window }; buckets.set(bk, b); }
      b.count++;
      if (b.count > eff.max) return { retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1e3)) };
      return null;
    },
  };
}
