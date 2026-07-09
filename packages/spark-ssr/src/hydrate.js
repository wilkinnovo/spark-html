/**
 * Hydration, the Spark way: the browser receives fully-rendered HTML wrapped
 * in a host `<div import="/__spark/page/<key>" data-spark-ssr>`. A client
 * `mount()` re-resolves that import against this module's generated component:
 * the authored page, minus the <spark-ssr> block, plus a synthesized <script>
 * holding local state, the initial data (imported from /__spark/data/<key>.js
 * so no code-shaped strings ever land in a component script), and the CRUD
 * handlers the template implies:
 *
 *   bare handler OUTSIDE a loop                          → insert (POST)
 *   bare handler INSIDE a loop, next to a member bind    → update (PATCH)
 *   bare handler INSIDE a loop, no member bind           → delete (DELETE)
 *
 * Handlers inside loops are rewritten to pass their row: onclick={remove}
 * becomes onclick={remove(todo)} — the runtime runs it as an inline statement.
 *
 * A page may also write its OWN <script> (the ambient-helpers path): the
 * framework injects `api_create/api_update/api_delete` and `refresh()` into
 * scope, synthesizes only the handlers the author didn't define, and appends
 * the author's code. Hydration is source-agnostic — any data source (table,
 * SQL, URL, glob, module) hydrates; `refresh()` refetches them all from the
 * per-request /__spark/data/<key>.json mirror.
 */
import { parseHTML } from 'linkedom';
import { templateKids } from './render.js';
import { definedNames } from './parse.js';

// Names the framework itself may inject into client scope (see clientScript
// below: refresh, navigate, api_*). A template handler sharing one of these
// names is never a synthesis candidate — the author's `onclick={navigate}`
// means "call the ambient helper", not "generate me an insert handler named
// navigate". Without this, any page happening to name a bare handler after
// one of these words gets a synthesized duplicate that clobbers the ambient
// one (found via spark-chat, which wires the ambient navigate() this way).
export const AMBIENT_NAMES = new Set(['refresh', 'navigate', 'api_create', 'api_update', 'api_delete']);

// Structural roles from the analysis (names are the author's own).
export function handlerRoles(analysis, defined = new Set()) {
  // "update" (bind:* on a loop member) and "delete" (plain in-loop call) are
  // structurally distinguishable, but a page can have MORE than one plain
  // in-loop handler — e.g. the docs' own toggle(p) + remove(p) — and both
  // look identical to this heuristic (inEach, no member bind). Only one of
  // them typically needs synthesis (the other is hand-written), so prefer a
  // NOT-yet-defined candidate for each role: that's the one synthesis
  // actually has to fill in. Falls back to the first structural match when
  // every candidate is already defined (nothing to synthesize either way).
  const pick = (pred) => analysis.handlers.find((h) => pred(h) && !defined.has(h.name) && !AMBIENT_NAMES.has(h.name))
    || analysis.handlers.find((h) => pred(h) && !AMBIENT_NAMES.has(h.name)) || null;
  const insert = pick((h) => !h.inEach);
  const update = pick((h) => h.inEach && h.withMemberBind);
  const del = pick((h) => h.inEach && !h.withMemberBind && h.name !== (update && update.name));
  return { insert, update, del };
}

// The column a lone top-level bind maps to when its name isn't a column:
// the first text-ish, non-bookkeeping column.
export function primaryColumn(cols) {
  const skip = new Set(['id', 'user_id', 'created', 'created_at', 'updated', 'updated_at']);
  const texty = cols.filter((c) => !skip.has(c.name) && /CHAR|TEXT|CLOB|^$/.test(c.type || ''));
  return (texty[0] || cols.find((c) => !skip.has(c.name)) || {}).name || null;
}

/**
 * Transform the authored page into the client component served at
 * /__spark/page/<key>.html.
 *  - <template await="x"> unwraps to its resolved-branch content (state
 *    starts from the init module; no promise to wait on client-side).
 *  - loop handlers get their row argument.
 *  - the synthesized <script> is appended.
 */
