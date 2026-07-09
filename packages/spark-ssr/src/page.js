/**
 * The page render pipeline: scope building (ambients + page <script> + data
 * plan + relations), the HTML shell (importmap/mount/head), source
 * resolution, the response-cache fast path, streaming for list pages, the
 * <spark-flash>/<spark-pager>/<spark-search> post-passes, guards and
 * auto-404 — servePage() end to end.
 *
 * makePage(app) closes over the serve() context bag; the response-cache
 * policy lives in ./cache.js.
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { renderFragment, renderFragmentTo, evalExpr } from './render.js';
import { urlSource, globSource, moduleSource } from './sources.js';
import { singular } from './parse.js';
import { readFlash, FLASH_COOKIE } from './session.js';
import { escapeHtml } from './screens.js';
import { makeCachePolicy } from './cache.js';
import { renderHead } from 'spark-html-head/ssr';

const AsyncFunction = (async () => {}).constructor;

export function makePage(app) {
  const { root, config, db, secret, quiet, live, sourceCache, sseEnc } = app;
  const { pageCacheTtl, pageCacheable, pageTables } = makeCachePolicy(app, shouldHydrate);

  const namesOf = (code) =>
    [...String(code).matchAll(/^\s*(?:let|const|var)\s+([a-zA-Z_$][\w$]*)/gm)].map((m) => m[1]);

  // Compiled once per parsed page (§3): pd is the mtime-invalidated cache
  // entry, so hanging the AsyncFunction off it recompiles exactly when the
  // file changes — not on every request.
  async function runPageScript(pd, req) {
    if (!pd.scriptFn) {
      const names = namesOf(pd.code);
      pd.scriptFn = new AsyncFunction('req', 'db', 'fetch', 'mail', pd.code + '\n;return { ' + names.join(', ') + ' };');
    }
    try { return await pd.scriptFn(req, db, app.makeAppFetch(req), app.mail); }
    catch (e) {
      if (!quiet) console.warn(`[spark-ssr] page <script> threw: ${e.message}`);
      if (live) e.__sparkPageScript = true;
      return {};
    }
  }

  // Hydrate any interactive page with data sources — table, SQL, URL, glob or
  // module. Sources that read the database (table/SQL/query) still need `db`;
  // file globs, URLs and modules hydrate without one. A page's own <script> no
  // longer opts out: it becomes the client component's script (ambient helpers
  // injected, missing handlers synthesized), so authored pages hydrate too.
  const DB_SOURCE = new Set(['table', 'query', 'sql']);
  function shouldHydrate(pd) {
    if (!pd.analysis.interactive || pd.plan.length === 0) return false;
    const needsDb = pd.plan.some((p) => p.source && DB_SOURCE.has(p.source.kind));
    return !needsDb || !!db;
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

  // Split point the streaming path (§7) uses to get the shell's prefix and
  // suffix around the body.
  const SHELL_MARK = '\u0000SPARK_BODY\u0000';

  function shell(page, body, { hydrate, mount, headExtra = '', scripts = '', routeParamsQS = '' }) {
    const title = page.key === 'index' ? 'Spark' : page.key.split('/').pop().replace(/\[|\]/g, '');
    const cssRel = page.key + '.css';
    const hasCss = existsSync(join(app.pagesDir, cssRel));
    // The importmap must precede EVERY module script in document order (a
    // later one is ignored), so the whole module story lives in <head>:
    // importmap → the page's own client scripts → mount. Page scripts are
    // the app's bootstrap (store()/theme() setup) and modules execute in
    // document order, so they run before components boot — same contract as
    // a hand-written main.js that ends with mount().
    const needModules = mount || scripts.includes('<script');
    const imports = {};
    for (const dep of ['spark-html', ...app.familyDeps]) {
      const info = app.moduleEntry(dep);
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
      (app.themeInit ? app.themeInit + '\n' : '') +
      (/<title\b/i.test(headExtra) ? '' : `<title>${title}</title>\n`) +
      (headExtra ? headExtra + '\n' : '') +
      (app.fontTags ? app.fontTags + '\n' : '') +
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
    const pageImportPath = `/__spark/page/${page.key}${routeParamsQS ? '?' + routeParamsQS : ''}`;
    const host = hydrate
      ? `<div import="${pageImportPath}" name="${compName}" data-spark-ssr>${body}</div>`
      : `<div data-spark-ssr>${body}</div>`;
    const reload = live ? app.RELOAD_CLIENT + '\n' : '';
    return `<!doctype html>\n<html>\n<head>\n${head}</head>\n<body>\n${host}\n${reload}</body>\n</html>\n`;
  }

  // Resolve one plan entry — table, query, named SQL, URL, glob, module —
  // honoring the block's cache="…" TTL.
  async function resolveSource(p, req) {
    const src = p.source;
    const ttl = (src.opts && src.opts.cache) || 0;
    if (src.kind === 'table') {
      if (!ttl) return app.tableRows(src.table, req, src.opts || {});
      const key = ['t', src.table, req.session?.id ?? '', req.query.q ?? '', req.query.sort ?? '', req.query.page ?? ''].join('|');
      const hit = sourceCache.get(key);
      if (hit) return hit.value;
      const rows = await app.tableRows(src.table, req, src.opts || {});
      sourceCache.set(key, rows, ttl, new Set([src.table]));
      return rows;
    }
    if (src.kind === 'query' || src.kind === 'sql') {
      const sql = src.kind === 'query' ? src.route.sql : src.binding.sql;
      const rows = await app.runSql(sql, req, ttl);
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
      const value = await globSource(src.binding.value, root);
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
    // A page's <script> runs on the server (the escape hatch) UNLESS the page
    // hydrates — then it's the client component's script (handlers, not data),
    // so it must not run here. Its data still comes from the <spark-ssr> blocks.
    if (pd.code && !shouldHydrate(pd)) Object.assign(scope, await runPageScript(pd, req));
    for (const p of pd.plan) {
      if (scope[p.var] !== undefined) continue; // the page <script> won
      scope[p.var] = await resolveSource(p, req);
    }
    // Relations (§): each="c in post.comments" attaches the child rows onto the
    // parent object(s) via the inferred foreign key — no JOIN in the template.
    // Batched (§8): one `WHERE fk IN (…)` for the whole parent list, grouped
    // by FK in memory — a 50-post page is one round-trip, not 50. Identifiers
    // come from the parsed template (word chars only), so they're safe to
    // interpolate.
    for (const r of pd.analysis.relations || []) {
      const parent = scope[r.parent];
      if (parent == null) continue;
      const fk = singular(r.parent) + '_id';
      const targets = (Array.isArray(parent) ? parent : [parent])
        .filter((o) => o && o.id != null && o[r.rel] === undefined);
      if (!targets.length) continue;
      const ids = [...new Set(targets.map((o) => o.id))];
      let byId = new Map();
      try {
        const rows = await db.query(
          `SELECT * FROM ${r.rel} WHERE ${fk} IN (${ids.map(() => '?').join(', ')})`, ids);
        for (const row of rows) {
          const k = row[fk];
          (byId.get(k) || byId.set(k, []).get(k)).push(row);
        }
      } catch { byId = new Map(); }
      for (const o of targets) o[r.rel] = byId.get(o.id) || [];
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

  // Full-page response cache policy → src/cache.js (pageCacheTtl /
  // pageCacheable / pageTables destructured above).
  async function servePage(page, req, extra = null) {
    const pd = app.pageData(page);

    const cacheKey = !extra && req.method === 'GET' && pageCacheable(pd)
      && !(req.headers.cookie || '').includes('spark_')
      ? 'p|' + req.path + '|' + JSON.stringify(Object.entries(req.query).sort())
      : null;
    if (cacheKey) {
      const hit = sourceCache.get(cacheKey);
      if (hit) {
        return new Response(hit.value.html, {
          status: hit.value.status,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
    }

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
        return app.errorPage(b.status || 403);
      }
    }

    // Auto-404 (§3): a dynamic [param] page that looks up one row and finds
    // nothing IS a 404 — no need to hand-write <template else status="404">.
    // Only fires when the page reads that row as an object ({post.title}); an
    // explicit if/else branch in the PAGE ITSELF opts out (it renders its own
    // answer) — scanning pd.ownBody rather than the merged pd.html, so a
    // shared layout's own if/else (a nav's logged-in/out branch, say) can't
    // opt every page under it out of this. Form re-renders (extra.status)
    // are left alone regardless.
    if (!extra && page.segs.some((s) => s.startsWith('['))
      && !/<template\b[^>]*\b(?:else|else-if)\b/i.test(pd.ownBody)) {
      for (const p of pd.plan) {
        if (p.shape === 'row' && pd.analysis.memberRoots.has(p.var) && scope[p.var] == null) {
          return app.errorPage(404);
        }
      }
    }

    const hydrate = shouldHydrate(pd);
    // Component imports keep their host (import + name + props) on pages the
    // page host won't rebuild wholesale, so a client mount re-resolves them
    // and their own <script> comes alive (counters, demos, …).
    const hasComponents = /\bimport\s*=\s*"/.test(pd.html);
    const rctx = { loadComponent: app.loadComponent, keepImports: !hydrate, dev: live, hydrating: hydrate };
    let headExtra = pd.head ? renderHead(pd.head, (e) => evalExpr(e, scope)) : '';
    if (headExtra) headExtra = withOgTags(headExtra);
    // A [param] route's :id/:slug never appears in the URL's query string —
    // it's a path segment, matched into req.params by matchPage(). But the
    // client's hydration fetches (the generated `import __init from
    // '/__spark/data/<key>.js'` and its refresh()) are keyed by the page's
    // TEMPLATE path ("pin/[id]"), the same URL for every instance of the
    // route — so without forwarding req.params along as a query string, the
    // client-side data fetch can never know WHICH row this instance is for
    // (:id resolves to null, not "3"). Baked onto the host import path here;
    // threaded through by the /__spark/page/ and /__spark/data/ handlers.
    //
    // req.query rides along too, for the same reason: a data source that
    // reads req.query itself (a module/URL source, or a named SQL binding
    // using a bare :q-less scalar) renders correctly at SSR (this request's
    // real query string) but the client's own __init fetch otherwise carries
    // NONE of it — ?q=... silently became "" the moment hydration's initial
    // boot (not a later refresh(), which already reads location.search live)
    // re-ran the same sources.
    const routeParamsQS = new URLSearchParams({ ...req.query, ...req.params }).toString();
    const shellOpts = { hydrate, mount: hydrate || hasComponents, headExtra, scripts: pd.scripts, routeParamsQS };
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    // A shown flash is consumed — clear the cookie so it appears exactly once.
    if (scope.flash) headers['set-cookie'] = FLASH_COOKIE('', { clear: true, secure: req.secure });

    // Streaming (§7): with the precompiled renderer (§1) a big list page can
    // flush its shell + head immediately and stream rows as they render —
    // lower time-to-first-byte and no whole-page string held in memory.
    // Production list pages only, and only when nothing needs the finished
    // body: no <spark-flash/pager/search> post-processing, no declarative
    // status= (a streamed status line is already sent), no cache store.
    if (!cacheKey && streamablePage(pd)) {
      const [shellPre, shellPost] = shell(page, SHELL_MARK, shellOpts).split(SHELL_MARK);
      const status = (extra && extra.status) || 200;
      const path = req.path;
      const stream = new ReadableStream({
        async start(c) {
          try {
            c.enqueue(sseEnc.encode(shellPre)); // head flushes before the first row renders
            let buf = '';
            const sink = {
              push(s) {
                buf += s;
                if (buf.length >= 16384) { c.enqueue(sseEnc.encode(buf)); buf = ''; }
              },
            };
            await renderFragmentTo(sink, pd.html, scope, rctx);
            c.enqueue(sseEnc.encode(buf + shellPost));
          } catch (e) {
            if (!quiet) console.error(`[spark-ssr] stream ${path} — ${e.stack || e.message}`);
            try { c.enqueue(sseEnc.encode('<!-- spark-ssr: render failed mid-stream -->' + shellPost)); } catch { /* client gone */ }
          }
          try { c.close(); } catch { /* already closed */ }
        },
      });
      return new Response(stream, { status, headers });
    }

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
    let html = shell(page, body, shellOpts);
    if (live && pd.plan.unresolved && pd.plan.unresolved.length) {
      html = html.replace('</body>', unresolvedBanner(pd.plan.unresolved) + '\n</body>');
    }
    const status = (extra && extra.status) || rctx.status || 200;
    // Store for the next anonymous visitor (§6) — never a response that
    // carries a cookie, never a non-200.
    if (cacheKey && status === 200 && !headers['set-cookie']) {
      sourceCache.set(cacheKey, { html, status }, pageCacheTtl, pageTables(pd));
    }
    return new Response(html, { status, headers });
  }

  // A page the streaming path (§7) can serve: production, has at least one
  // list loop (where streaming pays), and nothing that needs the finished
  // body string before the first byte goes out.
  function streamablePage(pd) {
    if (pd.streamable !== undefined) return pd.streamable;
    return (pd.streamable = !live
      && pd.analysis.eachRoots.size > 0
      && !/<spark-(flash|pager|search)\b/i.test(pd.html)
      && !/<template\b[^>]*\bstatus\s*=/i.test(pd.html));
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


  return { servePage, resolveSource, shouldHydrate };
}
