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

// Structural roles from the analysis (names are the author's own).
export function handlerRoles(analysis) {
  const insert = analysis.handlers.find((h) => !h.inEach) || null;
  const update = analysis.handlers.find((h) => h.inEach && h.withMemberBind) || null;
  const del = analysis.handlers.find((h) => h.inEach && !h.withMemberBind) || null;
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
export function clientComponent({ html, analysis, plan, tables, colsByTable, key, liveTables, authorScript, auto }) {
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
    + clientScript({ analysis, plan, tables, colsByTable, key, liveTables, authorScript, auto }) + '</script>\n';
}

// Top-level names the author's <script> already defines — a synthesized
// handler/helper of the same name is skipped so the author's version wins.
export function definedNames(code) {
  const names = new Set();
  const s = String(code || '');
  for (const m of s.matchAll(/^\s*(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of s.matchAll(/^\s*(?:let|const|var)\s+([a-zA-Z_$][\w$]*)/gm)) names.add(m[1]);
  return names;
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
export function clientScript({ analysis, plan, tables = [], colsByTable = {}, key, liveTables = [], authorScript = '', auto }) {
  const L = [];
  const provided = new Set();               // names the framework declares
  const defined = definedNames(authorScript); // names the author declares

  L.push(`import __init from '/__spark/data/${key}.js';`);
  for (const p of plan) { L.push(`let ${p.var} = __init.${p.var};`); provided.add(p.var); }
  for (const b of analysis.topBinds) {
    if (defined.has(b.v)) continue; // author owns this state var
    L.push(`let ${b.v} = ${b.kind === 'checked' ? 'false' : "''"};`);
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
    L.push(`  const __qs = typeof location !== 'undefined' ? location.search : '';`);
    L.push(`  const __r = await fetch('/__spark/data/${key}.json' + __qs);`);
    L.push(`  const __d = await __r.json();`);
    for (const p of plan) L.push(`  ${p.var} = __d.${p.var};`);
    L.push(`}`);
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
    const { insert, update, del } = handlerRoles(analysis);
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
