/**
 * spark-html-devtools — in-page inspector panel for spark-html apps.
 */

export interface DevtoolsOptions {
  /** Start with the panel expanded (default false). */
  open?: boolean;
}

/**
 * Mount the devtools panel (a ⚡ button bottom-right). Shows live store state,
 * the component tree with each component's reactive state, a patch counter, and
 * flashes whichever component just re-rendered. Read-only. Returns a teardown
 * function. Intended for development — gate it behind `import.meta.env.DEV`.
 */
export function devtools(options?: DevtoolsOptions): () => void;

declare const _default: { devtools: typeof devtools };
export default _default;
