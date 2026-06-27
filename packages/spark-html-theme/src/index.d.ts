/**
 * spark-html-theme — one-line dark/light/system theming for spark-html.
 */

/** The reactive `theme` store created by theme(). */
export interface ThemeStore {
  /** The user's choice: 'system' | 'light' | 'dark' (or a custom mode). */
  mode: string;
  /** What actually applies right now: 'light' | 'dark'. */
  resolved: string;
  /** Flip the visible theme (light↔dark) — always a visible change. Persists. */
  toggle(): void;
  /** Advance through `modes` (tri-state incl. 'system'); persists. */
  cycle(): void;
  /** Jump to a specific mode and persist. */
  set(mode: string): void;
}

export interface ThemeOptions {
  /** localStorage key for the saved mode (default 'theme-mode'). */
  key?: string;
  /** Attribute written on <html> with the resolved theme (default 'data-theme'). */
  attribute?: string;
  /** Cycle order for toggle() (default ['system','light','dark']). */
  modes?: string[];
  /** Store name (default 'theme'). */
  name?: string;
}

/**
 * Set up theming: create a reactive `theme` store, apply the resolved theme to
 * `<html data-theme>`, watch the OS preference, and persist the choice. Call
 * once during bootstrap. Returns the store proxy.
 */
export function theme(options?: ThemeOptions): ThemeStore;

/**
 * The inline no-flash snippet (a string) to drop into <head> so the correct
 * theme is set before first paint.
 */
export function themeInitScript(options?: { key?: string; attribute?: string }): string;

declare const _default: { theme: typeof theme; themeInitScript: typeof themeInitScript };
export default _default;