export function clientComponent({ html, analysis, plan, tables, colsByTable, key, liveTables, authorScript, auto, routeParamsQS }) {
  const { document } = parseHTML('<!doctype html><html><body>' + html + '</body></html>');

  const kids = templateKids;

  (function transform(node, loopVar) {
    if (node.nodeType !== 1) return;
    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'template') {
      const each = node.getAttribute('each');
      const aw = node.getAttribute('await');
      if (aw) {
        // Prefer an explicit then-branch, else the direct children.
        const content = kids(node);
        const thenTpl = content.find((c) => c.nodeType === 1
          && (c.tagName || '').toLowerCase() === 'template' && c.hasAttribute('then'));
        const keep = thenTpl ? kids(thenTpl) : content.filter((c) =>
          !(c.nodeType === 1 && (c.tagName || '').toLowerCase() === 'template'
            && (c.hasAttribute('then') || c.hasAttribute('catch'))));
        for (const k of keep) node.parentNode.insertBefore(k, node);
        node.remove();
        for (const k of keep) transform(k, loopVar);
        return;
      }
      let inner = loopVar;
      if (each) {
        const em = each.match(/^\s*([\w$]+)/);
        if (em) inner = em[1];
      }
      // Attribute rewrites must reach BOTH of linkedom's template stores —
      // it may hold duplicate copies in .content and .childNodes, and which
      // one the serializer emits varies. (Moves, like the await unwrap above,
      // take just the canonical side since the template is removed after.)
      const seen = new Set();
      for (const c of [...(node.content ? node.content.childNodes : []), ...node.childNodes]) {
        if (seen.has(c)) continue;
        seen.add(c);
        transform(c, inner);
      }
      return;
    }
    if (loopVar && node.attributes) {
      for (const attr of [...node.attributes]) {
        const v = String(attr.value || '').trim();
        if (/^on\w+$/.test(attr.name) && /^\{[a-zA-Z_$][\w$]*\}$/.test(v)) {
          const name = v.slice(1, -1);
          if (analysis.handlers.some((h) => h.name === name && h.inEach)) {
            attr.value = '{' + name + '(' + loopVar + ')}';
          }
        }
      }
    }
    for (const c of [...node.childNodes]) transform(c, loopVar);
  })(document.body, null);

  return document.body.innerHTML + '\n<script>\n'
    + clientScript({ analysis, plan, tables, colsByTable, key, liveTables, authorScript, auto, routeParamsQS }) + '</script>\n';
}

// Strip the author's own `let/const/var name = …;` for names the framework
// declares (the plan vars and top-level binds) so there's no double-declare —
// the framework's version is seeded from real data / the reactive default.
function stripDeclarations(code, names) {
  if (!code) return '';
  return String(code)
    .split('\n')
    .filter((line) => {
      const m = line.match(/^\s*(?:let|const|var)\s+([a-zA-Z_$][\w$]*)\s*=/);
      return !(m && names.has(m[1]));
    })
    .join('\n')
    .trim();
}

