export interface ManifestIcon {
  src: string;
  sizes?: string;
  type?: string;
  purpose?: string;
}

export interface ManifestConfig {
  /** App name (required). */
  name: string;
  /** Home-screen label (default: name). */
  shortName?: string;
  description?: string;
  /** Default '#ffffff'. */
  themeColor?: string;
  /** Default: themeColor. */
  backgroundColor?: string;
  /** Default 'standalone'. */
  display?: 'standalone' | 'browser' | 'minimal-ui' | 'fullscreen';
  /** Default '.'. */
  startUrl?: string;
  scope?: string;
  lang?: string;
  orientation?: string;
  /** Generated icon sizes in px (default [192, 512]). */
  sizes?: number[];
  /** Explicit icons array — skips generation entirely. */
  icons?: ManifestIcon[];
  /** Merged verbatim into the manifest (shortcuts, screenshots, …). */
  extra?: Record<string, unknown>;
}

export interface AppShellSwOptions {
  /** URLs to precache (default ['./', 'manifest.webmanifest']). */
  shell?: string[];
  /** Bump to invalidate old caches (default '1'). */
  version?: string;
  /** Emitted worker file name (default 'spark-manifest-sw.js'). */
  file?: string;
}

/** Default generated icon sizes. */
export const ICON_SIZES: number[];

/** File name for a generated icon: icons/<slug>-<size>.png */
export function iconPath(config: ManifestConfig, size: number): string;

/** Build the manifest object from one config. */
export function manifestJson(config: ManifestConfig): Record<string, unknown>;

/** The <head> block: manifest link + theme-color meta (+ registration when sw is set). */
export function manifestHtml(
  config: ManifestConfig,
  opts?: { href?: string; sw?: string },
): string;

/** Minimal offline app-shell service worker source. */
export function swSource(options?: AppShellSwOptions): string;

declare const _default: {
  manifestJson: typeof manifestJson;
  manifestHtml: typeof manifestHtml;
  swSource: typeof swSource;
  iconPath: typeof iconPath;
  ICON_SIZES: number[];
};
export default _default;
