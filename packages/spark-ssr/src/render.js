/**
 * Server-side renderer for Spark templates: {expr} interpolation,
 * <template each/if/else-if/else/await>, :attr dynamics, and <div import>
 * component composition — rendered to static HTML in one pass. Event
 * handlers and bind: attributes are stripped (the hydration component
 * re-attaches them client-side; static pages don't need them).
 */
import { parseHTML } from 'linkedom';

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

// Template children may live in .content or .childNodes depending on how
// linkedom parsed the (possibly nested) template — read both.
const kids = (node) => [
  ...(node.content ? node.content.childNodes : []),
  ...node.childNodes,
];
const interpolate = (text, scope) =>
  String(text).replace(/\{([^{}]+)\}/g, (_, e) => str(evalExpr(e, scope)));

/**
 * Render an HTML fragment (a Spark page or component body) with `scope`.
 * ctx: { loadComponent(spec) → html|null }
 */
export async function renderFragment(html, scope, ctx = {}, depth = 0) {
  const { document } = parseHTML('<!doctype html><html><body>' + html + '</body></html>');
  await walkChildren(document.body, scope, { maxDepth: 20, ...ctx, document }, depth);
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
  // (the doc's `<template await="todos">…</template>` shorthand).
  const branch = failed ? catchNodes : thenNodes.length ? thenNodes : direct;
  await insertRendered(branch, node, branchScope, ctx, depth);
  node.remove();
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
    await insertRendered(kids(winner.node), winner.node, scope, ctx, depth);
  }
  for (const link of chain) link.node.remove();
}

async function renderImport(node, scope, ctx, depth) {
  const spec = node.getAttribute('import');
  node.removeAttribute('import');
  if (depth >= (ctx.maxDepth || 20)) { node.innerHTML = ''; return; }

  // Slot content renders in the CALLER's scope, before the component swaps in.
  await walkChildren(node, scope, ctx, depth);
  const slotHtml = node.innerHTML;

  // Props: attribute values; `{expr}` evaluates in the caller's scope
  // (objects pass through intact). class/id stay on the host element.
  const props = Object.create(null);
  for (const attr of [...node.attributes]) {
    const n = attr.name;
    const v = String(attr.value || '');
    if (n === 'class' || n === 'id') { if (v.includes('{')) attr.value = interpolate(v, scope); continue; }
    const exact = v.trim().match(/^\{([\s\S]+)\}$/);
    props[n] = exact ? evalExpr(exact[1], scope) : v.includes('{') ? interpolate(v, scope) : v;
    node.removeAttribute(n);
  }

  const source = ctx.loadComponent ? await ctx.loadComponent(spec) : null;
  if (source == null) { node.innerHTML = ''; return; }
  // Components are pure UI: strip their <spark-ssr>/<script>, keep markup+style.
  const clean = String(source)
    .replace(/<spark-ssr\b[^>]*?\/>|<spark-ssr\b[^>]*>[\s\S]*?<\/spark-ssr>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  node.innerHTML = clean;
  await walkChildren(node, props, ctx, depth + 1);

  // Default slot: replace <slot> with the caller's rendered content.
  for (const slot of [...node.querySelectorAll('slot')]) {
    const holder = ctx.document.createElement('template');
    holder.innerHTML = slotHtml;
    slot.replaceWith(...(holder.content || holder).childNodes);
  }
}
