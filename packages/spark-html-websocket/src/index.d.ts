/**
 * spark-html-websocket — declarative WebSocket as a reactive store.
 */

export type WsStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface WsStore<T = unknown> {
  /** The last (post-filter) message. Survives reconnects. */
  data: T | null;
  status: WsStatus;
  error: Error | null;
  /** Send a message; objects are JSON-stringified. Queued until open. */
  send(value: unknown): void;
  /** Deliberate close — never reconnects. */
  close(): void;
  /** Re-open after a close() (or after retries were exhausted). */
  open(): void;
}

export interface WsOptions {
  /** Store name (default derived from the URL: "ws:host/path"). */
  name?: string;
  /** Parse incoming messages as JSON when possible. Default true. */
  json?: boolean;
  /** Only messages passing this land in `data`. */
  filter?: (data: unknown, event: MessageEvent) => boolean;
  /** Runs for every (post-filter) message — write to any store you like. */
  onMessage?: (data: unknown, event: MessageEvent) => void;
  /** Backoff tuning ({ retries=Infinity, base=500, max=10000 } ms) or false to disable. */
  reconnect?: { retries?: number; base?: number; max?: number } | false;
  /** WebSocket subprotocols. */
  protocols?: string[];
}

/**
 * Open (or join) a reactive WebSocket store. Calling it again with the same
 * name returns the existing handle (shared connection). Inert (status
 * 'closed') during prerender or where WebSocket doesn't exist.
 */
export function ws<T = unknown>(url: string, options?: WsOptions): WsStore<T>;

/**
 * Declarative form: open a socket per inert `<template ws="wss://…">` block.
 * Attributes: `ws` (url), `store` (name), `raw` (skip JSON parsing),
 * `retries` / `backoff` / `backoff-max` (reconnect tuning, ms).
 */
export function sockets(root?: ParentNode): WsStore[];

declare const _default: { ws: typeof ws; sockets: typeof sockets };
export default _default;
