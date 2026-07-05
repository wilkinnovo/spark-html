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
export function clientComponent({ html, analysis, plan, table, cols, key, live }) {
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

  return document.body.innerHTML + '\n<script>\n' + clientScript({ analysis, plan, table, cols, key, live }) + '</script>\n';
}

// The synthesized component script. Plain functions, no template literals,
// no code-shaped strings (the runtime's script rewriter is not string-aware).
export function clientScript({ analysis, plan, table, cols, key, live }) {
  const L = [];
  L.push(`import __init from '/__spark/data/${key}.js';`);
  for (const p of plan) {
    L.push(`let ${p.var} = __init.${p.var};`);
  }
  for (const b of analysis.topBinds) {
    L.push(`let ${b.v} = ${b.kind === 'checked' ? 'false' : "''"};`);
  }

  if (!table) return L.join('\n') + '\n';
  const api = '/api/' + table;
  const listVar = plan.find((p) => p.source && p.source.kind === 'table' && p.source.table === table)?.var;
  const { insert, update, del } = handlerRoles(analysis);
  const H = { 'content-type': 'application/json' };

  if (listVar) {
    L.push('async function __refresh() {');
    L.push(`  const r = await fetch('${api}');`);
    L.push(`  ${listVar} = await r.json();`);
    L.push('}');
  }
  if (insert) {
    L.push(`async function ${insert.name}() {`);
    L.push('  const body = {};');
    const colNames = cols.map((c) => c.name);
    const fallback = primaryColumn(cols);
    for (const b of analysis.topBinds) {
      const col = colNames.includes(b.v) ? b.v : fallback;
      if (col) L.push(`  body.${col} = ${b.v};`);
    }
    L.push(`  await fetch('${api}', { method: 'POST', headers: ${JSON.stringify(H)}, body: JSON.stringify(body) });`);
    for (const b of analysis.topBinds) L.push(`  ${b.v} = ${b.kind === 'checked' ? 'false' : "''"};`);
    if (listVar) L.push('  await __refresh();');
    L.push('}');
  }
  if (update) {
    L.push(`async function ${update.name}(row) {`);
    L.push('  const body = {};');
    for (const f of [...new Set(analysis.rowBinds.map((b) => b.field))]) {
      L.push(`  body.${f} = row.${f};`);
    }
    L.push(`  await fetch('${api}/' + row.id, { method: 'PATCH', headers: ${JSON.stringify(H)}, body: JSON.stringify(body) });`);
    L.push('}');
  }
  if (del) {
    L.push(`async function ${del.name}(row) {`);
    L.push(`  await fetch('${api}/' + row.id, { method: 'DELETE' });`);
    if (listVar) L.push('  await __refresh();');
    L.push('}');
  }
  // live (§9): every write the server sees on this table pings the channel;
  // every open tab refetches through its own session. Realtime as one
  // attribute — no socket code, no pub/sub setup.
  // Close on pagehide so the channel's HTTP/1.1 socket frees the instant we
  // navigate away — a live EventSource that outlives its page eats one of the
  // browser's ~6 per-host connections, and enough of them (rapid navigation
  // across live pages) starve the next page's own request until the tab hangs.
  // Reopen and refetch on a back/forward-cache restore.
  if (live && listVar) {
    L.push(`let __live;`);
    L.push(`function __openLive() {`);
    L.push(`  __live = new EventSource('/__spark/live');`);
    L.push(`  __live.onmessage = (e) => { if (e.data === '${table}') __refresh(); };`);
    L.push(`}`);
    L.push(`__openLive();`);
    L.push(`addEventListener('pagehide', () => { if (__live) __live.close(); });`);
    L.push(`addEventListener('pageshow', (e) => { if (e.persisted) { __openLive(); __refresh(); } });`);
  }
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
