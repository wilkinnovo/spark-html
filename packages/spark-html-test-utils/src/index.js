/**
 * spark-html-test-utils — mount a component on linkedom, inspect its reactive
 * scope, and fire realistic DOM events, with no browser.
 *
 * This formalizes the harness every spark-html debugging session hand-rolls
 * (see packages/spark-ssr/test/ssr.js `mountHydratedPage`). For component-level
 * tests it's enough; hydration / real-DOM-lifecycle work still wants a real
 * browser (the CDP recipe in the repo workflows).
 *
 *   import { mount, fireClick, inspect } from 'spark-html-test-utils';
 *
 *   const h = await mount({
 *     root: '<div import="counter"></div>',
 *     components: { counter: '<button onclick={inc}>{n}</button><script>let n = 0; function inc(){ n++; }</script>' },
 *   });
 *   fireClick(h.query('button'));
 *   await h.settle();
 *   assert.equal(h.query('button').textContent, '1');
 *   h.cleanup();
 *
 * `mount` re-exports the core `inspect` API (M1.3) so `h.scope()` / `h.deps()`
 * read the same `__spark*` internals devtools does — a supported window, not a
 * private hack.
 */
import { parseHTML } from 'linkedom';
import { mount as sparkMount, unmount as sparkUnmount, component, inspect } from 'spark-html';

export { inspect, component };

// The globals the runtime reaches for that linkedom's `window` doesn't put on
// `globalThis`. rAF → setTimeout(0) matches the core test shim; reactivity
// itself flushes on microtasks, so `settle()` just drains both.
function installGlobals(window, document, url) {
  const u = new URL(url);
  const globals = {
    window, document, Node: window.Node,
    location: { pathname: u.pathname, search: u.search, href: u.href, hash: u.hash, origin: u.origin },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  const prev = {};
  for (const [k, v] of Object.entries(globals)) { prev[k] = globalThis[k]; globalThis[k] = v; }
  return prev;
}
function restoreGlobals(prev) {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete globalThis[k]; else globalThis[k] = v;
  }
}

/**
 * mount(fixture) → a handle.
 *
 * fixture is either a markup string (the document body) or
 * `{ root, components?, url? }`:
 *   - root       markup placed in <body> (usually a `<div import="…">` host)
 *   - components map of name → source, registered before mount (component())
 *   - url        the location the runtime sees (default http://localhost/)
 */
export async function mount(fixture) {
  const { root = '', components = {}, url = 'http://localhost/' } =
    typeof fixture === 'string' ? { root: fixture } : (fixture || {});

  for (const [name, src] of Object.entries(components)) component(name, src);

  const { window, document } = parseHTML(`<!doctype html><html><body>${root}</body></html>`);
  try { if (document.readyState === 'loading') document.readyState = 'complete'; } catch { /* fine */ }

  const prev = installGlobals(window, document, url);
  let cleaned = false;

  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

  try {
    await sparkMount(document.body);
    await settle();
  } catch (e) {
    restoreGlobals(prev);
    throw e;
  }

  const hosts = () => [...document.querySelectorAll('[name]')].filter((h) => h.__sparkScope);
  const firstHost = () => hosts()[0] || document.body.firstElementChild;

  return {
    window,
    document,
    body: document.body,
    /** The first booted component host (its `name` element). */
    get el() { return firstHost(); },
    query: (sel) => document.querySelector(sel),
    queryAll: (sel) => [...document.querySelectorAll(sel)],
    /** The reactive scope proxy of `el` (or the first host) — read AND write it. */
    scope: (el) => inspect.scope(el || firstHost()),
    /** The tracked dependency keys of a node (Set or null). */
    deps: (node) => inspect.deps(node),
    /** Current body HTML — the serialized render. */
    html: () => document.body.innerHTML,
    /** Drain microtasks + rAF timers so reactive updates land before you assert. */
    settle,
    /** Tear down mounted components (drop store subscriptions) and restore globals. */
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      for (const h of hosts()) { try { sparkUnmount(h); } catch { /* already gone */ } }
      restoreGlobals(prev);
    },
  };
}

// ── event helpers ───────────────────────────────────────────────────────────
// The runtime binds handlers with addEventListener, so a dispatched Event with
// the right type triggers them; extra props (clientX, key, …) ride on the event
// object the handler receives. linkedom's Event bubbles, so delegated handlers
// (document/window + closest()) fire too.
function makeEvent(el, type, props) {
  const view = (el && el.ownerDocument && el.ownerDocument.defaultView) || globalThis.window;
  const Ev = (view && view.Event) || globalThis.Event;
  let ev;
  try { ev = new Ev(type, { bubbles: true, cancelable: true }); }
  catch { ev = { type, bubbles: true, cancelable: true, preventDefault() {}, stopPropagation() {} }; }
  Object.assign(ev, props);
  return ev;
}

/** Fire any event `type` on `el` with optional extra props; returns the event. */
export function fire(el, type, props = {}) {
  const ev = makeEvent(el, type, props);
  el.dispatchEvent(ev);
  return ev;
}

export const fireClick = (el, props = {}) => fire(el, 'click', { button: 0, ...props });

/** Set `el.value` (if given) then fire `input` — the event `bind:value` listens for. */
export function fireInput(el, value) {
  if (value !== undefined) el.value = value;
  return fire(el, 'input');
}
export function fireChange(el, value) {
  if (value !== undefined) el.value = value;
  return fire(el, 'change');
}
/** Set a checkbox/radio `checked` (if given) then fire `change`. */
export function fireToggle(el, checked) {
  if (checked !== undefined) el.checked = checked;
  return fire(el, 'change');
}
export const fireKey = (el, key, props = {}) => fire(el, 'keydown', { key, ...props });
export const fireSubmit = (el, props = {}) => fire(el, 'submit', props);

/**
 * A realistic pointer drag: pointerdown → pointermove → pointerup, each paired
 * with the mouse equivalent (libraries listen for one or the other), carrying
 * clientX/clientY. `from`/`to` are `{x, y}`; `target` defaults to `el` but can
 * be a drop target for the move/up phase.
 */
export function fireDrag(el, { from = { x: 0, y: 0 }, to = { x: 0, y: 0 }, target = el } = {}) {
  const down = { clientX: from.x, clientY: from.y, button: 0, pointerId: 1, isPrimary: true };
  const move = { clientX: to.x, clientY: to.y, button: 0, pointerId: 1, isPrimary: true };
  fire(el, 'pointerdown', down);
  fire(el, 'mousedown', down);
  fire(target, 'pointermove', move);
  fire(target, 'mousemove', move);
  fire(target, 'pointerup', move);
  fire(target, 'mouseup', move);
}
