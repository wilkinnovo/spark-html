/**
 * spark-html-language-server — LSP for single-file Spark components.
 *
 * Most users never import this module: editors launch the
 * `spark-html-language-server` binary (LSP over stdio). The programmatic API
 * exists for tests and tooling that want the analyzer directly.
 */

export interface Declaration {
  kind: 'prop' | 'let' | 'function' | 'reactive' | 'import';
  offset: number;
}

export interface Diagnostic {
  start: number;
  end: number;
  /** LSP severity: 1 error, 2 warning, 3 info, 4 hint */
  severity: 1 | 2 | 3 | 4;
  message: string;
  code: string;
}

export interface Analysis {
  script: { start: number; end: number } | null;
  declarations: Map<string, Declaration>;
  props: { name: string; offset: number }[];
  imports: { spec: string; locals: { name: string; offset: number }[] }[];
  templateRefs: { name: string; offset: number; inHandler?: boolean }[];
  importTags: { path: string; valueStart: number; valueEnd: number; tagStart: number; tagEnd: number }[];
  diagnostics: Diagnostic[];
  /** True when the file has a `<spark-ssr>` tag — an SSR page (see spark-ssr). */
  isSSRPage: boolean;
  /** Page data spark-ssr infers from `table=` / named `<spark-ssr>` blocks (plus the singular form). */
  ssrVars: Set<string>;
}

/** Analyze a component source string (offsets are into that string). */
export function analyze(text: string): Analysis;

/** Ambient identifiers spark-ssr injects into an SSR page's scope (session, api_create, …). */
export const SSR_AMBIENT_GLOBALS: Set<string>;

/** The LSP server core — transport-agnostic; feed it decoded JSON-RPC messages. */
export class SparkLanguageServer {
  constructor(options: { send: (message: object) => void });
  handle(message: { id?: number | string; method: string; params?: any }): void;
}

/** Start the server on stdio with Content-Length framing (what the bin runs). */
export function connectStdio(): SparkLanguageServer;

export function offsetToPosition(text: string, offset: number): { line: number; character: number };
export function positionToOffset(text: string, pos: { line: number; character: number }): number;
