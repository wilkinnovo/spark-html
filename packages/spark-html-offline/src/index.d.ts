/** Options shared by the worker generator and the build step. */
export interface OfflineSwOptions {
  /** Same-origin URL substrings to cache too (e.g. ['/components/']). */
  include?: string[];
  /** URL substrings the worker must never touch. */
  exclude?: string[];
  /** Override the cache bucket name (default 'spark-offline-v1'). */
  cacheName?: string;
}

export interface OfflineOptions {
  /** Worker URL, relative to the page base (default 'spark-sw.js'). */
  sw?: string;
  /** Registration scope (default: the worker's directory). */
  scope?: string;
}

/** Default cache bucket name. */
export const CACHE_NAME: string;

/** True when the worker should intercept this URL. */
export function shouldHandle(
  url: string,
  origin: string,
  config?: { include?: string[]; exclude?: string[] },
): boolean;

/** The full service-worker source as a string. */
export function swSource(options?: OfflineSwOptions): string;

/** Register the worker (no-op where service workers don't exist). */
export function offline(options?: OfflineOptions): Promise<ServiceWorkerRegistration | null>;

declare const _default: {
  offline: typeof offline;
  swSource: typeof swSource;
  shouldHandle: typeof shouldHandle;
  CACHE_NAME: string;
};
export default _default;

/** spark-html-bun build step: writes the worker in build, serves it in dev. */
export interface OfflineBuildOptions extends OfflineSwOptions {
  /** Written file name (default 'spark-sw.js'). */
  file?: string;
}
