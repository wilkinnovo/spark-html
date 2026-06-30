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
function warnOnce(key, ...args) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(...args);
}

// DOM nodeType literals — avoids depending on a global `Node` (smaller, and one
// fewer thing the prerender env must define).
const ELEMENT_NODE = 1, TEXT_NODE = 3;
// True while spark-prerender drives (server DOM). `globalThis` is guaranteed in
// every env Spark runs (it needs Proxy + import maps anyway), so no typeof guard.
const isPrerender = () => globalThis.__SPARK_PRERENDER__;

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

function reportError(err, ctx = {}) {
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
        'font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
        'padding:24px;box-sizing:border-box',
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

// ─── Expression evaluation ─────────────────────────────────────────────
// Compiling `new Function(...)` is the single most expensive thing the
// runtime does, and the same expressions are evaluated on every patch.
// Compile each unique source string once and cache the resulting function;
// the generated function closes over nothing but its arguments, so caching
// is safe and slashes both CPU cost and CSP `unsafe-eval` churn.
const exprCache = new Map();
function compileExpr(code) {
  let fn = exprCache.get(code);
  if (fn === undefined) {
    try {
      // The closing brace MUST be on its own line: if `code` ends with a
      // `//` line comment, putting `}` on the same line would comment it out.
      fn = new Function('__scope__', `with(__scope__) {\nreturn (${code})\n}`);
    } catch (e) {
      warnOnce(`c:${code}`, `[spark] Syntax error in expression {${code}} — ${e.message}`);
      fn = () => '';
    }
    exprCache.set(code, fn);
  }
  return fn;
}

const stmtCache = new Map();
function compileStmt(code) {
  let fn = stmtCache.get(code);
  if (fn === undefined) {
    try {
      // Newlines around `code` so a trailing `//` comment can't eat the `}`.
      fn = new Function('__scope__', 'event', '__val__', `with(__scope__) {\n${code}\n}`);
    } catch (e) {
      warnOnce(`c:${code}`, `[spark] Syntax error in "${code}" — ${e.message}`);
      fn = () => {};
    }
    stmtCache.set(code, fn);
  }
  return fn;
}

function evaluate(code, scope) {
  try {
    return compileExpr(code)(scope);
  } catch (e) {
    // A thrown evaluation (e.g. reading a property of undefined) renders as
    // empty — tell the consumer which expression and why, once.
    warnOnce(`e:${code}`, `[spark] Error evaluating {${code}} — ${e.message}. (Rendered as empty. Use {a?.b} for values that may be missing.)`);
    return '';
  }
}

function execute(code, scope, event = null, __val__ = undefined, ctx = null) {
  try {
    // `event` is a real parameter — handlers receive it directly, with no
    // proxy writes (which would trigger a re-patch mid-click) and no
    // reliance on the deprecated window.event (absent in Firefox).
    // `__val__` carries the element value for two-way bindings.
    compileStmt(code)(scope, event, __val__);
  } catch (e) {
    if (ctx) reportError(e, { phase: ctx.phase || 'handler', component: ctx.component, detail: ctx.detail || code });
    else console.warn(`[spark] Error in "${code}":`, e.message);
  }
}

// Name of the component that owns `el` (nearest [name] ancestor, or itself).
function componentNameFor(el) {
  let n = el;
  while (n) {
    if (n.getAttribute && n.hasAttribute && n.hasAttribute('name')) return n.getAttribute('name');
    n = n.parentNode;
  }
  return undefined;
}

// Find the `}` that closes the interpolation `{` whose body starts at `start`.
// Brace-aware: respects strings/template-literals (so `${…}` inside a backtick
// doesn't end it) and nested object braces (`{a ? {x:1} : {y:2}}`). Returns the
// index of the closing brace, or -1 if unbalanced.
function interpEnd(src, start) {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { if (--depth === 0) return i; i++; continue; }
    i++;
  }
  return -1;
}

