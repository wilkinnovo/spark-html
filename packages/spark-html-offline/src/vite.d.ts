import type { OfflineVitePluginOptions } from './index.js';

/** Vite plugin: emits the service worker in build, serves it in dev. */
export default function sparkOffline(options?: OfflineVitePluginOptions): {
  name: string;
  configureServer(server: unknown): void;
  generateBundle(): void;
};
