/** A post-build pipeline step (what `spark-prerender/bun` etc. return). */
export interface PipelineStep {
  name: string;
  /** Build: rewrite/emit files in outDir. */
  run?(ctx: { outDir: string; base: string; projectRoot: string }): void | Promise<void>;
  /** Dev: extra routes to serve (e.g. /manifest.webmanifest, service workers). */
  devRoutes?(ctx: { config: SparkConfig }): Record<string, { type: string; body(): string | Promise<string> }>;
  /** Dev/build: transform a served HTML page. */
  transformHtml?(html: string, ctx: { dev: boolean }): string | Promise<string>;
}

export interface SparkConfig {
  /** Deploy prefix, e.g. '/repo/' on GitHub Pages. Default '/'. */
  base?: string;
  /** The HTML entry to bundle. Default 'index.html'. */
  entry?: string;
  /** Build output dir. Default 'dist'. */
  outDir?: string;
  /** Static dir copied verbatim into the build. Default 'public'. */
  publicDir?: string;
  /** Component fragment dir (gets no-cache dev headers + HMR). Default 'components'. */
  componentsDir?: string;
  /** Post-build steps, run in order over outDir. */
  pipeline?: PipelineStep[];
  /** Dev/preview port. */
  port?: number;
}

export interface RunOptions extends SparkConfig {
  /** Project root (defaults to cwd). */
  root?: string;
  quiet?: boolean;
}

/** Load spark.config.js from root and merge with defaults/overrides. */
export function loadConfig(root?: string, overrides?: RunOptions): Promise<Required<SparkConfig> & { projectRoot: string }>;

/** Start the dev server (static + import map + WebSocket component HMR). */
export function dev(overrides?: RunOptions): Promise<{ port: number; stop(): void }>;

/** Build: copy publicDir, Bun.build the entry, run the pipeline. */
export function build(overrides?: RunOptions): Promise<{ outDir: string }>;

/** Serve outDir with path→path.html→404.html fallbacks. */
export function preview(overrides?: RunOptions): Promise<{ port: number; stop(): void }>;

declare const _default: { dev: typeof dev; build: typeof build; preview: typeof preview; loadConfig: typeof loadConfig };
export default _default;