// Parse a template into a flat list of literal strings and { code } exprs,
// cached per template string. The old regex (`\{([^}]+)\}`) broke on any `}`
// inside an expression (template literals, object literals); this doesn't, and
// caching the parse makes repeated patches cheaper than re-scanning.
const templateCache = new Map();
function parseTemplate(template) {
  let segs = templateCache.get(template);
  if (segs) return segs;
  segs = [];
  let i = 0;
  let lit = '';
  const flush = () => { if (lit) { segs.push(lit); lit = ''; } };
  while (i < template.length) {
    const c = template[i];
    // Escape: `\{` / `\}` render a LITERAL brace (so you can write `{` in
    // prose without it being read as an interpolation). Entities don't work —
    // the browser decodes them before Spark sees the text — but a backslash
    // survives. For code blocks, prefer the spark-ignore attribute.
    if (c === '\\' && (template[i + 1] === '{' || template[i + 1] === '}')) {
      lit += template[i + 1];
      i += 2;
      continue;
    }
    if (c === '{') {
      const end = interpEnd(template, i + 1);
      if (end === -1) { lit += c; i++; continue; } // unbalanced → literal
      flush();
      segs.push({ code: template.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }
    lit += c;
    i++;
  }
  flush();
  templateCache.set(template, segs);
  return segs;
}

function interpolate(template, scope) {
  // Fast path: no braces and no backslash-escape → nothing to do.
  if (!template.includes('{') && !template.includes('\\')) return template;
  let out = '';
  for (const s of parseTemplate(template)) {
    if (typeof s === 'string') {
      out += s;
    } else {
      const v = evaluate(s.code, scope);
      out += v == null ? '' : String(v);
    }
  }
  return out;
}

// ─── Single-file component parser (text level) ────────────────────────
// Splits raw component text into { markup, script, style } without
// ever putting <script> through innerHTML.
function parseSFC(source) {
  let script = '';
  let style = '';

  let markup = source.replace(
    /<script[^>]*>([\s\S]*?)<\/script>/gi,
    (_, body) => {
      script += body + '\n';
      return '';
    },
  );
  markup = markup.replace(
    /<style[^>]*>([\s\S]*?)<\/style>/gi,
    (_, body) => {
      style += body + '\n';
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

function reveal(el) {
  if (el && el.setAttribute) {
    el.setAttribute('data-spark-ready', '');
    el.removeAttribute('data-spark-cloak');
  }
}

// Nearest enclosing component element (the one whose scope governs `node`).
function closestComponent(node) {
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
  if (!path.endsWith('.html')) path += '.html';
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
    // Placeholder attributes become PROPS (except import/class/id and the
    // runtime's own name/data-spark-* markers, which are never props).
    const props = {};
    for (const attr of node.attributes) {
      if (attr.name === 'import' || attr.name === 'name' || attr.name.startsWith('data-spark')) continue;
      const val =
        scope && attr.value.includes('{')
          ? interpolate(attr.value, scope)
          : attr.value;
      if (attr.name === 'class' || attr.name === 'id') {
        host.setAttribute(attr.name, val);
        continue;
      }
      props[attr.name] = coerce(val);
    }
    host.__sparkProps = props;
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
      reveal(host);
      nested.forEach(reveal);
    }
    node.replaceWith(host);
    return host;
  } catch (e) {
    const hint = /HTTP 404/.test(e.message)
      ? ` Check the path is correct and the file is served (relative to the page).`
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
function hydrateBlockImports(nodes, scope) {
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

// Coerce attribute strings into sensible JS values for props.
function coerce(v) {
  if (v === '') return true;          // bare attribute → boolean true
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (v !== '' && !isNaN(Number(v))) return Number(v);
  try { return JSON.parse(v); } catch { /* keep as string */ }
  return v;
}

// ─── Stores: shared reactive state across components ──────────────────
const stores = new Map();           // name → { state, subscribers }

// Tag a store's state object with its kind ('store' | 'derived' | 'query') so
// tooling (spark-html-devtools) can label it. Non-enumerable → never shows up
// in JSON/state dumps. Global-registry symbol so sibling packages (the query
// package) can stamp their own kind without importing this module's symbol.
const STORE_KIND = Symbol.for('spark.storeKind');
function markStoreKind(state, kind) {
  try { Object.defineProperty(state, STORE_KIND, { value: kind, configurable: true }); }
  catch { /* frozen target — ignore */ }
}

/**
 * Create (or get) a named store.
 *
 *   // app code
 *   import { store } from 'spark-html';
 *   store('cart', { items: [], total: 0 });
 *
 *   // inside any component script
 *   const cart = useStore('cart');
 *   cart.items = [...cart.items, thing];   // every subscriber re-patches
 */
function store(name, initial) {
  if (stores.has(name)) return stores.get(name).proxy;

  const entry = { state: { ...(initial || {}) }, subscribers: new Set() };
  markStoreKind(entry.state, 'store');
  const cache = new WeakMap();
  const notify = () => entry.subscribers.forEach((fn) => fn());

  entry.proxy = new Proxy(entry.state, {
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (key === REACTIVE_STORE) return true;
      // NB: do NOT expose REACTIVE_RAW here — the component scope's set trap
      // unwraps REACTIVE_RAW values, which would store the raw state instead
      // of the reactive store proxy on `const s = useStore(...)`.
      // Deep reactivity: nested objects/arrays are wrapped so an in-place
      // mutation (cart.items.push(x), row.done = true) notifies EVERY
      // subscriber — not just the component that happened to mutate it.
      return reactify(target[key], notify, cache);
    },
    set(target, key, value) {
      if (value && typeof value === 'object' && value[REACTIVE_RAW]) {
        value = value[REACTIVE_RAW];
      }
      const prev = target[key];
      target[key] = value;
      if (prev !== value) notify();
      return true;
    },
  });

  stores.set(name, entry);
  return entry.proxy;
}

/**
 * Subscribe to a named store from outside a component (e.g. to persist it, log
 * it, or sync it elsewhere). `fn` runs after every change. Returns an
 * unsubscribe function. Creates the store if it doesn't exist yet.
 */
function subscribe(name, fn) {
  let entry = stores.get(name);
  if (!entry) { store(name, {}); entry = stores.get(name); }
  entry.subscribers.add(fn);
  return () => entry.subscribers.delete(fn);
}

// Subscribe a component element to a store; returns the store proxy.
// The subscriber is tracked on the element so destroyComponent() can remove
// it — otherwise the closure (and the whole component scope it captures)
// would live in the store's Set forever, leaking on every unmount.
function subscribeStore(name, componentEl, scopeRef) {
  let entry = stores.get(name);
  if (!entry) {
    // During prerender the page's bootstrap (which calls store()) hasn't run,
    // so an absent store is EXPECTED — auto-create it silently. In the browser
    // it's a real mistake, so warn there.
    if (!(isPrerender())) {
      console.warn(`[spark] useStore("${name}") — store not created. Call store("${name}", initial) before mount().`);
    }
    store(name, {});
    entry = stores.get(name);
  }
  const cb = () => {
    if (!scopeRef.scope || !componentEl.isConnected) return;
    // Route through the component's batching scheduler when available so a
    // burst of store writes collapses into a single patch. Store changes
    // aren't tracked against component-scope keys, so force a full pass.
    if (componentEl.__sparkScheduleFull) componentEl.__sparkScheduleFull();
    else patch(componentEl, scopeRef.scope);
  };
  entry.subscribers.add(cb);
  (componentEl.__sparkStoreUnsubs ||= []).push(() => entry.subscribers.delete(cb));
  return entry.proxy;
}

/**
 * derived(name, deps, compute) — a read-only store computed from other stores.
 *
 *   store('cart', { items: [] });
 *   derived('cartTotal', ['cart'], (cart) => ({
 *     count: cart.items.length,
 *     total: cart.items.reduce((s, i) => s + i.price, 0),
 *   }));
 *   // any component: const total = useStore('cartTotal'); → {total.count} items
 *
 * `compute(...sourceProxies)` returns an object whose keys become the derived
 * store's state. It recomputes whenever any source notifies, and only notifies
 * its OWN subscribers when a key actually changes (shallow) — memoizing the
 * derivation at the store layer, the one place component-local `$:` can't reach
 * across components. Chains: a derived store may list another derived as a dep.
 * Read-only — mutate the source store, never the derived proxy.
 */
function derived(name, deps, compute) {
  if (stores.has(name)) return stores.get(name).proxy;

  const sources = (Array.isArray(deps) ? deps : [deps]).map((d) => {
    if (!stores.has(d)) store(d, {});
    return stores.get(d);
  });
  const entry = { state: {}, subscribers: new Set(), derived: true };
  markStoreKind(entry.state, 'derived');
  const cache = new WeakMap();
  const notify = () => entry.subscribers.forEach((fn) => fn());

  const recompute = () => {
    let next;
    try { next = compute(...sources.map((s) => s.proxy)) || {}; }
    catch (e) { console.warn(`[spark] derived("${name}") compute threw — ${e.message}`); return; }
    let changed = false;
    for (const k of Object.keys(next)) {
      if (entry.state[k] !== next[k]) { entry.state[k] = next[k]; changed = true; }
    }
    for (const k of Object.keys(entry.state)) {
      if (!(k in next)) { delete entry.state[k]; changed = true; }
    }
    if (changed) notify();
  };

  // Recompute whenever any source store notifies. Derived stores live for the
  // app's lifetime (like stores), so this subscription is never torn down.
  for (const s of sources) s.subscribers.add(recompute);
  recompute(); // seed the initial value

  entry.proxy = new Proxy(entry.state, {
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (key === REACTIVE_STORE) return true;
      // Read-only: deep-wrap with a no-op onMutate so nested reads work, but an
      // in-place mutation can't masquerade as a (forbidden) write.
      return reactify(target[key], () => {}, cache);
    },
    set() {
      console.warn(`[spark] derived("${name}") is read-only — mutate its source store instead.`);
      return true;
    },
  });
  stores.set(name, entry);
  return entry.proxy;
}

// ─── Deep reactivity ───────────────────────────────────────────────────
// Plain objects and arrays read from a component's scope come back wrapped
// in a thin proxy whose mutations call the component's onMutate(). This is
// what makes `todos.push(x)`, `todos.sort()`, and `row.done = true` reactive
// without forcing the user to replace the whole value. The Spark way: no
// compiler, no dependency graph — just the same schedule() the set trap
// already uses, reached one level deeper.
//
// Only PLAIN objects/arrays are wrapped. Dates, Maps, Sets, class instances,
// and DOM nodes pass straight through, so their internal slots/methods keep
// working (a proxied Date would throw on .getTime()).
const REACTIVE_RAW = Symbol('spark.raw');
// Marks a store proxy so the component scope doesn't re-wrap it (which would
// bypass the store's own deep reactivity + subscriber notification).
const REACTIVE_STORE = Symbol('spark.store');

function isPlainContainer(v) {
  if (Array.isArray(v)) return true;
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Mutating methods that should trigger a re-render, per collection type.
const MAP_MUTATORS = new Set(['set', 'delete', 'clear']);
const SET_MUTATORS = new Set(['add', 'delete', 'clear']);

function reactify(value, onMutate, cache) {
  // Unwrap any reactive proxy back to its raw target first, so every value
  // maps to one canonical proxy (stable identity, no proxy-of-proxy).
  if (value && typeof value === 'object' && value[REACTIVE_RAW]) {
    value = value[REACTIVE_RAW];
  }

  // Map/Set: wrap so a mutation (set/add/delete/clear) re-renders, while every
  // method still runs on the REAL collection (internal slots intact — unlike a
  // naive proxy). Reads (get/has/size/iteration) pass straight through.
  if (value instanceof Map || value instanceof Set) {
    const cachedC = cache.get(value);
    if (cachedC) return cachedC;
    const mutators = value instanceof Map ? MAP_MUTATORS : SET_MUTATORS;
    const proxyC = new Proxy(value, {
      get(t, k) {
        if (k === REACTIVE_RAW) return t;
        const v = Reflect.get(t, k);
        if (typeof v !== 'function') return v;
        return function (...args) {
          const r = v.apply(t, args);
          if (mutators.has(k)) onMutate();
          return r === t ? proxyC : r; // keep chaining reactive (Map.set returns the map)
        };
      },
    });
    cache.set(value, proxyC);
    return proxyC;
  }

  if (!isPlainContainer(value)) return value;
  const cached = cache.get(value);
  if (cached) return cached;

  const proxy = new Proxy(value, {
    get(t, k) {
      if (k === REACTIVE_RAW) return t;
      return reactify(Reflect.get(t, k), onMutate, cache);
    },
    set(t, k, v) {
      if (v && typeof v === 'object' && v[REACTIVE_RAW]) v = v[REACTIVE_RAW];
      const prev = t[k];
      const ok = Reflect.set(t, k, v);
      if (ok && prev !== t[k]) onMutate(t); // `t` = the mutated object (maybe a loop row)
      return ok;
    },
    deleteProperty(t, k) {
      const had = k in t;
      const ok = Reflect.deleteProperty(t, k);
      if (ok && had) onMutate(t);
      return ok;
    },
  });
  cache.set(value, proxy);
  return proxy;
}

// ─── Dependency tracking (Tier 2: O(changed), not O(all bindings)) ─────
// Tier 1 made a patch walk only the DYNAMIC nodes; this makes each dynamic
// node re-evaluate ONLY when a value it actually reads changed. The whole
// mechanism rides on the proxies we already have:
//
//   • Reads: while a binding (text interpolation, :attr, attr interp, bind
//     read, or a `$:` statement) is evaluated, `captureSet` is its dep set.
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
let captureSet = null;     // Set being filled with the keys a binding reads
let captureSink = null;    // extra Set that ALSO receives every read (used to
                           // collect an each-block's full dependency set)
let gDirtyMode = false;    // is the current walk a targeted (dirty) pass?
let gDirtyKeys = null;     // keys changed this flush (gating set, live)
let gDirtyItems = null;    // raw loop-row objects deep-mutated this flush — lets
                           // a `rows[i].x = y` re-walk only row i, not all rows

function setsIntersect(a, b) {
  if (!a || !b) return false;
  if (a.size > b.size) { const t = a; a = b; b = t; }
  for (const x of a) if (b.has(x)) return true;
  return false;
}

// A node should re-evaluate this pass if we're in full mode, it has no
// recorded deps yet (first sight), it's untracked (deps === null), or one of
// its deps changed.
function shouldEval(node) {
  if (!gDirtyMode) return true;
  const deps = node.__sparkReadKeys;
  if (deps === undefined || deps === null) return true;
  return setsIntersect(deps, gDirtyKeys);
}

// Run `fn` (which evaluates a binding), recording every scope key it reads
// onto `node.__sparkReadKeys`. `null` means "read nothing trackable" → always
// re-evaluate (treated as untracked, never skipped). The dep Set is reused
// across evaluations of the same node to avoid per-patch allocation.
function withCapture(node, fn) {
  const prev = captureSet;
  let set = node.__sparkReadKeys;
  if (set == null) set = new Set();
  else set.clear();
  captureSet = set;
  try {
    fn();
  } finally {
    captureSet = prev;
  }
  node.__sparkReadKeys = set.size ? set : null;
}

// Run `fn` collecting EVERY scope key read anywhere inside it (including in
// nested withCapture leaves) onto `node.__sparkReadKeys`. Used by each/if
// blocks so the whole block can be skipped in dirty mode when none of the
// keys it depends on — the array/condition expr AND every per-row binding —
// changed.
function withSink(node, fn) {
  const prev = captureSink;
  let set = node.__sparkReadKeys;
  if (set == null) set = new Set();
  else set.clear();
  captureSink = set;
  try {
    fn();
  } finally {
    captureSink = prev;
    // Propagate to an enclosing block so a nested loop's deps count for the
    // outer one too.
    if (prev) for (const k of set) prev.add(k);
  }
  node.__sparkReadKeys = set.size ? set : null;
}

// ─── `$:` extraction (multi-line aware) ───────────────────────────────
// `$: x = a + b` is a reactive statement: pulled out of the script and re-run
// after every state change. We have no real JS parser (that's the point), so
// we scan character-by-character, skipping strings/comments and tracking
// bracket depth, to find where each `$:` statement actually ends. That lets a
// statement span lines when it's inside brackets, ends on an operator, or the
// next line begins with one — i.e. ASI-lite, matching how people write:
//   $: visible = tab === 'all'
//     ? items
//     : items.filter((i) => i.on);
const OPEN = '([{';
const CLOSE = ')]}';
// operators that, at a line's end OR a line's start, mean "this continues".
const CONT_END = new Set(['+','-','*','/','%','&','|','^','<','>','=','?',':','.',',']);
const CONT_START = new Set(['+','-','*','/','%','&','|','^','<','>','=','?',':','.',',','(','[','`']);

// Advance past a string/template literal starting at `i`; returns the index
// just after its closing quote. Handles escapes and `${…}` interpolation.
function skipString(src, i) {
  const q = src[i++];
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === q) return i + 1;
    if (q === '`' && c === '$' && src[i + 1] === '{') {
      i += 2;
      let d = 1;
      while (i < src.length && d > 0) {
        const k = src[i];
        if (k === '\\') { i += 2; continue; }
        if (k === '"' || k === "'" || k === '`') { i = skipString(src, i); continue; }
        if (k === '{') d++;
        else if (k === '}') d--;
        i++;
      }
      continue;
    }
    if (q !== '`' && c === '\n') return i; // unterminated normal string — bail
    i++;
  }
  return i;
}

// Names declared by `let/const/var`, INCLUDING comma chains
// (`let a = '', b = '', c`). The old code seeded only the first name, so the
// rest leaked to the global scope (and weren't reactive). Destructuring
// (`let {a} = …` / `let [a] = …`) is intentionally skipped — those stay local.
function extractDeclaredNames(code) {
  const names = [];
  const re = /(?:^|[\n;{}])\s*(?:let|const|var)\s+(?=[a-zA-Z_$])/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    let i = m.index + m[0].length; // at the first declarator name
    let depth = 0;
    let expectName = true;
    let lastReal = '';
    while (i < code.length) {
      const c = code[i];
      if (c === '"' || c === "'" || c === '`') { i = skipString(code, i); lastReal = '"'; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; lastReal = c; i++; continue; }
      if (c === ')' || c === ']' || c === '}') { depth--; lastReal = c; i++; continue; }
      if (depth === 0) {
        if (c === ';') break;
        if (c === '\n') { if (lastReal === ',') { i++; continue; } break; }
        if (c === ',') { expectName = true; lastReal = ','; i++; continue; }
        if (c === '=') { expectName = false; lastReal = '='; i++; continue; }
        if (expectName && /[a-zA-Z_$]/.test(c)) {
          let j = i;
          while (j < code.length && /[\w$]/.test(code[j])) j++;
          names.push(code.slice(i, j));
          expectName = false; lastReal = 'x'; i = j; continue;
        }
        if (!/\s/.test(c)) lastReal = c;
      }
      i++;
    }
  }
  return names;
}

// Find the end index of a `$:` statement whose body begins at `start`.
function reactiveStatementEnd(src, start) {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (OPEN.includes(c)) { depth++; i++; continue; }
    if (CLOSE.includes(c)) { if (depth === 0) return i; depth--; i++; continue; }
    if (depth === 0) {
      if (c === ';') return i;
      if (c === '\n') {
        const before = src.slice(start, i).replace(/\s+$/, '');
        const last = before[before.length - 1];
        if (last && CONT_END.has(last)) { i++; continue; }
        let k = i + 1;
        while (k < src.length && /[ \t\r]/.test(src[k])) k++;
        if (src[k] === '\n') { i++; continue; } // blank line — keep scanning
        const next = src[k];
        // ".method" chains, "? :" ternaries, binary operators on the next line
        if (next && CONT_START.has(next)) { i++; continue; }
        return i;
      }
    }
    i++;
  }
  return i;
}

// Pull every `$:` statement out of the script, returning the cleaned code
// (reactive spans blanked to newlines so line numbers stay put) and the list
// of statements to re-run on each change.
function extractReactiveStatements(src) {
  const reactiveStmts = [];
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { const j = skipString(src, i); out += src.slice(i, j); i = j; continue; }
    if (c === '/' && src[i + 1] === '/') { const s = i; while (i < src.length && src[i] !== '\n') i++; out += src.slice(s, i); continue; }
    if (c === '/' && src[i + 1] === '*') { const s = i; i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; out += src.slice(s, i); continue; }
    if (c === '$' && src[i + 1] === ':') {
      // Only at a statement boundary: start of script, or after ; { } newline.
      let j = out.length - 1;
      while (j >= 0 && (out[j] === ' ' || out[j] === '\t')) j--;
      const prev = j < 0 ? '\n' : out[j];
      if (prev === '\n' || prev === ';' || prev === '{' || prev === '}') {
        const end = reactiveStatementEnd(src, i + 2);
        const stmt = src.slice(i + 2, end).trim().replace(/;\s*$/, '');
        if (stmt) reactiveStmts.push(stmt);
        out += src.slice(i, end).replace(/[^\n]/g, ''); // keep newlines only
        i = end;
        continue;
      }
    }
    out += c;
    i++;
  }
  return { code: out, reactiveStmts };
}