// The synthesized component script. Plain functions, no template literals,
// no code-shaped strings (the runtime's script rewriter is not string-aware).
// Every generated local/param is `__`-prefixed: the rewriter turns any bare
// assignment to a top-level state name into a reactive write, so a helper
// local named `body`/`q`/`row` would clobber the page's own {body}/{q} state.
export function clientScript({ analysis, plan, tables = [], colsByTable = {}, key, liveTables = [], authorScript = '', auto, routeParamsQS = '' }) {
  const L = [];
  const provided = new Set();               // names the framework declares
  const defined = definedNames(authorScript); // names the author declares
  // Names the author defines as `function name(…)` — these are their own
  // client-side implementation (SSR uses the plan's MODULE source instead).
  // Skip them in plan-driven declarations and refresh so the author's function
  // is never overwritten by a JSON-serialized undefined (functions can't
  // round-trip through JSON).
  const authorFunctions = new Set();
  const funcRe = /(?:^|[\n;{}])\s*(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/g;
  let fm;
  while ((fm = funcRe.exec(authorScript)) !== null) authorFunctions.add(fm[1]);
  // Names the author creates as stores via `useStore('name')`. These shouldn't
  // be plan-driven client declarations — the store IS the client state, and the
  // plan value (from a MODULE source) is only for SSR rendering. Skip them so
  // the `useStore` call survives stripDeclarations and the store is created.
  const storeBacked = new Set();
  const storeRe = /^\s*(?:let|const|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*useStore\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
  let sm;
  while ((sm = storeRe.exec(authorScript)) !== null) storeBacked.add(sm[1]);

  // A [param] route's :id/:slug is a PATH segment — it's never in the query
  // string, so unlike ?q/?sort/?page it can't ride along via location.search
  // (every instance of this route shares the same /__spark/data/<key> URL).
  // The server resolves it once per request and bakes it on here; see
  // shell()'s routeParamsQS in server.js.
  L.push(`import __init from '/__spark/data/${key}.js${routeParamsQS ? '?' + routeParamsQS : ''}';`);
  for (const p of plan) {
    if (authorFunctions.has(p.var)) continue; // author's fn is the client impl
    if (storeBacked.has(p.var)) continue;     // store IS the client state
    L.push(`let ${p.var} = __init.${p.var};`);
    provided.add(p.var);
  }
  // Seeded from the CURRENT query string on the client, not a hardcoded
  // empty default — this script is static and shared across every instance
  // of this route (one /__spark/page/<key>), so it can't bake a per-request
  // value in server-side. Without this, a bookmarked/shared `?q=...` URL
  // rendered its filtered view correctly at SSR, then hydration silently
  // reset the bound var to '' the moment JS took over (reproduced even in
  // create-spark-html-app's own ssr-nodb template: /?q=spark loses its
  // filter as soon as the page hydrates).
  if (analysis.topBinds.some((b) => !defined.has(b.v))) {
    L.push(`const __qs = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;`);
  }
  for (const b of analysis.topBinds) {
    if (defined.has(b.v)) continue; // author owns this state var
    const fallback = b.kind === 'checked' ? 'false' : "''";
    const read = b.kind === 'checked' ? `__qs.get('${b.v}') === 'true'` : `__qs.get('${b.v}')`;
    L.push(`let ${b.v} = __qs && __qs.has('${b.v}') ? ${read} : ${fallback};`);
    provided.add(b.v);
  }
  // Ambient scope the layout relies on ({path} for nav highlighting,
  // {session} for the signed-in user) — kept alive through a whole-page
  // hydration under a layout, not just the SSR pass. {path} is the live
  // location (the init module's own path is the data URL, not the page);
  // {session} is seeded from the init module (only the server knows it).
  if (analysis.needs.has('path') && !provided.has('path') && !defined.has('path')) {
    L.push(`let path = typeof location !== 'undefined' ? location.pathname : '/';`);
    provided.add('path');
  }
  if (analysis.needs.has('session') && !provided.has('session') && !defined.has('session')) {
    L.push(`let session = __init.session;`);
    provided.add('session');
  }

  // refresh() — source-agnostic re-fetch: re-run every declared source through
  // the per-request JSON mirror and reassign the page's vars. Works the same
  // for tables, SQL, URL, glob and module sources. Carries the current query
  // string so ?q / ?sort / ?page-driven sources refetch in context.
  if (plan.length && !defined.has('refresh')) {
    L.push(`async function refresh() {`);
    L.push(`  const __ls = typeof location !== 'undefined' ? location.search.slice(1) : '';`);
    L.push(`  const __qs = [${JSON.stringify(routeParamsQS)}, __ls].filter(Boolean).join('&');`);
    L.push(`  const __r = await fetch('/__spark/data/${key}.json' + (__qs ? '?' + __qs : ''));`);
    L.push(`  const __d = await __r.json();`);
    for (const p of plan) {
      if (authorFunctions.has(p.var)) continue; // author's fn is the client impl
      if (storeBacked.has(p.var)) continue;     // store IS the client state
      L.push(`  ${p.var} = __d.${p.var};`);
    }
    L.push(`}`);
  }

  // navigate(e) — click-delegate same-page links so query-string-only nav
  // (list/detail selection, filters, pagination — anything driven by
  // ?param=) refetches through refresh() instead of a full document reload.
  // Wire it once on a container: onclick={navigate}. Cross-origin and
  // cross-path links (a different route) are ignored and fall through to a
  // normal navigation, so this is opt-in sugar on top of refresh(), not a
  // router — no route table, no new concept for pages that don't use it.
  if (plan.length && !defined.has('navigate')) {
    L.push(`function navigate(e) {`);
    L.push(`  const __a = e.target.closest ? e.target.closest('a') : null;`);
    L.push(`  if (!__a || __a.origin !== location.origin || __a.pathname !== location.pathname) return;`);
    L.push(`  e.preventDefault();`);
    L.push(`  history.pushState({}, '', __a.href);`);
    L.push(`  refresh();`);
    L.push(`}`);
    L.push(`addEventListener('popstate', refresh);`);
  }

  const H = { 'content-type': 'application/json' };
  const defaultTable = tables.length === 1 ? tables[0] : null;

  // Ambient CRUD helpers — always available when the page has ≥1 table. The
  // table is the sole one on the page (inferred), or passed as a leading
  // string argument when several are in play: api_create('posts', {…}).
  if (tables.length) {
    L.push(`const __table = ${JSON.stringify(defaultTable)};`);
    L.push(`function __api(__a) { if (typeof __a === 'string') return __a; if (!__table) throw new Error('spark-ssr: page has multiple tables — pass one, e.g. api_create("posts", {…})'); return __table; }`);
    if (!defined.has('api_create')) {
      L.push(`async function api_create(__a, __b) { const __t = __api(__a); const __body = typeof __a === 'string' ? __b : __a;`);
      L.push(`  const __r = await fetch('/api/' + __t, { method: 'POST', headers: ${JSON.stringify(H)}, body: JSON.stringify(__body) }); return __r.json(); }`);
    }
    if (!defined.has('api_update')) {
      L.push(`async function api_update(__a, __b, __c) { const __s = typeof __a === 'string'; const __t = __api(__a); const __id = __s ? __b : __a; const __body = __s ? __c : __b;`);
      L.push(`  const __r = await fetch('/api/' + __t + '/' + __id, { method: 'PATCH', headers: ${JSON.stringify(H)}, body: JSON.stringify(__body) }); return __r.json(); }`);
    }
    if (!defined.has('api_delete')) {
      L.push(`async function api_delete(__a, __b) { const __s = typeof __a === 'string'; const __t = __api(__a); const __id = __s ? __b : __a;`);
      L.push(`  const __r = await fetch('/api/' + __t + '/' + __id, { method: 'DELETE' }); return __r.json(); }`);
    }
  }

  // Auto-generated handlers — only for single-table pages (the role model is
  // one insert/update/delete set). Multi-table pages write their own handlers
  // on top of the ambient helpers. `auto` narrows or suppresses generation.
  if (defaultTable) {
    const list = auto === undefined || auto === null ? null
      : auto === 'none' ? [] : String(auto).split(',').map((s) => s.trim()).filter(Boolean);
    const wants = (role) => role && !defined.has(role.name) && (list === null || list.includes(role.name));
    const { insert, update, del } = handlerRoles(analysis, defined);
    const cols = colsByTable[defaultTable] || [];
    if (wants(insert)) {
      L.push(`async function ${insert.name}() {`);
      L.push('  const __body = {};');
      const colNames = cols.map((c) => c.name);
      const fallback = primaryColumn(cols);
      for (const b of analysis.topBinds) {
        const col = colNames.includes(b.v) ? b.v : fallback;
        if (col) L.push(`  __body.${col} = ${b.v};`);
      }
      L.push(`  await api_create(__body);`);
      for (const b of analysis.topBinds) L.push(`  ${b.v} = ${b.kind === 'checked' ? 'false' : "''"};`);
      L.push('  await refresh();');
      L.push('}');
    }
    if (wants(update)) {
      L.push(`async function ${update.name}(__row) {`);
      L.push('  const __body = {};');
      for (const f of [...new Set(analysis.rowBinds.map((b) => b.field))]) L.push(`  __body.${f} = __row.${f};`);
      L.push(`  await api_update(__row.id, __body);`);
      L.push('}');
    }
    if (wants(del)) {
      L.push(`async function ${del.name}(__row) {`);
      L.push(`  await api_delete(__row.id);`);
      L.push('  await refresh();');
      L.push('}');
    }
  }

  // live (§9): every write the server sees on a live table pings the channel;
  // every open tab refetches through its own session. Realtime as one
  // attribute — no socket code, no pub/sub setup.
  // Close on pagehide so the channel's HTTP/1.1 socket frees the instant we
  // navigate away — a live EventSource that outlives its page eats one of the
  // browser's ~6 per-host connections, and enough of them (rapid navigation
  // across live pages) starve the next page's own request until the tab hangs.
  // Reopen and refetch on a back/forward-cache restore.
  const live = liveTables.filter((t) => tables.includes(t));
  if (live.length && plan.length && !defined.has('refresh')) {
    L.push(`const __liveTables = ${JSON.stringify(live)};`);
    L.push(`let __live;`);
    L.push(`function __openLive() {`);
    L.push(`  __live = new EventSource('/__spark/live');`);
    L.push(`  __live.onmessage = (e) => { if (__liveTables.includes(e.data)) refresh(); };`);
    L.push(`}`);
    L.push(`__openLive();`);
    L.push(`addEventListener('pagehide', () => { if (__live) __live.close(); });`);
    L.push(`addEventListener('pageshow', (e) => { if (e.persisted) { __openLive(); refresh(); } });`);
  }

  // The author's own handlers — declarations of provided state/plan vars are
  // dropped (the framework declares those), the rest is appended verbatim.
  const rest = stripDeclarations(authorScript, provided);
  if (rest) L.push(rest);

  return L.join('\n') + '\n';
}

// The per-request init module served at /__spark/data/<key>.js — plain data
// in bundled JS (never inlined into a component <script>), no-store cached.
export function initModule(data) {
  const json = JSON.stringify(data)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/<\//g, '<\\/');
  return 'export default ' + json + ';\n';
}
