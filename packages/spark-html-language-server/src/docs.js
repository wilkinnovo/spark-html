/**
 * Hover documentation + completion entries for Spark's template directives.
 * One source of truth: `DIRECTIVES` drives both features.
 *
 * `match` is what the cursor word/attribute must look like; entries with
 * `insert` differing from `label` use LSP insertText (e.g. snippets-lite).
 */

export const DIRECTIVES = [
  {
    label: 'import',
    match: /^import$/,
    detail: 'component placeholder',
    doc: 'Import a component: `<div import="components/card"></div>`. The path resolves against the importing file (`.html` optional). Extra attributes become props (`export let` in the target). Full URLs work too: `<div import="https://…/card.html">`.',
  },
  {
    label: 'each',
    match: /^each$/,
    detail: 'loop — <template each="item in items">',
    doc: 'Repeat the template content per array item: `<template each="todo in todos">`. With index: `each="todo, i in todos"`. Add `key="todo.id"` for keyed reconciliation (rows move instead of being rewritten).',
  },
  {
    label: 'key',
    match: /^key$/,
    detail: 'keyed reconciliation for each',
    doc: 'Stable identity per row: `<template each="row in rows" key="row.id">`. Evaluated per item; rows with the same key are reused in place when the array reorders.',
  },
  {
    label: 'if',
    match: /^if$/,
    detail: 'conditional — <template if="expr">',
    doc: 'Mount the content while the expression is truthy: `<template if="show">…</template>`. Real DOM is added/removed, not hidden. Chain `<template else-if>` / `<template else>` directly after.',
  },
  {
    label: 'else-if',
    match: /^else-if$/,
    detail: 'conditional chain branch',
    doc: 'A branch chained directly after `<template if>`: `<template else-if="score > 60">`. The first truthy branch in the chain renders.',
  },
  {
    label: 'else',
    match: /^else$/,
    detail: 'conditional fallback branch',
    doc: 'The fallback chained directly after `<template if>` / `<template else-if>`. Renders when no earlier branch matched.',
  },
  {
    label: 'await',
    match: /^await$/,
    detail: 'async block — <template await="promise">',
    doc: 'Declarative loading states: `<template await="loadUser(id)">` shows its content while pending, `<template then>` when resolved (value available as `{await}`), `<template catch>` on rejection (`{await.message}`). Re-evaluates when dependencies change; wrap in `once(…)` to fire only on mount.',
  },
  {
    label: 'then',
    match: /^then$/,
    detail: 'await resolved branch',
    doc: 'Inside `<template await>`: renders when the promise resolves. The resolved value is `{await}` — e.g. `{await.name}`.',
  },
  {
    label: 'catch',
    match: /^catch$/,
    detail: 'await rejected branch',
    doc: 'Inside `<template await>`: renders when the promise rejects. The error is `{await}` — e.g. `{await.message}`.',
  },
  {
    label: 'route',
    match: /^route$/,
    detail: 'spark-html-router — <template route="/path">',
    doc: 'A router outlet: `<template route="/docs">` mounts its content when the URL matches. Params: `route="/post/:id"` → `useStore(\'route\').params.id`; query via `route.query`; `route="*"` is the 404 catch-all. Requires `router()` from `spark-html-router`.',
  },
  {
    label: 'bind:value',
    match: /^bind:value$/,
    detail: 'two-way binding — inputs, selects, textareas',
    doc: 'Two-way binding: `<input bind:value="draft">` keeps the element and the variable in sync both ways.',
  },
  {
    label: 'bind:checked',
    match: /^bind:checked$/,
    detail: 'two-way binding — checkboxes',
    doc: 'Two-way binding for checkboxes: `<input type="checkbox" bind:checked="done">`.',
  },
  {
    label: 'bind:group',
    match: /^bind:group$/,
    detail: 'two-way binding — radio groups / checkbox arrays',
    doc: 'Bind a set of inputs to one variable: radios write the selected value, checkbox groups collect an array. `<input type="radio" bind:group="size" value="L">`.',
  },
  {
    label: 'bind:form',
    match: /^bind:form$/,
    detail: 'two-way binding — whole form as an object',
    doc: 'Bind an entire form to one object keyed by field names: `<form bind:form="signup">`.',
  },
  {
    label: 'transition',
    match: /^transition(:(fade|slide|scale))?$/,
    detail: 'spark-html-motion — enter/leave animation',
    doc: 'Animate elements as `if`/`each` blocks add or remove them: `transition="fade"` (or `slide`/`scale`; directive form `transition:fade` works too). Tune with `transition-duration="300"` (ms) and `transition-easing="ease-out"`. Requires `motion()` from `spark-html-motion`. Honors prefers-reduced-motion.',
  },
  {
    label: 'transition-duration',
    match: /^transition-duration$/,
    detail: 'spark-html-motion — duration in ms',
    doc: 'Duration of the enter/leave transition in milliseconds: `transition-duration="300"`.',
  },
  {
    label: 'transition-easing',
    match: /^transition-easing$/,
    detail: 'spark-html-motion — CSS easing',
    doc: 'Easing for the enter/leave transition: `transition-easing="ease-out"` (any CSS easing).',
  },
  {
    label: 'spark-ignore',
    match: /^spark-ignore$/,
    detail: 'escape hatch — subtree never patched',
    doc: 'Spark never touches this element or its children — no interpolation, no patching. For third-party widgets and code samples containing literal `{braces}`.',
  },
  {
    label: ':hidden',
    match: /^:[\w-]+$/,
    detail: 'dynamic attribute — :attr="expr"',
    doc: 'Any attribute prefixed with `:` is re-evaluated on every state change: `<button :disabled="count >= 10">`, `<div :class="active ? \'on\' : \'off\'">`, `<p :hidden="!open">`. Boolean results toggle the attribute; other values are set as strings.',
  },
  // ── spark-ssr — full-stack SSR: the template infers the backend ──────────
  {
    label: 'spark-ssr',
    match: /^spark-ssr$/,
    detail: 'spark-ssr — page data / config element',
    doc: 'Declares this page\'s data and backend config; stripped from rendered output. Self-closing (`<spark-ssr table="todos" live />`) or a block of named sources: `<spark-ssr>\n  posts = SELECT * FROM posts\n</spark-ssr>`. Sources can be SQL, a URL, a file glob, or a JS module — same block, more worlds.',
  },
  {
    label: 'table',
    match: /^table$/,
    detail: 'spark-ssr — <spark-ssr table="name" />',
    doc: 'Backs this page with a table, inferred entirely from the template: `<spark-ssr table="todos" live />`. Columns come from `{todo.title}` interpolations, `bind:checked`, `type="number"` inputs, etc. `bun spark-ssr db push` applies the inferred schema; auto CRUD (`POST/PATCH/DELETE /api/<table>`) is wired from the handlers the template references.',
  },
  {
    label: 'live',
    match: /^live$/,
    detail: 'spark-ssr — realtime refresh across tabs',
    doc: 'Every write through the server pings `/__spark/live` (SSE) with the table name; every hydrated tab refetches through its own session, scoping intact. No socket code, no pub/sub.',
  },
  {
    label: 'seed',
    match: /^seed$/,
    detail: 'spark-ssr — seed data for a table',
    doc: 'Seed rows applied once, idempotently, only into an empty table: `<spark-ssr table="todos" seed="./seed/todos.json" live />`. Also sharpens inferred column types; auth-table passwords hash on the way in.',
  },
  {
    label: 'limit',
    match: /^limit$/,
    detail: 'spark-ssr — page size for a table list',
    doc: 'Rows per page for a table-backed list: `<spark-ssr table="recipes" limit="20" search="title,ingredients" />`. `?page=2` walks pages; `{recipes.total}` / `{recipes.pages}` become available.',
  },
  {
    label: 'search',
    match: /^search$/,
    detail: 'spark-ssr — ?q= full-text columns',
    doc: 'Columns searched by `?q=…` (`LIKE`) on a table-backed list: `search="title,ingredients"`.',
  },
  {
    label: 'cache',
    match: /^cache$/,
    detail: 'spark-ssr — per-source TTL (seconds)',
    doc: 'Caches this source for N seconds: `cache="60"`. Invalidated automatically when a table it reads from changes — a bounded LRU indexed by table, not a blunt timer.',
  },
  {
    label: 'guard',
    match: /^guard$/,
    detail: 'spark-ssr — access-control expression',
    doc: 'When this expression is falsy, the request is denied: `<spark-ssr guard="session" redirect="/login" />`. Default response is 403 (override with `status=`); with `auth` configured, a bare `guard="session"` defaults to redirecting to `/login`. `guard="session.is_admin"` reads scoped tables unscoped.',
  },
  {
    label: 'redirect',
    match: /^redirect$/,
    detail: 'spark-ssr — 303 target',
    doc: 'On `<spark-ssr guard>`: where a failed guard sends the browser. On a `<form>`: where a successful post 303s to (default: the referrer) — `<form action="/api/posts" method="post" redirect="/admin">`.',
  },
  {
    label: 'status',
    match: /^status$/,
    detail: 'spark-ssr — response status for a branch',
    doc: 'Sets the response status when this branch renders: `<template else status="404"><h1>Not found</h1></template>` — crawlers stop indexing a 200-that-means-404. Also valid on `<spark-ssr guard>` (e.g. `status="401"`).',
  },
  {
    label: 'flash',
    match: /^flash$/,
    detail: 'spark-ssr — one-shot message on redirect',
    doc: 'Sets a flash message that survives the post/redirect: `<form … flash="Saved">`. Read it with the ambient `{flash}` or the default `<spark-flash>` toast.',
  },
  {
    label: 'job',
    match: /^job$/,
    detail: 'spark-ssr — background job',
    doc: 'Runs `jobs/<name>.js` (default export `(req, db) => …`): `<spark-ssr job="digest" every="1d" />` (scheduled) or `<spark-ssr job="onOrder" on="insert:orders" />` (after a matching write, row on `req.row`).',
  },
  {
    label: 'every',
    match: /^every$/,
    detail: 'spark-ssr — job schedule',
    doc: 'Schedule for a `job=`: `every="1d"` (`ms`/`s`/`m`/`h`/`d` units).',
  },
  {
    label: 'on',
    match: /^on$/,
    detail: 'spark-ssr — job write trigger',
    doc: 'Fires a `job=` after a matching write: `on="insert:orders"` (or `update:`/`delete:`/`*:`), with the affected row on `req.row`.',
  },
  {
    label: 'auto',
    match: /^auto$/,
    detail: 'spark-ssr — narrow synthesized handlers',
    doc: 'Limits which handlers get synthesized for a table-backed interactive page: `<spark-ssr auto="create,remove">`. `auto="none"` keeps only the ambient helpers (`api_create`, …) and synthesizes nothing.',
  },
  {
    label: 'spark-pager',
    match: /^spark-pager$/,
    detail: 'spark-ssr — no-JS pagination control',
    doc: 'A drop-in `?page=` control over a table-backed list: `<spark-pager for="posts"/>`.',
  },
  {
    label: 'spark-search',
    match: /^spark-search$/,
    detail: 'spark-ssr — no-JS search control',
    doc: 'A drop-in `?q=` search box over a table-backed list\'s `search=` columns: `<spark-search for="posts"/>`.',
  },
  {
    label: 'spark-flash',
    match: /^spark-flash$/,
    detail: 'spark-ssr — default flash-message toast',
    doc: 'Renders the current ambient `{flash}` message as a styled toast, if one is set. Drop it anywhere in a layout or page — empty (and inert) when there\'s no message.',
  },
];