// ─── Reactive scope ────────────────────────────────────────────────────
function makeScope(rawCode, componentEl, props = {}) {
  // Normalize line endings + strip comments so the declaration regexes
  // behave identically on every OS/editor. (CRLF was a real-world bug.)
  let code = rawCode.replace(/\r\n?/g, '\n');
  // `export let x = …` marks a PROP (overridable from the import
  // placeholder). Record prop names, then treat as a normal declaration.
  const propNames = new Set();
  code = code.replace(
    /(^|[\n;{}])(\s*)export\s+(let|const|var)\s+([a-zA-Z_$][\w$]*)/g,
    (_, before, space, kw, name) => {
      propNames.add(name);
      return `${before}${space}${kw} ${name}`;
    },
  );
  // `$: doubled = count * 2;` — reactive statements. Extracted here (multi-line
  // aware), re-run after every state change before patching.
  const extracted = extractReactiveStatements(code);
  code = extracted.code;
  const reactiveStmts = extracted.reactiveStmts;

  const codeNoComments = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const raw = Object.create(null);

  // Seed every top-level declared identifier so the proxy `has` trap
  // claims it inside the with() block.
  const funcRe =
    /(?:^|[\n;{}])\s*(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/g;
  let m;
  for (const n of extractDeclaredNames(codeNoComments)) raw[n] = undefined;
  while ((m = funcRe.exec(codeNoComments)) !== null) raw[m[1]] = undefined;
  // `$: x = …` implicitly declares x
  for (const stmt of reactiveStmts) {
    const t = stmt.match(/^([a-zA-Z_$][\w$]*)\s*=[^=]/);
    if (t) raw[t[1]] = undefined;
  }
  // Each `$:` statement becomes an effect carrying the keys it reads
  // (stamped on `__sparkReadKeys` by withCapture, like a DOM binding), so a
  // dirty-mode flush re-runs only the statements whose inputs changed.
  const reactiveEffects = reactiveStmts.map((src) => ({ src }));

  // Rewrite declarations to bare assignments so they hit the proxy.
  let rewritten = code.replace(
    /(^|[\n;{}])(\s*)(async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g,
    (_, before, space, async_ = '', name) =>
      `${before}${space}${name} = ${async_}function ${name}(`,
  );
  // Strip the `let`/`const`/`var` KEYWORD from declarations that start with an
  // identifier (single or comma-chained), turning `let a = 1, b = 2` into
  // `a = 1, b = 2` so every name hits the proxy. Destructuring (`let {…}` /
  // `let [@…]`) is left intact — it stays block-local, as documented.
  rewritten = rewritten.replace(
    /(^|[\n;{}])(\s*)(?:let|const|var)\s+(?=[a-zA-Z_$])/g,
    (_, before, space) => `${before}${space}`,
  );

  // Builtins available inside every component script.
  const scopeRef = { scope: null };
  const mountCallbacks = [];
  const builtins = {
    useStore: (name) => subscribeStore(name, componentEl, scopeRef),
    props: { ...props },
    // onMount(fn) — runs after the component is booted and painted.
    // A returned function is kept as a cleanup hook on the element.
    onMount: (fn) => mountCallbacks.push(fn),
  };

  // Keys changed since the last flush (drives targeted dirty-mode updates),
  // and a flag forcing a full re-evaluation when a change can't be pinned to
  // a key (deep mutation, store, member-path write). See the dep-tracking
  // section above.
  let dirtyKeys = new Set();
  // Raw loop-row objects deep-mutated this tick (e.g. `todos[0].done = true`).
  // These get a surgical re-walk of just their row instead of a full pass.
  let dirtyItems = new Set();
  let fullDirty = false;

  // Per-component cache so each raw object/array maps to one stable
  // reactive proxy (identity-preserving, see reactify).
  const reactiveCache = new WeakMap();
  // In-place mutation of a plain object/array. If the mutated object is a live
  // loop row (tracked in __sparkItems by patchEach), record it so only that row
  // re-walks. Anything else (a non-loop object, an array/Map/Set, deep nesting)
  // can't be pinned to a row, so it forces a full pass — never stale.
  const onMutate = (obj) => {
    if (!ready) return;
    if (obj && componentEl.__sparkItems && componentEl.__sparkItems.has(obj)) {
      dirtyItems.add(obj);
    } else {
      fullDirty = true;
    }
    schedule();
  };

  const scope = new Proxy(raw, {
    has(target, key) {
      if (typeof key !== 'string') return false;
      if (Object.hasOwn(builtins, key)) return true;
      // own-property check: stops window built-ins (name, status, length,
      // location…) from shadowing or escaping component state.
      return Object.hasOwn(target, key);
    },
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (Object.hasOwn(builtins, key)) return builtins[key];
      // Record this read for the binding currently being evaluated (Tier 2),
      // and for any enclosing each/if block collecting its full dep set.
      if (typeof key === 'string') {
        if (captureSet !== null) captureSet.add(key);
        if (captureSink !== null) captureSink.add(key);
      }
      const v = target[key];
      // A store proxy manages its own deep reactivity and notifies all
      // subscribers — return it as-is so the component doesn't re-wrap it
      // (which would route mutations through the component only, bypassing
      // the store's subscribers).
      if (v !== null && typeof v === 'object' && v[REACTIVE_STORE]) return v;
      // Wrap plain objects/arrays so in-place mutation re-renders.
      return reactify(v, onMutate, reactiveCache);
    },
    set(target, key, value) {
      if (typeof key === 'symbol') {
        target[key] = value;
        return true;
      }
      // Store the raw value, not a reactive wrapper, for stable identity.
      if (value && typeof value === 'object' && value[REACTIVE_RAW]) {
        value = value[REACTIVE_RAW];
      }
      target[key] = value;
      if (!ready) return true; // initialization writes: no scheduling/tracking
      if (inReactive) {
        // A `$:` write during a flush: extend the live gating set so nodes
        // reading this key re-evaluate in the same pass. Don't reschedule —
        // the in-progress flush will patch once at the end.
        if (gDirtyKeys) gDirtyKeys.add(key);
        return true;
      }
      // Normal write (e.g. an event handler): record the key and coalesce
      // into ONE patch on the microtask queue.
      dirtyKeys.add(key);
      schedule();
      return true;
    },
  });

  scopeRef.scope = scope;
  componentEl.__sparkOnMount = mountCallbacks;
  componentEl.__sparkSchedule = schedule;
  // Force a full (non-targeted) re-evaluation next flush — used by changes we
  // can't pin to a scope key (store notifications, member-path two-way writes).
  componentEl.__sparkScheduleFull = () => { fullDirty = true; schedule(); };

  // Re-run `$:` statements. Guarded so a reactive assignment doesn't
  // recurse into another full reactive pass; the patch after the outer
  // set sees the settled state.
  let inReactive = false;
  let ready = false; // don't run reactive stmts mid-initialization
  function runOneReactive(eff) {
    withCapture(eff, () => {
      try {
        compileStmt(eff.src)(scope);
      } catch (e) {
        // Runs on every state change — report once per statement.
        reportError(e, {
          phase: 'reactive', component: componentEl.getAttribute('name'), detail: '$: ' + eff.src,
        });
      }
    });
  }
  function runReactive() {
    if (!ready || inReactive || reactiveEffects.length === 0) return;
    inReactive = true;
    try {
      if (!gDirtyMode) {
        // Full pass: run every `$:` statement, (re)recording its deps.
        for (const eff of reactiveEffects) runOneReactive(eff);
      } else {
        // Dirty pass: run only statements whose deps changed. A statement's
        // write extends gDirtyKeys (via the set trap), which can make a later
        // statement newly dirty — so iterate to a fixpoint. The pass cap is
        // the statement count (a linear `$:` chain settles in that many
        // passes); it also bounds any pathological cycle.
        let grew = true;
        let passes = 0;
        while (grew && passes++ <= reactiveEffects.length) {
          grew = false;
          for (const eff of reactiveEffects) {
            if (!shouldEval(eff)) continue;
            const before = gDirtyKeys.size;
            runOneReactive(eff);
            if (gDirtyKeys.size > before) grew = true;
          }
        }
      }
    } finally {
      inReactive = false;
    }
  }

  // Re-render any content this component lent to a child's <slot>. It lives
  // inside the child but belongs to us, so our patch must refresh it too.
  function patchSlots() {
    const lent = componentEl.__sparkSlotProjected;
    if (!lent) return;
    for (const n of lent) if (n.isConnected) walkNode(n, scope, false);
  }

  // Microtask-batched flush: recompute reactive statements once, then patch
  // once, no matter how many writes happened this tick. Snapshot + reset the
  // trigger state up front so any new change DURING the flush schedules the
  // next one cleanly.
  let scheduled = false;
  function flush() {
    scheduled = false;
    // Swap the dirty set out (cheaper than copying) so writes during the
    // flush accumulate into a fresh set for the next round.
    const keys = dirtyKeys.size ? dirtyKeys : null;
    dirtyKeys = new Set();
    const items = dirtyItems.size ? dirtyItems : null;
    dirtyItems = new Set();
    const wasFull = fullDirty;
    fullDirty = false;
    if (!componentEl.isConnected) return;

    // Three modes (the update is wrapped so a throw is contained to THIS
    // component — logged + overlay — instead of wedging it as an uncaught
    // microtask):
    //   • dirty-key pass  — only top-level key writes: re-evaluate just the
    //     bindings that read a changed key (the existing fast path).
    //   • pure-row pass   — only loop-row deep mutations (`todos[i].done = …`):
    //     a FULL pass for everything OUTSIDE loops (so a `$:` aggregate or a
    //     direct `{rows[0].x}` is never stale), but patchEach re-walks ONLY the
    //     mutated rows — O(changed) instead of O(rows).
    //   • full pass       — anything else (mixed, store, Map/Set, scheduleFull,
    //     a non-loop deep mutation): re-walk everything. Never stale.
    gDirtyMode = !wasFull && !!keys && !items;
    gDirtyKeys = gDirtyMode ? keys : null;
    gDirtyItems = (!wasFull && items && !keys) ? items : null;
    try {
      runReactive();
      patch(componentEl, scope);
      patchSlots();
    } catch (e) {
      reportError(e, { phase: 'update', component: componentEl.getAttribute('name') });
    } finally {
      gDirtyMode = false;
      gDirtyKeys = null;
      gDirtyItems = null;
    }
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  }

  try {
    // Newline before `}` so a script ending in a `//` comment still closes.
    new Function('__scope__', `with(__scope__) {\n${rewritten}\n}`)(scope);
    ready = true;
    // Props override `export let` defaults.
    for (const [key, value] of Object.entries(props)) {
      if (propNames.has(key)) raw[key] = value;
      else if (!Object.hasOwn(raw, key)) raw[key] = value;
    }
    runReactive();
    patch(componentEl, scope);
    patchSlots();
  } catch (e) {
    // A throw here means the whole <script> failed to run, so none of the
    // component's state/handlers exist — make that unmistakable.
    reportError(e, {
      phase: 'script', component: componentEl.getAttribute('name'),
      detail: 'the <script> failed to run — state and handlers are unavailable',
    });
  }
  return scope;
}

// ─── DOM patching ──────────────────────────────────────────────────────
function patch(el, scope) {
  walkNode(el, scope, true);
  // Optional observation seam (used by the test suite to assert batching).
  // No-op in normal use — nothing sets this hook in the browser.
  if (globalThis.__sparkTestOnPatch) {
    globalThis.__sparkTestOnPatch(el);
  }
}

// Request a batched re-render of the component that owns `el`. Used after
// two-way binds: `bind:value="row.text"` is a member write, which mutates
// the object directly without tripping the scope proxy's set trap, so we
// have to ask the owning component to re-patch explicitly — and since it's
// not attributable to a key, force a full pass.
function scheduleRerender(el) {
  let n = el;
  while (n) {
    if (n.__sparkScheduleFull) return n.__sparkScheduleFull();
    n = n.parentNode;
  }
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

// Is a child node already known to be static — i.e. re-walking it can't
// change anything? Text without `{…}`, fully-static element subtrees, and
// comments qualify. An each/if anchor (never marked static) and any element
// with a live binding do not, so the parent keeps descending into them.
function isStaticNode(n) {
  if (n.nodeType === TEXT_NODE) {
    return !(n.__sparkTpl && n.__sparkTpl.includes('{'));
  }
  if (n.nodeType !== ELEMENT_NODE) return true;
  return n.__sparkStatic === true;
}

function walkNode(node, scope, isRoot = false) {
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

  // Escape hatch: subtrees marked spark-ignore are never patched —
  // essential for documentation/code samples containing literal {braces}.
  if (node.hasAttribute('spark-ignore')) {
    if (!isRoot) node.__sparkStatic = true;
    return;
  }
  // Don't reach into a nested component's territory — it self-manages via
  // its own scheduler, so from here its whole subtree counts as static. Only a
  // GENUINE component, though: a native `name=` on a form control (e.g.
  // `<input name="email">`) is not a boundary, so it keeps patching against the
  // parent scope (its `bind:value`/`{…}` read the parent's state).
  if (!isRoot && node.hasAttribute('name') && isSparkComponent(node)) {
    node.__sparkStatic = true;
    return;
  }

  // each/if anchors drive dynamic structure — never marked static. In dirty
  // mode they're SKIPPED when none of the keys they depend on (the array /
  // condition expr AND every per-row or branch binding, collected via the
  // sink) changed — so an unrelated update no longer re-reconciles a 1000-row
  // loop. Deep mutations (todos.push) take the full-walk path, so they still
  // reconcile correctly.
  if (node.hasAttribute('each')) {
    if (gDirtyMode && !shouldEval(node)) return;
    withSink(node, () => patchEach(node, scope));
    return;
  }

  // <template if="expr"> — conditional block. Content is inserted after
  // the template when truthy, removed when falsy. Unlike :hidden, the
  // nodes genuinely leave the DOM.
  if (node.hasAttribute('if')) {
    if (gDirtyMode && !shouldEval(node)) return;
    withSink(node, () => patchIf(node, scope));
    return;
  }

  // <template await="promise"> — async block. Shows its loading content while
  // the promise is pending, then swaps to <template then> (await = resolved
  // value) or <template catch> (await = error). Like if/each, the anchor drives
  // dynamic structure and is gated by the keys it reads in dirty mode.
  if (node.hasAttribute('await')) {
    if (gDirtyMode && !shouldEval(node)) return;
    withSink(node, () => patchAwait(node, scope));
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
    if (child.__sparkSlotHost && child.__sparkSlotHost.__sparkScope) {
      walkNode(child, child.__sparkSlotHost.__sparkScope);
      if (!isStaticNode(child)) allStatic = false;
      continue;
    }
    walkNode(child, scope);
    if (!isStaticNode(child)) allStatic = false;
  }
  if (!isRoot) node.__sparkStatic = allStatic;
}

function patchText(node, scope) {
  if (node.__sparkTpl === undefined) {
    node.__sparkTpl = node.textContent || '';
  }
  if (!node.__sparkTpl.includes('{')) return; // static text: nothing to do
  if (!shouldEval(node)) return;              // deps unchanged this pass
  let next;
  withCapture(node, () => { next = interpolate(node.__sparkTpl, scope); });
  if (node.textContent !== next) node.textContent = next;
}

// ─── <template if="expr"> conditional blocks ──────────────────────────
// ─── enter/leave lifecycle hooks ──────────────────────────────────────
// Tiny seam for optional animation packages (spark-html-motion). When a
// hook is registered, if/each blocks call enter() after inserting a node and
// leave(node, remove) before removing one — the hook may defer `remove` until
// an exit transition finishes. With no hook set this is a no-op: nodes are
// inserted and removed synchronously, exactly as before. Core ships nothing
// that animates; it just exposes the seam.
let enterHook = null;
let leaveHook = null;
function lifecycle(hooks = {}) {
  enterHook = typeof hooks.enter === 'function' ? hooks.enter : null;
  leaveHook = typeof hooks.leave === 'function' ? hooks.leave : null;
}
function enterNode(n) {
  if (enterHook && n && n.nodeType === 1) enterHook(n);
}
// Run component cleanups now (the node is leaving and goes inert), then let the
// leave hook animate before it actually detaches; no hook ⇒ remove immediately.
function leaveNode(n) {
  destroyComponent(n);
  const remove = () => {
    if (n.parentNode) n.parentNode.removeChild(n);
  };
  if (leaveHook && n.nodeType === 1) leaveHook(n, remove);
  else remove();
}

function patchIf(el, scope) {
  if (!el.__sparkIfParsed) {
    el.__sparkIfExpr = el.getAttribute('if').trim();
    if (el.tagName.toLowerCase() === 'template') {
      el.__sparkIfTemplate = [...el.content.childNodes].map((n) =>
        n.cloneNode(true),
      );
    } else {
      el.__sparkIfTemplate = [...el.childNodes].map((n) => n.cloneNode(true));
      el.innerHTML = '';
    }
    el.__sparkIfParsed = true;
  }

  if (!el.parentNode) return;
  const show = Boolean(evaluate(el.__sparkIfExpr, scope));
  const isShown = Boolean(el.__sparkIfRendered && el.__sparkIfRendered.length);

  if (show && !isShown) {
    el.__sparkIfRendered = [];
    let insertAfter = el;
    el.__sparkIfTemplate.forEach((tpl) => {
      const clone = tpl.cloneNode(true);
      clone.__sparkManaged = true; // owned by this if-block, not the parent walk
      insertAfter.after(clone);
      insertAfter = clone;
      el.__sparkIfRendered.push(clone);
      walkNode(clone, scope, false);
      enterNode(clone);
    });
    // Resolve any [import] placeholders cloned into the branch (async).
    hydrateBlockImports(el.__sparkIfRendered, scope);
  } else if (!show && isShown) {
    el.__sparkIfRendered.forEach(leaveNode); // cleanups + (optional) exit anim
    el.__sparkIfRendered = [];
  } else if (show && isShown) {
    // keep contents fresh
    el.__sparkIfRendered.forEach((n) => {
      if (n.parentNode) walkNode(n, scope, false);
    });
  }
}

// ─── <template await="promise"> async blocks ──────────────────────────
// Declarative async, the Spark way: no compiler, reuse the same template +
// scope-proxy + dependency-tracking machinery the each/if blocks ride on.
//
//   <template await="expr">
//     <p>Loading…</p>                       <!-- pending (default) -->
//     <template then>  {await.value} </template>   <!-- await = resolved value -->
//     <template catch> {await.message} </template> <!-- await = error -->
//   </template>
//
// • await="expr"        re-evaluates when a scalar dependency changes (like $:),
//                       cancels the prior promise, and shows pending again.
// • await="once(expr)"  fires on mount only (never re-fires).
// A non-thenable expr is treated as an already-resolved value (then branch).

// A child scope where the identifier `await` resolves to the settled value
// (resolved value in `then`, error in `catch`) — same shape as the loop scope.
function awaitScope(scope, value, asName) {
  return new Proxy(scope, {
    get(t, k) {
      if (k === 'await' || (asName && k === asName)) return value;
      if (k === Symbol.unscopables) return undefined;
      return t[k];
    },
    has(t, k) { return k === 'await' || (asName && k === asName) || k in t; },
    set(t, k, v) { if (k === 'await' || (asName && k === asName)) return true; t[k] = v; return true; },
  });
}

function parseAwait(el) {
  let expr = (el.getAttribute('await') || '').trim();
  // once(expr): one-shot — evaluate on mount only. Greedy capture so inner
  // parens (once(load())) round-trip.
  const m = expr.match(/^once\(([\s\S]*)\)$/);
  el.__sparkAwaitOnce = !!m;
  el.__sparkAwaitExpr = (m ? m[1] : expr).trim();
  el.__sparkAwaitAs = el.getAttribute('as') || null;

  const content = el.tagName.toLowerCase() === 'template'
    ? [...el.content.childNodes]
    : [...el.childNodes];

  const pending = [], thenNodes = [], catchNodes = [];
  for (const n of content) {
    const isTpl = n.nodeType === ELEMENT_NODE && n.tagName === 'TEMPLATE';
    if (isTpl && n.hasAttribute('then')) thenNodes.push(...n.content.childNodes);
    else if (isTpl && n.hasAttribute('catch')) catchNodes.push(...n.content.childNodes);
    else pending.push(n);
  }
  const clone = (nodes) => nodes.map((n) => n.cloneNode(true));
  el.__sparkPendingTpl = clone(pending);
  el.__sparkThenTpl = clone(thenNodes);
  el.__sparkCatchTpl = clone(catchNodes);
  if (el.tagName.toLowerCase() !== 'template') el.innerHTML = '';
  el.__sparkAwaitParsed = true;

  // Hydration: drop any branch content a prerender baked as live siblings
  // (tagged data-spark-await) so the client re-runs the promise and renders
  // once — no duplicate. The crawler still got the resolved HTML.
  if (!(isPrerender())) {
    let probe = el.nextSibling;
    while (probe && probe.nodeType !== ELEMENT_NODE) probe = probe.nextSibling;
    if (probe && probe.hasAttribute && probe.hasAttribute('data-spark-await')) {
      let n = el.nextSibling;
      while (n) {
        const next = n.nextSibling;
        if (n.nodeType === ELEMENT_NODE && !(n.hasAttribute && n.hasAttribute('data-spark-await'))) break;
        destroyComponent(n);
        if (n.parentNode) n.parentNode.removeChild(n);
        n = next;
      }
    }
  }
}

// Tear down the current branch's DOM and render the branch for the current
// state, walking it with the right scope (await-bound for then/catch).
function applyAwaitState(el, scope) {
  if (el.__sparkAwaitRendered) {
    for (const n of el.__sparkAwaitRendered) {
      destroyComponent(n);
      if (n.parentNode) n.parentNode.removeChild(n);
    }
  }
  el.__sparkAwaitRendered = [];
  const state = el.__sparkAwaitState;
  const tpl = state === 'then' ? el.__sparkThenTpl
    : state === 'catch' ? el.__sparkCatchTpl
    : el.__sparkPendingTpl;
  const branchScope = state === 'then' ? awaitScope(scope, el.__sparkAwaitValue, el.__sparkAwaitAs)
    : state === 'catch' ? awaitScope(scope, el.__sparkAwaitError, el.__sparkAwaitAs)
    : scope;
  // Tag baked branch nodes during prerender so a client mount can clear them
  // (see parseAwait) and re-render without duplicating.
  const tag = (isPrerender()) && state !== 'pending';
  let insertAfter = el;
  for (const t of tpl) {
    const c = t.cloneNode(true);
    c.__sparkManaged = true; // owned by this await-block, not the parent walk
    if (tag && c.nodeType === ELEMENT_NODE && c.setAttribute) c.setAttribute('data-spark-await', '');
    insertAfter.after(c);
    insertAfter = c;
    el.__sparkAwaitRendered.push(c);
    walkNode(c, branchScope, false);
  }
  hydrateBlockImports(el.__sparkAwaitRendered, branchScope);
  el.__sparkAwaitRenderedState = state;
}

// Keep the current branch's reactive bindings fresh on later patches.
function refreshAwait(el, scope) {
  if (!el.__sparkAwaitRendered) return;
  const state = el.__sparkAwaitRenderedState;
  const branchScope = state === 'then' ? awaitScope(scope, el.__sparkAwaitValue, el.__sparkAwaitAs)
    : state === 'catch' ? awaitScope(scope, el.__sparkAwaitError, el.__sparkAwaitAs)
    : scope;
  for (const n of el.__sparkAwaitRendered) if (n.parentNode) walkNode(n, branchScope, false);
}

// (Re)start the block on a new promise/value: show pending, then settle into
// then/catch. Stale promises (superseded by a newer evaluation) are ignored.
function startAwait(el, source, scope) {
  el.__sparkAwaitSource = source;
  const thenable = source && typeof source.then === 'function';
  if (!thenable) {
    // A plain value (or nullish) — resolved immediately.
    el.__sparkAwaitState = 'then';
    el.__sparkAwaitValue = source;
    applyAwaitState(el, scope);
    return;
  }
  const p = source;
  el.__sparkAwaitPromise = p;
  el.__sparkAwaitState = 'pending';
  applyAwaitState(el, scope); // loading, now

  // During prerender, let the settle loop wait for the promise (like load()),
  // so :then content is in the serialized HTML.
  if (isPrerender() && Array.isArray(globalThis.__SPARK_AWAITS__)) {
    globalThis.__SPARK_AWAITS__.push(p);
  }

  const settle = (state, payload) => {
    if (el.__sparkAwaitPromise !== p) return; // superseded — drop
    el.__sparkAwaitState = state;
    if (state === 'then') el.__sparkAwaitValue = payload;
    else el.__sparkAwaitError = payload;
    // Re-render through the owning component's batched flush when present (so a
    // burst of settles collapses into one patch). Crucially that flush re-walks
    // in FULL mode, which does NOT re-evaluate the await expr (avoiding promise
    // churn for inline exprs like fetch()) — it only applies the new state.
    const comp = el.__sparkAwaitComp;
    if (comp && comp.__sparkScheduleFull && comp.isConnected) comp.__sparkScheduleFull();
    else applyAwaitState(el, el.__sparkAwaitScope || scope);
  };
  p.then((v) => settle('then', v), (e) => settle('catch', e));
}

function patchAwait(el, scope) {
  if (!el.__sparkAwaitParsed) parseAwait(el);
  if (!el.parentNode) return;
  el.__sparkAwaitScope = scope; // latest scope for async settles + refresh
  if (el.__sparkAwaitComp === undefined) el.__sparkAwaitComp = closestComponent(el);

  const firstTime = !el.__sparkAwaitStarted;
  const exprKeys = el.__sparkAwaitExprKeys;
  // Re-evaluate the expr (and maybe restart) only on first sight, or — unless
  // it's once() — in a dirty pass where one of the expr's own deps changed.
  // Never in a full pass: that's where async settles re-render, and re-running
  // an inline expr (fetch(url)) there would mint a new promise every time.
  const reEval = firstTime
    || (!el.__sparkAwaitOnce && gDirtyMode && setsIntersect(exprKeys, gDirtyKeys));

  if (reEval) {
    let set = el.__sparkAwaitExprKeys;
    set = set ? (set.clear(), set) : new Set();
    const prev = captureSet;
    captureSet = set; // record THIS expr's deps (also flows to the block sink)
    let result;
    try { result = evaluate(el.__sparkAwaitExpr, scope); }
    finally { captureSet = prev; }
    el.__sparkAwaitExprKeys = set.size ? set : null;

    if (firstTime || result !== el.__sparkAwaitSource) {
      el.__sparkAwaitStarted = true;
      startAwait(el, result, scope);
      return;
    }
  } else if (exprKeys && captureSink) {
    // Not re-evaluating this pass — still keep the block's gating deps.
    for (const k of exprKeys) captureSink.add(k);
  }

  // State may have advanced asynchronously since the last walk → swap branch;
  // otherwise just refresh the current branch's reactive content.
  if (el.__sparkAwaitState !== el.__sparkAwaitRenderedState) applyAwaitState(el, scope);
  else refreshAwait(el, scope);
}

// ─── each="item in array" loops ───────────────────────────────────────
// Reconciling, not rebuilding. The old implementation removed every clone
// and recreated it on every patch — which fires on every keystroke — so an
// <input> inside a loop could never hold focus and long lists thrashed the
// DOM. We now keep one "block" of nodes per item and REUSE it across
// patches: blocks are matched by key (default: index), reused in place
// (no move when already correct, so focus survives), created for new items,
// and destroyed for removed ones.
//
// Optional explicit key for identity-stable reconciliation across reorders:
//   <template each="todo in todos" key="todo.id"> … </template>
function patchEach(el, scope) {
  if (!el.__sparkEachParsed) {
    const expr = el.getAttribute('each').trim();
    const match = expr.match(/^(\w+)(?:\s*,\s*(\w+))?\s+in\s+(.+)$/);
    if (!match) {
      el.__sparkEachParsed = true;
      warnOnce(
        `each:${expr}`,
        `[spark] Invalid each="${expr}". Expected each="item in items" or each="item, i in items".`,
      );
      return;
    }

    el.__sparkEachVar = match[1];
    el.__sparkEachIndexVar = match[2] || null;
    el.__sparkEachArrayExpr = match[3].trim();
    el.__sparkEachKeyExpr = el.getAttribute('key')
      ? el.getAttribute('key').trim()
      : null;

    if (el.tagName.toLowerCase() === 'template') {
      el.__sparkEachTemplate = [...el.content.childNodes].map((n) =>
        n.cloneNode(true),
      );
    } else {
      el.__sparkEachTemplate = [...el.childNodes].map((n) =>
        n.cloneNode(true),
      );
      el.innerHTML = '';
    }
    el.__sparkEachParsed = true;
    el.__sparkEachBlocks = []; // [{ key, nodes: [] }]
  }

  const {
    __sparkEachVar: varName,
    __sparkEachIndexVar: idxName,
    __sparkEachArrayExpr: arrayExpr,
    __sparkEachKeyExpr: keyExpr,
    __sparkEachTemplate: templateNodes,
  } = el;

  if (!varName || !arrayExpr || !templateNodes) return;
  if (!el.parentNode) return;

  const arr = evaluate(arrayExpr, scope);
  if (!Array.isArray(arr)) {
    // null/undefined is a normal "loading" state; warn only for a real
    // type mistake (e.g. each over an object or string).
    if (arr != null) {
      warnOnce(
        `eacharr:${arrayExpr}`,
        `[spark] each="… in ${arrayExpr}" expected an array but got ${typeof arr}. Nothing rendered.`,
      );
    }
    return;
  }

  const makeLoopScope = (item, i) =>
    new Proxy(scope, {
      get(t, k) {
        if (k === varName) return item;
        if (idxName && k === idxName) return i;
        if (k === Symbol.unscopables) return undefined;
        return t[k];
      },
      has(t, k) {
        return k === varName || (idxName && k === idxName) || k in t;
      },
      set(t, k, v) {
        // Never let an assignment clobber the loop variable/index on the
        // shared parent scope; everything else writes through normally.
        if (k === varName || (idxName && k === idxName)) return true;
        t[k] = v;
        return true;
      },
    });

  const keyOf = (item, i, loopScope) =>
    keyExpr ? evaluate(keyExpr, loopScope) : i;

  const oldBlocks = el.__sparkEachBlocks || [];
  const oldByKey = new Map();
  for (const b of oldBlocks) oldByKey.set(b.key, b);

  const newBlocks = [];
  let insertAfter = el;

  // Track each row's raw item on the owning component, so a deep mutation
  // (`todos[i].done = …`) can re-walk just that row instead of the whole
  // component. A WeakSet → dropped rows are collected automatically.
  const comp = el.__sparkEachComp || (el.__sparkEachComp = closestComponent(el));
  const items = comp && (comp.__sparkItems || (comp.__sparkItems = new WeakSet()));

  arr.forEach((item, i) => {
    const loopScope = makeLoopScope(item, i);
    const rawItem = (item && item[REACTIVE_RAW]) || item;
    if (items && rawItem && typeof rawItem === 'object') items.add(rawItem);
    const key = keyOf(item, i, loopScope);
    let block = oldByKey.get(key);

    if (block) {
      oldByKey.delete(key);
      // Reuse the existing nodes — only move them if they're not already in
      // the right spot, so a focused input is left untouched.
      let cursor = insertAfter;
      for (const n of block.nodes) {
        if (cursor.nextSibling !== n) cursor.after(n);
        cursor = n;
      }
      // Pure-row pass (gDirtyItems set): only re-walk a row whose item was
      // mutated this tick. Otherwise nothing it reads changed, so skip it —
      // this is what turns O(rows) into O(changed rows).
      if (!gDirtyItems || gDirtyItems.has(rawItem)) {
        for (const n of block.nodes) walkNode(n, loopScope, false);
      }
    } else {
      const nodes = [];
      let cursor = insertAfter;
      for (const tpl of templateNodes) {
        const clone = tpl.cloneNode(true);
        clone.__sparkManaged = true; // owned by this loop, not the parent walk
        cursor.after(clone);
        cursor = clone;
        nodes.push(clone);
        walkNode(clone, loopScope, false);
        enterNode(clone);
      }
      // Resolve any [import] placeholders cloned into this block (async),
      // swapping them for booted hosts; mutates `nodes` so reconciliation
      // tracks the host on later patches.
      hydrateBlockImports(nodes, loopScope);
      block = { key, nodes };
    }

    newBlocks.push(block);
    const last = block.nodes[block.nodes.length - 1];
    if (last) insertAfter = last;
  });

  // Anything left in oldByKey was dropped from the array — clean it up.
  for (const b of oldByKey.values()) {
    for (const n of b.nodes) leaveNode(n); // cleanups + (optional) exit anim
  }

  el.__sparkEachBlocks = newBlocks;
}

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
      el.addEventListener(eventName, () => {
        let val;
        if (mode === 'checked') val = el.checked;
        else if (mode === 'group') { if (!el.checked) return; val = el.value; }
        else if (mode === 'number') { const v = el.value; val = v === '' ? null : Number(v); }
        else if (mode === 'multi') {
          val = [...(el.selectedOptions || [])].map((o) => o.value);
        } else if (mode === 'text') val = el.textContent;
        else val = el.value; // value / select
        execute(`${expr} = __val__`, el.__sparkScopeRef, null, val, {
          phase: 'bind', component: componentNameFor(el), detail: name + '="' + expr + '"',
        });
        // Member writes don't trip the scope proxy, so re-render explicitly.
        scheduleRerender(el);
      });
      plan.push({ kind: 'bind', mode, expr });
      live = true;
      continue;
    }

    // onclick={…} — attached once; no per-patch op. A bare reference (a name or
    // dotted path like `add` / `theme.toggle`) is CALLED with the event;
    // anything else (`count++`, `pick='b'`, `add(5)`, `x = event.target.value`)
    // is run as an inline statement, with `event` in scope.
    if (/^on\w+$/.test(name) && value.startsWith('{') && value.endsWith('}')) {
      // (A <form bind:form>'s onsubmit was already captured + stripped by the
      // pre-scan above, so it never reaches here.)
      const fnExpr = value.slice(1, -1).trim();
      const isRef = /^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*$/.test(fnExpr);
      const code = isRef ? `${fnExpr}(event)` : fnExpr;
      const evt = name.slice(2);
      el.addEventListener(evt, (e) => {
        // A plain onsubmit on a <form> almost always means "handle it in JS" —
        // preventDefault by default so the page doesn't navigate (long-standing
        // papercut). Escape hatch: call nothing / use a real <a> for navigation.
        if (evt === 'submit' && e && e.preventDefault) e.preventDefault();
        execute(code, el.__sparkScopeRef, e, undefined, {
          phase: 'handler', component: componentNameFor(el), detail: name + '={' + fnExpr + '}',
        });
      });
      el.removeAttribute(name);
      live = true;
      continue;
    }

    // :disabled="count >= 10" — dynamic attribute, evaluated each patch.
    if (name.startsWith(':')) {
      const realAttr = name.slice(1);
      const op = { kind: 'attr', name, realAttr, expr: value };
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
      const current = evaluate(op.expr, scope);
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
        result = compileExpr(op.expr)(scope);
      } catch (e) {
        // Evaluation failed — leave the attribute untouched (event handlers
        // may still need to read it) but tell the consumer once.
        warnOnce(
          `attr:${op.name}=${op.expr}`,
          `[spark] Error in :${op.realAttr}="${op.expr}" — ${e.message}. (Attribute left unchanged.)`,
        );
        continue;
      }
      if (typeof result === 'boolean' && op.staticClass === undefined) {
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
  withCapture(el, () => runElementPlan(el, scope));
}

// ─── Component boot ───────────────────────────────────────────────────
// Spark marks component hosts with a `name` attribute — but `name` is ALSO a
// native HTML attribute on form controls (`<input name="email">`, `<select>`,
// radio groups, `<button name>`…). A bare `name` on such a field is a form
// field, NOT a component: booting it would give it its own empty scope and
// strand any `bind:`/`{…}` that reads the parent's state. A genuine component
// always carries source — a resolved import, attached SFC script/style, an
// inline <script>/<style> child, or (once booted) its own scope. This
// distinguishes the two everywhere `[name]` is treated as a component.
function isSparkComponent(el) {
  if (el.__sparkScope !== undefined) return true;       // already booted
  if (el.__sparkBooted) return true;                    // booting now
  if (el.__sparkImportPath !== undefined) return true;  // resolved import host
  if (el.__sparkScriptSrc !== undefined) return true;   // SFC source attached
  if (el.__sparkStyleSrc !== undefined) return true;
  if (el.childNodes) {                                  // legacy inline component
    for (const c of el.childNodes) {
      if (c.nodeType === ELEMENT_NODE && (c.tagName === 'SCRIPT' || c.tagName === 'STYLE')) return true;
    }
  }
  return false;
}

function bootComponent(el) {
  if (el.__sparkBooted) return;
  if (!isSparkComponent(el)) return; // a bare native `name=` (form field) — skip
  el.__sparkBooted = true;

  const tag = el.getAttribute('name');

  // Whole boot is wrapped: scopeCss / makeScope setup run outside makeScope's
  // own try, so a throw here would otherwise abort mount()'s boot loop and
  // leave every later component unbooted (a blank page). Contain it instead —
  // this component degrades, siblings boot, and it's revealed (never cloaked).
  try {
    // Script/style come from the SFC parser (preferred), or fall back to
    // legacy DOM children for old-style wrapped components.
    let scriptSrc = el.__sparkScriptSrc || '';
    let styleSrc = el.__sparkStyleSrc || '';

    const domScript = el.querySelector(':scope > script');
    const domStyle = el.querySelector(':scope > style');
    if (domScript) {
      scriptSrc = scriptSrc || domScript.textContent;
      domScript.remove();
    }
    if (domStyle) {
      styleSrc = styleSrc || domStyle.textContent;
      domStyle.remove();
    }

    if (styleSrc) {
      if (tag && !document.querySelector(`style[data-spark="${tag}"]`)) {
        const s = document.createElement('style');
        s.dataset.spark = tag;
        // Scope every selector to this component automatically.
        s.textContent = scopeCss(styleSrc, tag);
        document.head.appendChild(s);
      }
    }

    if (scriptSrc) {
      el.__sparkScope = makeScope(scriptSrc, el, el.__sparkProps || {});
    } else {
      el.__sparkScope = {};
      patch(el, el.__sparkScope);
    }
  } catch (e) {
    reportError(e, { phase: 'boot', component: tag });
    reveal(el); // don't strand a failed component cloaked/invisible
  }

  requestAnimationFrame(() => {
    try {
      patch(el, el.__sparkScope || {});
    } catch (e) {
      reportError(e, { phase: 'patch', component: tag });
    }
    // onMount fires once, after the first paint-ready patch.
    (el.__sparkOnMount || []).forEach((fn) => {
      try {
        const cleanup = fn();
        if (typeof cleanup === 'function') {
          (el.__sparkOnDestroy ||= []).push(cleanup);
        }
      } catch (e) {
        reportError(e, { phase: 'onMount', component: tag });
      }
    });
    el.__sparkOnMount = [];
    reveal(el); // booted, styled and patched — safe to show (no FOUC)
  });
}

// ─── Teardown ─────────────────────────────────────────────────────────
// Run every component's onMount-returned cleanups and drop its store
// subscriptions. Called when if/each removes a subtree, or directly via
// unmount(). Without this, cleanups never ran and store subscribers
// (which capture the whole component scope) leaked forever.
function destroyComponent(node) {
  if (!node || node.nodeType !== ELEMENT_NODE) return;
  const comps = [];
  if (node.hasAttribute && node.hasAttribute('name')) comps.push(node);
  if (node.querySelectorAll) comps.push(...node.querySelectorAll('[name]'));
  for (const c of comps) {
    (c.__sparkOnDestroy || []).forEach((fn) => {
      try {
        fn();
      } catch (e) {
        console.warn('[spark] onDestroy error:', e.message);
      }
    });
    c.__sparkOnDestroy = [];
    (c.__sparkStoreUnsubs || []).forEach((fn) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    });
    c.__sparkStoreUnsubs = [];
  }
}

