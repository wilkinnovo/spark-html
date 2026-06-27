/**
 * spark-prerender/vite — Vite plugin that prerenders `dist/*.html` on build.
 */
import type { PrerenderOptions } from './prerender.js';

export interface SparkPrerenderPluginOptions {
  /** HTML files in the out dir to prerender (default: ['index.html']). */
  pages?: string[];
  /** Options forwarded to prerender() (e.g. fetch, meta, stubs). */
  prerender?: PrerenderOptions;
}

/** A Vite plugin (loosely typed to avoid a hard `vite` dependency). */
export interface VitePluginLike {
  name: string;
  apply?: 'build' | 'serve';
  configResolved?: (config: any) => void;
  closeBundle?: () => Promise<void> | void;
}

export default function sparkPrerender(
  options?: SparkPrerenderPluginOptions,
): VitePluginLike;
