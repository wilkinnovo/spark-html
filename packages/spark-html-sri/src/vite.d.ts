import type { SriAlgorithm } from './index.js';

export interface SriVitePluginOptions {
  /** Hash algorithm for assets and the manifest (default 'sha384'). */
  algorithm?: SriAlgorithm;
}

/**
 * Vite plugin: hashes every built JS/CSS/component fragment, stamps
 * integrity + crossorigin onto script/link tags, and bakes the manifest
 * into each page. Put it after prerender() in `plugins`.
 */
export default function sparkSri(options?: SriVitePluginOptions): {
  name: string;
  apply: 'build';
  configResolved(config: unknown): void;
  closeBundle: { order: 'post'; handler(): Promise<void> };
};
