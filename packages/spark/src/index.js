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
    host.innerHTML = markup; // markup contains no <script>/<style> now

    // stash extracted source on the element — bootComponent reads these
    host.__sparkScriptSrc = script;
    host.__sparkStyleSrc = style;

    projectSlots(host, slotted, parentHost); // <slot> content projection
    await resolveImports(host); // nested imports (incl. inside slots)
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
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

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
    // burst of store writes collapses into a single patch. Store changes
    // aren't tracked against component-scope keys, so force a full pass.
    if (componentEl.__sparkScheduleFull) componentEl.__sparkScheduleFull();
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
let gDirtyMode = false;    // is the current walk a targeted (dirty) pass?
let gDirtyKeys = null;     // keys changed this flush (gating set, live)

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

  // Keys changed since the last flush (drives targeted dirty-mode updates),
  // and a flag forcing a full re-evaluation when a change can't be pinned to
  // a key (deep mutation, store, member-path write). See the dep-tracking
  // section above.
  let dirtyKeys = new Set();
  let fullDirty = false;

  // Per-component cache so each raw object/array maps to one stable
  // reactive proxy (identity-preserving, see reactify).
  const reactiveCache = new WeakMap();
  // In-place mutation of a plain object/array can't be attributed to a single
  // top-level key, so it forces a full re-evaluation (never stale).
  const onMutate = () => {
    if (!ready) return;
    fullDirty = true;
    schedule();
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
      // Record this read for the binding currently being evaluated (Tier 2).
      if (captureSet !== null && typeof key === 'string') captureSet.add(key);
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
        // Runs on every state change — warn once per statement.
        warnOnce(`react:${eff.src}`, `[spark] Error in reactive "$: ${eff.src}" — ${e.message}`);
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
    const wasFull = fullDirty;
    fullDirty = false;
    if (!componentEl.isConnected) return;

    // Dirty mode only when the change set is fully attributable to keys.
    if (!wasFull && keys) {
      gDirtyMode = true;
      gDirtyKeys = keys;
      try {
        runReactive();
        patch(componentEl, scope);
        patchSlots();
      } finally {
        gDirtyMode = false;
        gDirtyKeys = null;
      }
    } else {
      runReactive();
      patch(componentEl, scope);
      patchSlots();
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
// have to ask the owning component to re-patch explicitly — and since it's
// not attributable to a key, force a full pass.
function scheduleRerender(el) {
  let n = el;
  while (n) {
    if (n.__sparkScheduleFull) return n.__sparkScheduleFull();
    n = n.parentNode;
  }
}

// Is a child node already known to be static — i.e. re-walking it can't
// change anything? Text without `{…}`, fully-static element subtrees, and
// comments qualify. An each/if anchor (never marked static) and any element
// with a live binding do not, so the parent keeps descending into them.
function isStaticNode(n) {
  if (n.nodeType === Node.TEXT_NODE) {
    return !(n.__sparkTpl && n.__sparkTpl.includes('{'));
  }
  if (n.nodeType !== Node.ELEMENT_NODE) return true;
  return n.__sparkStatic === true;
}

function walkNode(node, scope, isRoot = false) {
  if (node.nodeType === Node.TEXT_NODE) {
    patchText(node, scope);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

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
  // its own scheduler, so from here its whole subtree counts as static.
  if (!isRoot && node.hasAttribute('name')) {
    node.__sparkStatic = true;
    return;
  }

  // each/if anchors drive dynamic structure — never marked static, so the
  // parent always re-walks them (and they re-run their own reconciler).
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
    // Resolve any [import] placeholders cloned into the branch (async).
    hydrateBlockImports(el.__sparkIfRendered, scope);
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
    for (const n of b.nodes) {
      destroyComponent(n);
      if (n.parentNode) n.parentNode.removeChild(n);
    }
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
  for (const attr of [...el.attributes]) {
    const { name, value } = attr;

    // bind:value="draft" / bind:checked="done" — two-way binding.
    // Reading (per patch): push the scope value into the element.
    // Writing (once): input/change event pushes the element value back.
    if (name === 'bind:value' || name === 'bind:checked') {
      const prop = name.slice(5); // 'value' | 'checked'
      const expr = value.trim();
      const eventName = prop === 'checked' ? 'change' : 'input';
      el.addEventListener(eventName, () => {
        // Simple identifiers and member paths both work:
        // bind:value="draft" / bind:value="form.email" / bind:value="row.text"
        execute(`${expr} = __val__`, el.__sparkScopeRef, null, el[prop]);
        // Member writes don't trip the scope proxy, so re-render explicitly.
        scheduleRerender(el);
      });
      plan.push({ kind: 'bind', prop, expr });
      live = true;
      continue;
    }

    // onclick={handler} — attached once; no per-patch op.
    if (/^on\w+$/.test(name) && value.startsWith('{') && value.endsWith('}')) {
      const fnExpr = value.slice(1, -1).trim();
      el.addEventListener(name.slice(2), (e) => {
        execute(`${fnExpr}(event)`, el.__sparkScopeRef, e);
      });
      el.removeAttribute(name);
      live = true;
      continue;
    }

    // :disabled="count >= 10" — dynamic attribute, evaluated each patch.
    if (name.startsWith(':')) {
      plan.push({ kind: 'attr', name, realAttr: name.slice(1), expr: value });
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
      if (op.prop === 'checked') {
        const want = Boolean(current);
        if (el.checked !== want) el.checked = want;
      } else {
        const want = current == null ? '' : String(current);
        if (el.value !== want) el.value = want;
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
      if (typeof result === 'boolean') {
        result ? el.setAttribute(op.realAttr, '') : el.removeAttribute(op.realAttr);
      } else {
        const str = String(result ?? '');
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

export { mount, unmount, component, store, evaluate, interpolate, parseSFC, scopeCss };
export default { mount, unmount, component, store };
