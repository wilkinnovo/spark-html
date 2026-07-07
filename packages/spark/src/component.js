/**
 * Component lifecycle — makeScope (the reactive scope proxy + flush scheduler)
 * + bootComponent + destroyComponent + isSparkComponent + reveal.
 *
 * The riskiest single module of the M3.1 split: makeScope contains the
 * component scope proxy whose `get`/`set` traps are the heart of the
 * reactivity core. Its `get` populates the imported `capture.set` /
 * `capture.sink` (the binding currently being evaluated); its `set`
 * reassigns-and-extends the live `capture.dirtyKeys` so a write during a
 * dirty-mode flush marks itself dirty in the same pass; its `flush` writes
 * `capture.dirtyMode` / `capture.dirtyKeys` / `capture.dirtyItems` around
 * the patch walk. Three shipped bugs in one week (0.27.12-14) came from
 * small edits precisely here — confidence is the warning sign, the fuzzer
 * is the safety net. This file moves verbatim; no behavior change.
 *
 * Imports from ./index.js are circular and safe: function declarations
 * are hoisted in ESM's instantiate phase, only ever CALLED at runtime
 * well after every module has loaded. `capture` is a const object whose
 * PROPERTIES mutate freely across the module boundary — the bag refactor
 * (the prior commit before this split window started) is what made this
 * module possible.
 *
 * isPrerender stays as a local one-liner (cheaper than exporting it
 * across the circular boundary, keeps it off the de-facto public export
 * line — same pattern as reactivity.js and directives.js).
 *
 * Public surface: NONE (bootComponent is internal-but-exported, consumed
 * by index.js's import-resolution + mount + hydration paths; isSparkComponent
 * by walkNode; reveal by walkNode + bootComponent; destroyComponent by
 * index.js's unmount path AND by directives.js — imported directly from
 * here, not via index.js, to avoid a re-export layer). M4.1 freeze review
 * will bucket each as a sibling-only internal, the same status as `__spark*`.
 *
 * makeScope is MODULE-LOCAL: only bootComponent calls it (the script-less
 * component fast-path in bootComponent builds its own scope proxy inline,
 * not via makeScope). No external consumer — keep it private.
 */
import { analyzeScript, compileScript, makeImporter } from './script.js';
import { compileStmt, runExpr } from './expr.js';
import {
  subscribeStore, reactify, REACTIVE_RAW, REACTIVE_STORE, setsIntersect,
} from './reactivity.js';
import { scopeCss } from './css.js';
import {
  capture, withCapture, shouldEval,
  patch, walkNode, reportError, pushPrerenderWait,
  closestComponent,
  buildProps,
  ELEMENT_NODE,
} from './index.js';

// Local one-liner copy of index.js's isPrerender — duplicating a trivial
// pure global read is cheaper than exporting it across the circular
// boundary, and keeps isPrerender off the (de-facto public) export line.
const isPrerender = () => globalThis.__SPARK_PRERENDER__;

// ─── FOUC reveal ──────────────────────────────────────────────────────
// Companion to index.js's injectCloak() — that one runs at module load and
// hides Spark-managed subtrees until they're ready; this one un-hides a
// single element after it's been booted, styled, and patched (or after a
// boot throw, so failure isn't invisible). Tagged via `data-spark-ready`
// (which the cloak rule's :not() matches), and the cloak attribute removed
// for hosts tagged manually with `data-spark-cloak`.
export function reveal(el) {
  if (el && el.setAttribute) {
    el.setAttribute('data-spark-ready', '');
    el.removeAttribute('data-spark-cloak');
  }
}

