/**
 * Reactivity — stores, derived stores, and deep reactive proxies.
 *
 * Two halves of the reactivity story live here:
 *
 *   • Named stores + derived stores — the cross-component shared state. A
 *     store is aProxy over a plain state object; mutations (including
 *     in-place `cart.items.push(x)`) notify every component that read it.
 *     A derived store recomputes from its sources and notifies its own
 *     subscribers only when a key actually changes.
 *   • Deep reactivity (reactify) — wraps plain objects/arrays read out of a
 *     component scope so `todos.push(x)`, `row.done = true` trigger the
 *     component's onMutate schedule without the user replacing the whole
 *     value. Map/Set are wrapped too (internal slots preserved); Dates,
 *     class instances, and DOM nodes pass straight through.
 *
 * What does NOT live here: the capture machinery — withCapture/withSink/
 * shouldEval and the mutable gDirty* globals. Those are written from four
 * sites in index.js (buildProps, the patch flush, patchAwait) and ESM import
 * bindings are read-only from the importer, so moving the `let` declarations
 * here would break those write sites. They stay in index.js until a later
 * split (directives.js) gives the patch flush itself a module — at which
 * point the capture globals move with it. The O(changed) dependency-tracking
 * Tier-2 comment block (in index.js) explains why.
 *
 * Imports `isPrerender` and `patch` from ./index.js — a circular import,
 * safe because these are function declarations (hoisted in ESM's
 * instantiate phase) only ever CALLED at runtime, well after all modules
 * have loaded. Same pattern as expr.js importing warnOnce/reportError.
 */
import { patch } from './index.js';

// Local one-liner copy of index.js's isPrerender — duplicating a trivial
// pure global read is cheaper than exporting a helper across the circular
// boundary, and keeps `isPrerender` off the (de-facto public) export line.
const isPrerender = () => globalThis.__SPARK_PRERENDER__;

// ─── Stores: shared reactive state across components ──────────────────
export const stores = new Map();           // name → { state, subscribers }

// Tag a store's state object with its kind ('store' | 'derived' | 'query') so
// tooling (spark-html-devtools) can label it. Non-enumerable → never shows up
// in JSON/state dumps. Global-registry symbol so sibling packages (the query
// package) can stamp their own kind without importing this module's symbol.
export const STORE_KIND = Symbol.for('spark.storeKind');
export function markStoreKind(state, kind) {
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
export function store(name, initial) {
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
// The store entry for `name`, creating an empty store when absent.
export function storeEntry(name) {
  if (!stores.has(name)) store(name, {});
  return stores.get(name);
}

export function subscribe(name, fn) {
  const entry = storeEntry(name);
  entry.subscribers.add(fn);
  return () => entry.subscribers.delete(fn);
}

// Subscribe a component element to a store; returns the store proxy.
// The subscriber is tracked on the element so destroyComponent() can remove
// it — otherwise the closure (and the whole component scope it captures)
// would live in the store's Set forever, leaking on every unmount.
export function subscribeStore(name, componentEl, scopeRef) {
  // During prerender the page's bootstrap (which calls store()) hasn't run,
  // so an absent store is EXPECTED — auto-create it silently. In the browser
  // it's a real mistake, so warn there.
  if (!stores.has(name) && !isPrerender()) {
    console.warn(`[spark] useStore("${name}") — store not created. Call store("${name}", initial) before mount().`);
  }
  const entry = storeEntry(name);
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
export function derived(name, deps, compute) {
  if (stores.has(name)) return stores.get(name).proxy;

  const sources = (Array.isArray(deps) ? deps : [deps]).map((d) => storeEntry(d));
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
export const REACTIVE_RAW = Symbol('spark.raw');
// Marks a store proxy so the component scope doesn't re-wrap it (which would
// bypass the store's own deep reactivity + subscriber notification).
export const REACTIVE_STORE = Symbol('spark.store');

export function isPlainContainer(v) {
  if (Array.isArray(v)) return true;
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  // A module namespace (`import * as ns`) is null-proto but sealed — wrapping
  // it would make writes throw and identity churn. Leave it raw.
  return v[Symbol.toStringTag] !== 'Module';
}

// Mutating methods that should trigger a re-render. One list serves both
// collections: Map has no .add and Set has no .set, so nothing misfires.
export const MUTATORS = new Set(['set', 'add', 'delete', 'clear']);

export function reactify(value, onMutate, cache) {
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
    const proxyC = new Proxy(value, {
      get(t, k) {
        if (k === REACTIVE_RAW) return t;
        const v = Reflect.get(t, k);
        if (typeof v !== 'function') return v;
        return function (...args) {
          const r = v.apply(t, args);
          if (MUTATORS.has(k)) onMutate();
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

// ─── Dependency tracking (Tier 2 helpers) ───────────────────────────────
// Pure helper used by shouldEval and the patch flush's dirty-mode gating.
// Lives here (with the reactivity primitives) rather than in the capture
// machinery because it carries no mutable state — it's just a set-intersection
// test the dirty-mode walker needs, and dirty mode is what makes the stores
// above affordable (a store notification triggers a full pass, but a plain
// scope write narrows to only the bindings whose deps intersect).
export function setsIntersect(a, b) {
  if (!a || !b) return false;
  if (a.size > b.size) { const t = a; a = b; b = t; }
  for (const x of a) if (b.has(x)) return true;
  return false;
}