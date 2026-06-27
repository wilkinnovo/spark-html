/**
 * spark-html-router — declarative <template route> client routing for spark-html.
 *
 * The router publishes the active route to a built-in reactive `route` store,
 * so any component can react to navigation without manual history wiring:
 *
 *   const route = useStore<RouteState>('route');
 *   $: active = route.path === '/about';
 */

/** Shape of the built-in `route` store the router maintains. */
export interface RouteState {
  /** The active, base-stripped, no-trailing-slash path (e.g. "/about"). */
  path: string;
}

export interface RouterOptions {
  /**
   * Path prefix the app is served under (e.g. "/spark" on GitHub Pages).
   * Stripped from the URL before matching; added back when navigating.
   */
  base?: string;
  /** Mount root (default: document.body). */
  root?: string | Element;
}

/**
 * Start the router: mount the page and show the `<template route>` that matches
 * the URL, intercept same-origin `<a>` clicks for SPA navigation, and track
 * Back/Forward. Call it once (it replaces `mount()`).
 */
export function router(options?: RouterOptions): Promise<void>;

/** Navigate to a route programmatically (route-relative; base is added). */
export function navigate(to: string): Promise<void> | void;

declare const _default: { router: typeof router; navigate: typeof navigate };
export default _default;
