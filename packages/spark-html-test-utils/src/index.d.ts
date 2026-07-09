/** spark-html-test-utils — mount components on linkedom, no browser. */

export interface MountFixture {
  /** Markup placed in <body> — usually a `<div import="…">` host. */
  root: string;
  /** `{ name: source }` registered with component() before mount. */
  components?: Record<string, string>;
  /** The location the runtime sees (default `http://localhost/`). */
  url?: string;
}

export interface MountHandle {
  window: any;
  document: any;
  body: any;
  /** The first booted component host. */
  readonly el: any;
  query(sel: string): any | null;
  queryAll(sel: string): any[];
  /** The reactive scope proxy of `el` (or the given host) — read AND write it. */
  scope(el?: any): any;
  /** The tracked dependency keys of a node (Set or null). */
  deps(node: any): Set<string> | null;
  /** Current body HTML — the serialized render. */
  html(): string;
  /** Drain microtasks + rAF timers so reactive updates land before you assert. */
  settle(): Promise<void>;
  /** Tear down mounted components and restore globals. */
  cleanup(): void;
}

export function mount(fixture: string | MountFixture): Promise<MountHandle>;

export function fire(el: any, type: string, props?: Record<string, unknown>): Event;
export const fireClick: (el: any, props?: Record<string, unknown>) => Event;
export function fireInput(el: any, value: string): Event;
export function fireChange(el: any, value?: string): Event;
export function fireToggle(el: any, checked?: boolean): Event;
export function fireKey(el: any, key: string, props?: Record<string, unknown>): Event;
export function fireSubmit(el: any): Event;

export const inspect: { scope(el: any): any; deps(node: any): Set<string> | null };
export function component(name: string, source: string): void;
