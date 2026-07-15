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
// warm.on: set while the idle self-warmup drives synthetic rows (speed-max-
// pro P3) — warnings are suppressed WITHOUT entering the dedupe set, so a
// real row hitting the same expression later still warns.
export const warm = { on: 0 };
export function warnOnce(key, ...args) {
  if (warm.on || warned.has(key)) return;
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
// interpolate — the compile/cache/run pipeline and template
// interpolation. Imports skipString from ./script.js and warnOnce/reportError
// from here (circular import, safe: function declarations hoisted in ESM).
import {
  compileExpr, compileStmt, runExpr, evaluate, execute,
  interpEnd, exprSemicolons, parseTemplate, interpolate,
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
    // A WHOLE single {expr} attribute (e.g. photo="{c.avatar}") is already
    // fully typed by runExpr — including when it evaluates to a string, and
    // including the empty string. It must NOT go through coerce(): coerce's
    // `'' → true` rule exists for a genuinely bare literal attribute (e.g.
    // `<div disabled>`, attr.value === '' with no `{}` at all) — an
    // evaluated prop that merely happens to equal '' is not that, and
    // silently promoting it to `true` corrupts any prop whose real value is
    // falsy-but-defined (an empty string, 0, ""). Only a literal attribute
    // string or a MIXED interpolation (`"{a}-{b}"`, always a real string)
    // goes through coerce()'s "true"/"false"/number/JSON text parsing.
    let val, wholeExpr = false;
    if (scope && brace) {
      const segs = parseTemplate(attr.value);
      if (segs.length === 1 && typeof segs[0] === 'object') {
        val = runExpr(segs[0].fn, segs[0].code, scope);
        wholeExpr = true;
      } else {
        val = interpolate(attr.value, scope);
      }
    } else {
      val = attr.value;
    }
    props[attr.name] = (!wholeExpr && typeof val === 'string') ? coerce(val) : val;
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
  // Claim-once: a placeholder inside a nested block (each rows in an if) is
  // reachable by BOTH the inner block's hydrate pass (right scope, runs
  // first) and the outer block's [import] sweep (outer scope) — resolving
  // twice evaluates loop-var props against a scope that lacks them. The
  // claim rides __sparkImportPath (truthy on a resolved HOST, never set on
  // a fresh placeholder — expandos don't survive serialization or cloning).
  if (node.__sparkImportPath) return null;
  node.__sparkImportPath = 1;
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
    // An eager-fetch attr holding raw {expr} hits the network as literal
    // text (a 404 for /%7Burl%7D) the moment the parser sees it — even
    // detached. Park the template in the element's plan now, then blank the
    // attr; the first patch writes the real value.
    for (const n of ['src', 'poster']) {
      for (const el of host.querySelectorAll('[' + n + ']')) {
        if (el.getAttribute(n)?.includes('{')) {
          el.__sparkPlan ??= buildElementPlan(el);
          el.removeAttribute(n);
        }
      }
    }

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
//    rowForce   — inside a row walk forced by an item-identity/index change
//                  (walkBlock): the row's inputs changed wholesale, so
//                  per-node key gating is suspended for the walk, exactly
//                  like a full pass scoped to one row
export const capture = { set: null, sink: null, dirtyMode: false, dirtyKeys: null, dirtyItems: null, rowForce: 0 };

// A node should re-evaluate this pass if we're in full mode, inside a forced
// row walk, it has no recorded deps yet (first sight), it's untracked
// (deps === null), or one of its deps changed.
export function shouldEval(node) {
  return !capture.dirtyMode || capture.rowForce
    || node.__sparkReadKeys == null || setsIntersect(node.__sparkReadKeys, capture.dirtyKeys);
}

// Merge a dep set upward (no-op without a destination) — the one-liner the
// capture plumbing repeats at every propagation seam.
export function spill(set, into) {
  if (into) for (const k of set) into.add(k);
}

// Run `fn(a, b)` (which evaluates a binding), recording every scope key it
// reads onto `node.__sparkReadKeys`. `null` means "read nothing trackable" →
// always re-evaluate (treated as untracked, never skipped). The dep Set is
// reused across evaluations of the same node, and the arguments are passed
// through, so the hot call sites allocate no closure and no Set per patch.
export function withCapture(node, fn, a, b) {
  const prev = capture.set;
  let set = node.__sparkReadKeys;
  set == null ? set = new Set() : set.clear();
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
      console.error(`[spark] invariant: dep set shrank on ${node.tagName || '$:stmt'} — ${beforeSize}→${set.size}.`);
    }
    // Propagate to an enclosing block so a nested loop's deps count for the
    // outer one too.
    spill(set, prev);
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
  for (const field of form.elements || []) {
    const fname = field.name;
    if (!fname) continue;
    if (field.type === 'checkbox') values[fname] = field.checked;
    else if (field.type === 'radio') { if (field.checked) values[fname] = field.value; }
    else values[fname] = field.value;
    if (field.checkValidity && !field.checkValidity()) {
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
      pending: !!prev.pending,
      submitted: !!prev.submitted,
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
    e.preventDefault?.();
    refresh({ submitted: true });
    if (form.checkValidity && !form.checkValidity()) {
      const bad = [...(form.elements || [])].find(
        (f) => f.name && f.checkValidity && !f.checkValidity());
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
  const isTpl = el.tagName.toLowerCase() === 'template';
  const nodes = [...(isTpl ? el.content : el).childNodes].map((n) => n.cloneNode(true));
  if (!isTpl) el.innerHTML = '';
  return nodes;
}

// Stamp a fresh clone with the recipe cached on its template counterpart:
// the shared plan array, liveness, kind flags, text-interpolation caches —
// and wire its per-instance listeners — by walking both trees in parallel
// (cloneNode(true) guarantees identical shape). Elements the walk must own
// (anchors, components, imports) are left unstamped. Returns whether the
// subtree is fully static, and marks it so — a static row cell is then
// skipped by every walk INCLUDING the first one.
function stampTree(clone, tpl, live) {
  if (clone.nodeType === TEXT_NODE) {
    const t = clone.__sparkTpl = textTpl(tpl);
    if (live && t !== null) live.push(clone);
    return t === null;
  }
  if (clone.nodeType !== ELEMENT_NODE) return true; // comments etc.
  const kind = kindOf(tpl);
  clone.__sparkKind = kind;
  clone.__sparkNamed = tpl.__sparkNamed;
  // Anchors, components, and import placeholders manage their own subtree —
  // stamping (or static-marking) them would fight that machinery.
  if (kind || tpl.__sparkNamed || tpl.hasAttribute('import')) return false;
  let a = tpl.__sparkAnalysis;
  if (!a) {
    // First stamp for this template: analyzeElement just stripped the
    // TEMPLATE's handler attributes, but this clone predates that — strip it
    // too. Every later clone is born clean.
    a = tpl.__sparkAnalysis = analyzeElement(tpl);
    for (const h of a.handlers) clone.removeAttribute(h.name);
  }
  clone.__sparkPlan = a.plan; // shared — ops are stateless descriptors
  wireElement(clone, a, 1);
  if (live && a.live) live.push(clone);
  let allStatic = !a.live;
  // Parallel descent — if the shapes ever diverge (they can't after a
  // cloneNode, but be graceful), stop stamping and let the walk lazy-build.
  let c = clone.firstChild, t = tpl.firstChild;
  while (c && t) {
    if (!stampTree(c, t, live)) allStatic = false;
    c = c.nextSibling; t = t.nextSibling;
  }
  if (c || t) allStatic = false;
  if (allStatic) clone.__sparkStatic = 1;
  return allStatic;
}

// ── Positional stamp recipes (G5, post-spark-speed-pro-max) ──
// One preorder step over a template-shaped tree: firstChild → nextSibling →
// climb until a sibling exists or the root is reached. `skip` = treat the
// current node as an opaque leaf (a spark-ignore subtree stays untouched,
// but its single step keeps builder and stamper hop counts aligned).
function stepPre(n, root, skip) {
  if (!skip && n.firstChild) return n.firstChild;
  while (n !== root && !n.nextSibling) n = n.parentNode;
  return n === root ? null : n.nextSibling;
}

// E1 (speed-up-extended): does this interpolation template reduce to
// [static?, loop-var dot-path, static?]? Then its value is a property
// chain off the RAW row — the patch path reads it directly and skips the
// fast-fn invocation and interpolate assembly entirely (call elision).
// The seed row still evaluates the real expression under capture, so
// dependency learning is untouched; ANY doubt returns 0 = today's path.
function pathDesc(tpl, v) {
  if (!v) return 0;
  const segs = parseTemplate(tpl);
  let e = -1;
  for (let i = 0; i < segs.length; i++) {
    if (typeof segs[i] === 'object') { if (e >= 0) return 0; e = i; }
  }
  if (e < 0) return 0;
  const m = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(segs[e].code);
  return m && m[1] === v ? { t: tpl, p: segs[e - 1] || '', s: segs[e + 1] || '', k: m[2] } : 0;
}

// Build the positional recipe for ONE top-level template node: flat
// [hopsFromPrevPoint, type, payload] triples over the preorder walk.
// Types: 1 dynamic text (payload: interpolation template) · 2 element with
// per-patch work but no per-clone wiring (payload: the shared analysis;
// bubbling handlers are pre-delegated here, ONCE — wireElement's del branch
// hoisted out of the per-clone path; never wire the template node itself,
// binds would attach dead listeners) · 3 element that must wire per clone
// (binds / form / non-bubbling handler) · 4 opaque leaf. Returns 0 when the
// subtree needs the full stampTree walk (anchor/component/import — callers
// are shallow-gated already, this is the belt); ??= at the call sites keeps
// 0 sticky.
function buildStampRecipe(tpl) {
  const r = [];
  let n = tpl, hops = 0;
  while (n) {
    let skip = 0, type = 0, payload = 0;
    if (n.nodeType === TEXT_NODE) {
      payload = textTpl(n);
      if (payload !== null) {
        type = 1;
        // tpl.__sparkEV (the anchor's loop-var name) exists only on
        // each-templates — if/await recipes never carry descriptors.
        const d = pathDesc(payload, tpl.__sparkEV);
        if (d) { type = 5; payload = d; }
      }
    } else if (n.nodeType === ELEMENT_NODE) {
      const k = kindOf(n);
      if (k === 1) { type = 4; skip = 1; }
      else if (k || n.__sparkNamed || n.hasAttribute('import')) return 0;
      else {
        const a = n.__sparkAnalysis ??= analyzeElement(n);
        if (a.live) {
          payload = a;
          type = a.binds.length || a.form ? 3 : 2;
          for (const h of a.handlers) {
            if (NO_BUBBLE.test(h.evt)) type = 3;
            else {
              (a.hm ||= {})[h.evt] = h;
              if (!gDelegated[h.evt]) document.addEventListener(h.evt, delegate, gDelegated[h.evt] = 1);
            }
          }
        }
      }
    }
    if (type) { r.push(hops, type, payload); hops = 0; }
    n = stepPre(n, tpl, skip);
    hops++;
  }
  return r;
}

// Replay a recipe over a fresh clone: touch ONLY the dynamic points (~4 per
// krausest row) instead of stampTree's per-node kind/static/plan writes and
// recursion over every node. Static cells carry no __spark* expandos at all
// — walkBlock never descends a live row (all passes go patchLive), kindOf/
// textTpl self-heal lazily for any stray reader, and shallow teardown is
// n.remove(). Push order = preorder = stampTree's order: sweepEach treats
// live[j] as the same template column across ALL blocks — never reorder.
function stampFast(clone, r, live) {
  let n = clone, skip = 0;
  for (let i = 0; i < r.length; i += 3) {
    for (let h = r[i]; h--; skip = 0) n = stepPre(n, clone, skip);
    const t = r[i + 1], p = r[i + 2];
    if (t === 1) { n.__sparkTpl = p; live.push(n); }
    else if (t === 5) { n.__sparkTpl = p.t; n.__sparkPD = p; live.push(n); }
    else if (t === 4) skip = 1;
    else {
      // Points always carry the shared plan (even empty): a lazy
      // patchElement build on a clone would re-analyze with the handler
      // attrs already stripped — and double-wire a bind:form.
      n.__sparkPlan = p.plan;
      if (t === 3) wireElement(n, p, 1);
      else if (p.hm) n.__sparkH = p.hm;
      live.push(n);
    }
  }
}

// Render a block: clone every template node, mark it managed (owned by its
// anchor, not the parent walk), stamp it with the template's cached recipe,
// insert the clones in order after `cursor`, and collect them into `out`.
// Shared by the each/if/await anchors. Shallow live rows go positional
// (stampFast): the recipe is built BEFORE the first clone, so analyzeElement
// has already stripped handler attrs — every clone is born clean.
export function insertClones(templateNodes, cursor, out, live) {
  for (const tpl of templateNodes) {
    const r = live && (tpl.__sparkR ??= buildStampRecipe(tpl));
    const clone = tpl.cloneNode(true);
    clone.__sparkManaged = 1;
    if (r) stampFast(clone, r, live);
    else stampTree(clone, tpl, live);
    cursor.after(clone);
    cursor = clone;
    out.push(clone);
  }
}

// Chunked sibling of insertClones (F3, shallow keyed rows only): stamp `n`
// rows out of ONE deep clone of a cached pristine ×n fragment and land them
// with ONE insert — the per-row clone + per-node after() crossings collapse
// ~n×. `host` (the each anchor) caches the fragment; it is built from the
// template AFTER row 0 stamped (analysis done, handler attrs stripped), so
// every chunk clone is born clean. `mk(nodes, live)` builds the caller's
// block (returning it); initial values run through patchPoint while still
// in the fragment — legal exactly because shallow rows are position-
// independent (no anchors, no if/else followers) — and the enter hook
// fires only after attachment, like the single path.
export function insertChunk(templateNodes, cursor, host, n, mk) {
  let cf = host.__sparkEachChunkTpl;
  if (!cf) {
    cf = host.__sparkEachChunkTpl = document.createDocumentFragment();
    for (let g = 0; g < n; g++) for (const t of templateNodes) cf.appendChild(t.cloneNode(true));
  }
  const frag = cf.cloneNode(true);
  let c = frag.firstChild;
  let m = n * templateNodes.length;
  for (let g = 0; g < n; g++) {
    const nodes = [], live = [];
    for (const t of templateNodes) {
      const nx = c.nextSibling;
      c.__sparkManaged = 1;
      const r = t.__sparkR ??= buildStampRecipe(t);
      if (r) stampFast(c, r, live);
      else stampTree(c, t, live);
      nodes.push(c);
      c = nx;
    }
    patchLive(live, mk(nodes, live).scope, 1);
  }
  cursor.after(frag);
  for (let nd = cursor.nextSibling; m--; nd = nd.nextSibling) enterNode(nd);
}

// Full first render of an if/each block: insert the clones, THEN walk them
// (a nested if/else chain needs its followers present when its head first
// runs), fire the enter hook, and resolve any [import] placeholders (async).
export function renderClones(templateNodes, cursor, out, scope, live, fast) {
  insertClones(templateNodes, cursor, out, live);
  // Shallow keyed rows arrive with a stamp-time recipe (live): patch those
  // nodes directly, skipping the tree descent — no anchors, components, or
  // imports can exist there (the caller guarantees it). `fast` = the anchor
  // is seeded (graph mode): the template's dependency facts are already
  // known from row 0, so initial values go through patchPoint — no per-node
  // withCapture, no per-node dep Sets. Scope-trap recording into the active
  // sink still happens on every read, keeping the anchor's own key set
  // (the walkNode gate) a superset of everything its rows read.
  if (live) patchLive(live, scope, fast);
  else for (const clone of out) walkNode(clone, scope);
  for (const clone of out) enterNode(clone);
  if (!live) hydrateBlockImports(out, scope);
}

// Is a child node already known to be static — i.e. re-walking it can't
// change anything? Text without `{…}`, fully-static element subtrees, and
// comments qualify. An each/if anchor (never marked static) and any element
// with a live binding do not, so the parent keeps descending into them.
function isStaticNode(n) {
  // text: null tpl = no `{…}` (undefined = not seen yet); non-elements static
  return n.nodeType === TEXT_NODE ? n.__sparkTpl == null
    : n.nodeType !== ELEMENT_NODE || n.__sparkStatic;
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
    if (!isRoot) node.__sparkStatic = 1;
    return;
  }
  // Don't reach into a nested component's territory — it self-manages via
  // its own scheduler, so from here its whole subtree counts as static. Only a
  // GENUINE component, though: a native `name=` on a form control (e.g.
  // `<input name="email">`) is not a boundary, so it keeps patching against the
  // parent scope (its `bind:value`/`{…}` read the parent's state).
  if (!isRoot && node.__sparkNamed && isSparkComponent(node)) {
    node.__sparkStatic = 1;
    return;
  }

  // each/if anchors drive dynamic structure — never marked static. In dirty
  // mode they're SKIPPED when none of the keys they depend on (the array /
  // condition expr AND every per-row or branch binding, collected via the
  // sink) changed — so an unrelated update no longer re-reconciles a 1000-row
  // loop. Deep mutations (todos.push) take the full-walk path, so they still
  // reconcile correctly.
  // 4 = <template if="expr"> conditional chain head (content genuinely enters
  // and leaves the DOM; else-if/else siblings are driven from here);
  // 6 = <template await="promise"> async block (loading → then/catch).
  if (kind === 3 || kind === 4 || kind === 6) {
    if (capture.dirtyMode && !shouldEval(node)) return;
    withSink(node, kind === 3 ? patchEach : kind === 4 ? patchIf : patchAwait, node, scope);
    return;
  }

  // else-if / else chain members render via their head's patchIf — the
  // anchor itself never changes, so it's static from the parent's view.
  // (Its rendered content is inserted as managed siblings, like if/each.)
  if (kind === 5) {
    if (!node.__sparkIfManagedBy) {
      warnOnce(
        `orphan-else:${node.getAttribute('else-if') || 'else'}`,
        '[spark] <template else-if>/<template else> must directly follow the if/else-if branch — ignored.',
      );
    }
    if (!isRoot) node.__sparkStatic = 1;
    return;
  }

  patchElement(node, scope);

  // A node is static only if it has no live binding of its own AND every
  // child is static. Computed bottom-up here and cached on the node.
  // Live sibling-chain iteration (no [...childNodes] snapshot — that
  // allocated an array per element per pass): the only mid-loop structural
  // changes are an anchor child inserting/removing its OWN managed siblings
  // — insertions are visited and skipped by the managed check below, and a
  // removed node simply drops out of the chain (an anchor never detaches
  // itself, so child.nextSibling is always live and attached).
  let allStatic = !node.__sparkLive;
  for (let child = node.firstChild; child; child = child.nextSibling) {
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

// Static text (no `{`) caches as null — later passes are one null check,
// not a string scan.
function textTpl(n) {
  let t = n.__sparkTpl;
  if (t === undefined) {
    const s = n.textContent || '';
    t = n.__sparkTpl = s.includes('{') ? s : null;
  }
  return t;
}

export function patchText(node, scope) {
  const tpl = textTpl(node);
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
  patchIf, patchEach, patchAwait, warmEach,
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
// Analysis half — PURE: reads the element's attributes and produces the
// per-patch plan plus wiring descriptors (handlers/binds/form). Touches no
// DOM and attaches no listeners, so the result is cacheable on a loop
// TEMPLATE node and shared by every clone (stampTree) — clones skip the
// attribute iteration and regex tests entirely.
function analyzeElement(el) {
  const plan = [];
  const handlers = [];
  const binds = [];
  let form = null;
  let live = 0;
  const a = { plan, handlers, binds, form: null, live: 0 };
  // An unresolved [import] placeholder's attributes are exclusively the
  // import machinery's territory (buildProps evaluates them as typed
  // whole-value props) — never the generic patcher's. Top-level imports
  // never reach here (mount() resolves them into named component hosts,
  // which walkNode's component-boundary check skips, BEFORE patch() ever
  // walks that subtree). But an each/if-CLONED import placeholder IS
  // walked by patch() synchronously, before hydrateBlockImports resolves
  // it asynchronously — so without this guard, the generic `interp` op
  // below would stringify a prop like photo="{c.avatar}" into a plain
  // attribute (always a string, via interpolate()) BEFORE buildProps ever
  // saw the original {expr}, permanently losing whether it was a whole
  // typed expression (see the examples/spark-chat fix).
  if (el.hasAttribute && el.hasAttribute('import')) return a;
  // Pre-scan: a <form bind:form> captures its onsubmit handler up front, so
  // neither the generic on-handler nor the attribute-interpolation path
  // touches it — bind:form owns the submit lifecycle. (wireElement strips it.)
  const isForm = el.hasAttribute && el.hasAttribute('bind:form') && (el.tagName || '').toLowerCase() === 'form';
  const formSubmit = isForm ? el.getAttribute('onsubmit') : null;
  for (const attr of [...el.attributes]) {
    const { name, value } = attr;

    // bind:form="signup" on a <form> — declarative form state. Creates a
    // reactive `signup` object in scope { valid, errors, values, pending,
    // submitted, error }. Validity is native HTML constraint validation read
    // back reactively; submit is auto-preventDefault'd and an async onsubmit
    // handler is awaited with `pending` / caught into `error`. No manual flags.
    if (name === 'bind:form') {
      form = { stateName: value.trim(), handlerAttr: formSubmit };
      live = 1;
      continue;
    }
    if (isForm && name === 'onsubmit') continue; // owned by bind:form above

    // bind:value="draft" / bind:checked="done" — two-way binding.
    // Reading (per patch): push the scope value into the element.
    // Writing (once, via wireElement): input/change pushes the value back.
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
      binds.push({ name, expr, mode, eventName, writeStmt: `${expr} = __val__` });
      plan.push({ kind: 1, mode, expr, fn: compileExpr(expr) });
      live = 1;
      continue;
    }

    // onclick={…} — attached once (wireElement); no per-patch op. A bare
    // reference (a name or dotted path like `add` / `theme.toggle`) is CALLED
    // with the event; anything else (`count++`, `pick='b'`, `add(5)`) is run
    // as an inline statement, with `event` in scope.
    const trimmedValue = value.trim();
    if (/^on\w+$/.test(name) && trimmedValue.startsWith('{') && trimmedValue.endsWith('}')) {
      const fnExpr = trimmedValue.slice(1, -1).trim().replace(/(?:;\s*)+$/, '');
      const isRef = /^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*$/.test(fnExpr);
      const code = isRef ? `${fnExpr}(event)` : fnExpr;
      // An arrow function here (`onclick={() => remove(item)}`, the React/
      // Vue instinct) is run as a bare STATEMENT like any other non-ref
      // expression: it constructs a closure and discards it — the click
      // does nothing, with no error. Name the fix instead of failing silent.
      if (/^(async\s*)?(\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/.test(fnExpr)) {
        const body = fnExpr.replace(/^(async\s*)?\([^)]*\)\s*=>\s*/, '').replace(/^(async\s*)?[a-zA-Z_$][\w$]*\s*=>\s*/, '');
        warnOnce(name + '={' + fnExpr + '}',
          `[spark] ${name}="{${fnExpr}}" builds a function and discards it — never called. Write the call: ${name}={${body}}.`);
      }
      handlers.push({ name, evt: name.slice(2), code, fnExpr });
      live = 1;
      continue;
    }

    // :disabled="count >= 10" — dynamic attribute, evaluated each patch.
    if (name.startsWith(':')) {
      const realAttr = name.slice(1);
      const op = { kind: 2, name, realAttr, expr: value, fn: compileExpr(value) };
      // `:class` MERGES with the static class instead of replacing it, so
      // `<div class="card" :class="state">` keeps `card`. Capture the static
      // class now (before the first :class run overwrites the attribute).
      if (realAttr === 'class') op.staticClass = el.getAttribute('class') || '';
      plan.push(op);
      live = 1;
      continue;
    }

    // value="{input}" — interpolated attribute. Capture the template now,
    // while the braces are still present (after the first interpolation the
    // live value has none, which is why this is cached, not re-read).
    if (value.includes('{')) {
      plan.push({ kind: 3, name, tpl: value });
      live = 1;
    }
  }
  // Strip handler attributes here, not in wireElement: on a loop TEMPLATE
  // node this runs once, so every later clone is born without them — no
  // per-clone removeAttribute, and the served rows match the no-framework
  // markup byte-for-byte. (A `{…}` on* attr must never reach the native
  // inline-handler machinery anyway.)
  for (const h of handlers) el.removeAttribute(h.name);
  a.form = form;
  a.live = live;
  return a;
}

// Patch a stamp-time live-node recipe: the row's dynamic nodes, directly —
// no tree descent, no per-node static/kind checks. Per-node dep gating
// still applies inside patchText/patchElement.
export function patchLive(live, scope, fast) {
  for (const nd of live) {
    if (fast) patchPoint(nd, scope);
    else (nd.nodeType === TEXT_NODE ? patchText : patchElement)(nd, scope);
  }
}

// Ungated, non-capturing single-point patch — the column-dispatch and
// fast-create primitive (graph mode). Dependencies are TEMPLATE-level facts
// here (the anchor's masks, built from fn.__keys); per-node gating and
// recording would only re-derive what the template already knows.
// Scope-ref invariant: handler/bind listeners read __sparkScopeRef at fire
// time; a block's scope identity only changes on the box.scope rebuild,
// which forces a FULL row pass through this same path — a masked sweep may
// skip plan-less listener elements precisely because of that coupling.
export function patchPoint(nd, scope) {
  if (nd.nodeType === TEXT_NODE) {
    const d = nd.__sparkPD;
    if (d) {
      // E1 path-op: property read off the RAW row (never the proxy —
      // hot-loop discipline), compare-write via textContent (NOT .data:
      // linkedom backs Text.textContent only — a .data write is inert
      // there, and in browsers the two are the same accessor). A throw
      // (null deref) falls through PERMANENTLY for this node: the
      // interpolate path reproduces the '' render and owns the warning.
      try {
        let v = scope.__b.raw[d.k];
        v = d.p + (v == null ? '' : v) + d.s;
        if (nd.textContent !== v) nd.textContent = v;
        return;
      } catch { nd.__sparkPD = 0; }
    }
    const next = interpolate(nd.__sparkTpl, scope);
    if (nd.textContent !== next) nd.textContent = next;
  } else {
    nd.__sparkScopeRef = scope;
    const plan = nd.__sparkPlan;
    if (plan && plan.length) runElementPlan(nd, scope);
  }
}

// Run one handler descriptor against its element. A plain onsubmit on a
// <form> almost always means "handle it in JS" — preventDefault by default
// so the page doesn't navigate (long-standing papercut). Escape hatch: call
// nothing / use a real <a> for navigation.
function fireHandler(h, t, e) {
  if (h.evt === 'submit') e.preventDefault?.();
  execute(h.code, t.__sparkScopeRef, e, undefined, () => ({
    phase: 'handler', component: componentNameFor(t), detail: h.name + '={' + h.fnExpr + '}',
  }));
}
// Framework-internal event delegation for STAMPED row clones. Blink taxes
// every per-element mouse listener in hit-test regions, commit, and
// dispatch — trace-measured at ~45 ms per interaction op with 2×1,000 row
// listeners, dwarfing the JS it dispatches to. Rows therefore own no
// listeners at all: one document-level CAPTURE listener per event type
// walks target→root through `__sparkH` entries. Capture keeps today's
// ordering guarantees: row handlers still run before any ancestor's direct
// (bubble) handler, and stopPropagation still suppresses them. Non-bubbling
// event types keep direct listeners; so do input/change — bind: write-backs
// are direct, and a delegated row handler would otherwise run BEFORE the
// write-back that updates the bound state it reads.
const NO_BUBBLE = /^(?:focus|blur|mouse(?:enter|leave)|load|error|scroll|input|change)$/;
const gDelegated = {};
function delegate(e) {
  for (let n = e.target; n; n = n.parentNode) {
    const h = n.__sparkH?.[e.type];
    if (h) {
      // User code must see the handling element, exactly as a direct
      // listener would. Shadow the getter only for this dispatch — a
      // lingering own property would corrupt currentTarget for every
      // later listener in the same propagation.
      Object.defineProperty(e, 'currentTarget', { value: n, configurable: true });
      fireHandler(h, n, e);
      if (e.cancelBubble) break;
    }
  }
  delete e.currentTarget;
}
// Wiring half — the per-INSTANCE side effects the analysis described:
// attach event handlers (and strip their attributes), attach two-way bind
// write-back listeners, set up bind:form. `del` = a stamped row clone:
// bubbling handlers become one `__sparkH` property + the shared document
// delegate instead of an addEventListener each.
function wireElement(el, a, del) {
  // binds wire BEFORE handlers: a same-event onXXX (onchange={…} beside
  // bind:checked=…) must observe the write-back's new value, not the stale
  // one — DOM fires same-type listeners in registration order.
  for (const b of a.binds) {
    // Context is a factory: built only if the write actually throws.
    const bindCtx = () => ({
      phase: 'bind', component: componentNameFor(el), detail: b.name + '="' + b.expr + '"',
    });
    el.addEventListener(b.eventName, () => {
      let val;
      if (b.mode === 'checked') val = el.checked;
      else if (b.mode === 'group') { if (!el.checked) return; val = el.value; }
      else if (b.mode === 'number') { const v = el.value; val = v === '' ? null : Number(v); }
      else if (b.mode === 'multi') {
        val = [...(el.selectedOptions || [])].map((o) => o.value);
      } else if (b.mode === 'text') val = el.textContent;
      else val = el.value; // value / select
      execute(b.writeStmt, el.__sparkScopeRef, null, val, bindCtx);
      // Member writes don't trip the scope proxy, so re-render explicitly.
      scheduleRerender(el);
    });
  }
  for (const h of a.handlers) {
    if (del && !NO_BUBBLE.test(h.evt)) {
      // P4c: the evt→handler map is identical for every clone of this
      // template element — build it ONCE on the analysis and point every
      // clone's __sparkH at it (heap receipt: 2 such objects per krausest
      // row). delegate() only ever reads it.
      (a.hm ||= {})[h.evt] = h;
      // The assignment doubles as capture:true — one delegate per type, ever.
      if (!gDelegated[h.evt]) document.addEventListener(h.evt, delegate, gDelegated[h.evt] = 1);
    } else {
      // One SHARED listener per handler descriptor (h.l, built lazily) —
      // the element comes back out of e.currentTarget.
      el.addEventListener(h.evt, h.l ??= (e) => fireHandler(h, e.currentTarget, e));
    }
  }
  if (del && a.hm) el.__sparkH = a.hm;
  if (a.form) {
    if (a.form.handlerAttr != null) el.removeAttribute('onsubmit');
    setupFormBinding(el, a.form.stateName, a.form.handlerAttr);
  }
  el.__sparkLive = a.live;
}

function buildElementPlan(el) {
  const a = analyzeElement(el);
  wireElement(el, a);
  return a.plan;
}

const BOOL_ATTRS = /^(?:disabled|checked|selected|readonly|required|multiple|hidden|open)$/;

function runElementPlan(el, scope) {
  for (const op of el.__sparkPlan) {
    if (op.kind === 1) {
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
    } else if (op.kind === 2) {
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
      // Genuine boolean attrs: a falsy NON-boolean (a SQLite 0, NaN) must
      // also remove — disabled="0" is still disabled. Truthy non-booleans
      // keep their string (hidden="until-found"). List mirrored in
      // spark-ssr render.js — keep the two in sync.
      const sc = op.staticClass;
      if ((typeof result === 'boolean' || result == null ||
           (!result && BOOL_ATTRS.test(op.realAttr))) && sc === undefined) {
        result ? el.setAttribute(op.realAttr, '') : el.removeAttribute(op.realAttr);
      } else {
        let str = String(result ?? '');
        // `:class` merges with the captured static class.
        if (sc !== undefined) {
          str = (sc + ' ' + str).trim();
        }
        // `?? ''`: an ABSENT attribute equals an empty result — writing
        // class="" onto every row that evaluates to '' is a style
        // invalidation storm (1,000 setAttribute per keyed sweep) and
        // breaks markup parity with no-framework HTML. Never materialize
        // an empty attribute that isn't there.
        if ((el.getAttribute(op.realAttr) ?? '') !== str) el.setAttribute(op.realAttr, str);
      }
    } else {
      const next = interpolate(op.tpl, scope);
      if ((el.getAttribute(op.name) ?? '') !== next) el.setAttribute(op.name, next);
      // The value PROPERTY diverges from the attribute once the user has
      // typed — sync it independently so programmatic clears reach the UI.
      if (op.name === 'value' && 'value' in el && el.value !== next) {
        el.value = next;
      }
    }
  }
}

export function patchElement(el, scope) {
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
      const count = [...root.querySelectorAll('[name]')].filter((e) => e.__sparkScope).length;
      console.log(`[spark] ⚡ ready — ${count} component(s)`);
    }
    // Idle self-warmup (speed-max-pro P3): the rIC presence-check gates it
    // to real browsers (shims/prerender have none). Scheduling is rAF →
    // setTimeout(0): a bare rIC can run BEFORE first paint — the round-5
    // 3-cycle battery made that visible (fp A/B vs 1.6.0: +13 ms in all 3
    // pairs) — while a macrotask queued FROM a frame callback runs right
    // AFTER that frame's paint. Not rAF → rIC: the browser may hold an
    // idle slot long enough to lose the race to the first interaction,
    // which resurrects the mid-click tier-up cost the battery removes
    // (measured: update10th 1.30 → 1.37 with rIC here).
    if (!isPrerender() && globalThis.requestIdleCallback) {
      requestAnimationFrame(() => setTimeout(() => { warm.on = 1; try { warmEach(root); } catch { /* never the page's problem */ } warm.on = 0; }));
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
