/**
 * spark-html-font — font loading optimizer. Zero deps.
 */

export interface FontMetrics {
  /** size-adjust, percent (e.g. 107.4). */
  sizeAdjust: number;
  /** ascent-override, percent. */
  ascent: number;
  /** descent-override, percent. */
  descent: number;
  /** line-gap-override, percent. Default 0. */
  lineGap?: number;
}

export interface FontFace {
  family: string;
  /** Self-hosted file(s) (woff2/woff/ttf/otf). Omit for Google fonts. */
  src?: string | string[];
  /** Google-hosted: emit preconnect + the css2 stylesheet URL instead of @font-face. */
  google?: boolean;
  /** e.g. 400, "700", or a variable range "100 900". */
  weight?: string | number;
  /** For Google fonts: the weights to request, e.g. [400, 700]. */
  weights?: Array<string | number>;
  style?: string;
  /** font-display strategy. Default "swap". */
  display?: string;
  /** Override the source format sniffed from the file extension. */
  format?: string;
  /** Fallback-face metrics; built-in approximations exist for popular families. */
  metrics?: FontMetrics;
  /** Disable the size-adjusted fallback face for this family. */
  adjust?: boolean;
  /** The local() font the fallback face adjusts. Default "Arial". */
  adjustFrom?: string;
  /** Disable the preload link for this font. */
  preload?: boolean;
}

export interface FontConfig {
  fonts?: FontFace[];
  /** Generic families appended to every --font-<slug> stack. Default ['system-ui', 'sans-serif']. */
  fallback?: string[];
  /** Disable all preload links. Default true (preload on). */
  preload?: boolean;
}

/** The full CSS block: @font-face rules, fallback faces, :root vars. */
export function fontCss(config?: FontConfig): string;

/** The <link> descriptors: preloads, Google preconnects + stylesheet. */
export function fontLinks(config?: FontConfig): Array<Record<string, string>>;

/** Links + style serialized as an HTML block (marked data-spark-font). */
export function fontHtml(config?: FontConfig): string;

/** Runtime: inject the tags into document.head now. Idempotent; returns stop(). */
export function fonts(config?: FontConfig): () => void;

declare const _default: {
  fonts: typeof fonts;
  fontCss: typeof fontCss;
  fontLinks: typeof fontLinks;
  fontHtml: typeof fontHtml;
};
export default _default;
