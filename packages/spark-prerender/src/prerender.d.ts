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
  /**
   * Write the import path back onto top-level component hosts so a client
   * `mount()` re-renders over the prerendered DOM (no blank). Default: true.
   * Set false for pure-static output (no client takeover).
   */
  hydratable?: boolean;
  /**
   * Render a specific `<template route>` (spark-html-router). The matching
   * route's content is activated (with an adoptable `data-spark-route` marker)
   * before mount. Falls back to `route="*"` for unknown paths.
   */
  route?: string;
}

/** The concrete routes declared by `<template route>` in an HTML string (the catch-all `*` excluded). */
export function routesOf(html: string): string[];
/** Map a route to its static file: `/` → `index.html`, `/about` → `about.html`. */
export function routeToFile(route: string): string;
/** Netlify/Cloudflare `_redirects` body: clean-URL rewrites + an `index.html` SPA fallback. */
export function redirectsFor(routes: string[]): string;
/** `vercel.json` body with the equivalent rewrites. */
export function vercelConfigFor(routes: string[]): string;

/**
 * Prerender a single entry HTML file to a fully-rendered HTML string:
 * interpolations resolved, `each`/`if`/`await` and nested imports rendered,
 * scoped styles inlined, and metadata injected into `<head>`. An async
 * `load()` declared in a component — and any `<template await>` promise — is
 * awaited so its resolved data/`:then` content lands in the HTML.
 */
export function prerender(entryPath: string, options?: PrerenderOptions): Promise<string>;

declare const _default: { prerender: typeof prerender };
export default _default;
