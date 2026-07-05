/**
 * Server-side renderer for Spark templates: {expr} interpolation,
 * <template each/if/else-if/else/await>, :attr dynamics, and <div import>
 * component composition — rendered to static HTML in one pass. Event
 * handlers and bind: attributes are stripped (the hydration component
 * re-attaches them client-side; static pages don't need them).
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
function scopeProxy(scope) {
  return new Proxy(scope, {
    has: (t, k) => k !== Symbol.unscopables,
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : GLOBALS[k]),
  });
}
export function evalExpr(expr, scope) {
  try { return compile(expr)(scopeProxy(scope)); }
  catch { return undefined; }
}

const str = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

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
const kids = templateKids;
const interpolate = (text, scope) =>
  String(text).replace(/\{([^{}]+)\}/g, (_, e) => str(evalExpr(e, scope)));

/**
 * Render an HTML fragment (a Spark page or component body) with `scope`.
 * ctx: { loadComponent(spec) → html|null }
 */
export async function renderFragment(html, scope, ctx = {}, depth = 0) {
  const { document } = parseHTML('<!doctype html><html><body>' + html + '</body></html>');
  const inner = { maxDepth: 20, ...ctx, document };
  await walkChildren(document.body, scope, inner, depth);
  if (inner.status) ctx.status = inner.status; // a rendered branch set it (§3)
  return document.body.innerHTML;
}

async function walkChildren(el, scope, ctx, depth) {
  for (const child of [...el.childNodes]) await walkNode(child, scope, ctx, depth);
}

