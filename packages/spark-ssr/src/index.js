/**
 * spark-ssr — zero-config SSR for spark-html on Bun.
 *
 * The HTML template infers everything: <template each="todo in todos"> means
 * you need `todos`; <spark-ssr table="todos"> backs it with a table and the
 * REST endpoints the handlers imply; a user_id column means auth scoping;
 * the form constraints are the validation; the template is the schema.
 * Filesystem routing, layouts, sessions, uploads, middleware, live updates —
 * no build step.
 */
export { serve, scanPages, projectSchema } from './server.js';
export { loadConfig } from './config.js';
export { connect } from './db.js';
export {
  extractBlocks, rewriteParams, analyze, mergeAnalyses, dataPlan, singleShaped,
  extractForms, validateFields, sqlTables,
} from './parse.js';
export { renderFragment, evalExpr } from './render.js';
export { clientComponent, clientScript, initModule, handlerRoles, primaryColumn } from './hydrate.js';
export { urlSource, globSource, moduleSource, parseFrontMatter, makeSourceCache } from './sources.js';
export { inferSchema, diffSchema, pushSchema, seedTables } from './schema.js';
