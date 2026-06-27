/**
 * spark-prerender — build-time SEO prerender for spark-html.
 * Types for the programmatic API.
 */

/** Maps a component-scope variable onto a `<head>` tag. */
export interface MetaMapping {
  /** The component-scope variable to read (e.g. "pageTitle"). */
  var: string;
  /** Write `<title>` from this var. */
  kind?: 'title';
  /** Write `<meta name="…">` (e.g. "description"). */
  name?: string;
  /** Write `<meta property="…">` (e.g. "og:image"). */
  property?: string;
}

export interface PrerenderOptions {
  /** Base dir for resolving components. Defaults to the entry file's dir. */
  root?: string;
  /** Explicit dirs to resolve `import="components/x"` against. */
  componentRoots?: string[];
  /** Metadata mapping; defaults cover pageTitle/pageDescription/og*. */
  meta?: MetaMapping[];
  /** Settle-loop safety cap (default 100). */
  maxPasses?: number;
  /**
   * Fetch used for NON-component (data) requests a `load()` hook makes — point
   * it at fixtures or a local API. Defaults to the real global fetch.
   */
  fetch?: (url: string, init?: unknown) => Promise<unknown>;
  /**
   * Stub browser-only globals (matchMedia, localStorage, IntersectionObserver,
   * …) so components that touch them prerender instead of degrading.
   * Default: true.
   */
  stubBrowserGlobals?: boolean;
  /** Extra/override global stubs. */
  stubs?: Record<string, unknown>;
}

/**
 * Prerender a single entry HTML file to a fully-rendered HTML string:
 * interpolations resolved, `each`/`if` and nested imports rendered, scoped
 * styles inlined, and metadata injected into `<head>`. An async `load()`
 * declared in a component is awaited so its data lands in the HTML.
 */
export function prerender(entryPath: string, options?: PrerenderOptions): Promise<string>;

declare const _default: { prerender: typeof prerender };
export default _default;
