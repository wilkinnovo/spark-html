/**
 * spark-html-image — build-time image optimization (spark-html-bun step).
 * Converts local raster <img> references in the built HTML (pages and
 * component fragments) to webp/avif variants with a responsive srcset.
 */

export interface SparkImageOptions {
  /** srcset widths, capped at each image's intrinsic width. Default [640, 960, 1280, 1920]. */
  widths?: number[];
  /** Output formats, in <source> order when picture=true. Default ['webp']. */
  formats?: Array<'webp' | 'avif'>;
  /** Encoder quality for every format. Default 80. */
  quality?: number;
  /** The sizes attribute written alongside srcset (when the img has none). Default '100vw'. */
  sizes?: string;
  /** Wrap in <picture> with one <source> per format instead of img srcset. Default false. */
  picture?: boolean;
  /** Add loading="lazy" + decoding="async" when absent. Default true. */
  lazy?: boolean;
}

/** spark-html-bun pipeline step: optimize <img> references in the build output. */
export default function sparkImage(options?: SparkImageOptions): {
  name: string;
  run(ctx: { outDir: string }): Promise<void>;
};
