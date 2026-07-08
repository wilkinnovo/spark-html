/**
 *  ⚡ Spark v2 — single-file HTML components, zero build step.
 *
 *  A component file is just:
 *
 *    <h1>Welcome {name}</h1>
 *    <script>  let name = 'John Doe';  </script>
 *    <style>   h1 { color: rebeccapurple; }  </style>
 *
 *  No wrapper element required. Import with:
 *
 *    <div import="components/welcome"></div>
 *
 *  Key design decision: <script> and <style> are extracted from the RAW
 *  FETCHED TEXT with a tokenizer — before the markup ever touches
 *  innerHTML. Browsers neuter/strip <script> tags injected via innerHTML,
 *  which is why DOM-based extraction is unreliable. Text-level extraction
 *  sidesteps the whole class of bugs.
 */


// ─── Debugging help for consumers ──────────────────────────────────────
// Expressions are evaluated on every patch, so a broken one would warn on
// every keystroke. Dedupe by a stable key: each distinct problem is
// reported ONCE — enough to debug, quiet enough to live with.
const warned = new Set();
export function warnOnce(key, ...args) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(...args);
}

// DOM nodeType literals — avoids depending on a global `Node` (smaller, and one
// fewer thing the prerender env must define).
export const ELEMENT_NODE = 1, TEXT_NODE = 3;
// True while spark-prerender drives (server DOM). `globalThis` is guaranteed in
// every env Spark runs (it needs Proxy + import maps anyway), so no typeof guard.
const isPrerender = () => globalThis.__SPARK_PRERENDER__;
// During prerender, hand a promise to the settle loop (the channel
// <template await> and async scripts share) so the serialized HTML waits.
export function pushPrerenderWait(p) {
  if (isPrerender() && Array.isArray(globalThis.__SPARK_AWAITS__)) {
    globalThis.__SPARK_AWAITS__.push(p);
  }
}

// ─── Fault isolation + dev error overlay ──────────────────────────────
// A failure in one component must never blank the page or take down a
// sibling. Every catch site routes through reportError(), which warns once
// (deduped) and — when the opt-in dev overlay is enabled — surfaces the
// error, the failing component, a detail, and a stack in a dismissible
// full-screen panel. The overlay is OFF by default (Spark has no dev/prod
// split): enable with mount(el, { devOverlay: true }) or a global flag.
let devOverlay = false;
const overlaySeen = new Set();
const overlayErrors = [];
let overlayEl = null;

export function reportError(err, ctx = {}) {
  const msg = (err && err.message) || String(err);
  const where = ctx.component ? ` in "${ctx.component}"` : '';
  const detail = ctx.detail ? ` — ${ctx.detail}` : '';
  warnOnce(
    `rt:${ctx.phase || ''}:${ctx.component || ''}:${ctx.detail || ''}:${msg}`,
    `[spark] ${ctx.phase || 'error'}${where} — ${msg}${detail}`,
  );
  reportToOverlay(err, ctx, msg);
}

function reportToOverlay(err, ctx, msg) {
  if (!devOverlay) return;
  if (typeof document === 'undefined' || !document.body) return;
  const key = `${ctx.component || ''}|${ctx.detail || ''}|${msg}`;
  if (overlaySeen.has(key)) return;
  overlaySeen.add(key);
  overlayErrors.push({
    message: msg,
    component: ctx.component || '(unknown)',
    phase: ctx.phase || 'error',
    detail: ctx.detail || '',
    stack: (err && err.stack) || '',
  });
  renderOverlay();
}

function renderOverlay() {
  const make = (tag, style, text) => {
    const el = document.createElement(tag);
    if (style) el.setAttribute('style', style);
    if (text != null) el.textContent = text;
    return el;
  };
  if (!overlayEl) {
    overlayEl = make(
      'div',
      'position:fixed;inset:0;z-index:2147483647;overflow:auto;' +
        'background:rgba(20,2,2,.96);color:#ffd9d9;' +
        'font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:24px',
    );
    // Never let Spark patch its own overlay.
    overlayEl.setAttribute('spark-ignore', '');
    overlayEl.setAttribute('data-spark-overlay', '');
    document.body.appendChild(overlayEl);
  }
  overlayEl.innerHTML = '';
  const head = make(
    'div',
    'display:flex;align-items:center;gap:12px;margin-bottom:16px;' +
      'border-bottom:1px solid #5a1a1a;padding-bottom:12px',
  );
  head.appendChild(
    make('strong', 'color:#ff6b6b;font-size:15px', `⚡ spark — ${overlayErrors.length} error(s)`),
  );
  const dismiss = make(
    'button',
    'margin-left:auto;background:#3a0d0d;color:#ffd9d9;border:1px solid #6a2020;' +
      'border-radius:6px;padding:4px 12px;cursor:pointer;font:inherit',
    'dismiss',
  );
  dismiss.addEventListener('click', dismissOverlay);
  head.appendChild(dismiss);
  overlayEl.appendChild(head);

  for (const e of overlayErrors) {
    const card = make('div', 'margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid #3a1414');
    card.appendChild(make('div', 'color:#ff8a8a;font-weight:700;font-size:14px', e.message));
    card.appendChild(make('div', 'color:#e89a9a;margin:4px 0', `in component: ${e.component}  ·  ${e.phase}`));
    if (e.detail) {
      card.appendChild(
        make('pre', 'margin:8px 0 0;white-space:pre-wrap;color:#ffc2c2', e.detail),
      );
    }
    if (e.stack) {
      card.appendChild(
        make('pre', 'margin:8px 0 0;white-space:pre-wrap;color:#b98a8a;font-size:12px', e.stack),
      );
    }
    overlayEl.appendChild(card);
  }
}

function dismissOverlay() {
  if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
  overlayEl = null;
  overlayErrors.length = 0;
  // Keep `overlaySeen` so the same errors don't immediately re-pop; a NEW
  // distinct error will create a fresh overlay.
}

// ─── Expression evaluation (split to src/expr.js) ──────────────────────
// compileExpr, runExpr, evaluate, execute, interpEnd, parseTemplate,
// interpolate, evalPropValue — the compile/cache/run pipeline and template
// interpolation. Imports skipString from ./script.js and warnOnce/reportError
// from here (circular import, safe: function declarations hoisted in ESM).
import {
  compileExpr, compileStmt, runExpr, evaluate, execute,
  interpEnd, exprSemicolons, parseTemplate, interpolate, evalPropValue,
} from './expr.js';

// Name of the component that owns `el` (nearest [name] ancestor, or itself).
function componentNameFor(el) {
  const c = el && el.hasAttribute && el.hasAttribute('name') ? el : closestComponent(el);
  return c ? c.getAttribute('name') : undefined;
}

// (interpEnd, exprSemicolons, parseTemplate, interpolate now in ./expr.js)

// ─── Single-file component parser (text level) ────────────────────────
// Splits raw component text into { markup, script, style } without
// ever putting <script> through innerHTML.
function parseSFC(source) {
  let script = '';
  let style = '';

  // The comment alternation wins first, so prose like <!-- no <script>
  // here --> can never start an extraction that swallows markup up to a
  // real </script> — comments pass through verbatim.
  const markup = source.replace(
    /<!--.*?-->|<(script|style)[^>]*>(.*?)<\/\1>/gis,
    (m, kind, body) => {
      if (!kind) return m;
      // script (6 letters) vs style (5) — cheaper than lowercasing the tag
      if (kind.length > 5) script += body + '\n';
      else style += body + '\n';
      return '';
    },
  );

  return { markup: markup.trim(), script: script.trim(), style: style.trim() };
}

