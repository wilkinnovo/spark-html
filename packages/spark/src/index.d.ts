/**
 * ⚡ Spark — single-file HTML components, zero build step.
 *
 * Type definitions for the public module API (the functions you import in
 * your app's JS/TS — `import { mount, store } from 'spark-html'`).
 *
 * NOTE: these types cover the MODULE API only. They do not type the reactive
 * `let`/`$:`/`bind:value`/`useStore`/`onMount` you write inside a component's
 * `.html` `<script>` block — that lives in plain HTML, outside TS's view. For
 * the in-script builtins (`useStore`, `onMount`, `props`), see
 * `spark-html/globals`.
 */

/**
 * Mount Spark on a root element (default: `document.body`).
 *
 * Resolves all `[import]` placeholders, then boots every component. The
 * returned promise resolves once everything is booted.
 *
 * ```ts
 * import { mount } from 'spark-html';
 * await mount();            // whole document
 * await mount('#app');      // a subtree by selector
 * await mount(el);          // a subtree by element
 * ```
 */
export function mount(root?: string | Element): Promise<void>;

/**
 * Tear down a mounted subtree: runs `onMount` cleanups and unsubscribes its
 * components from any stores. Call before removing a component you mounted
 * imperatively, so timers/listeners/subscriptions don't leak.
 *
 * ```ts
 * unmount(el); el.remove();
 * ```
 */
export function unmount(el: Element): void;

/**
 * Register a component from a source string, without fetching a file. Useful
 * for tests and inline components. Then use it in HTML via
 * `<div import="name">`, or mount a node directly.
 *
 * ```ts
 * component('hello', `<h1>Hi {who}</h1><script>let who = 'you'<\/script>`);
 * ```
 */
export function component(name: string, source: string): void;

/**
 * Create (or get) a named, shared reactive store. Mutating a property on the
 * returned proxy re-renders every subscribing component. Calling `store` again
 * with the same name returns the existing instance (the second `initial` is
 * ignored).
 *
 * Create stores BEFORE calling {@link mount}.
 *
 * ```ts
 * const cart = store('cart', { items: [] as Item[] });
 * cart.items = [...cart.items, thing];   // every subscriber re-patches
 * ```
 */
export function store<T extends object>(name: string, initial?: T): T;

/**
 * Evaluate a single JS expression against a scope object. Returns `''` if the
 * expression throws or fails to compile (Spark renders broken expressions as
 * empty). Primarily an internal/advanced helper.
 */
export function evaluate(code: string, scope: Record<string, unknown>): unknown;

/**
 * Interpolate a template string, replacing each `{expr}` with its evaluated
 * value (`null`/`undefined` render as empty). Primarily an internal/advanced
 * helper.
 */
export function interpolate(
  template: string,
  scope: Record<string, unknown>,
): string;

/**
 * Split single-file component source into its `markup`, `script`, and `style`
 * parts at the text level (before any markup touches `innerHTML`).
 */
export function parseSFC(source: string): {
  markup: string;
  script: string;
  style: string;
};

/**
 * Scope a component's CSS by prefixing every selector with
 * `[name="<tag>"]`. Recurses into `@media`/`@supports`, leaves
 * `@keyframes`/`@font-face` bodies untouched, and unwraps `:global(...)`
 * anywhere in a selector. Primarily an internal/advanced helper.
 */
export function scopeCss(css: string, tag: string): string;

declare const _default: {
  mount: typeof mount;
  unmount: typeof unmount;
  component: typeof component;
  store: typeof store;
};
export default _default;