// ─── Reactive scope ────────────────────────────────────────────────────
function makeScope(rawCode, componentEl, props = {}) {
  const { rewritten, seedNames, propNames, reactiveStmts, hasImports } =
    analyzeScript(rawCode);

  const raw = Object.create(null);
  for (const n of seedNames) raw[n] = undefined;
  // Each `$:` statement becomes an effect carrying its compiled function and
  // the keys it reads (stamped on `__sparkReadKeys` by withCapture, like a
  // DOM binding), so a dirty-mode flush re-runs only the statements whose
  // inputs changed — with no compile-cache lookup per run.
  const reactiveEffects = reactiveStmts.map((src) => ({ src, fn: compileStmt(src) }));

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
        if (capture.set !== null) capture.set.add(key);
        if (capture.sink !== null) capture.sink.add(key);
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
        if (capture.dirtyKeys) capture.dirtyKeys.add(key);
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
  const runEffect = (eff) => {
    try {
      eff.fn(scope);
    } catch (e) {
      // Runs on every state change — report once per statement.
      reportError(e, {
        phase: 'reactive', component: componentEl.getAttribute('name'), detail: '$: ' + eff.src,
      });
    }
  };
  function runReactive() {
    if (!ready || inReactive || reactiveEffects.length === 0) return;
    inReactive = true;
    try {
      if (!capture.dirtyMode) {
        // Full pass: run every `$:` statement, (re)recording its deps.
        for (const eff of reactiveEffects) withCapture(eff, runEffect, eff);
      } else {
        // Dirty pass: run only statements whose deps changed. A statement's
        // write extends capture.dirtyKeys (via the set trap), which can make a
        // later statement newly dirty — so iterate to a fixpoint. The pass
        // cap is the statement count (a linear `$:` chain settles in that
        // many passes); it also bounds any pathological cycle.
        let grew = true;
        let passes = 0;
        while (grew && passes++ <= reactiveEffects.length) {
          grew = false;
          for (const eff of reactiveEffects) {
            if (!shouldEval(eff)) continue;
            const before = capture.dirtyKeys.size;
            withCapture(eff, runEffect, eff);
            if (capture.dirtyKeys.size > before) grew = true;
          }
        }
        if (!isPrerender() && grew && passes > reactiveEffects.length) {
          const cycling = reactiveEffects.filter(eff => shouldEval(eff)).map(eff => eff.src);
          if (cycling.length) console.warn(`[spark] $: block(s) kept re-evaluating — possible cycle:`, cycling);
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
    // flush accumulate into a fresh set for the next round. An untouched
    // (empty) set is simply kept — no allocation on store-driven flushes.
    const keys = dirtyKeys.size ? dirtyKeys : null;
    if (keys) dirtyKeys = new Set();
    const items = dirtyItems.size ? dirtyItems : null;
    if (items) dirtyItems = new Set();
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
    capture.dirtyMode = !wasFull && !!keys && !items;
    capture.dirtyKeys = capture.dirtyMode ? keys : null;
    capture.dirtyItems = (!wasFull && items && !keys) ? items : null;
    try {
      runReactive();
      patch(componentEl, scope);
      patchSlots();
      // Reactive props (M2.1): push updates to child components whose
      // whole-value {expr} prop deps changed since the last flush.
      if (!isPrerender()) {
        for (const child of componentEl.childNodes) {
          if (child.nodeType !== ELEMENT_NODE || !child.__sparkNamed || !child.__sparkScope) continue;
          const rps = child.__sparkReactiveProps;
          if (!rps) continue;
          if (!rps) continue;
          for (const rp of rps) {
            if (!capture.dirtyMode || setsIntersect(rp.deps, capture.dirtyKeys)) {
              child.__sparkScope[rp.name] = runExpr(rp.fn, rp.code, scope);
            }
          }
        }
      }
    } catch (e) {
      reportError(e, { phase: 'update', component: componentEl.getAttribute('name') });
    } finally {
      capture.dirtyMode = false;
      capture.dirtyKeys = null;
      capture.dirtyItems = null;
    }
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  }

  // Shared post-script sequence: mark ready, apply props over `export let`
  // defaults, run `$:` once, render.
  const finish = () => {
    ready = true;
    componentEl.__sparkScopePending = false;
    for (const [key, value] of Object.entries(props)) {
      if (propNames.has(key)) raw[key] = value;
      else if (!Object.hasOwn(raw, key)) raw[key] = value;
    }
    runReactive();
    patch(componentEl, scope);
    patchSlots();
  };
  // A throw here means the whole <script> failed to run, so none of the
  // component's state/handlers exist — make that unmistakable.
  const reportScriptError = (e) => {
    componentEl.__sparkScopePending = false;
    reportError(e, {
      phase: 'script', component: componentEl.getAttribute('name'),
      detail: 'the <script> failed to run — state and handlers are unavailable',
    });
  };

  try {
    const fn = compileScript(rewritten, hasImports);
    if (hasImports) {
      // Imports make the script async. The scope proxy exists NOW (handlers
      // and useStore work the moment they're defined); the completion promise
      // is stashed so boot/mount/hydration can wait before revealing — no
      // flash of unimported state. Until it settles, the component's state is
      // still the seeded `undefined`s — flag that so a CHILD component's patch
      // doesn't evaluate slot content lent by this component too early.
      componentEl.__sparkScopePending = true;
      const p = fn(scope, makeImporter(componentEl)).then(finish).catch(reportScriptError);
      componentEl.__sparkScriptReady = p;
      // Prerender: the settle loop waits for the modules + post-import render.
      pushPrerenderWait(p);
    } else {
      fn(scope);
      finish();
    }
  } catch (e) {
    reportScriptError(e);
  }
  return scope;
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
export function isSparkComponent(el) {
  if (el.__sparkScope !== undefined) return true;       // already booted
  if (el.__sparkBooted) return true;                    // booting now
  if (el.__sparkImportPath !== undefined) return true;  // resolved import host
  if (el.__sparkScriptSrc !== undefined) return true;   // SFC source attached
  if (el.__sparkStyleSrc !== undefined) return true;
  if (el.__sparkNotComp) return false;                  // cached negative (form field)
  if (el.childNodes) {                                  // legacy inline component
    for (const c of el.childNodes) {
      if (c.nodeType === ELEMENT_NODE && (c.tagName === 'SCRIPT' || c.tagName === 'STYLE')) return true;
    }
  }
  // A form field's native name= never becomes a component; don't re-scan its
  // children on every patch. (A genuine component acquires one of the markers
  // above BEFORE it's ever walked, so caching the negative is safe.)
  el.__sparkNotComp = true;
  return false;
}

export function bootComponent(el) {
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
      // A script-less component is pure UI — but it needs a reactive scope
      // proxy so dep tracking captures its bindings (for dirty-mode gating)
      // and writes through __sparkSchedule trigger re-renders (M2.1).
      const raw = { ...el.__sparkProps };
      let scheduled = false;
      const trigger = () => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => { scheduled = false; patch(el, scope); });
      };
      const scope = new Proxy(raw, {
        get(target, key) {
          if (typeof key === 'string') {
            if (capture.set !== null) capture.set.add(key);
            if (capture.sink !== null) capture.sink.add(key);
          }
          return target[key];
        },
        set(target, key, value) {
          if (typeof key === 'symbol') { target[key] = value; return true; }
          target[key] = value;
          if (capture.dirtyKeys) capture.dirtyKeys.add(key);
          trigger();
          return true;
        },
      });
      el.__sparkScope = scope;
      el.__sparkSchedule = trigger;
      patch(el, scope);
    }
  } catch (e) {
    reportError(e, { phase: 'boot', component: tag });
    reveal(el); // don't strand a failed component cloaked/invisible
  }

  // Retry props that read the ENCLOSING component's own state (buildProps'
  // `__sparkPend`) — that ancestor is guaranteed booted by now
  // (querySelectorAll + forEach visits it first, in document order). Its
  // scope may still be filling in, though (an async `import` in its own
  // script) — wait for that, then re-patch: `el`'s own first patch above
  // may already have run against the not-yet-resolved value. Also wait for
  // `el`'s OWN scriptReady (if it has one) before that re-patch — otherwise
  // the retry can fire (and patch `el`) before `el`'s own async imports
  // have resolved, evaluating its template against an incomplete scope.
  if (el.__sparkPend) {
    const a = closestComponent(el);
    const retry = () => {
      if (!a || !a.__sparkScope) return;
      Object.assign(el.__sparkScope, buildProps(el.__sparkPend, a.__sparkScope, el));
      patch(el, el.__sparkScope);
    };
    const waits = [a && a.__sparkScriptReady, el.__sparkScriptReady].filter(Boolean);
    if (waits.length) Promise.all(waits).then(retry, retry);
    else retry();
  }

  const finishBoot = () => requestAnimationFrame(() => {
    try {
      patch(el, el.__sparkScope || {});
    } catch (e) {
      reportError(e, { phase: 'patch', component: tag });
    }
    // onMount fires once, after the first paint-ready patch. NOT during
    // prerender: there's no paint and no browser at build time — onMount is
    // live-only lifecycle (WebSockets, timers, measurements), so components
    // need no `typeof __SPARK_PRERENDER__` guard. Build-time data belongs in
    // load() / <template await>; the client runs onMount normally on mount.
    if (!isPrerender()) {
      (el.__sparkOnMount || []).forEach((fn) => {
        try {
          const cleanup = fn();
          if (typeof cleanup === 'function') {
            (el.__sparkOnDestroy ||= []).push(cleanup);
          } else if (cleanup && typeof cleanup.then === 'function') {
            // An async onMount: contain a rejection (it used to escape as an
            // unhandled promise rejection) and accept a resolved cleanup fn.
            cleanup.then(
              (c) => { if (typeof c === 'function') (el.__sparkOnDestroy ||= []).push(c); },
              (e) => reportError(e, { phase: 'onMount', component: tag }),
            );
          }
        } catch (e) {
          reportError(e, { phase: 'onMount', component: tag });
        }
      });
    }
    el.__sparkOnMount = [];
    reveal(el); // booted, styled and patched — safe to show (no FOUC)
  });
  // A script with JS imports finishes asynchronously — hold the first-paint
  // patch/onMount/reveal until its modules are in, so the component never
  // shows (or runs onMount against) half-initialized state.
  const scriptReady = el.__sparkScriptReady;
  if (scriptReady) scriptReady.then(finishBoot, finishBoot);
  else finishBoot();
}