// ─── FOUC cloak ────────────────────────────────────────────────────────
// Without this, there's a visible flash on load: import placeholders swap
// in their markup with raw `{interpolation}` braces showing, and component
// <style> blocks are injected only after boot — so users briefly see
// unstyled content with literal braces. We inject a style at MODULE LOAD
// (before any component renders) that hides Spark-managed subtrees, then
// reveal each one the frame after it's booted and patched.
//
// We deliberately scope the cloak to `[import]` placeholders and hosts we
// tag with `data-spark-cloak` — never a bare `[name]`, which would also
// hide ordinary <input name="…"> fields.
let cloakInjected = false;
function injectCloak() {
  if (cloakInjected) return;
  if (typeof document === 'undefined' || !document.head) return;
  cloakInjected = true;
  const s = document.createElement('style');
  s.setAttribute('data-spark-cloak', '');
  s.textContent =
    '[import]:not([data-spark-ready]),[data-spark-cloak]:not([data-spark-ready]){visibility:hidden!important}';
  document.head.appendChild(s);
}
injectCloak();


// Nearest enclosing component element (the one whose scope governs `node`).
export function closestComponent(node) {
  let n = node.parentNode;
  while (n) {
    if (n.hasAttribute && n.hasAttribute('name')) return n;
    n = n.parentNode;
  }
  return null;
}

// ─── Slots: project the placeholder's children into the component ─────────
// The Spark way: reuse the real <slot> element. Whatever a caller writes
// between <div import="…"> … </div> is projected into the component's
// <slot> (default) and <slot name="x"> positions, with the slot's own
// children as fallback. Caller content keeps the PARENT's scope, so it
// interpolates and reacts where the author wrote it — not inside the child.
function projectSlots(host, slotted, parentHost) {
  const slots = host.querySelectorAll ? [...host.querySelectorAll('slot')] : [];
  if (!slots.length) return; // component declares no slots → content dropped

  const byName = new Map();
  const def = [];
  for (const n of slotted) {
    const name = n.getAttribute && n.getAttribute('slot');
    if (name) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(n);
    } else {
      def.push(n);
    }
  }

  const projected = [];
  for (const slot of slots) {
    const name = slot.getAttribute('name');
    const content = name ? byName.get(name) || [] : def;
    let cursor = slot;
    if (content.length) {
      for (const c of content) {
        if (c.removeAttribute) c.removeAttribute('slot');
        // Tag with the parent so walkNode patches it in the parent's scope.
        if (parentHost) c.__sparkSlotHost = parentHost;
        cursor.after(c);
        cursor = c;
        projected.push(c);
      }
    } else {
      // Fallback content is the component's own — leave it in child scope.
      for (const c of [...slot.childNodes]) {
        cursor.after(c);
        cursor = c;
      }
    }
    slot.remove();
  }
  if (parentHost && projected.length) {
    (parentHost.__sparkSlotProjected ||= []).push(...projected);
  }
}

// Placeholder attributes → props (except import/class/id/data-spark-*,
// which are never props; class/id are set directly on `host`). With no
// `scope` (a top-level placeholder, not cloned out of an each/if block), a
// `{expr}` prop can't be evaluated yet — that would need THIS placeholder's
// OWN enclosing component's state, and that component hasn't booted yet
// (resolveImports() resolves the whole tree before any bootComponent() runs).
// `__sparkPend` remembers the node so bootComponent() can retry it once the
// closest named ancestor's scope exists (see there) — but ONLY when some
// attribute actually has a `{…}` left unevaluated. Setting it unconditionally
// made bootComponent's retry (and its extra patch()) run for EVERY top-level
// import, including ones with no such prop at all — patching a component
// before its OWN async script (a dynamic import) had resolved, evaluating
// its template against an incomplete scope.
// (evalPropValue now in ./expr.js)

export function buildProps(node, scope, host) {
  const props = {};
  let pending = false;
  for (const attr of node.attributes) {
    if (attr.name === 'import' || attr.name === 'name' || attr.name.startsWith('data-spark')) continue;
    const brace = attr.value.includes('{');
    if (brace && !scope) pending = true;
    if (attr.name === 'class' || attr.name === 'id') {
      host.setAttribute(attr.name, scope && brace ? interpolate(attr.value, scope) : attr.value);
      continue;
    }
    const val = scope && brace ? evalPropValue(attr.value, scope) : attr.value;
    // Only a genuine STRING needs coerce()'s "true"/"false"/number/JSON
    // parsing (that's for plain HTML attribute text, e.g. a literal
    // `count="3"` or an interpolated `class`-style mixed template) — a
    // whole-value expression that already evaluated to a real array,
    // object, function, number, or boolean is passed through as-is.
    props[attr.name] = typeof val === 'string' ? coerce(val) : val;
  }
  if (pending) host.__sparkPend = node;
  // Capture parent-scope deps for whole-value {expr} props so they can
  // re-evaluate reactively when the parent's state changes (M2.1).
  if (scope) {
    for (const attr of node.attributes) {
      if (attr.name === 'import' || attr.name === 'name' || attr.name.startsWith('data-spark')) continue;
      if (!attr.value.includes('{')) continue;
      const segs = parseTemplate(attr.value);
      if (segs.length === 1 && typeof segs[0] === 'object') {
        const prev = capture.set;
        const deps = new Set();
        capture.set = deps;
        try { segs[0].fn(scope); } catch (e) { /* eval error at mount — deps still capture whatever was read */ }
        finally { capture.set = prev; }
        if (deps.size) {
          (host.__sparkReactiveProps ||= []).push({ name: attr.name, fn: segs[0].fn, code: segs[0].code, deps });
        }
      }
    }
  }
  return props;
}