async function walkNode(node, scope, ctx, depth) {
  if (node.nodeType === 3) {
    const t = String(node.data || '');
    if (t.includes('{')) node.data = interpolate(t, scope);
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = (node.tagName || '').toLowerCase();
  if (node.hasAttribute && node.hasAttribute('spark-ignore')) return;
  if (tag === 'script') { node.remove(); return; }
  if (tag === 'style') return;

  if (tag === 'template') {
    if (node.hasAttribute('each')) return renderEach(node, scope, ctx, depth);
    if (node.hasAttribute('await')) return renderAwait(node, scope, ctx, depth);
    if (node.hasAttribute('if')) return renderIfChain(node, scope, ctx, depth);
    if (node.hasAttribute('else-if') || node.hasAttribute('else')) { node.remove(); return; }
    return; // plain template: leave inert
  }

  if (node.hasAttribute('import')) return renderImport(node, scope, ctx, depth);

  // No-JS forms (§5): redirect="…" and flash="…" attributes on a form posting
  // to /api/* become hidden _redirect / _flash fields, so the plain-browser 303
  // knows where to land and what one-shot message to show. The attributes
  // themselves never reach the browser.
  if (tag === 'form' && (node.hasAttribute('redirect') || node.hasAttribute('flash'))) {
    const isApi = (node.getAttribute('action') || '').startsWith('/api/');
    const addHidden = (name, value) => {
      const h = ctx.document.createElement('input');
      h.setAttribute('type', 'hidden');
      h.setAttribute('name', name);
      h.setAttribute('value', value);
      node.appendChild(h);
    };
    for (const [attr, field] of [['redirect', '_redirect'], ['flash', '_flash']]) {
      if (!node.hasAttribute(attr)) continue;
      const v = node.getAttribute(attr);
      node.removeAttribute(attr);
      if (isApi) addHidden(field, v);
    }
  }

  renderAttrs(node, scope);
  await walkChildren(node, scope, ctx, depth);
}

function renderAttrs(node, scope) {
  for (const attr of [...node.attributes]) {
    const n = attr.name;
    const v = String(attr.value || '');
    if (n.startsWith('bind:') || (/^on\w+$/.test(n) && v.trim().startsWith('{'))) {
      node.removeAttribute(n);
      continue;
    }
    if (n.startsWith(':')) {
      const val = evalExpr(v, scope);
      node.removeAttribute(n);
      if (val === false || val == null) continue;
      if (n === ':class') {
        node.setAttribute('class', ((node.getAttribute('class') || '') + ' ' + str(val)).trim());
      } else {
        node.setAttribute(n.slice(1), val === true ? '' : str(val));
      }
      continue;
    }
    if (v.includes('{')) attr.value = interpolate(v, scope);
  }
}

// Insert rendered clones of `nodes` before `anchor`, walking each with `scope`.
async function insertRendered(nodes, anchor, scope, ctx, depth) {
  for (const n of nodes) {
    const clone = n.cloneNode(true);
    anchor.parentNode.insertBefore(clone, anchor);
    await walkNode(clone, scope, ctx, depth);
  }
}

async function renderEach(node, scope, ctx, depth) {
  const expr = node.getAttribute('each') || '';
  const m = expr.match(/^\s*([\w$]+)\s*(?:,\s*([\w$]+))?\s+in\s+([\s\S]+)$/);
  const arr = m ? evalExpr(m[3], scope) : null;
  if (m && Array.isArray(arr)) {
    const content = kids(node);
    for (let i = 0; i < arr.length; i++) {
      const rowScope = Object.create(scope);
      rowScope[m[1]] = arr[i];
      if (m[2]) rowScope[m[2]] = i;
      await insertRendered(content, node, rowScope, ctx, depth);
    }
  }
  node.remove();
}

async function renderAwait(node, scope, ctx, depth) {
  let value;
  let failed = null;
  try {
    value = evalExpr(node.getAttribute('await').replace(/^once\(([\s\S]*)\)$/, '$1'), scope);
    if (value && typeof value.then === 'function') value = await value;
  } catch (e) { failed = e; }

  const content = kids(node);
  const isTpl = (n, a) => n.nodeType === 1 && (n.tagName || '').toLowerCase() === 'template' && n.hasAttribute(a);
  const thenNodes = [];
  const catchNodes = [];
  const direct = [];
  for (const c of content) {
    if (isTpl(c, 'then')) thenNodes.push(...kids(c));
    else if (isTpl(c, 'catch')) catchNodes.push(...kids(c));
    else direct.push(c);
  }
  const branchScope = Object.create(scope);
  branchScope.await = failed || value;
  const as = node.getAttribute('as');
  if (as) branchScope[as] = failed || value;
  // Resolved: the then-branch when declared, otherwise the direct content
  // (the doc's `<template await="todos">…</template>` shorthand). Failed: the
  // catch-branch if written, otherwise a default inline error boundary — so an
  // await that throws degrades to a message, never a silently blank section.
  if (failed && !catchNodes.length) {
    node.parentNode?.insertBefore(defaultAwaitError(node, failed, ctx), node);
    node.remove();
    return;
  }
  const branch = failed ? catchNodes : thenNodes.length ? thenNodes : direct;
  await insertRendered(branch, node, branchScope, ctx, depth);
  node.remove();
}

// The zero-config error boundary for a failed <template await> with no catch.
function defaultAwaitError(node, failed, ctx) {
  const doc = node.ownerDocument || (ctx && ctx.document);
  const el = doc.createElement('div');
  el.setAttribute('role', 'alert');
  el.setAttribute('data-spark-await-error', '');
  el.setAttribute('style',
    'border:1px solid #ff6b6b;background:rgba(255,107,107,.1);color:#ff6b6b;'
    + 'border-radius:8px;padding:.6rem .8rem;font-size:.85rem');
  // Dev shows the real reason; production stays generic.
  el.textContent = ctx && ctx.dev
    ? '⚠ Failed to load: ' + (failed && (failed.message || String(failed)))
    : '⚠ This section could not be loaded.';
  return el;
}

async function renderIfChain(node, scope, ctx, depth) {
  // Collect the chain: this template plus adjacent else-if / else templates
  // (whitespace between them is fine).
  const chain = [{ node, expr: node.getAttribute('if') }];
  let probe = node.nextSibling;
  while (probe) {
    if (probe.nodeType === 3 && !String(probe.data).trim()) { probe = probe.nextSibling; continue; }
    if (probe.nodeType === 1 && (probe.tagName || '').toLowerCase() === 'template'
      && (probe.hasAttribute('else-if') || probe.hasAttribute('else'))) {
      chain.push({ node: probe, expr: probe.hasAttribute('else-if') ? probe.getAttribute('else-if') : null });
      probe = probe.nextSibling;
      continue;
    }
    break;
  }
  let winner = null;
  for (const link of chain) {
    if (link.expr === null || evalExpr(link.expr, scope)) { winner = link; break; }
  }
  if (winner) {
    // Declarative status (§3): the rendered branch sets the response status —
    // <template else status="404"> stops being a 200-that-means-404.
    const st = Number(winner.node.getAttribute('status'));
    if (st) ctx.status = st;
    await insertRendered(kids(winner.node), winner.node, scope, ctx, depth);
  }
  for (const link of chain) link.node.remove();
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

async function renderImport(node, scope, ctx, depth) {
  const spec = node.getAttribute('import');
  if (depth >= (ctx.maxDepth || 20)) { node.innerHTML = ''; return; }

  // A top-level host on a page that will client-mount keeps its import (plus
  // a `name` and its evaluated props) so the runtime's flash-free hydrate
  // path re-resolves it and the component comes alive — exactly the contract
  // spark-prerender's makeHydratable establishes. Nested hosts are inlined;
  // their parent rebuilds them on the client.
  const keepHost = !!ctx.keepImports && depth === 0;
  if (!keepHost) node.removeAttribute('import');
  else node.setAttribute('name', String(spec).split(/[?#]/)[0].replace(/\/+$/, '').replace(/.*\//, '').replace(/\.html$/, ''));

  // Slot content renders in the CALLER's scope, before the component swaps in.
  await walkChildren(node, scope, ctx, depth);
  const slotHtml = node.innerHTML;

  // Props: attribute values; `{expr}` evaluates in the caller's scope
  // (objects pass through intact). class/id stay on the host element.
  const props = Object.create(null);
  for (const attr of [...node.attributes]) {
    const n = attr.name;
    const v = String(attr.value || '');
    if (n === 'import' || n === 'name' || n.startsWith('data-spark')) continue;
    if (n === 'class' || n === 'id') { if (v.includes('{')) attr.value = interpolate(v, scope); continue; }
    const exact = v.trim().match(/^\{([\s\S]+)\}$/);
    props[n] = exact ? evalExpr(exact[1], scope) : v.includes('{') ? interpolate(v, scope) : v;
    // Kept hosts re-serialize the evaluated value so the client re-resolve
    // receives the same props; inlined hosts drop them.
    if (keepHost) attr.value = serializeProp(props[n]);
    else node.removeAttribute(n);
  }

  const source = ctx.loadComponent ? await ctx.loadComponent(spec) : null;
  if (source == null) { node.innerHTML = ''; return; }
  // Components are pure UI on the server: strip <spark-ssr>/<script> from the
  // output, but read literal script defaults so {count} renders as 0.
  // Comments are masked so prose mentioning those tags never truncates one.
  let script = '';
  const { masked, restore } = maskComments(source);
  const clean = restore(masked
    .replace(/<spark-ssr\b[^>]*?\/>|<spark-ssr\b[^>]*>[\s\S]*?<\/spark-ssr>/gi, '')
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (m, body) => { script += body + '\n'; return ''; }));
  node.innerHTML = clean;
  const compScope = Object.assign(Object.create(null), scriptLiterals(script), props);
  await walkChildren(node, compScope, ctx, depth + 1);

  // Default slot: replace <slot> with the caller's rendered content.
  for (const slot of [...node.querySelectorAll('slot')]) {
    const holder = ctx.document.createElement('div');
    holder.innerHTML = slotHtml;
    slot.replaceWith(...holder.childNodes);
  }

  // Stash the rendered slot content for the client's hydrate path
  // (<template data-spark-slots>, read by the runtime on re-resolve).
  if (keepHost && slotHtml.trim()) {
    const stash = ctx.document.createElement('template');
    stash.setAttribute('data-spark-slots', '');
    stash.innerHTML = slotHtml;
    node.appendChild(stash);
  }
}