// ─── Teardown ─────────────────────────────────────────────────────────
// Run every component's onMount-returned cleanups and drop its store
// subscriptions. Called when if/each removes a subtree, or directly via
// unmount(). Without this, cleanups never ran and store subscribers
// (which capture the whole component scope) leaked forever.
// ─── Teardown ─────────────────────────────────────────────────────────
// Run every component's onMount-returned cleanups and drop its store
// subscriptions. Called when if/each removes a subtree, or directly via
// unmount(). Without this, cleanups never ran and store subscribers
// (which capture the whole component scope) leaked forever.
export function destroyComponent(node) {
  if (!node || node.nodeType !== ELEMENT_NODE) return;
  const comps = [];
  if (node.hasAttribute && node.hasAttribute('name')) comps.push(node);
  if (node.querySelectorAll) comps.push(...node.querySelectorAll('[name]'));
  for (const c of comps) {
    // onMount cleanups first, then store unsubscribes — each throw contained.
    for (const fn of [...(c.__sparkOnDestroy || []), ...(c.__sparkStoreUnsubs || [])]) {
      try {
        fn();
      } catch (e) {
        console.warn('[spark] onDestroy error:', e.message);
      }
    }
    c.__sparkOnDestroy = [];
    c.__sparkStoreUnsubs = [];
  }
}

// ─── CSS scoping (split to src/css.js) ─────────────────────────────────
// scopeCss prefixes every selector with [name="comp"] so a component's
