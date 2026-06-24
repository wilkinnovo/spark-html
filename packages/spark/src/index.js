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

function execute(code, scope, event = null, __val__ = undefined) {
  try {
    // `event` is a real parameter — handlers receive it directly, with no
    // proxy writes (which would trigger a re-patch mid-click) and no
    // reliance on the deprecated window.event (absent in Firefox).
    // `__val__` carries the element value for two-way bindings.
    compileStmt(code)(scope, event, __val__);
  } catch (e) {
    console.warn(`[spark] Error in "${code}":`, e.message);
  }
}

function interpolate(template, scope) {
  return template.replace(/\{([^}]+)\}/g, (_, code) => {
    const v = evaluate(code.trim(), scope);
    return v == null ? '' : String(v);
  });
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
async function resolveImports(root) {
  const nodes = [...root.querySelectorAll('[import]')];
  await Promise.all(
    nodes.map(async (node) => {
      let path = node.getAttribute('import');
      if (!path.endsWith('.html')) path += '.html';
      try {
        const res = await _origFetchComponent(path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const source = await res.text();

        const compName = path.replace(/.*\//, '').replace('.html', '');
        const { markup, script, style } = parseSFC(source);

        // Capture the placeholder's children as slot content (before they're
        // discarded), and the component that owns them, for scope.
        const slotted = [...node.childNodes];
        const parentHost = closestComponent(node);

        // Build the component host. The import placeholder itself becomes
        // the host, so classes/ids on it are preserved.
        const host = document.createElement('div');
        host.setAttribute('name', compName);
        // Cloak until booted+patched so the raw markup (with {braces}) and
        // not-yet-injected styles never flash. reveal() clears this.
        host.setAttribute('data-spark-cloak', '');
        // Placeholder attributes become PROPS (except import/class/id,
        // which keep their normal HTML meaning and are carried over).
        const props = {};
        for (const attr of node.attributes) {
          if (attr.name === 'import') continue;
          if (attr.name === 'class' || attr.name === 'id') {
            host.setAttribute(attr.name, attr.value);
            continue;
          }
          props[attr.name] = coerce(attr.value);
        }
        host.__sparkProps = props;
        host.innerHTML = markup; // markup contains no <script>/<style> now

        // stash extracted source on the element — bootComponent reads these
        host.__sparkScriptSrc = script;
        host.__sparkStyleSrc = style;

        projectSlots(host, slotted, parentHost); // <slot> content projection
        await resolveImports(host); // nested imports (incl. inside slots)
        node.replaceWith(host);
      } catch (e) {
        const hint = /HTTP 404/.test(e.message)
          ? ` Check the path is correct and the file is served (relative to the page).`
          : '';
        console.warn(`[spark] Could not import "${path}" — ${e.message}.${hint}`);
      }
    }),
  );
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

  entry.proxy = new Proxy(entry.state, {
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      return target[key];
    },
    set(target, key, value) {
      target[key] = value;
      entry.subscribers.forEach((fn) => fn());
      return true;
    },
  });

  stores.set(name, entry);
  return entry.proxy;
}

// Subscribe a component element to a store; returns the store proxy.
// The subscriber is tracked on the element so destroyComponent() can remove
// it — otherwise the closure (and the whole component scope it captures)
// would live in the store's Set forever, leaking on every unmount.
function subscribeStore(name, componentEl, scopeRef) {
  let entry = stores.get(name);
  if (!entry) {
    console.warn(`[spark] useStore("${name}") — store not created. Call store("${name}", initial) before mount().`);
    store(name, {});
    entry = stores.get(name);
  }
  const cb = () => {
    if (!scopeRef.scope || !componentEl.isConnected) return;
    // Route through the component's batching scheduler when available so a
    // burst of store writes collapses into a single patch.
    if (componentEl.__sparkSchedule) componentEl.__sparkSchedule();
    else patch(componentEl, scopeRef.scope);
  };
  entry.subscribers.add(cb);
  (componentEl.__sparkStoreUnsubs ||= []).push(() => entry.subscribers.delete(cb));
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

function isPlainContainer(v) {
  if (Array.isArray(v)) return true;
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function reactify(value, onMutate, cache) {
  // Unwrap any reactive proxy back to its raw target first, so every value
  // maps to one canonical proxy (stable identity, no proxy-of-proxy).
  if (value && typeof value === 'object' && value[REACTIVE_RAW]) {
    value = value[REACTIVE_RAW];
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
      if (ok && prev !== t[k]) onMutate();
      return ok;
    },
    deleteProperty(t, k) {
      const had = k in t;
      const ok = Reflect.deleteProperty(t, k);
      if (ok && had) onMutate();
      return ok;
    },
  });
  cache.set(value, proxy);
  return proxy;
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
  // `$: doubled = count * 2;` — reactive statements.
  // Extracted here, re-run after every state change before patching.
  const reactiveStmts = [];
  code = code.replace(/(^|[\n;{}])(\s*)\$:\s*([^\n]+)/g, (_, before, space, stmt) => {
    reactiveStmts.push(stmt.trim().replace(/;\s*$/, ''));
    return `${before}${space}`;
  });

  const codeNoComments = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const raw = Object.create(null);

  // Seed every top-level declared identifier so the proxy `has` trap
  // claims it inside the with() block.
  const declRe = /(?:^|[\n;{}])\s*(?:let|const|var)\s+([a-zA-Z_$][\w$]*)/g;
  const funcRe =
    /(?:^|[\n;{}])\s*(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/g;
  let m;
  while ((m = declRe.exec(codeNoComments)) !== null) raw[m[1]] = undefined;
  while ((m = funcRe.exec(codeNoComments)) !== null) raw[m[1]] = undefined;
  // `$: x = …` implicitly declares x
  for (const stmt of reactiveStmts) {
    const t = stmt.match(/^([a-zA-Z_$][\w$]*)\s*=[^=]/);
    if (t) raw[t[1]] = undefined;
  }

  // Rewrite declarations to bare assignments so they hit the proxy.
  let rewritten = code.replace(
    /(^|[\n;{}])(\s*)(async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g,
    (_, before, space, async_ = '', name) =>
      `${before}${space}${name} = ${async_}function ${name}(`,
  );
  rewritten = rewritten.replace(
    /(^|[\n;{}])(\s*)(?:let|const|var)\s+([a-zA-Z_$][\w$]*)\s*=/g,
    (_, before, space, name) => `${before}${space}${name} =`,
  );
  // bare declarations without assignment: `let x;` → noop (already seeded)
  rewritten = rewritten.replace(
    /(^|[\n;{}])(\s*)(?:let|const|var)\s+([a-zA-Z_$][\w$]*)\s*(;|\n)/g,
    (_, before, space, _name, end) => `${before}${space}${end}`,
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

  // Per-component cache so each raw object/array maps to one stable
  // reactive proxy (identity-preserving, see reactify).
  const reactiveCache = new WeakMap();
  const onMutate = () => {
    if (ready && !inReactive) schedule();
  };

  const scope = new Proxy(raw, {
    has(target, key) {
      if (typeof key !== 'string') return false;
      if (Object.prototype.hasOwnProperty.call(builtins, key)) return true;
      // own-property check: stops window built-ins (name, status, length,
      // location…) from shadowing or escaping component state.
      return Object.prototype.hasOwnProperty.call(target, key);
    },
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (Object.prototype.hasOwnProperty.call(builtins, key)) return builtins[key];
      // Wrap plain objects/arrays so in-place mutation re-renders.
      return reactify(target[key], onMutate, reactiveCache);
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
      // Don't patch synchronously per assignment: a single handler often
      // makes several writes, and each `$:` statement is itself an
      // assignment. Coalesce them into ONE patch on the microtask queue.
      // (`inReactive` writes are already inside a flush — no need to
      // reschedule; the in-progress flush will patch once at the end.)
      if (ready && !inReactive) schedule();
      return true;
    },
  });

  scopeRef.scope = scope;
  componentEl.__sparkOnMount = mountCallbacks;
  componentEl.__sparkSchedule = schedule;

  // Re-run `$:` statements. Guarded so a reactive assignment doesn't
  // recurse into another full reactive pass; the patch after the outer
  // set sees the settled state.
  let inReactive = false;
  let ready = false; // don't run reactive stmts mid-initialization
  function runReactive() {
    if (!ready || inReactive || reactiveStmts.length === 0) return;
    inReactive = true;
    try {
      for (const stmt of reactiveStmts) {
        try {
          compileStmt(stmt)(scope);
        } catch (e) {
          // Runs on every state change — warn once per statement.
          warnOnce(`react:${stmt}`, `[spark] Error in reactive "$: ${stmt}" — ${e.message}`);
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
  // once, no matter how many writes happened this tick.
  let scheduled = false;
  function flush() {
    scheduled = false;
    if (!componentEl.isConnected) return;
    runReactive();
    patch(componentEl, scope);
    patchSlots();
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
      else if (!Object.prototype.hasOwnProperty.call(raw, key)) raw[key] = value;
    }
    runReactive();
    patch(componentEl, scope);
    patchSlots();
  } catch (e) {
    // A throw here means the whole <script> failed to run, so none of the
    // component's state/handlers exist — make that unmistakable.
    console.warn(
      `[spark] <script> in component "${componentEl.getAttribute('name')}" failed to run — ${e.message}. The component's state and handlers are unavailable.`,
    );
  }
  return scope;
}

// ─── DOM patching ──────────────────────────────────────────────────────
function patch(el, scope) {
  walkNode(el, scope, true);
  // Optional observation seam (used by the test suite to assert batching).
  // No-op in normal use — nothing sets this hook in the browser.
  if (typeof globalThis !== 'undefined' && globalThis.__sparkTestOnPatch) {
    globalThis.__sparkTestOnPatch(el);
  }
}

// Request a batched re-render of the component that owns `el`. Used after
// two-way binds: `bind:value="row.text"` is a member write, which mutates
// the object directly without tripping the scope proxy's set trap, so we
// have to ask the owning component to re-patch explicitly.
function scheduleRerender(el) {
  let n = el;
  while (n) {
    if (n.__sparkSchedule) return n.__sparkSchedule();
    n = n.parentNode;
  }
}

function walkNode(node, scope, isRoot = false) {
  if (node.nodeType === Node.TEXT_NODE) {
    patchText(node, scope);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  // Escape hatch: subtrees marked spark-ignore are never patched —
  // essential for documentation/code samples containing literal {braces}.
  if (node.hasAttribute('spark-ignore')) return;
  // Don't reach into a nested component's territory.
  if (!isRoot && node.hasAttribute('name')) return;

  if (node.hasAttribute('each')) {
    patchEach(node, scope);
    return;
  }

  // <template if="expr"> — conditional block. Content is inserted after
  // the template when truthy, removed when falsy. Unlike :hidden, the
  // nodes genuinely leave the DOM.
  if (node.hasAttribute('if')) {
    patchIf(node, scope);
    return;
  }

  patchElement(node, scope);

  for (const child of [...node.childNodes]) {
    // A child may have been detached during this loop; skip stragglers.
    if (child.parentNode !== node) continue;
    // Nodes rendered by a sibling each/if are "managed" by that block and
    // get walked with the correct loop/branch scope there. Walking them
    // here with the parent scope would evaluate loop bindings against the
    // wrong scope and blank out interpolations.
    if (child.__sparkManaged) continue;
    // Slot-projected content belongs to the parent component — patch it
    // with the parent's scope, not the component it now physically sits in.
    if (child.__sparkSlotHost && child.__sparkSlotHost.__sparkScope) {
      walkNode(child, child.__sparkSlotHost.__sparkScope);
      continue;
    }
    walkNode(child, scope);
  }
}

function patchText(node, scope) {
  if (node.__sparkTpl === undefined) {
    node.__sparkTpl = node.textContent || '';
  }
  if (!node.__sparkTpl.includes('{')) return;
  const next = interpolate(node.__sparkTpl, scope);
  if (node.textContent !== next) node.textContent = next;
}

// ─── <template if="expr"> conditional blocks ──────────────────────────
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
    });
  } else if (!show && isShown) {
    el.__sparkIfRendered.forEach((n) => {
      destroyComponent(n); // run cleanups for any nested components
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    el.__sparkIfRendered = [];
  } else if (show && isShown) {
    // keep contents fresh
    el.__sparkIfRendered.forEach((n) => {
      if (n.parentNode) walkNode(n, scope, false);
    });
  }
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

  arr.forEach((item, i) => {
    const loopScope = makeLoopScope(item, i);
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
      for (const n of block.nodes) walkNode(n, loopScope, false);
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
      }
      block = { key, nodes };
    }

    newBlocks.push(block);
    const last = block.nodes[block.nodes.length - 1];
    if (last) insertAfter = last;
  });

  // Anything left in oldByKey was dropped from the array — clean it up.
  for (const b of oldByKey.values()) {
    for (const n of b.nodes) {
      destroyComponent(n);
      if (n.parentNode) n.parentNode.removeChild(n);
    }
  }

  el.__sparkEachBlocks = newBlocks;
}

// ─── Attribute / event bindings ───────────────────────────────────────
function patchElement(el, scope) {
  // Listeners are attached ONCE but a node may be re-walked with a different
  // scope on every patch (loop clones are reused, not recreated). Stash the
  // current scope on the node so the long-lived listener always reads the
  // live one — never the scope captured at first render.
  el.__sparkScopeRef = scope;
  for (const attr of [...el.attributes]) {
    const { name, value } = attr;

    // bind:value="draft" / bind:checked="done" — two-way binding.
    // Reading: every patch pushes the scope value into the element.
    // Writing: input/change events push the element value into the scope.
    if (name === 'bind:value' || name === 'bind:checked') {
      const prop = name.slice(5); // 'value' | 'checked'
      const expr = value.trim();
      if (!el.__sparkBound) el.__sparkBound = new Set();
      if (!el.__sparkBound.has(name)) {
        el.__sparkBound.add(name);
        const eventName = prop === 'checked' ? 'change' : 'input';
        el.addEventListener(eventName, () => {
          // Simple identifiers and member paths both work:
          // bind:value="draft" / bind:value="form.email" / bind:value="row.text"
          execute(`${expr} = __val__`, el.__sparkScopeRef, null, el[prop]);
          // Member writes don't trip the scope proxy, so re-render explicitly.
          scheduleRerender(el);
        });
      }
      const current = evaluate(expr, scope);
      if (prop === 'checked') {
        const want = Boolean(current);
        if (el.checked !== want) el.checked = want;
      } else {
        const want = current == null ? '' : String(current);
        if (el.value !== want) el.value = want;
      }
      continue;
    }

    // onclick={handler}
    if (
      /^on\w+$/.test(name) &&
      value.startsWith('{') &&
      value.endsWith('}')
    ) {
      if (!el.__sparkEvents) el.__sparkEvents = new Set();
      if (!el.__sparkEvents.has(name)) {
        el.__sparkEvents.add(name);
        const fnExpr = value.slice(1, -1).trim();
        el.addEventListener(name.slice(2), (e) => {
          execute(`${fnExpr}(event)`, el.__sparkScopeRef, e);
        });
        el.removeAttribute(name);
      }
      continue;
    }

    // :disabled="count >= 10"
    if (name.startsWith(':')) {
      const realAttr = name.slice(1);
      let result;
      try {
        result = compileExpr(value)(scope);
      } catch (e) {
        // Evaluation failed — leave the attribute untouched (event handlers
        // may still need to read it) but tell the consumer once.
        warnOnce(
          `attr:${name}=${value}`,
          `[spark] Error in :${realAttr}="${value}" — ${e.message}. (Attribute left unchanged.)`,
        );
        continue;
      }
      if (typeof result === 'boolean') {
        result
          ? el.setAttribute(realAttr, '')
          : el.removeAttribute(realAttr);
      } else {
        const str = String(result ?? '');
        if (el.getAttribute(realAttr) !== str)
          el.setAttribute(realAttr, str);
      }
      continue;
    }

    // value="{input}" interpolation in attributes.
    // Interpolated attribute: value="{draft}". The template is cached on
    // first sight — the guard must check the CACHE, not the live value,
    // because after the first interpolation the live value has no braces
    // and the binding would go dead (the "input never clears" bug).
    const tpl =
      attr.__sparkTpl !== undefined
        ? attr.__sparkTpl
        : value.includes('{')
          ? value
          : undefined;
    if (tpl !== undefined) {
      attr.__sparkTpl = tpl;
      const next = interpolate(tpl, scope);
      if (attr.value !== next) el.setAttribute(name, next);
      // The value PROPERTY diverges from the attribute once the user has
      // typed — sync it independently so programmatic clears reach the UI.
      if (name === 'value' && 'value' in el && el.value !== next) {
        el.value = next;
      }
    }
  }
}

// ─── Component boot ───────────────────────────────────────────────────
function bootComponent(el) {
  if (el.__sparkBooted) return;
  el.__sparkBooted = true;

  const tag = el.getAttribute('name');

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

  requestAnimationFrame(() => {
    patch(el, el.__sparkScope);
    // onMount fires once, after the first paint-ready patch.
    (el.__sparkOnMount || []).forEach((fn) => {
      try {
        const cleanup = fn();
        if (typeof cleanup === 'function') {
          (el.__sparkOnDestroy ||= []).push(cleanup);
        }
      } catch (e) {
        console.warn('[spark] onMount error:', e.message);
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
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
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

// Prefix bare selectors with [name="comp"] for automatic scoping.
// `:global(...)` escapes scoping.
function scopeCss(css, tag) {
  return css.replace(
    /(^|\})\s*([^{}@]+)\s*\{/g,
    (full, brace, selectorList) => {
      const scoped = selectorList
        .split(',')
        .map((sel) => {
          sel = sel.trim();
          if (!sel) return sel;
          const globalMatch = sel.match(/^:global\((.+)\)$/);
          if (globalMatch) return globalMatch[1];
          return `[name="${tag}"] ${sel}`;
        })
        .join(', ');
      return `${brace}\n${scoped} {`;
    },
  );
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
 *
 * Returns a promise that resolves when everything is booted.
 */
async function mount(root = document.body) {
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
    console.log(
      `[spark] ⚡ ready — ${root.querySelectorAll('[name]').length} component(s)`,
    );
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

export { mount, unmount, component, store, evaluate, interpolate, parseSFC };
export default { mount, unmount, component, store };
