/**
 * spark-ssr — zero-config SSR for spark-html on Bun.
 *
 * The HTML template infers everything: <template each="todo in todos"> means
 * you need `todos`; <spark-ssr table="todos"> backs it with a table and the
 * REST endpoints the handlers imply; a user_id column means auth scoping.
 * Filesystem routing, sessions, uploads, middleware — no build step.
 */
export { serve } from './server.js';
export { loadConfig } from './config.js';
export { connect } from './db.js';
export { extractBlocks, rewriteParams, analyze, dataPlan, singleShaped } from './parse.js';
export { renderFragment, evalExpr } from './render.js';
export { clientComponent, clientScript, initModule, handlerRoles, primaryColumn } from './hydrate.js';
