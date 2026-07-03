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
];

// Script-side builtins (hover inside <script>).
export const SCRIPT_BUILTINS = {
  useStore: 'Subscribe this component to a named store and return its reactive proxy: `const cart = useStore(\'cart\')`. The store must be created with `store(name, initial)` before `mount()`.',
  onMount: 'Run a callback after the component is mounted and painted: `onMount(() => { …; return () => cleanup(); })`. The returned function runs when the component is destroyed.',
  props: 'The raw props object passed from the import placeholder\'s attributes. Prefer `export let name = default` for individual declared props.',
  '$:': 'Reactive statement: `$: doubled = count * 2` re-runs whenever any variable it reads changes, before the DOM patch. The assigned variable is implicitly declared.',
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