// ─── Import resolution ─────────────────────────────────────────────────
// Resolve ONE [import] placeholder into a booted-ready component host and
// swap it into the DOM. Returns the host (or null on failure).
//
// `scope` is optional: when an import lives inside an each/if block, the
// placeholder's path and prop attributes may interpolate loop state —
// import="/users/{u.id}" or name="{u.name}" — so we evaluate them against
// the block's scope before fetching and building props.
async function resolveImportNode(node, scope = null) {
  let path = node.getAttribute('import');
  if (scope && path.includes('{')) path = interpolate(path, scope);
  // A query string (e.g. a server-baked "?id=3") must survive the
  // extension check — appending blindly would turn "path?id=3" into the
  // nonsensical "path?id=3.html" (the ".html" lands in the query VALUE,
  // not the path).
  const qi = path.indexOf('?');
  const base = qi === -1 ? path : path.slice(0, qi);
  path = (base.endsWith('.html') ? base : base + '.html') + (qi === -1 ? '' : path.slice(qi));
  try {
    const res = await _origFetchComponent(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const source = await res.text();

    const compName = path.replace(/.*\//, '').replace('.html', '');
    const { markup, script, style } = parseSFC(source);

    // HYDRATION: a prerendered host carries both `import` AND `name` (the
    // prerenderer wrote the path back onto an already-booted host). We rebuild
    // it FRESH but flash-free: the old, visible prerendered content stays in
    // the DOM through the async fetch + nested resolves, then we boot the new
    // subtree WHILE IT'S STILL DETACHED and swap it in atomically — so the
    // browser never paints raw braces, a cloak, or a blank. A normal authored
    // placeholder (import only) keeps the original cloak-then-reveal path.
    const hydrate = node.hasAttribute('name');

    // Slot content: a real placeholder's children are the caller's slotted
    // content. A prerendered host's children are its own rendered output, so
    // we read the caller's original slots from the <template data-spark-slots>
    // the prerenderer stashed (if any), and re-project those.
    let slotted;
    if (hydrate) {
      const tpl = [...node.childNodes].find(
        (c) =>
          c.nodeType === ELEMENT_NODE &&
          c.tagName === 'TEMPLATE' &&
          c.hasAttribute('data-spark-slots'),
      );
      slotted = tpl ? [...tpl.content.childNodes] : [];
      if (tpl) tpl.remove();
    } else {
      slotted = [...node.childNodes];
    }
    const parentHost = closestComponent(node);

    // Build the component host. The import placeholder itself becomes
    // the host, so classes/ids on it are preserved.
    const host = document.createElement('div');
    host.setAttribute('name', compName);
    // Remember where this came from. The prerenderer reads this to write the
    // import path back onto the serialized host, so a client mount can
    // re-resolve and render over the prerendered DOM (no blank).
    host.__sparkImportPath = path;
    // Cloak until booted+patched so the raw markup (with {braces}) and
    // not-yet-injected styles never flash. reveal() clears this. (Hydration
    // hosts are booted before insertion, so they need no cloak.)
    if (!hydrate) host.setAttribute('data-spark-cloak', '');
    host.__sparkProps = buildProps(node, scope, host);
    host.__sparkHadSlots = slotted.length > 0; // lets dev HMR skip slotted hosts (full-reload instead)
    host.innerHTML = markup; // markup contains no <script>/<style> now

    // stash extracted source on the element — bootComponent reads these
    host.__sparkScriptSrc = script;
    host.__sparkStyleSrc = style;

    // During prerender, stash a clone of the caller's slot content so the
    // prerenderer can serialize it for the client to re-project on hydration
    // (the projected originals get consumed + rendered otherwise). Browser-only
    // work is skipped — this only runs at build time.
    if (isPrerender() && slotted.length) {
      host.__sparkSlotted = slotted.map((n) => (n.cloneNode ? n.cloneNode(true) : n));
    }

    projectSlots(host, slotted, parentHost); // <slot> content projection
    await resolveImports(host); // nested imports (incl. inside slots)

    if (hydrate) {
      // Boot the whole subtree while detached so it's fully rendered before it
      // ever touches the page, then swap it for the old content in one tick.
      bootComponent(host);
      const nested = [...host.querySelectorAll('[name]')];
      nested.forEach(bootComponent);
      // Scripts with JS imports finish async — wait so the swap is flash-free.
      const waits = [host, ...nested].map((n) => n.__sparkScriptReady).filter(Boolean);
      if (waits.length) await Promise.all(waits);
      reveal(host);
      nested.forEach(reveal);
    }
    node.replaceWith(host);
    return host;
  } catch (e) {
    const hint = /HTTP 404/.test(e.message)
      ? ' Check the path — is the file served?'
      : '';
    console.warn(`[spark] Could not import "${path}" — ${e.message}.${hint}`);
    return null;
  }
}

async function resolveImports(root) {
  const nodes = [...root.querySelectorAll('[import]')];
  await Promise.all(nodes.map((node) => resolveImportNode(node)));
}

// Hydrate imports inside a freshly-rendered each/if block. patch() is
// synchronous, but imports are async and `querySelectorAll('[import]')`
// never descends into <template> content — so placeholders cloned out of a
// loop/conditional are invisible to mount()'s one-shot resolveImports and
// would otherwise sit cloaked-and-empty forever (the silent failure).
//
// `nodes` is the block's node list; we mutate it IN PLACE, replacing each
// self-import placeholder with its booted host so the each-loop reconciler
// tracks the host (not the discarded placeholder) on later patches.
export function hydrateBlockImports(nodes, scope) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const node = nodes[idx];
    if (node.nodeType !== ELEMENT_NODE) continue;

    // The cloned node IS itself an import placeholder.
    if (node.hasAttribute('import')) {
      resolveImportNode(node, scope).then((host) => {
        if (!host) return;
        host.__sparkManaged = node.__sparkManaged; // stays owned by the block
        nodes[idx] = host;
        bootComponent(host);
        host.querySelectorAll('[name]').forEach(bootComponent);
      });
      continue;
    }

    // Imports nested somewhere inside the cloned node.
    if (node.querySelector && node.querySelector('[import]')) {
      const inner = [...node.querySelectorAll('[import]')];
      Promise.all(inner.map((n) => resolveImportNode(n, scope))).then(() => {
        node.querySelectorAll('[name]').forEach(bootComponent);
      });
    }
  }
}

// Coerce attribute strings into sensible JS values for props. '∅' is a
// dedicated escape for a prop a server-side renderer (spark-ssr, spark-
// prerender) evaluated to a real, legitimate empty STRING — plain '' is
// reserved for a bare HTML attribute (<input disabled> === true), and once
// serialized to an attribute the two are indistinguishable without it (a
// server-baked q="" and an authored <div import q> parse identically).
function coerce(v) {
  if (v === '∅') return '';
  if (v === '' || v === 'true') return true; // bare attribute → boolean true
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (!isNaN(Number(v))) return Number(v);
  try { return JSON.parse(v); } catch { /* keep as string */ }
  return v;
}

// ─── Reactivity: stores + deep proxies (split to src/reactivity.js) ────
// store, derived, subscribe, subscribeStore, storeEntry, markStoreKind,
// STORE_KIND, reactify, REACTIVE_RAW, REACTIVE_STORE, MUTATORS,
// isPlainContainer, setsIntersect — the cross-component shared-state layer
// and the deep-reactive wrappers that make in-place mutations
// (todos.push, row.done = true) trigger the component's onMutate schedule.
// Imports isPrerender + patch from here (circular import, safe: function
// declarations hoisted in ESM, only ever called at runtime post-load).
// What STAYS here: the capture machinery — withCapture/withSink/shouldEval
// + the mutable gDirty* globals — because their write sites in buildProps,
// the patch flush, and patchAwait need to reassign bindings ESM doesn't let
// an importer reassign. They get their own home when directives.js splits.
import {
  stores, STORE_KIND, markStoreKind,
  store, storeEntry, subscribe, subscribeStore, derived,
  REACTIVE_RAW, REACTIVE_STORE, MUTATORS, isPlainContainer,
  reactify, setsIntersect,
} from './reactivity.js';

