/**
 * spark-html-persist — persist a spark-html store across reloads.
 */

export interface PersistOptions {
  /** Storage key. Default: `spark:<name>`. */
  key?: string;
  /** A Storage to use. Default: `localStorage` (pass `sessionStorage` for per-tab). */
  storage?: Storage;
  /** Only persist these keys. */
  include?: string[];
  /** Persist everything except these keys. */
  exclude?: string[];
}

/**
 * Create (or get) a named store, hydrated from storage and saved on every
 * change. Equivalent to `store(name, initial)` plus persistence.
 *
 * ```ts
 * persist('settings', { theme: 'dark' });
 * // component: const s = useStore('settings'); s.theme = 'light'; // saved
 * ```
 */
export function persist<T extends object>(
  name: string,
  initial?: T,
  options?: PersistOptions,
): T;

declare const _default: { persist: typeof persist };
export default _default;