// ─── CSS scoping ───────────────────────────────────────────────────────
// Prefix every selector with [name="comp"] so a component's styles can't
// leak out (or in). The old implementation was a single regex — it couldn't
// see into @media, mangled @keyframes step selectors (0%/100%), embedded
// CSS comments into selectors, and only handled :global() when it wrapped
// the ENTIRE selector. This is a small, proper tokenizer instead: it strips
// comments, walks the rule tree by brace depth, scopes only real selector
// lists (recursing into @media/@supports so their selectors get the SAME
// scope — which also balances specificity against base rules), leaves
// @keyframes/@font-face bodies untouched, and unwraps :global(...) wherever
// it appears in a selector.

// Advance past a CSS string starting at `i`; returns the index just after
// the closing quote. Handles escapes.
function cssSkipString(s, i) {
  const q = s[i++];
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === q) return i + 1;
    i++;
  }
  return i;
}

// Strip /* … */ comments, preserving strings. A comment becomes one space so
// adjacent tokens never fuse (e.g. `a/* x */b` → `a b`, not `ab`).
function stripCssComments(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") { const j = cssSkipString(css, i); out += css.slice(i, j); i = j; continue; }
    if (c === '/' && css[i + 1] === '*') {
      i += 2;
      while (i < css.length && !(css[i] === '*' && css[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Index of the `}` matching the `{` at `openIdx` (string-aware).
function cssMatchBrace(css, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") { i = cssSkipString(css, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return css.length; // unbalanced — treat the rest as the body
}

// Index just past a balanced ( … ) or [ … ] group starting at `open`.
function cssMatchGroup(s, open) {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { i = cssSkipString(s, i); continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return s.length;
}

// At-rules whose body is itself a list of rules (so we recurse + scope the
// nested selectors). Everything else with a block (@keyframes, @font-face,
// @page, @font-feature-values…) has a body that is NOT selectors — leave it.
const NESTED_AT_RULES = new Set([
  'media', 'supports', 'container', 'document', '-moz-document', 'layer',
]);

// Split a selector list on top-level commas (commas inside (), [], or strings
// — e.g. :is(.a, .b) or [x="a,b"] — don't separate selectors).
function splitSelectorList(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < list.length) {
    const c = list[i];
    if (c === '"' || c === "'") { i = cssSkipString(list, i); continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(list.slice(start, i)); start = i + 1; }
    i++;
  }
  parts.push(list.slice(start));
  return parts;
}

// Break one complex selector into compounds + combinators, respecting
// strings and ()/[] groups (so `>`/`+`/`~`/spaces inside :nth-child(2n+1) or
// [a~=b] are not treated as combinators).
function tokenizeSelector(sel) {
  const tokens = [];
  let compound = '';
  const flush = () => { if (compound) { tokens.push({ t: 'c', v: compound }); compound = ''; } };
  let i = 0;
  while (i < sel.length) {
    const c = sel[i];
    if (c === '"' || c === "'") { const j = cssSkipString(sel, i); compound += sel.slice(i, j); i = j; continue; }
    if (c === '(' || c === '[') { const j = cssMatchGroup(sel, i); compound += sel.slice(i, j); i = j; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '>' || c === '+' || c === '~') {
      flush();
      let comb = '';
      while (i < sel.length && /[\s>+~]/.test(sel[i])) { comb += sel[i]; i++; }
      const sym = comb.match(/[>+~]/);
      tokens.push({ t: 'comb', v: sym ? ` ${sym[0]} ` : ' ' });
      continue;
    }
    compound += c;
    i++;
  }
  flush();
  return tokens;
}

// Scope one selector: insert `prefix ` before the first compound that isn't
// wrapped in :global(), and unwrap :global(X) → X wherever it appears. A
// selector that is entirely :global(...) stays fully unscoped.
function scopeSelector(sel, prefix) {
  const trimmed = sel.trim();
  if (!trimmed) return sel;
  const tokens = tokenizeSelector(trimmed);
  let out = '';
  let inserted = false;
  for (const tok of tokens) {
    if (tok.t === 'comb') { out += tok.v; continue; }
    const whole = tok.v.match(/^:global\(([\s\S]*)\)$/);
    if (whole) {
      out += whole[1]; // a purely-global compound: drop the wrapper, no scope
    } else {
      if (!inserted) { out += `${prefix} `; inserted = true; }
      out += tok.v.replace(/:global\(([\s\S]*?)\)/g, '$1'); // partial :global()
    }
  }
  return out;
}

function scopeSelectorList(list, prefix) {
  return splitSelectorList(list)
    .map((sel) => scopeSelector(sel, prefix))
    .join(', ');
}

// Walk a sequence of rules at one nesting level, scoping style-rule selectors.
function scopeRules(css, prefix) {
  let out = '';
  let i = 0;
  const n = css.length;
  while (i < n) {
    // Preserve leading whitespace between rules.
    const ws = i;
    while (i < n && /\s/.test(css[i])) i++;
    out += css.slice(ws, i);
    if (i >= n) break;

    // Read the prelude (selector list or at-rule header) up to a top-level
    // `{` or `;` — `{`/`;` inside (), [], or strings don't count.
    const preludeStart = i;
    let depth = 0;
    while (i < n) {
      const c = css[i];
      if (c === '"' || c === "'") { i = cssSkipString(css, i); continue; }
      if (c === '(' || c === '[') { depth++; i++; continue; }
      if (c === ')' || c === ']') { depth--; i++; continue; }
      if (depth === 0 && (c === '{' || c === ';')) break;
      i++;
    }
    const prelude = css.slice(preludeStart, i);

    if (i >= n) { out += prelude; break; }

    if (css[i] === ';') {        // statement at-rule (@import, @charset…)
      out += prelude + ';';
      i++;
      continue;
    }

    // css[i] === '{' — block rule.
    const end = cssMatchBrace(css, i);
    const body = css.slice(i + 1, end);
    const trimmed = prelude.trim();

    if (trimmed[0] === '@') {
      const name = (trimmed.slice(1).match(/^[\w-]*/) || [''])[0].toLowerCase();
      out += NESTED_AT_RULES.has(name)
        ? `${trimmed} {${scopeRules(body, prefix)}}` // scope nested selectors
        : `${trimmed} {${body}}`;                    // @keyframes/@font-face: leave
    } else {
      out += `${scopeSelectorList(prelude, prefix)} {${body}}`;
    }
    i = end + 1;
  }
  return out;
}

function scopeCss(css, tag) {
  return scopeRules(stripCssComments(css), `[name="${tag}"]`);
}

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
  if (options.devOverlay || (globalThis.__SPARK_DEV_OVERLAY__)) {
    devOverlay = true;
  }
  if (typeof root === 'string') root = document.querySelector(root);
  if (!root) throw new Error('[spark] mount target not found');

  const run = async () => {
    await resolveImports(root);
    root.querySelectorAll('[name]').forEach(bootComponent);
    if (root.hasAttribute && root.hasAttribute('name')) bootComponent(root);
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

// Patch fetch path resolution: check the registry first.
const _origFetchComponent = async (path) => {
  const bare = path.replace(/\.html$/, '');
  if (registry.has(bare)) {
    return { ok: true, text: async () => registry.get(bare) };
  }
  return fetch(path);
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

export { mount, unmount, component, store, derived, subscribe, evaluate, interpolate, parseSFC, scopeCss, inspectStores, lifecycle };
export default { mount, unmount, component, store, derived };