// ─── Dependency tracking (Tier 2: O(changed), not O(all bindings)) ─────
// Tier 1 made a patch walk only the DYNAMIC nodes; this makes each dynamic
// node re-evaluate ONLY when a value it actually reads changed. The whole
// mechanism rides on the proxies we already have:
//
//   • Reads: while a binding (text interpolation, :attr, attr interp, bind
//     read, or a `$:` statement) is evaluated, `capture.set` is its dep set.
//     The component scope's `get` trap adds each key read to it — so after
//     one evaluation we know exactly which top-level keys the binding needs.
//     (Loop variables resolve in the loop proxy and never reach the scope
//     get, so they aren't captured — deep mutation handles those via the
//     full-walk fallback below.)
//   • Writes: a plain `count = …` assignment hits the scope `set` trap, which
//     records the changed key. The flush then runs in DIRTY MODE: it still
//     walks the (already cheap, Tier-1) tree, but SKIPS re-evaluating any
//     node whose captured deps don't intersect the changed keys.
//
// Safety first — dirty mode is used ONLY when a flush was triggered purely by
// tracked top-level scope writes. Anything we can't attribute to a key →
// FULL MODE (re-evaluate everything, exactly like Tier 1): deep mutation of a
// plain object/array (`todos.push`), a store notification, a member-path
// two-way write (`bind:value="row.text"`). And a binding that read no
// trackable key (e.g. `{Math.random()}`) is marked untracked and always
// re-evaluates. The result is never stale; at worst it does redundant work.
// The capture/dirty state, collected in one object so it can be passed
// across module boundaries without breaking ESM's "import bindings are
// read-only from the importer" rule. The binding `capture` is const (never
// reassigned); its PROPERTIES mutate freely, which IS legal across imports.
// This is what lets directives.js and component.js read/write the same state
// once they're split out — the `let` form would have blocked the split.
// Exported inline (not on the public API line); the M4.1 freeze review
// buckets shouldEval/withCapture/withSink/capture as internal-only helpers.
//    set        — Set being filled with the keys a binding reads
//    sink       — extra Set that ALSO receives every read (collects an
//                  each-block's full dependency set)
//    dirtyMode  — is the current walk a targeted (dirty) pass?
//    dirtyKeys  — keys changed this flush (gating set, live)
//    dirtyItems — raw loop-row objects deep-mutated this flush — lets a
//                  `rows[i].x = y` re-walk only row i, not all rows
export const capture = { set: null, sink: null, dirtyMode: false, dirtyKeys: null, dirtyItems: null };

// A node should re-evaluate this pass if we're in full mode, it has no
// recorded deps yet (first sight), it's untracked (deps === null), or one of
// its deps changed.
export function shouldEval(node) {
  if (!capture.dirtyMode) return true;
  const deps = node.__sparkReadKeys;
  if (deps === undefined || deps === null) return true;
  return setsIntersect(deps, capture.dirtyKeys);
}

// Run `fn(a, b)` (which evaluates a binding), recording every scope key it
// reads onto `node.__sparkReadKeys`. `null` means "read nothing trackable" →
// always re-evaluate (treated as untracked, never skipped). The dep Set is
// reused across evaluations of the same node, and the arguments are passed
// through, so the hot call sites allocate no closure and no Set per patch.
export function withCapture(node, fn, a, b) {
  const prev = capture.set;
  let set = node.__sparkReadKeys;
  if (set == null) set = new Set();
  else set.clear();
  capture.set = set;
  try {
    return fn(a, b);
  } finally {
    capture.set = prev;
    node.__sparkReadKeys = set.size ? set : null;
  }
}

// Run `fn(a, b)` collecting EVERY scope key read anywhere inside it (including
// in nested withCapture leaves) onto `node.__sparkReadKeys`. Used by each/if
// blocks so the whole block can be skipped in dirty mode when none of the
// keys it depends on — the array/condition expr AND every per-row binding —
// changed. Arguments pass through so anchor call sites allocate no closure.
//
// Deliberately ACCUMULATES rather than resetting each run (no `.clear()`):
// a block's own content can contain NESTED each/if/await anchors that are
// independently gated by this SAME dirty-mode mechanism — so a pass where
// THIS block runs (because ITS OWN deps matched) but a nested anchor inside
// it gets SKIPPED (because the nested anchor's deps didn't match) means the
// nested anchor's dependencies are never actually read this pass. Resetting
// the set on every run would then DROP those dependencies from the parent's
// recorded set — e.g. an outer `<template if="cond">` wrapping an
// `each="v in results"`: a pass triggered by `cond` alone (the each skipped,
// its own deps not touched) would erase `results` from the outer if's own
// recorded deps, so a LATER pass where only `results` changes incorrectly
// skips the outer if entirely — the inner each never gets a chance to
// re-walk despite the very array it iterates having changed. Accumulating
// means a dependency, once seen, is never forgotten — deps sets only grow,
// never falsely shrink. The cost is purely extra (safe) re-evaluations after
// a large structural change stops touching some field a row used to read —
// same "at worst redundant work, never stale" tradeoff already used
// elsewhere in this file.
export function withSink(node, fn, a, b) {
  const prev = capture.sink;
  let set = node.__sparkReadKeys;
  if (set == null) set = new Set();
  const beforeSize = set.size;
  capture.sink = set;
  try {
    return fn(a, b);
  } finally {
    capture.sink = prev;
    // Invariant: dep sets must never shrink (the 0.27.14 lesson).
    // If this fires, something cleared or deleted from a withSink set.
    if (!isPrerender() && set.size < beforeSize) {
      console.error(`[spark] invariant: dep set shrank on ${node.tagName || '$:stmt'} — ${beforeSize}→${set.size}. This is a bug.`);
    }
    // Propagate to an enclosing block so a nested loop's deps count for the
    // outer one too.
    if (prev) for (const k of set) prev.add(k);
    node.__sparkReadKeys = set.size ? set : null;
  }
}

// ─── Script scanner + rewriter (split to src/script.js) ───────────────
// skipString, braceDepths, extractTopLevel, analyzeScript, compileScript,
// makeImporter — the string-scanning machinery the runtime needs. Pure
// string analysis: no reactivity core, no DOM. Kept in its own module so the
// "the scanner is NOT a parser" boundary is a file boundary too.
import {
  skipString, braceDepths, extractDeclaredNames, reactiveStatementEnd,
  extractTopLevel, parseImportStatement, importAssign, makeImporter,
  analyzeScript, compileScript,
} from './script.js';

// ─── Component lifecycle (split to src/component.js) ────────────────
// makeScope (the reactive scope proxy + flush scheduler — the riskiest
// code in the org; three shipped 0.27.1x bugs in one week came from here),
// bootComponent, destroyComponent, isSparkComponent, reveal. The scope
// proxy's get/set traps populate the imported `capture` object's set/sink
// and write its dirtyKeys/dirtyMode/dirtyItems — all property writes,
// legal across the module boundary (the bag refactor two commits back
// unblocked this split, which the directives split had already
// demonstrated). makeScope is module-local in component.js (only
// bootComponent calls it); the other four symbols are imported here.
//
// What STAYS here: the capture machinery itself (withCapture/withSink/
// shouldEval + the capture object declaration), the patch flush (patch +
// walkNode), the FOUC cloak (injectCloak runs at module load — one-time
// global side effect; reveal moved to component.js but the cloak stays),
// buildProps (used by import-resolution in this file AND by bootComponent's
// __sparkPend retry path), coerce (used only by buildProps), hydrateBlockImports,
// slots, the public API entry points, and everything DOM-tree-structural
// outside the component lifecycle.
import {
  reveal, isSparkComponent,
  bootComponent, destroyComponent,
} from './component.js';
// ─── DOM patching ──────────────────────────────────────────────────────
// Exported inline so ./reactivity.js can `import { patch }` (circular,
// safe: function declarations are hoisted in ESM's instantiate phase, only
// ever CALLED at runtime post-load). Internal — not on the public API line;
// the M4.1 freeze review buckets it as a sibling-only internal.
export function patch(el, scope) {
  walkNode(el, scope, true);
  // Optional observation seam (used by the test suite to assert batching).
  // No-op in normal use — nothing sets this hook in the browser.
  globalThis.__sparkTestOnPatch?.(el);
}

