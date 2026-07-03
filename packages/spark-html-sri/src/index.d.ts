/** Remote origins allowed by default for URL-imported components. */
export const DEFAULT_ALLOW: string[];

export type SriAlgorithm = 'sha256' | 'sha384' | 'sha512';

/** Compute an SRI string — `integrity('hi')` → `"sha384-…"`. */
export function integrity(
  data: string | Uint8Array | ArrayBuffer,
  algo?: SriAlgorithm,
): Promise<string>;

/** Verify data against an SRI string (space-separated list allowed; any match passes). */
export function verify(
  data: string | Uint8Array | ArrayBuffer,
  integrityString: string,
): Promise<boolean>;

export interface SriOptions {
  /** path → SRI string. Default: the manifest the vite plugin baked into the page. */
  manifest?: Record<string, string>;
  /** Allowed remote hosts for URL imports (subdomains included). */
  allow?: string[];
  /** Block on failure. 'auto' (default) enforces everywhere except localhost. */
  enforce?: boolean | 'auto';
  /** Observe failures (fires whether or not the request was blocked). */
  onViolation?: (message: string, url: string) => void;
}

/**
 * Install the integrity guard around `fetch`. Call once from main.js,
 * before mount()/router(). Returns a function that restores the original fetch.
 */
export function sri(options?: SriOptions): () => void;

/** Forget every remembered remote-component hash (TOFU store). */
export function resetTofu(): void;

declare const _default: {
  sri: typeof sri;
  integrity: typeof integrity;
  verify: typeof verify;
  resetTofu: typeof resetTofu;
  DEFAULT_ALLOW: string[];
};
export default _default;
