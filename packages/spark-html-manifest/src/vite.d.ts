import type { ManifestConfig, AppShellSwOptions } from './index.js';

export interface ManifestVitePluginOptions extends ManifestConfig {
  /** Source image — resized to every size in `sizes` (requires sharp). */
  icon?: string;
  /** Emitted manifest file name (default 'manifest.webmanifest'). */
  filename?: string;
  /** Emit + register the offline app-shell worker. */
  offline?: boolean | AppShellSwOptions;
}

/**
 * Vite plugin: manifest.webmanifest + resized icons + head tags +
 * (optionally) the app-shell service worker. Put it after prerender().
 */
export default function sparkManifest(options: ManifestVitePluginOptions): {
  name: string;
  configResolved(config: unknown): void;
  configureServer(server: unknown): void;
  transformIndexHtml(html: string): string;
  generateBundle(): Promise<void>;
  closeBundle: { order: 'post'; handler(): Promise<void> };
};