// Request a batched re-render of the component that owns `el`. Used after
// two-way binds: `bind:value="row.text"` is a member write, which mutates
// the object directly without tripping the scope proxy's set trap, so we
// have to ask the owning component to re-patch explicitly — and since it's
// not attributable to a key, force a full pass.
function scheduleRerender(el) {
  let n = el;
  while (n && !n.__sparkScheduleFull) n = n.parentNode;
  if (n) n.__sparkScheduleFull();
}

// ─── Declarative forms: bind:form ─────────────────────────────────────
// Snapshot a <form>'s native constraint-validation state into a plain object.
// Validity/messages come from the platform (required, type=email, pattern,
// minlength…), so there's no validation library — just HTML attributes read
// back reactively.
function formStateSnapshot(form) {
  const errors = {};
  const values = {};
  let valid = true;
  for (const field of form.elements ? [...form.elements] : []) {
    const fname = field.name;
    if (!fname) continue;
    if (field.type === 'checkbox') values[fname] = field.checked;
    else if (field.type === 'radio') { if (field.checked) values[fname] = field.value; }
    else values[fname] = field.value;
    if (typeof field.checkValidity === 'function' && !field.checkValidity()) {
      valid = false;
      if (!errors[fname]) errors[fname] = field.validationMessage || 'Invalid';
    }
  }
  return { valid, errors, values };
}

// Wire `bind:form="name"` on a <form>: maintain a reactive `name` object in the
// component scope — { valid, errors, values, pending, submitted, error } — and
// own the submit lifecycle (auto-preventDefault, native validity gate, await an
// async onsubmit handler with `pending`, catch a rejection into `error`).
function setupFormBinding(form, stateName, handlerAttr) {
  const write = (extra) => {
    const scope = form.__sparkScopeRef;
    if (!scope) return false;
    const prev = scope[stateName] || {};
    const base = formStateSnapshot(form);
    scope[stateName] = {
      ...base,
      pending: prev.pending || false,
      submitted: prev.submitted || false,
      error: prev.error || null,
      ...extra,
    };
    return true;
  };

  // Seed initial state so `{form.valid}` / `:disabled={form.pending}` resolve on
  // first paint. scopeRef is attached just before the plan builds; if it isn't
  // ready yet, retry on the next microtask.
  if (!write({})) queueMicrotask(() => write({}));

  const refresh = (extra) => { if (write(extra)) scheduleRerender(form); };
  form.addEventListener('input', () => refresh({}));
  form.addEventListener('change', () => refresh({}));

  form.addEventListener('submit', async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    refresh({ submitted: true });
    if (typeof form.checkValidity === 'function' && !form.checkValidity()) {
      const bad = [...(form.elements || [])].find(
        (f) => f.name && typeof f.checkValidity === 'function' && !f.checkValidity());
      if (bad && bad.focus) bad.focus(); // native focus-first-invalid, no library
      return;
    }
    if (!handlerAttr || !handlerAttr.startsWith('{') || !handlerAttr.endsWith('}')) return;
    const expr = handlerAttr.slice(1, -1).trim();
    const isRef = /^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*$/.test(expr);
    refresh({ pending: true, error: null });
    try {
      const scope = form.__sparkScopeRef;
      const r = evaluate(expr, scope);            // a call expr runs here; a bare
      const value = isRef && typeof r === 'function' ? r() : r; // ref resolves, then call
      await Promise.resolve(value);
      refresh({ pending: false, error: null });
    } catch (err) {
      refresh({ pending: false, error: err });
      reportError(err, { phase: 'submit', component: componentNameFor(form), detail: `onsubmit={${expr}}` });
    }
  });
}

// Clone an anchor's content as its reusable template: a <template>'s content
// fragment, or — for a non-template anchor — its children (which are then
// cleared; the anchor renders clones as managed siblings).
export function cloneTemplateNodes(el) {
  if (el.tagName.toLowerCase() === 'template') {
    return [...el.content.childNodes].map((n) => n.cloneNode(true));
  }
  const nodes = [...el.childNodes].map((n) => n.cloneNode(true));
  el.innerHTML = '';
  return nodes;
}

// Render a block: clone every template node, mark it managed (owned by its
// anchor, not the parent walk), insert the clones in order after `cursor`,
// and collect them into `out`. Shared by the each/if/await anchors.
export function insertClones(templateNodes, cursor, out) {
  for (const tpl of templateNodes) {
    const clone = tpl.cloneNode(true);
    clone.__sparkManaged = true;
    cursor.after(clone);
    cursor = clone;
    out.push(clone);
  }
  return cursor;
}

// Full first render of an if/each block: insert the clones, THEN walk them
// (a nested if/else chain needs its followers present when its head first
// runs), fire the enter hook, and resolve any [import] placeholders (async).
export function renderClones(templateNodes, cursor, out, scope) {
  insertClones(templateNodes, cursor, out);
  for (const clone of out) {
    walkNode(clone, scope, false);
    enterNode(clone);
  }
  hydrateBlockImports(out, scope);
}

// Is a child node already known to be static — i.e. re-walking it can't
// change anything? Text without `{…}`, fully-static element subtrees, and
// comments qualify. An each/if anchor (never marked static) and any element
// with a live binding do not, so the parent keeps descending into them.
function isStaticNode(n) {
  if (n.nodeType === TEXT_NODE) {
    return n.__sparkTpl == null; // null = no `{…}`; undefined = not seen yet
  }
  if (n.nodeType !== ELEMENT_NODE) return true;
  return n.__sparkStatic === true;
}

// Classify an element once — the attributes that shape the walk (spark-ignore,
// each/if/else/await, name) are authoring-time constants, so later walks pay
// one property read instead of up to seven hasAttribute() calls.
// 0 plain · 1 spark-ignore · 3 each · 4 if · 5 else/else-if · 6 await.
// (`name=` is a separate flag: whether it's a real component boundary depends
// on isSparkComponent, which can flip at boot — see walkNode.)
function kindOf(node) {
  let k = node.__sparkKind;
  if (k === undefined) {
    node.__sparkNamed = node.hasAttribute('name');
    k = node.hasAttribute('spark-ignore') ? 1
      : node.hasAttribute('each') ? 3
      : node.hasAttribute('if') ? 4
      : node.hasAttribute('else-if') || node.hasAttribute('else') ? 5
      : node.hasAttribute('await') ? 6
      : 0;
    node.__sparkKind = k;
  }
  return k;
}

