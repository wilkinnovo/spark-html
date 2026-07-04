/**
 * The HTML template IS the spec — this module reads it.
 *
 * • extractBlocks: pull <spark-ssr> declarations out of a page.
 *     <spark-ssr table="todos" />                      table mode (auto CRUD)
 *     <spark-ssr> GET /api/x → SELECT … </spark-ssr>   explicit queries
 * • rewriteParams: quote-aware `:param` → `?` placeholder rewrite.
 * • analyze: what data the template needs, which binds are local state,
 *   which handlers play which structural role (insert / update / delete).
 * • dataPlan: match template needs to the declared data sources.
 */
import { parseHTML } from 'linkedom';

// ── <spark-ssr> blocks ─────────────────────────────────────────────────
export function extractBlocks(source) {
  const blocks = [];
  const re = /<spark-ssr\b([^>]*?)\/>|<spark-ssr\b([^>]*)>([\s\S]*?)<\/spark-ssr>/gi;
  const html = String(source).replace(re, (m, selfAttrs, attrs, inner) => {
    const attrStr = selfAttrs ?? attrs ?? '';
    const table = (attrStr.match(/\btable\s*=\s*"([^"]+)"/) || [])[1] || null;
    blocks.push({ table, routes: inner ? parseRoutes(inner) : [] });
    return '';
  });
  return { blocks, html };
}

// Route lines:  METHOD [/path] → SQL   (SQL may continue on following lines).
// `->` is accepted alongside `→`.
function parseRoutes(text) {
  const routes = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(GET|POST|PUT|PATCH|DELETE)\s*(\/\S*)?\s*(?:→|->)\s*([\s\S]*)$/);
    if (m) {
      if (cur) routes.push(cur);
      cur = { method: m[1], path: m[2] || null, sql: m[3].trim() };
    } else if (cur && line.trim()) {
      cur.sql += '\n' + line.trim();
    }
  }
  if (cur) routes.push(cur);
  return routes.filter((r) => r.sql);
}

// ── :param → ? rewrite ─────────────────────────────────────────────────
// Skips single-quoted SQL strings ('12:30', '' escapes) and `::` casts.
// Tokens keep dots and dashes (:body.title, :header.x-forwarded-for).
export function rewriteParams(sql) {
  let out = '';
  const tokens = [];
  const s = String(sql);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; }
        if (s[j] === "'") break;
        j++;
      }
      out += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === ':' && s[i + 1] === ':') { out += '::'; i++; continue; }
    if (ch === ':' && /[a-zA-Z_$]/.test(s[i + 1] || '')) {
      let j = i + 1;
      while (j < s.length && /[\w$.-]/.test(s[j])) j++;
      const tok = s.slice(i + 1, j).replace(/[.-]+$/, '');
      tokens.push(tok);
      out += '?';
      i = i + tok.length; // resume after the token (loop ++ steps past it)
      continue;
    }
    out += ch;
  }
  return { sql: out, tokens };
}

