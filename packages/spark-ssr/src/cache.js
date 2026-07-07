/**
 * Full-page response cache policy (§6).
 *
 * Anonymous GETs of pages whose output is a pure function of (path, query)
 * render identically for every visitor — serve the HTML string straight
 * from memory. Auto-detected, production only (dev must re-render), and
 * strictly gated: no server <script> that runs per request, no module
 * sources (arbitrary code), no SQL reading :header/:body. Session-reading
 * pages stay eligible — anonymous visitors all see session = null — but a
 * request carrying any spark_ cookie (session or flash) bypasses the cache
 * entirely (servePage checks), and a response that sets a cookie is never
 * stored. Entries ride the source cache, so writes through the server
 * invalidate them by table and the heartbeat sweep frees expired ones.
 * `responseCache` in spark.json: false disables, a number overrides the
 * TTL (default 60s).
 *
 * The M3.3 cache-poisoning tests pin this file's rules — change them only
 * with the security suite green.
 */
import { sqlTables } from './parse.js';

export function makeCachePolicy(app, shouldHydrate) {
  const { config, live } = app;

  const pageCacheTtl = typeof config.responseCache === 'number' ? config.responseCache : 60;

  function pageCacheable(pd) {
    if (pd.cacheable !== undefined) return pd.cacheable;
    let ok = !live && config.responseCache !== false;
    if (ok && pd.code && !shouldHydrate(pd)) ok = false;
    for (const p of ok ? pd.plan : []) {
      if (p.source.kind === 'module') { ok = false; break; }
      const sql = p.source.kind === 'query' ? p.source.route.sql
        : p.source.kind === 'sql' ? p.source.binding.sql : null;
      if (sql && /:(header|body)\./.test(sql)) { ok = false; break; }
    }
    return (pd.cacheable = ok);
  }

  function pageTables(pd) {
    if (pd.cacheTables) return pd.cacheTables;
    const tables = new Set();
    for (const p of pd.plan) {
      if (p.source.kind === 'table') tables.add(p.source.table);
      const sql = p.source.kind === 'query' ? p.source.route.sql
        : p.source.kind === 'sql' ? p.source.binding.sql : null;
      if (sql) for (const t of sqlTables(sql)) tables.add(t);
    }
    return (pd.cacheTables = tables);
  }

  return { pageCacheTtl, pageCacheable, pageTables };
}