// Script-side builtins (hover inside <script>).
export const SCRIPT_BUILTINS = {
  useStore: 'Subscribe this component to a named store and return its reactive proxy: `const cart = useStore(\'cart\')`. The store must be created with `store(name, initial)` before `mount()`.',
  onMount: 'Run a callback after the component is mounted and painted: `onMount(() => { …; return () => cleanup(); })`. The returned function runs when the component is destroyed.',
  props: 'The raw props object passed from the import placeholder\'s attributes. Prefer `export let name = default` for individual declared props.',
  '$:': 'Reactive statement: `$: doubled = count * 2` re-runs whenever any variable it reads changes, before the DOM patch. The assigned variable is implicitly declared.',
};

// spark-ssr ambient identifiers (hover inside <script> or a template's
// {…}) — only surfaced for files with a <spark-ssr> tag (see analyze.js's
// SSR_AMBIENT_GLOBALS, which drives which of these are never "undefined").
export const SSR_BUILTINS = {
  session: 'The logged-in user\'s session (or `null`), ambient on every page — set once `auth` is configured in spark.json.',
  path: 'The current request path, ambient on every page.',
  flash: 'The one-shot message set by a form\'s `flash="…"`, ambient on every page for one render.',
  errors: 'Per-field validation errors after a failed form post: `{errors.title}`. Comes from the form\'s constraint attributes (`required`, `maxlength`, …) re-validated server-side.',
  values: 'The submitted field values after a failed form post, for re-filling inputs: `{values.title}`.',
  api_create: 'POST to the page\'s table: `await api_create({ title })` → the created row. Pass the table name first when a page declares more than one: `api_create(\'posts\', {…})`.',
  api_update: 'PATCH a row by id: `await api_update(id, { done: true })` (or `api_update(\'posts\', id, {…})` with multiple tables).',
  api_delete: 'DELETE a row by id: `await api_delete(id)` (or `api_delete(\'posts\', id)` with multiple tables).',
  refresh: 'Re-runs every source on the page (table, SQL, URL, glob, module) and reassigns its vars: `await refresh()`.',
};

export function directiveDoc(word) {
  for (const d of DIRECTIVES) if (d.match.test(word)) return d;
  return null;
}

// Completion list for attribute position (label, detail, doc).
export function directiveCompletions() {
  const items = DIRECTIVES.filter((d) => d.label !== ':hidden').map((d) => ({
    label: d.label,
    detail: d.detail,
    documentation: d.doc,
  }));
  for (const attr of [':hidden', ':disabled', ':class', ':style']) {
    items.push({
      label: attr,
      detail: 'dynamic attribute — re-evaluated on every state change',
      documentation: DIRECTIVES.find((d) => d.label === ':hidden').doc,
    });
  }
  for (const t of ['transition:fade', 'transition:slide', 'transition:scale']) {
    items.push({
      label: t,
      detail: 'spark-html-motion — enter/leave animation',
      documentation: DIRECTIVES.find((d) => d.label === 'transition').doc,
    });
  }
  return items;
}