export function walkNode(node, scope, isRoot = false) {
  if (node.nodeType === TEXT_NODE) {
    patchText(node, scope);
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;

  // Known-static subtree from a previous walk: nothing in it ever changes,
  // so skip the whole branch in one check. The component root (isRoot) is
  // never skipped — it must always re-walk its children. This is the core
  // of Tier 1: cost becomes proportional to DYNAMIC nodes, not total nodes.
  if (!isRoot && node.__sparkStatic) return;

  const kind = kindOf(node);

  // Escape hatch: subtrees marked spark-ignore are never patched —
  // essential for documentation/code samples containing literal {braces}.
  if (kind === 1) {
    if (!isRoot) node.__sparkStatic = true;
    return;
  }
  // Don't reach into a nested component's territory — it self-manages via
  // its own scheduler, so from here its whole subtree counts as static. Only a
  // GENUINE component, though: a native `name=` on a form control (e.g.
  // `<input name="email">`) is not a boundary, so it keeps patching against the
  // parent scope (its `bind:value`/`{…}` read the parent's state).
  if (!isRoot && node.__sparkNamed && isSparkComponent(node)) {
    node.__sparkStatic = true;
    return;
  }

  // each/if anchors drive dynamic structure — never marked static. In dirty
  // mode they're SKIPPED when none of the keys they depend on (the array /
  // condition expr AND every per-row or branch binding, collected via the
  // sink) changed — so an unrelated update no longer re-reconciles a 1000-row
  // loop. Deep mutations (todos.push) take the full-walk path, so they still
  // reconcile correctly.
  if (kind === 3) {
    if (capture.dirtyMode && !shouldEval(node)) return;
    withSink(node, patchEach, node, scope);
    return;
  }

  // <template if="expr"> — conditional block. Content is inserted after
  // the template when truthy, removed when falsy. Unlike :hidden, the
  // nodes genuinely leave the DOM. May be followed by <template else-if>
  // / <template else> siblings — the whole chain is driven from this head.
  if (kind === 4) {
    if (capture.dirtyMode && !shouldEval(node)) return;
    withSink(node, patchIf, node, scope);
    return;
  }

  // else-if / else chain members render via their head's patchIf — the
  // anchor itself never changes, so it's static from the parent's view.
  // (Its rendered content is inserted as managed siblings, like if/each.)
  if (kind === 5) {
    if (!node.__sparkIfManagedBy) {
      warnOnce(
        `orphan-else:${node.getAttribute('else-if') || 'else'}`,
        '[spark] <template else-if>/<template else> must directly follow a <template if> (or another else-if). Branch ignored.',
      );
    }
    if (!isRoot) node.__sparkStatic = true;
    return;
  }

  // <template await="promise"> — async block. Shows its loading content while
  // the promise is pending, then swaps to <template then> (await = resolved
  // value) or <template catch> (await = error). Like if/each, the anchor drives
  // dynamic structure and is gated by the keys it reads in dirty mode.
  if (kind === 6) {
    if (capture.dirtyMode && !shouldEval(node)) return;
    withSink(node, patchAwait, node, scope);
    return;
  }

  patchElement(node, scope);

  // A node is static only if it has no live binding of its own AND every
  // child is static. Computed bottom-up here and cached on the node.
  let allStatic = !node.__sparkLive;
  for (const child of [...node.childNodes]) {
    // A child may have been detached during this loop; skip stragglers.
    if (child.parentNode !== node) continue;
    // Nodes rendered by a sibling each/if are "managed" by that block and
    // get walked with the correct loop/branch scope there. Walking them
    // here with the parent scope would evaluate loop bindings against the
    // wrong scope and blank out interpolations.
    if (child.__sparkManaged) {
      allStatic = false; // dynamic structure lives here — never skip this node
      continue;
    }
    // Slot-projected content belongs to the parent component — patch it
    // with the parent's scope, not the component it now physically sits in.
    if (child.__sparkSlotHost) {
      const lender = child.__sparkSlotHost;
      // The lender may not be booted yet, or its script may still be
      // initializing (async JS imports) — its state isn't in scope, so
      // evaluating now reports spurious errors against seeded `undefined`s.
      // Skip: the lender's own first patch (finish → patchSlots) walks this
      // content once its state exists.
      if (!lender.__sparkScope || lender.__sparkScopePending) {
        allStatic = false;
        continue;
      }
      walkNode(child, lender.__sparkScope);
      if (!isStaticNode(child)) allStatic = false;
      continue;
    }
    walkNode(child, scope);
    if (!isStaticNode(child)) allStatic = false;
  }
  if (!isRoot) node.__sparkStatic = allStatic;
}

function patchText(node, scope) {
  let tpl = node.__sparkTpl;
  if (tpl === undefined) {
    // Static text (no `{`) caches as null — later passes are one null check,
    // not a string scan.
    const t = node.textContent || '';
    tpl = node.__sparkTpl = t.includes('{') ? t : null;
  }
  if (tpl === null) return;      // static text: nothing to do
  if (!shouldEval(node)) return; // deps unchanged this pass
  const next = withCapture(node, interpolate, tpl, scope);
  if (node.textContent !== next) node.textContent = next;
}

// ─── Directives: if/each/await patchers (split to src/directives.js) ──
// patchIf, patchEach, patchAwait + their helpers (lifecycle enter/leave
// seam, anchor/block-end DOM helpers, loop-scope proxy, await state
// machine). Called from the patch flush below via
//   withSink(node, patchIf/patchEach/patchAwait, node, scope)
// and re-imported here as a circular module (function declarations hoisted
// in ESM's instantiate phase; only ever called post-load — safe).
//
// Public surface: lifecycle (re-exported by the public API export line).
// Internal-but-exported: patchIf, patchEach, patchAwait, enterNode (the
// only directives symbol called from outside directives.js, by
// buildElementPlan's clone-insert path). M4.1 freeze review buckets each.
//
// What STAYS here: the patch flush (patch + walkNode + the dirty-mode
// walker), which is what calls these patchers and WRITES the capture
// state — that's the one tight coupling the directives need to stay
// adjacent to. The capture machinery (withCapture/withSink/shouldEval)
// stays here too; the directive patchers reach it via the imported
// `capture` object + the imported helpers.
import {
  lifecycle, enterNode,
  patchIf, patchEach, patchAwait,
} from './directives.js';

// ─── Attribute / event bindings ───────────────────────────────────────
// An element's bindings are parsed ONCE into a "plan": a list of the
// per-patch operations it needs (read a two-way bind, evaluate a `:attr`,
// interpolate an attribute). Event handlers + bind listeners are attached
// during this one-time parse — they're not per-patch work. Later patches
// just replay the cached plan, skipping the attribute spread and the regex
// re-tests that used to run on every keystroke.
//
// `__sparkLive` marks an element that must keep being walked even when its
// plan is empty: one with an attached listener still needs its live scope
// ref refreshed each patch (loop clones are reused with a new scope). Only
// elements that are NOT live AND whose whole subtree is static can be
// skipped wholesale (see walkNode).
function buildElementPlan(el) {
  const plan = [];
  let live = false;
  // Pre-scan: a <form bind:form> captures its onsubmit handler up front and
  // strips the attribute, so neither the generic on-handler nor the attribute-
  // interpolation path touches it — bind:form owns the submit lifecycle.
  let formBinding = null;
  if (el.hasAttribute && el.hasAttribute('bind:form') && (el.tagName || '').toLowerCase() === 'form') {
    formBinding = el.getAttribute('onsubmit');
    if (formBinding != null) el.removeAttribute('onsubmit');
  }
  for (const attr of [...el.attributes]) {
    const { name, value } = attr;

    // bind:form="signup" on a <form> — declarative form state. Creates a
    // reactive `signup` object in scope { valid, errors, values, pending,
    // submitted, error }. Validity is native HTML constraint validation read
    // back reactively; submit is auto-preventDefault'd and an async onsubmit
    // handler is awaited with `pending` / caught into `error`. No manual flags.
    if (name === 'bind:form') {
      setupFormBinding(el, value.trim(), formBinding);
      live = true;
      continue;
    }

    // bind:value="draft" / bind:checked="done" — two-way binding.
    // Reading (per patch): push the scope value into the element.
    // Writing (once): input/change event pushes the element value back.
    if (name === 'bind:value' || name === 'bind:checked' || name === 'bind:group') {
      const expr = value.trim();
      const tag = (el.tagName || '').toLowerCase();
      const type = ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
      // Pick the binding mode from the element shape.
      let mode;
      if (name === 'bind:checked') mode = 'checked';            // checkbox
      else if (name === 'bind:group') mode = 'group';           // radio group
      else if (el.hasAttribute && el.hasAttribute('contenteditable')) mode = 'text';
      else if (tag === 'select') mode = el.hasAttribute('multiple') ? 'multi' : 'select';
      else if (type === 'number' || type === 'range') mode = 'number';
      else mode = 'value';                                      // text input / textarea
      // change vs input: discrete controls fire `change`, text fires `input`.
      const eventName = mode === 'value' || mode === 'number' || mode === 'text' ? 'input' : 'change';
      const writeStmt = `${expr} = __val__`;
      // Context is a factory: built only if the write actually throws.
      const bindCtx = () => ({
        phase: 'bind', component: componentNameFor(el), detail: name + '="' + expr + '"',
      });
      el.addEventListener(eventName, () => {
        let val;
        if (mode === 'checked') val = el.checked;
        else if (mode === 'group') { if (!el.checked) return; val = el.value; }
        else if (mode === 'number') { const v = el.value; val = v === '' ? null : Number(v); }
        else if (mode === 'multi') {
          val = [...(el.selectedOptions || [])].map((o) => o.value);
        } else if (mode === 'text') val = el.textContent;
        else val = el.value; // value / select
        execute(writeStmt, el.__sparkScopeRef, null, val, bindCtx);
        // Member writes don't trip the scope proxy, so re-render explicitly.
        scheduleRerender(el);
      });
      plan.push({ kind: 'bind', mode, expr, fn: compileExpr(expr) });
      live = true;
      continue;
    }

    // onclick={…} — attached once; no per-patch op. A bare reference (a name or
    // dotted path like `add` / `theme.toggle`) is CALLED with the event;
    // anything else (`count++`, `pick='b'`, `add(5)`, `x = event.target.value`)
    // is run as an inline statement, with `event` in scope.
    const trimmedValue = value.trim();
    if (/^on\w+$/.test(name) && trimmedValue.startsWith('{') && trimmedValue.endsWith('}')) {
      // (A <form bind:form>'s onsubmit was already captured + stripped by the
      // pre-scan above, so it never reaches here.)
      const fnExpr = trimmedValue.slice(1, -1).trim().replace(/(?:;\s*)+$/, '');
      const isRef = /^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*$/.test(fnExpr);
      const code = isRef ? `${fnExpr}(event)` : fnExpr;
      const evt = name.slice(2);
      // An arrow function here (`onclick={() => remove(item)}`, the React/
      // Vue instinct) is run as a bare STATEMENT like any other non-ref
      // expression: it constructs a closure and discards it — the click
      // does nothing, with no error. Name the fix instead of failing silent.
      if (/^(async\s*)?(\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/.test(fnExpr)) {
        const body = fnExpr.replace(/^(async\s*)?\([^)]*\)\s*=>\s*/, '').replace(/^(async\s*)?[a-zA-Z_$][\w$]*\s*=>\s*/, '');
        warnOnce(name + '={' + fnExpr + '}',
          `[spark] ${name}="{${fnExpr}}" — this is a function, not a handler: it's constructed and discarded on click, never called. Write the call directly instead, e.g. ${name}={${body}}.`);
      }
      // Context is a factory: built only if the handler actually throws.
      const handlerCtx = () => ({
        phase: 'handler', component: componentNameFor(el), detail: name + '={' + fnExpr + '}',
      });
      el.addEventListener(evt, (e) => {
        // A plain onsubmit on a <form> almost always means "handle it in JS" —
        // preventDefault by default so the page doesn't navigate (long-standing
        // papercut). Escape hatch: call nothing / use a real <a> for navigation.
        if (evt === 'submit' && e && e.preventDefault) e.preventDefault();
        execute(code, el.__sparkScopeRef, e, undefined, handlerCtx);
      });
      el.removeAttribute(name);
      live = true;
      continue;
    }

    // :disabled="count >= 10" — dynamic attribute, evaluated each patch.
    if (name.startsWith(':')) {
      const realAttr = name.slice(1);
      const op = { kind: 'attr', name, realAttr, expr: value, fn: compileExpr(value) };
      // `:class` MERGES with the static class instead of replacing it, so
      // `<div class="card" :class="state">` keeps `card`. Capture the static
      // class now (before the first :class run overwrites the attribute).
      if (realAttr === 'class') op.staticClass = el.getAttribute('class') || '';
      plan.push(op);
      live = true;
      continue;
    }

    // value="{input}" — interpolated attribute. Capture the template now,
    // while the braces are still present (after the first interpolation the
    // live value has none, which is why this is cached, not re-read).
    if (value.includes('{')) {
      plan.push({ kind: 'interp', name, tpl: value });
      live = true;
    }
  }
  el.__sparkLive = live;
  return plan;
}

function runElementPlan(el, scope) {
  for (const op of el.__sparkPlan) {
    if (op.kind === 'bind') {
      const current = runExpr(op.fn, op.expr, scope);
      const str = current == null ? '' : String(current);
      if (op.mode === 'checked') {
        const want = Boolean(current);
        if (el.checked !== want) el.checked = want;
      } else if (op.mode === 'group') {
        // A radio is checked when the bound value equals this input's value.
        const want = str === el.value;
        if (el.checked !== want) el.checked = want;
      } else if (op.mode === 'multi') {
        const sel = new Set(Array.isArray(current) ? current.map(String) : []);
        for (const o of el.options || []) o.selected = sel.has(String(o.value));
      } else if (op.mode === 'text') {
        if (el.textContent !== str) el.textContent = str;
      } else {
        // value / number / select
        if (el.value !== str) el.value = str;
      }
    } else if (op.kind === 'attr') {
      let result;
      try {
        result = op.fn(scope);
      } catch (e) {
        // Evaluation failed — leave the attribute untouched (event handlers
        // may still need to read it) but tell the consumer once.
        warnOnce(
          `attr:${op.name}=${op.expr}`,
          `[spark] Error in :${op.realAttr}="${op.expr}" — ${e.message}. (Attribute left unchanged.)`,
        );
        continue;
      }
      // null/undefined removes the attribute — `hidden="a.loading || a.error"`
      // yields null when both are clear, and stringifying that to hidden=""
      // would mean hidden=TRUE (an empty boolean attribute is present).
      if ((typeof result === 'boolean' || result == null) && op.staticClass === undefined) {
        result ? el.setAttribute(op.realAttr, '') : el.removeAttribute(op.realAttr);
      } else {
        let str = String(result ?? '');
        // `:class` merges with the captured static class.
        if (op.staticClass !== undefined) {
          str = (op.staticClass + ' ' + str).trim();
        }
        if (el.getAttribute(op.realAttr) !== str) el.setAttribute(op.realAttr, str);
      }
    } else if (op.kind === 'interp') {
      const next = interpolate(op.tpl, scope);
      if (el.getAttribute(op.name) !== next) el.setAttribute(op.name, next);
      // The value PROPERTY diverges from the attribute once the user has
      // typed — sync it independently so programmatic clears reach the UI.
      if (op.name === 'value' && 'value' in el && el.value !== next) {
        el.value = next;
      }
    }
  }
}

function patchElement(el, scope) {
  // Stash the current scope so long-lived listeners always read the live one
  // — never the scope captured at first render (loop clones are reused). This
  // happens every walk, even when the bindings are skipped below.
  el.__sparkScopeRef = scope;
  if (el.__sparkPlan === undefined) el.__sparkPlan = buildElementPlan(el);
  if (!el.__sparkPlan.length) return;
  if (!shouldEval(el)) return; // deps unchanged this pass — skip re-evaluation
  withCapture(el, runElementPlan, el, scope);
}


// ─── CSS scoping (split to src/css.js) ─────────────────────────────────
// scopeCss prefixes every selector with [name="comp"] so a component's
// styles can't leak out (or in). The tokenizer handles @media nesting,
// @keyframes bodies, :global(...) unwrapping, and comments. Imports the
// brace/string-aware skipString from ./script.js.
import { scopeCss } from './css.js';

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Mount Spark on a root element (default: document.body).
 * Resolves all [import] placeholders, then boots every component.
 *
 *   import { mount } from 'spark-html';
 *   mount();                         // whole document
 *   mount('#app');                   // a subtree
 *   mount(document.querySelector('#app'));
 *   mount(document.body, { devOverlay: true });  // dev error overlay
 *
 * Options:
 *   devOverlay — show a full-screen error overlay (message + component +
 *   stack) when a component fails. Off by default; also enabled by the global
 *   `globalThis.__SPARK_DEV_OVERLAY__`. Intended for development only.
 *   quiet — suppress the "⚡ ready" console line. Used for repeated subtree
 *   mounts (e.g. the router booting each route) so navigation doesn't spam the
 *   console; the initial app mount still logs once.
 *
 * Returns a promise that resolves when everything is booted.
 */
async function mount(root = document.body, options = {}) {
  // Freeze the app base at boot — the first mount() always runs before any
  // client-side router navigation can mutate location (see componentURL).
  if (typeof location !== 'undefined') appBase ||= location.href;
  if (options.devOverlay || (globalThis.__SPARK_DEV_OVERLAY__)) {
    devOverlay = true;
  }
  if (typeof root === 'string') root = document.querySelector(root);
  if (!root) throw new Error('[spark] mount target not found');

  const run = async () => {
    await resolveImports(root);
    const booted = [...root.querySelectorAll('[name]')];
    booted.forEach(bootComponent);
    if (root.hasAttribute && root.hasAttribute('name')) {
      bootComponent(root);
      booted.push(root);
    }
    // Scripts with JS imports settle asynchronously — wait for them so
    // mount()'s promise still means "everything is booted". (These promises
    // never reject; failures are contained + reported per component.)
    const waits = booted.map((el) => el.__sparkScriptReady).filter(Boolean);
    if (waits.length) await Promise.all(waits);
    // Safety net: anything still cloaked (e.g. a component whose script
    // threw before the rAF reveal) is shown now, so a bug can never leave
    // the page permanently invisible.
    if (root.querySelectorAll) {
      root.querySelectorAll('[data-spark-cloak]').forEach(reveal);
    }
    if (!options.quiet && !(isPrerender())) {
      // Count genuine components only — a booted component carries __sparkScope,
      // so a form field's native `name=` doesn't inflate the tally.
      const count = [...root.querySelectorAll('[name]')].filter((e) => e.__sparkScope !== undefined).length;
      console.log(`[spark] ⚡ ready — ${count} component(s)`);
    }
  };

  if (document.readyState === 'loading') {
    await new Promise((res) =>
      document.addEventListener('DOMContentLoaded', res, { once: true }),
    );
  }
  return run();
}

/**
 * Register a component programmatically from a source string,
 * without fetching a file. Useful for tests and inline components.
 *
 *   component('hello', `<h1>Hi {who}</h1><script>let who='you'<\/script>`);
 *   // then in HTML: <div import="hello"></div> — or mount a node directly:
 */
const registry = new Map();

function component(name, source) {
  registry.set(name, source);
}

// Patch fetch path resolution: check the registry first. Concurrent requests
// for the SAME component path (e.g. a list rendering 50 identical card
// imports in one mount wave) share ONE fetch — the entry is dropped as soon
// as it settles, so dev edits (HMR re-mounts) always re-fetch fresh.
const inflightComponents = new Map();
// A relative import path ("components/x.html") resolves against the APP
// BASE: an authored <base href> when present (read live, so it always wins),
// otherwise the page URL as FIRST loaded — frozen at the first mount() call
// (see mount), NOT at first use: an app whose entry page has no relative
// imports would otherwise capture a base only after a router navigation,
// inside the navigated path (fetch()'s own base is the live location.href,
// which is how "/dash/settings" used to 404 every relative import). Never
// the origin root: forcing "/" broke subdirectory deployments (GitHub Pages)
// in 1.0.0. Hard-loading a deep client-routed URL on a history-fallback
// server still needs <base href="/"> or absolute import paths. Absolute
// paths, full URLs, prerender, and non-browser harnesses pass through
// untouched.
let appBase;
const componentURL = (path) => {
  if (isPrerender() || typeof location === 'undefined' || /^(\/|[a-z]+:)/i.test(path)) return path;
  const u = new URL(path, document.querySelector('base[href]') ? document.baseURI : (appBase ||= location.href));
  return u.pathname + u.search;
};
const _origFetchComponent = (path) => {
  const bare = path.replace(/\.html$/, '');
  if (registry.has(bare)) {
    return Promise.resolve({ ok: true, text: async () => registry.get(bare) });
  }
  let p = inflightComponents.get(path);
  if (!p) {
    // Read the body ONCE here — a shared real Response would throw
    // "body already read" on the second .text() call.
    p = (async () => {
      const res = await fetch(componentURL(path));
      if (!res.ok) return { ok: false, status: res.status };
      const text = await res.text();
      return { ok: true, status: res.status, text: async () => text };
    })();
    inflightComponents.set(path, p);
    p.then(() => inflightComponents.delete(path), () => inflightComponents.delete(path));
  }
  return p;
};

/**
 * Tear down a mounted subtree: runs onMount cleanups and unsubscribes its
 * components from any stores. Call before removing a component you mounted
 * imperatively, so timers/listeners/subscriptions don't leak.
 *
 *   import { unmount } from 'spark-html';
 *   unmount(el); el.remove();
 */
function unmount(el) {
  destroyComponent(el);
}

// Introspection for tooling (spark-html-devtools). Returns a live snapshot of
// every named store's state — `{ storeName: state }`. Not needed by apps.
function inspectStores() {
  const out = {};
  for (const [name, entry] of stores) out[name] = entry.state;
  return out;
}

// ── Inspection API (M1.3) ──────────────────────────────────────────────
// Formalizes __spark* internals that every debugging session already uses.
//   inspect.deps(node)  → the tracked dependency keys (Set or null)
//   inspect.scope(el)   → the component's reactive scope proxy or null
const inspect = {
  deps(node) {
    return node ? node.__sparkReadKeys ?? null : null;
  },
  scope(el) {
    return el ? el.__sparkScope ?? null : null;
  },
};

export { mount, unmount, component, store, derived, subscribe, evaluate, interpolate, parseSFC, scopeCss, inspectStores, inspect, lifecycle };
export default { mount, unmount, component, store, derived };
