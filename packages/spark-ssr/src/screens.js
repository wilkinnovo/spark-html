/**
 * Built-in screens + generated documents: the zero-config error pages, the
 * overridable auth screens, the dev /__spark/plan view, the generated
 * OpenAPI document + typed client, and SEO (sitemap.xml / robots.txt).
 *
 * Everything here renders standalone HTML/JSON with no dependency on the
 * app's layout or data — the robustness contract: an error page must render
 * even when layout and data are exactly what failed.
 *
 * makeScreens(app) closes over the serve() context bag; app.pagesDir /
 * app.tables / app.apiRoutes are live views of serve() state.
 */
import { join, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { rewriteParams } from './parse.js';
import { localPath } from './request.js';
import { globSource } from './sources.js';

export const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Human copy for the built-in default error screen (used when the app ships
// no <status>.html of its own).
const STATUS_INFO = {
  400: ['Bad request', 'That request could not be understood.'],
  401: ['Sign in required', 'You need to sign in to view this page.'],
  403: ['Forbidden', "You don't have access to this page."],
  404: ['Page not found', "The page you're looking for doesn't exist — it may have moved."],
  500: ['Server error', 'Something went wrong on our end. Try again in a moment.'],
};

export function makeScreens(app) {
  const { root, config, db, live } = app;

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
    for (const dir of new Set([app.pagesDir, root])) {
      const file = join(dir, `${status}.html`);
      if (existsSync(file)) {
        // The reload client rides along so fixing the page un-sticks the browser.
        const custom = readFileSync(file, 'utf8') + (live ? '\n' + app.RELOAD_CLIENT : '');
        return new Response(custom, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    }
    const body = defaultErrorPage(status) + (live ? '\n' + app.RELOAD_CLIENT : '');
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
    const nextField = localPath(next) ? escapeHtml(next) : '';
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
${live ? app.RELOAD_CLIENT : ''}
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
      + app.RELOAD_CLIENT + '</body></html>';
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
    for (const page of app.pages) {
      let pd;
      try { pd = app.pageData(page); } catch { continue; }
      const vars = pd.plan.map((p) => `<code>${esc(p.var)}</code> ← ${esc(srcLabel(p.source))} <em>(${p.shape})</em>`).join('<br>');
      const un = (pd.plan.unresolved || []).map((u) => `<code>{${esc(u.name)}}</code> unresolved`).join('<br>');
      const guards = pd.blocks.filter((b) => b.guard)
        .map((b) => `guard <code>${esc(b.guard)}</code>${b.redirect ? ` → ${esc(b.redirect)}` : ''}`).join('<br>');
      rows += `<tr><td><code>${esc(page.route)}</code></td><td>${esc(relative(root, page.file))}</td>`
        + `<td>${vars}${un ? '<br><span style="color:#f87171">' + un + '</span>' : ''}${guards ? '<br>' + guards : ''}</td></tr>\n`;
    }
    const endpoints = app.apiRoutes.map((r) => `<li><code>${esc(r.method)} /${esc(r.segs.join('/'))}</code></li>`).join('\n');
    const tbls = [...app.tables].map((t) => `<code>${esc(t)}${app.liveTables.has(t) ? ' (live)' : ''}</code>`).join(', ');
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
    for (const r of app.apiRoutes) {
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
    for (const page of app.pages) {
      let pd;
      try { pd = app.pageData(page); } catch { continue; }
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
        if (glob) vals = (await globSource(glob.source.binding.value, root)).map((r) => r.slug);
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

  return {
    errorPage, authScreen, builtinAuthKind, devErrorPage,
    planPage, openapiDoc, clientTs, sitemapXml, robotsTxt,
  };
}