// ── template analysis ──────────────────────────────────────────────────
const rootOf = (expr) => (String(expr).trim().match(/^[a-zA-Z_$][\w$]*/) || [])[0] || null;
const BRACE = /\{\s*([a-zA-Z_$][\w$]*)/g;

export function analyze(html) {
  const { document } = parseHTML('<html><body>' + html + '</body></html>');
  const needs = new Set();      // root identifiers the template reads
  const eachRoots = new Set();  // …used as list sources
  const memberRoots = new Set(); // …accessed as objects ({post.title})
  const topBinds = [];          // bind:* to a plain var outside loops → local state
  const rowBinds = [];          // bind:* to a member of a loop var → editable fields
  const handlers = [];          // bare-ref on* handlers with structural context
  let hasScript = false;

  const addRoots = (text, loops) => {
    const s = String(text);
    for (const m of s.matchAll(BRACE)) {
      if (loops.includes(m[1]) || m[1] === 'await' || m[1] === 'event') continue;
      needs.add(m[1]);
      const after = s[m.index + m[0].length];
      if (after === '.' || after === '[') memberRoots.add(m[1]);
    }
  };

  (function walk(node, loops) {
    if (node.nodeType === 3) return addRoots(node.data || '', loops);
    if (node.nodeType !== 1) return;
    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'script') { hasScript = true; return; }
    if (tag === 'style') return;

    let nextLoops = loops;
    if (tag === 'template') {
      const each = node.getAttribute('each');
      const aw = node.getAttribute('await');
      const iff = node.getAttribute('if') || node.getAttribute('else-if');
      if (each) {
        const em = each.match(/^\s*([\w$]+)\s*(?:,\s*([\w$]+))?\s+in\s+([\s\S]+)$/);
        if (em) {
          const src = rootOf(em[3]);
          if (src && !loops.includes(src)) { needs.add(src); eachRoots.add(src); }
          nextLoops = [...loops, em[1], ...(em[2] ? [em[2]] : [])];
        }
      } else if (aw) {
        const src = rootOf(aw.replace(/^once\(/, ''));
        if (src && !loops.includes(src)) needs.add(src);
      } else if (iff) {
        const src = rootOf(iff);
        if (src && !loops.includes(src)) needs.add(src);
      }
      for (const c of (node.content || node).childNodes) walk(c, nextLoops);
      return;
    }

    const nodeHandlers = [];
    let memberBind = false;
    for (const attr of [...(node.attributes || [])]) {
      const n = attr.name;
      const v = String(attr.value || '');
      if (n === 'bind:value' || n === 'bind:checked' || n === 'bind:group') {
        const root = rootOf(v);
        const dot = v.indexOf('.');
        if (root && loops.includes(root) && dot > 0) {
          rowBinds.push({ loopVar: root, field: v.slice(dot + 1).trim() });
          memberBind = true;
        } else if (root && dot === -1) {
          if (!topBinds.some((b) => b.v === root)) topBinds.push({ v: root, kind: n.slice(5) });
        }
      } else if (/^on\w+$/.test(n) && /^\{[\s\S]*\}$/.test(v.trim())) {
        const inner = v.trim().slice(1, -1).trim();
        if (/^[a-zA-Z_$][\w$]*$/.test(inner)) {
          nodeHandlers.push({ name: inner, event: n.slice(2), inEach: loops.length ? loops[loops.length - 1] : null });
        } else {
          addRoots(v, loops);
        }
      } else if (n.startsWith(':')) {
        const src = rootOf(v);
        if (src && !loops.includes(src)) needs.add(src);
      } else {
        addRoots(v, loops);
      }
    }
    for (const h of nodeHandlers) handlers.push({ ...h, withMemberBind: memberBind });

    for (const c of node.childNodes) walk(c, loops);
  })(document.body, []);

  // Local state and handler names aren't data the server must provide.
  for (const b of topBinds) needs.delete(b.v);
  for (const h of handlers) needs.delete(h.name);

  return {
    needs, eachRoots, memberRoots, topBinds, rowBinds, handlers, hasScript,
    interactive: handlers.length > 0 || topBinds.length > 0 || rowBinds.length > 0,
  };
}

// ── data plan: match template needs to declared sources ───────────────
const singular = (s) =>
  s.endsWith('ies') ? s.slice(0, -3) + 'y' : s.endsWith('s') ? s.slice(0, -1) : s;

export function dataPlan(analysis, blocks) {
  const sources = [];
  for (const b of blocks) {
    if (b.table) sources.push({ kind: 'table', table: b.table, name: b.table });
    for (const r of b.routes) {
      if (r.method !== 'GET' || !r.path) continue;
      const segs = r.path.split('/').filter(Boolean)
        .filter((sg) => !sg.startsWith(':') && !sg.startsWith('['));
      sources.push({ kind: 'query', route: r, name: segs[segs.length - 1] || null });
    }
  }
  const plan = [];
  const unresolved = [];
  for (const name of analysis.needs) {
    const shape = analysis.eachRoots.has(name) ? 'list' : 'row';
    const src = sources.find((sg) => sg.name === name)
      || sources.find((sg) => sg.name && singular(sg.name) === name);
    if (src) plan.push({ var: name, source: src, shape: src.kind === 'table' && shape !== 'list' ? 'list' : shape });
    else unresolved.push(name);
  }
  // One leftover DATA-shaped need + one unmatched source → they belong
  // together (the blog example: GET /api/blog feeds {post.title}). Bare
  // scalars like {q} come from the request, not from a query — skip them.
  const unmatched = sources.filter((sg) => !plan.some((p) => p.source === sg));
  const dataShaped = unresolved.filter(
    (n) => analysis.eachRoots.has(n) || (analysis.memberRoots && analysis.memberRoots.has(n)),
  );
  if (dataShaped.length === 1 && unmatched.length === 1) {
    const name = dataShaped[0];
    plan.push({ var: name, source: unmatched[0], shape: analysis.eachRoots.has(name) ? 'list' : 'row' });
  }
  return plan;
}

// A query whose result is one row by construction (aggregates without
// GROUP BY, or LIMIT 1) serves an object instead of an array.
export function singleShaped(sql) {
  const s = String(sql);
  if (/\blimit\s+1\b/i.test(s)) return true;
  return /\b(count|sum|avg|min|max|total)\s*\(/i.test(s) && !/\bgroup\s+by\b/i.test(s);
}
