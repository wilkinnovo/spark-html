/**
 * Route registry beyond pages: the api/ folder (custom endpoints as .html
 * files with a server <script>), API route matching, and middleware.html
 * (compiled per mtime, run first on every request).
 *
 * makeRoutes(app) closes over the serve() context bag. app.apiRoutes /
 * app.registerQuery / app.makeAppFetch / app.mail are wired by serve()
 * before any request runs.
 */
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extractBlocks, splitScript } from './parse.js';
import { json } from './request.js';

const AsyncFunction = (async () => {}).constructor;

export function makeRoutes(app) {
  const { root, db, quiet } = app;

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
          for (const r of b.routes) app.registerQuery({ ...r, path: r.path || route, cache: b.cache });
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
            app.apiRoutes.push({
              method,
              segs,
              handler: async (req, res) => {
                if (!def.fn) return json({ error: 'not found' }, 404);
                const out = await def.fn(req, res, db, app.makeAppFetch(req), app.mail);
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
    outer: for (const r of app.apiRoutes) {
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

  return {
    refreshApi, matchApi, refreshMiddleware, mwState,
    get middleware() { return middleware; },
  };
}
