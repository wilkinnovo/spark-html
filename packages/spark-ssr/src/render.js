/**
 * Server-side renderer for Spark templates: {expr} interpolation,
 * <template each/if/else-if/else/await>, :attr dynamics, and <div import>
 * component composition — rendered to static HTML. Event handlers and bind:
 * attributes are stripped (the hydration component re-attaches them
 * client-side; static pages don't need them).
 *
 * Precompiled (§1 of ssr-improvements.md): linkedom parses each template
 * ONCE, at compile time — the parsed DOM is walked into a flat program of
 * ops (static chunks, interpolations, each/if/await/import), and rendering
 * a request is a loop over ops pushing strings. No DOM, no serialization,
 * no linkedom on the request path. Static chunks are captured FROM the
 * linkedom DOM, so the output is byte-compatible with what the old
 * parse-mutate-serialize pipeline produced (same entity escaping, same
 * attribute normalization, same template quirks).
 */
import { parseHTML } from 'linkedom';
import { maskComments } from './parse.js';

const FN_CACHE = new Map();
function compile(expr) {
  let fn = FN_CACHE.get(expr);
  if (!fn) {
    try { fn = new Function('__scope__', 'with (__scope__) { return (' + expr + '); }'); }
    catch { fn = () => undefined; }
    FN_CACHE.set(expr, fn);
  }
  return fn;
}

// Every identifier resolves through the scope proxy (undefined when absent),
// with the handful of globals expressions legitimately reach for.
const GLOBALS = {
  JSON, Math, Date, Object, Array, String, Number, Boolean,
  encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
};
// One proxy per scope OBJECT, not per expression: a 1,000-row loop with five
// bindings per row used to allocate 5,000 proxies per render; the memo makes
// it one per row scope (§2).
const PROXY_MEMO = new WeakMap();
function scopeProxy(scope) {
  let p = PROXY_MEMO.get(scope);
  if (!p) {
    p = new Proxy(scope, {
      has: (t, k) => k !== Symbol.unscopables,
      get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : GLOBALS[k]),
    });
    PROXY_MEMO.set(scope, p);
  }
  return p;
}
export function evalExpr(expr, scope) {
  try { return compile(expr)(scopeProxy(scope)); }
  catch { return undefined; }
}
// Ops carry the compiled function; this is evalExpr minus the FN_CACHE hit.
function evalFn(fn, scope) {
  try { return fn(scopeProxy(scope)); }
  catch { return undefined; }
}

