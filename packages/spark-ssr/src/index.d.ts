/**
 * spark-ssr — zero-config SSR for spark-html on Bun.
 * Typed surface = what an app touches: serve() and its options. The
 * lower-level exports (renderFragment, inferSchema, …) are the server's own
 * plumbing, re-exported for tooling and tests — typed loosely on purpose.
 */

export interface ServeOptions {
  /** Project root (spark.json, pages/, public/). Default: cwd. */
  root?: string;
  /** Port; 0 picks a free one. Default 3000 (or config). */
  port?: number;
  /** Watch mode: dev reload + SSE + the fail-loud diagnostics layer.
   *  `false` = production (response cache + streaming, no dev channel). */
  watch?: boolean;
  /** Suppress logs (tests). */
  quiet?: boolean;
  /** API-only mode: declare the API in HTML, don't serve the HTML (pages return
   *  their bound data as JSON). Overrides spark.json `api`. */
  api?: boolean;
  /** Serve pages AND the JSON API (hybrid) on top of `api`. */
  html?: boolean;
  [key: string]: unknown;
}

export interface SparkServer {
  port: number;
  /** The live database handle (bun:sqlite or postgres). */
  db: any;
  stop(closeActiveConnections?: boolean): Promise<void> | void;
  [key: string]: any;
}

export function serve(options?: ServeOptions): Promise<SparkServer>;
export function loadConfig(root?: string): Promise<Record<string, any>>;
export function connect(config?: Record<string, any>): Promise<any>;

/** Render a page fragment against a scope — the opcode renderer. */
export function renderFragment(html: string, scope?: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<string>;
export function evalExpr(expr: string, scope?: Record<string, unknown>): unknown;

export function scanPages(root?: string): any[];
export function projectSchema(root?: string): any;
export function inferSchema(...args: any[]): any;
export function diffSchema(...args: any[]): any;
export function pushSchema(...args: any[]): any;
export function seedTables(...args: any[]): any;
export function clientComponent(...args: any[]): string;
export function clientScript(...args: any[]): string;
export function initModule(...args: any[]): string;
export function handlerRoles(...args: any[]): any;
export function primaryColumn(...args: any[]): string | null;
export function urlSource(...args: any[]): any;
export function globSource(...args: any[]): any;
export function moduleSource(...args: any[]): any;
export function parseFrontMatter(...args: any[]): any;
export function makeSourceCache(...args: any[]): any;