const str = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// linkedom's serialization rules, reproduced for the dynamic parts (static
// chunks come from linkedom itself): text escapes & < >; HTML attribute
// values escape only the double quote; a fixed set of attributes serializes
// bare when the value is empty.
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => String(s).replace(/"/g, '&quot;');
const EMPTY_ATTRS = new Set([
  'allowfullscreen', 'allowpaymentrequest', 'async', 'autofocus', 'autoplay',
  'checked', 'class', 'contenteditable', 'controls', 'default', 'defer',
  'disabled', 'draggable', 'formnovalidate', 'hidden', 'ismap', 'itemscope',
  'loop', 'multiple', 'muted', 'nomodule', 'novalidate', 'open', 'playsinline',
  'readonly', 'required', 'reversed', 'selected', 'style', 'truespeed',
]);
// linkedom serializes `id=""`/`style=""` bare too, but bare id is invalid
// HTML the old pipeline never produced from OUR setAttribute path — keep the
// full list for parity with parsed-static attributes.
const VOID = /^(?:area|base|br|col|embed|hr|img|input|keygen|link|menuitem|meta|param|source|track|wbr)$/;

// linkedom's template parsing is inconsistent: children can land in .content,
// in .childNodes, split between the two (whitespace one side, elements the
// other), or fully DUPLICATED into both. Never merge — pick the side that
// actually holds elements; on a tie (duplicates) .content is canonical.
export function templateKids(node) {
  const c = node.content ? [...node.content.childNodes] : [];
  const d = [...node.childNodes];
  if (!c.length) return d;
  if (!d.length) return c;
  const hasEl = (a) => a.some((n) => n.nodeType === 1);
  if (hasEl(c)) return c;
  if (hasEl(d)) return d;
  return c;
}

// ── compile: DOM → ops ─────────────────────────────────────────────────
// Op shapes (t = type):
//   static  { s }                                   raw HTML chunk
//   text    { parts: (string | {fn})[] }            interpolated text node
//   el      { tag, attrs, kids, void }              element with dynamic bits
//   each    { v, i, fn, kids }                      <template each>
//   ifchain { links: [{ fn|null, status, kids, trail }] }
//   await   { fn, as, then, catch: c, direct }      <template await>
//   import  { tag, spec, attrs, kids }              component host
//   slot    {}                                      <slot> in a component
// attrs entries: { kind: 'static', name, value(escaped) }
//              | { kind: 'interp', name, parts }
//              | { kind: 'dyn', name, fn }

const textParts = (t, esc) => {
  const parts = [];
  let last = 0;
  for (const m of String(t).matchAll(/\{([^{}]+)\}/g)) {
    if (m.index > last) parts.push(esc(t.slice(last, m.index)));
    parts.push({ fn: compile(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < t.length) parts.push(esc(t.slice(last)));
  return parts;
};

function compileAttrs(node) {
  const attrs = [];
  for (const attr of node.attributes) {
    const n = attr.name;
    const v = String(attr.value || '');
    if (n.startsWith('bind:') || (/^on\w+$/.test(n) && v.trim().startsWith('{'))) continue;
    if (n.startsWith(':')) { attrs.push({ kind: 'dyn', name: n.slice(1), fn: compile(v) }); continue; }
    if (v.includes('{')) { attrs.push({ kind: 'interp', name: n, parts: textParts(v, escapeAttr) }); continue; }
    attrs.push({ kind: 'static', name: n, value: escapeAttr(v) });
  }
  return attrs;
}

// Serialize one raw (untransformed) attribute the way linkedom would.
const rawAttr = (attr) => {
  const v = String(attr.value || '');
  return v === '' && EMPTY_ATTRS.has(attr.name) ? attr.name : `${attr.name}="${escapeAttr(v)}"`;
};

function compileList(nodes) {
  const ops = [];
  const push = (s) => {
    // Merge adjacent static chunks so the render loop touches fewer ops.
    if (ops.length && ops[ops.length - 1].t === 'static') ops[ops.length - 1].s += s;
    else ops.push({ t: 'static', s });
  };
  for (let idx = 0; idx < nodes.length; idx++) {
    const node = nodes[idx];
    if (node.nodeType === 3) {
      const t = String(node.data || '');
      if (!t.includes('{')) { push(escapeText(t)); continue; }
      const parts = textParts(t, escapeText);
      if (parts.every((p) => typeof p === 'string')) push(parts.join(''));
      else ops.push({ t: 'text', parts });
      continue;
    }
    if (node.nodeType === 8) { push('<!--' + String(node.data || '') + '-->'); continue; }
    if (node.nodeType !== 1) continue;
    const tag = node.localName || (node.tagName || '').toLowerCase();
    if (node.hasAttribute('spark-ignore')) { push(node.outerHTML); continue; }
    if (tag === 'script') continue; // stripped from server output
    if (tag === 'style') { push(node.outerHTML); continue; }

    if (tag === 'template') {
      if (node.hasAttribute('each')) {
        const expr = node.getAttribute('each') || '';
        const m = expr.match(/^\s*([\w$]+)\s*(?:,\s*([\w$]+))?\s+in\s+([\s\S]+)$/);
        if (m) ops.push({ t: 'each', v: m[1], i: m[2] || null, fn: compile(m[3]), kids: compileList(templateKids(node)) });
        continue;
      }
      if (node.hasAttribute('await')) {
        const expr = (node.getAttribute('await') || '').replace(/^once\(([\s\S]*)\)$/, '$1');
        const content = templateKids(node);
        const isTpl = (n, a) => n.nodeType === 1 && (n.tagName || '').toLowerCase() === 'template' && n.hasAttribute(a);
        const thenNodes = [];
        const catchNodes = [];
        const direct = [];
        for (const c of content) {
          if (isTpl(c, 'then')) thenNodes.push(...templateKids(c));
          else if (isTpl(c, 'catch')) catchNodes.push(...templateKids(c));
          else direct.push(c);
        }
        ops.push({
          t: 'await', fn: compile(expr), as: node.getAttribute('as') || null,
          then: compileList(thenNodes), catch: compileList(catchNodes), direct: compileList(direct),
        });
        continue;
      }
      if (node.hasAttribute('if')) {
        // Collect the chain: this template plus adjacent else-if / else
        // templates. Whitespace between links stays in the output at its
        // original position (the old walker never removed it).
        const links = [{
          fn: compile(node.getAttribute('if') || ''),
          status: Number(node.getAttribute('status')) || 0,
          kids: compileList(templateKids(node)),
          trail: '',
        }];
        while (idx + 1 < nodes.length) {
          let j = idx + 1;
          let ws = '';
          while (j < nodes.length && nodes[j].nodeType === 3 && !String(nodes[j].data).trim()) {
            ws += String(nodes[j].data); j++;
          }
          const probe = nodes[j];
          if (!probe || probe.nodeType !== 1 || (probe.tagName || '').toLowerCase() !== 'template'
            || !(probe.hasAttribute('else-if') || probe.hasAttribute('else'))) break;
          links[links.length - 1].trail = escapeText(ws);
          links.push({
            fn: probe.hasAttribute('else-if') ? compile(probe.getAttribute('else-if') || '') : null,
            status: Number(probe.getAttribute('status')) || 0,
            kids: compileList(templateKids(probe)),
            trail: '',
          });
          idx = j;
        }
        ops.push({ t: 'ifchain', links });
        continue;
      }
      if (node.hasAttribute('else-if') || node.hasAttribute('else')) continue; // orphan — removed
      push(node.outerHTML); // plain template: leave inert, children untouched
      continue;
    }

    if (tag === 'slot') {
      // Inside a component this is replaced by the caller's rendered slot
      // content; on a page (no component context) it stays a normal element.
      ops.push({ t: 'slot', el: { t: 'el', tag, attrs: compileAttrs(node), kids: compileList([...node.childNodes]), void: false } });
      continue;
    }

    if (node.hasAttribute('import')) {
      ops.push({
        t: 'import', tag,
        spec: node.getAttribute('import'),
        attrs: [...node.attributes].map((a) => ({ name: a.name, value: String(a.value || '') })),
        kids: compileList([...node.childNodes]),
      });
      continue;
    }

    // No-JS forms (§5): redirect="…" and flash="…" on a form posting to
    // /api/* become hidden _redirect / _flash fields; the attributes
    // themselves never reach the browser.
    let extraKids = null;
    let dropAttrs = null;
    if (tag === 'form' && (node.hasAttribute('redirect') || node.hasAttribute('flash'))) {
      const isApi = (node.getAttribute('action') || '').startsWith('/api/');
      dropAttrs = new Set(['redirect', 'flash']);
      if (isApi) {
        extraKids = [];
        for (const [attr, field] of [['redirect', '_redirect'], ['flash', '_flash']]) {
          if (!node.hasAttribute(attr)) continue;
          const v = node.getAttribute(attr);
          const valueAttr = v.includes('{')
            ? { kind: 'interp', name: 'value', parts: textParts(v, escapeAttr) }
            : { kind: 'static', name: 'value', value: escapeAttr(v) };
          extraKids.push({
            t: 'el', tag: 'input', void: true, kids: [],
            attrs: [
              { kind: 'static', name: 'type', value: 'hidden' },
              { kind: 'static', name: 'name', value: field },
              valueAttr,
            ],
          });
        }
      }
    }

    let attrs = compileAttrs(node);
    if (dropAttrs) attrs = attrs.filter((a) => !(a.kind === 'static' && dropAttrs.has(a.name)));
    const isVoid = VOID.test(tag);
    let kids = isVoid ? [] : compileList([...node.childNodes]);
    if (extraKids) kids = kids.concat(extraKids);

    // Fully static element → one chunk.
    if (attrs.every((a) => a.kind === 'static') && kids.every((k) => k.t === 'static')) {
      const open = '<' + tag + attrs.map((a) => ' ' + (a.value === '' && EMPTY_ATTRS.has(a.name) ? a.name : `${a.name}="${a.value}"`)).join('') + '>';
      push(open + kids.map((k) => k.s).join('') + (isVoid ? '' : `</${tag}>`));
      continue;
    }
    ops.push({ t: 'el', tag, attrs, kids, void: isVoid });
  }
  return ops;
}

// ── program caches ─────────────────────────────────────────────────────
function lru(max) {
  const m = new Map();
  return {
    get(k) {
      if (!m.has(k)) return undefined;
      const v = m.get(k);
      m.delete(k); m.set(k, v);
      return v;
    },
    set(k, v) {
      if (m.has(k)) m.delete(k);
      else if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, v);
    },
  };
}
// Keyed by the template string itself: pages are mtime-cached upstream, so
// the same string arrives per request until the file changes; components are
// keyed by their (stripped) source. LRU-bounded so edits don't accumulate.
const PROGRAMS = lru(256);
const COMPONENTS = lru(256);

function programFor(html) {
  let prog = PROGRAMS.get(html);
  if (!prog) {
    const { document } = parseHTML('<!doctype html><html><body>' + html + '</body></html>');
    prog = compileList([...document.body.childNodes]);
    PROGRAMS.set(html, prog);
  }
  return prog;
}

// Literal top-level defaults from a component <script> (let count = 0;
// let greeting = 'hi') so the SSR output shows initial values instead of
// blanks. Anything non-literal is skipped — the client boot computes it.
export function scriptLiterals(code) {
  const out = {};
  for (const m of String(code).matchAll(/^\s*(?:let|var|const)\s+([a-zA-Z_$][\w$]*)\s*=\s*(.+?);?\s*$/gm)) {
    const raw = m[2].trim();
    try {
      out[m[1]] = JSON.parse(raw.replace(/^'([^'\\]*)'$/, '"$1"'));
    } catch { /* not a literal — client-side only */ }
  }
  return out;
}

// Components are pure UI on the server: strip <spark-ssr>/<script> from the
// output, but read literal script defaults so {count} renders as 0.
// Comments are masked so prose mentioning those tags never truncates one.
function componentProgram(source) {
  let comp = COMPONENTS.get(source);
  if (!comp) {
    let script = '';
    const { masked, restore } = maskComments(source);
    const clean = restore(masked
      .replace(/<spark-ssr\b[^>]*?\/>|<spark-ssr\b[^>]*>[\s\S]*?<\/spark-ssr>/gi, '')
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (m, body) => { script += body + '\n'; return ''; }));
    comp = { ops: programFor(clean), literals: scriptLiterals(script) };
    COMPONENTS.set(source, comp);
  }
  return comp;
}

// ── render: ops → string ───────────────────────────────────────────────
/**
 * Render an HTML fragment (a Spark page or component body) with `scope`.
 * ctx: { loadComponent(spec) → html|null, keepImports, dev, maxDepth }
 * On return ctx.status carries a status a rendered branch declared (§3).
 */
export async function renderFragment(html, scope, ctx = {}, depth = 0) {
  const out = [];
  await run(programFor(html), scope, ctx, out, depth, null);
  return out.join('');
}

/**
 * Streaming variant (§7): render into any { push(string) } sink instead of
 * building the whole page string — the server wires this to a ReadableStream
 * so big list pages flush as they render.
 */
export async function renderFragmentTo(sink, html, scope, ctx = {}, depth = 0) {
  await run(programFor(html), scope, ctx, sink, depth, null);
}

async function run(ops, scope, ctx, out, depth, slotHtml) {
  for (const op of ops) {
    switch (op.t) {
      case 'static':
        out.push(op.s);
        break;
      case 'text': {
        let s = '';
        for (const p of op.parts) s += typeof p === 'string' ? p : escapeText(str(evalFn(p.fn, scope)));
        out.push(s);
        break;
      }
      case 'el':
        emitOpen(op, scope, out);
        if (!op.void) {
          await run(op.kids, scope, ctx, out, depth, slotHtml);
          out.push(`</${op.tag}>`);
        }
        break;
      case 'each': {
        const arr = evalFn(op.fn, scope);
        if (Array.isArray(arr)) {
          for (let i = 0; i < arr.length; i++) {
            const rowScope = Object.create(scope);
            rowScope[op.v] = arr[i];
            if (op.i) rowScope[op.i] = i;
            await run(op.kids, rowScope, ctx, out, depth, slotHtml);
          }
        }
        break;
      }
      case 'ifchain': {
        let winner = -1;
        for (let i = 0; i < op.links.length; i++) {
          if (op.links[i].fn === null || evalFn(op.links[i].fn, scope)) { winner = i; break; }
        }
        for (let i = 0; i < op.links.length; i++) {
          if (i === winner) {
            // Declarative status (§3): the rendered branch sets the response
            // status — <template else status="404"> stops being a 200.
            if (op.links[i].status) ctx.status = op.links[i].status;
            await run(op.links[i].kids, scope, ctx, out, depth, slotHtml);
          }
          out.push(op.links[i].trail);
        }
        break;
      }
      case 'await': {
        let value;
        let failed = null;
        try {
          value = evalFn(op.fn, scope);
          if (value && typeof value.then === 'function') value = await value;
        } catch (e) { failed = e; }
        // Resolved: the then-branch when declared, otherwise the direct
        // content. Failed: the catch-branch if written, otherwise a default
        // inline error boundary — a throwing await degrades to a message,
        // never a silently blank section.
        if (failed && !op.catch.length) {
          out.push(defaultAwaitError(failed, ctx));
          break;
        }
        const branchScope = Object.create(scope);
        branchScope.await = failed || value;
        if (op.as) branchScope[op.as] = failed || value;
        const branch = failed ? op.catch : op.then.length ? op.then : op.direct;
        await run(branch, branchScope, ctx, out, depth, slotHtml);
        break;
      }
      case 'slot':
        if (slotHtml === null) { // page context — a literal <slot> element
          emitOpen(op.el, scope, out);
          await run(op.el.kids, scope, ctx, out, depth, slotHtml);
          out.push('</slot>');
        } else {
          out.push(slotHtml);
        }
        break;
      case 'import':
        await renderImport(op, scope, ctx, out, depth, slotHtml);
        break;
    }
  }
}

function emitOpen(op, scope, out) {
  const pairs = [];
  for (const a of op.attrs) {
    if (a.kind === 'static') { pairs.push({ name: a.name, value: a.value }); continue; }
    if (a.kind === 'interp') {
      let v = '';
      for (const p of a.parts) v += typeof p === 'string' ? p : escapeAttr(str(evalFn(p.fn, scope)));
      pairs.push({ name: a.name, value: v });
      continue;
    }
    const val = evalFn(a.fn, scope);
    if (val === false || val == null) continue;
    if (a.name === 'class') {
      const ex = pairs.find((p) => p.name === 'class');
      if (ex) { ex.value = (ex.value + ' ' + escapeAttr(str(val))).trim(); continue; }
      pairs.push({ name: 'class', value: escapeAttr(str(val)).trim() });
      continue;
    }
    const ex = pairs.find((p) => p.name === a.name);
    const value = val === true ? '' : escapeAttr(str(val));
    if (ex) ex.value = value;
    else pairs.push({ name: a.name, value });
  }
  let s = '<' + op.tag;
  for (const p of pairs) {
    s += ' ' + (p.value === '' && EMPTY_ATTRS.has(p.name) ? p.name : `${p.name}="${p.value}"`);
  }
  out.push(s + '>');
}

// The zero-config error boundary for a failed <template await> with no catch.
// Dev shows the real reason; production stays generic.
function defaultAwaitError(failed, ctx) {
  const msg = ctx && ctx.dev
    ? '⚠ Failed to load: ' + (failed && (failed.message || String(failed)))
    : '⚠ This section could not be loaded.';
  return '<div role="alert" data-spark-await-error="" style="'
    + 'border:1px solid #ff6b6b;background:rgba(255,107,107,.1);color:#ff6b6b;'
    + 'border-radius:8px;padding:.6rem .8rem;font-size:.85rem">'
    + escapeText(msg) + '</div>';
}

// Round-trip an evaluated prop back to an attribute string the runtime's
// coerce() understands ('' = true, JSON for objects, …) — same contract as
// spark-prerender's serializeProp.
function serializeProp(v) {
  if (v === true) return '';
  if (v === false) return 'false';
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

async function renderImport(op, scope, ctx, out, depth, outerSlot) {
  const maxDepth = ctx.maxDepth || 20;
  if (depth >= maxDepth) {
    // Recursion stop: the host serializes untouched, with empty content.
    out.push('<' + op.tag + op.attrs.map((a) => ' ' + rawAttr(a)).join('') + '>' + (VOID.test(op.tag) ? '' : `</${op.tag}>`));
    return;
  }

  // A top-level host on a page that will client-mount keeps its import (plus
  // a `name` and its evaluated props) so the runtime's flash-free hydrate
  // path re-resolves it and the component comes alive — exactly the contract
  // spark-prerender's makeHydratable establishes. Nested hosts are inlined;
  // their parent rebuilds them on the client.
  const keepHost = !!ctx.keepImports && depth === 0;

  // Slot content renders in the CALLER's scope, before the component swaps in.
  const slotOut = [];
  await run(op.kids, scope, ctx, slotOut, depth, outerSlot);
  const slotHtml = slotOut.join('');

  // Props: attribute values; `{expr}` evaluates in the caller's scope
  // (objects pass through intact). class/id stay on the host element.
  const props = Object.create(null);
  const hostPairs = [];
  for (const attr of op.attrs) {
    const n = attr.name;
    const v = attr.value;
    if (n === 'import') {
      if (keepHost) {
        hostPairs.push({ name: 'import', value: escapeAttr(v) });
        hostPairs.push({
          name: 'name',
          value: escapeAttr(String(op.spec).split(/[?#]/)[0].replace(/\/+$/, '').replace(/.*\//, '').replace(/\.html$/, '')),
        });
      }
      continue;
    }
    if (n === 'name') { if (!keepHost) hostPairs.push({ name: n, value: escapeAttr(v) }); continue; }
    if (n.startsWith('data-spark')) { hostPairs.push({ name: n, value: escapeAttr(v) }); continue; }
    if (n === 'class' || n === 'id') {
      hostPairs.push({ name: n, value: v.includes('{') ? escapeAttr(interpolate(v, scope)) : escapeAttr(v) });
      continue;
    }
    const exact = v.trim().match(/^\{([\s\S]+)\}$/);
    props[n] = exact ? evalExpr(exact[1], scope) : v.includes('{') ? interpolate(v, scope) : v;
    // Kept hosts re-serialize the evaluated value so the client re-resolve
    // receives the same props; inlined hosts drop them.
    if (keepHost) hostPairs.push({ name: n, value: escapeAttr(serializeProp(props[n])) });
  }
  let open = '<' + op.tag;
  for (const p of hostPairs) {
    open += ' ' + (p.value === '' && EMPTY_ATTRS.has(p.name) ? p.name : `${p.name}="${p.value}"`);
  }
  out.push(open + '>');

  const source = ctx.loadComponent ? await ctx.loadComponent(op.spec) : null;
  if (source != null) {
    const comp = componentProgram(source);
    const compScope = Object.assign(Object.create(null), comp.literals, props);
    await run(comp.ops, compScope, ctx, out, depth + 1, slotHtml);
    // Stash the rendered slot content for the client's hydrate path
    // (<template data-spark-slots>, read by the runtime on re-resolve).
    if (keepHost && slotHtml.trim()) {
      out.push('<template data-spark-slots="">' + slotHtml + '</template>');
    }
  }
  out.push(`</${op.tag}>`);
}

const interpolate = (text, scope) =>
  String(text).replace(/\{([^{}]+)\}/g, (_, e) => str(evalExpr(e, scope)));
