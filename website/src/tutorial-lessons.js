/**
 * Tutorial lessons for /tutorials. This lives in the BUNDLED app JS (not in
 * the component) on purpose: component <script> blocks go through Spark's
 * declaration rewriter, which is not string-aware — lesson code kept inside a
 * component script would get its `let`/`function` declarations rewritten.
 * Here the strings ship untouched; the component reads them from the
 * `tutorial` store.
 *
 * `<\/script>` inside the template literals evaluates to `</script>` without
 * terminating any surrounding script context.
 */

export const TUTORIAL_LESSONS = [
  // ── Beginner ─────────────────────────────────────────────────────────
  {
    level: 'beginner',
    title: 'Hello, reactivity',
    text: 'A component is a plain .html file. Anything in curly braces is a live JavaScript expression over the variables declared in <script>. Change the variable, the DOM updates — no compiler, no virtual DOM.',
    task: 'change the name, then interpolate an expression like {name.length} or {name.toUpperCase()}.',
    code: `<h1>Hello {name}!</h1>
<p>Your name has {name.length} letters.</p>

<script>
  let name = 'World';
<\/script>`,
  },
  {
    level: 'beginner',
    title: 'Events',
    text: 'Event handlers are plain attributes: onclick={fn} calls a function from your <script>. Assigning to any state variable re-renders exactly what depends on it.',
    task: 'add a "−1" button that calls a new dec() function.',
    code: `<p>Count: <b>{count}</b></p>
<button onclick={inc}>+1</button>

<script>
  let count = 0;
  function inc() { count++; }
<\/script>`,
  },
  {
    level: 'beginner',
    title: 'Two-way binding',
    text: 'bind:value keeps an input and a variable in sync in both directions. There is also bind:checked for checkboxes, bind:group for radios, and bind:form for whole forms.',
    task: 'add <input type="checkbox" bind:checked="loud"> and shout the greeting when it is on.',
    code: `<input bind:value="who" placeholder="type here…" />
<p>Hi {who || 'stranger'}!</p>

<script>
  let who = '';
<\/script>`,
  },
  {
    level: 'beginner',
    title: 'Reactive statements ($:)',
    text: 'A statement starting with $: re-runs whenever any variable it reads changes — like a spreadsheet cell. The assigned variable is implicitly declared.',
    task: 'add a second derived value, e.g. $: emoji = total > 20 ? "🔥" : "🙂".',
    code: `<p>{price} × {qty} = <b>{total}</b></p>
<button onclick={more}>qty++</button>

<script>
  let price = 4;
  let qty = 2;
  $: total = price * qty;
  function more() { qty++; }
<\/script>`,
  },
  {
    level: 'beginner',
    title: 'Conditionals',
    text: '<template if="expr"> mounts real DOM while the expression is truthy — and removes it when it is not. Chain <template else-if> and <template else> directly after.',
    task: 'add an else-if branch for score > 40 that says "almost".',
    code: `<p>Score: {score}</p>
<button onclick={bump}>+25</button>

<template if="score >= 100"><p>🏆 perfect!</p></template>
<template else-if="score >= 50"><p>👍 passing</p></template>
<template else><p>keep going…</p></template>

<script>
  let score = 0;
  function bump() { score = (score + 25) % 125; }
<\/script>`,
  },
  {
    level: 'beginner',
    title: 'Loops (each)',
    text: 'Repeat markup per array item with <template each="item in items"> — with index: "item, i in items". Add key="item.id" when rows can reorder, so DOM moves instead of being rewritten.',
    task: 'add a key= to the loop, then make remove() delete from the middle.',
    code: `<input bind:value="draft" placeholder="add fruit…" />
<button onclick={add}>Add</button>
<ul>
  <template each="f, i in fruits">
    <li>{i + 1}. {f} <button onclick={remove} :data-i="i">✕</button></li>
  </template>
</ul>

<script>
  let fruits = ['apple', 'mango'];
  let draft = '';
  function add() {
    if (!draft.trim()) return;
    fruits = [...fruits, draft.trim()];
    draft = '';
  }
  function remove(e) {
    const i = Number(e.target.dataset.i);
    fruits = fruits.filter((_, idx) => idx !== i);
  }
<\/script>`,
  },

  // ── Intermediate ─────────────────────────────────────────────────────
  {
    level: 'intermediate',
    title: 'Async blocks (await)',
    text: '<template await="promise"> shows its content while pending, <template then> when resolved (the value is {await}), <template catch> on failure. It re-evaluates when its dependencies change.',
    task: 'raise ms to feel the loading state; then make load() reject to see the catch branch.',
    code: `<button onclick={again}>load (attempt {attempt})</button>

<template await="load(attempt)">
  <p>⏳ loading…</p>
  <template then><p>✔ {await.msg}</p></template>
  <template catch><p>✘ {await.message}</p></template>
</template>

<script>
  let attempt = 1;
  let ms = 700;
  function again() { attempt++; }
  function load(n) {
    return new Promise((res) =>
      setTimeout(() => res({ msg: 'answer #' + n + ' after ' + ms + 'ms' }), ms));
  }
<\/script>`,
  },
  {
    level: 'intermediate',
    title: 'Shared stores',
    text: 'store(name, initial) (created in your app JS) makes a named reactive store; any component subscribes with useStore(name) — no providers, no prop drilling. This lesson shares the SAME store as the Playground page: bump it here, then visit the Playground.',
    task: 'add a reset button that sets pg.sparks = 0.',
    code: `<p>shared sparks: <b>{pg.sparks}</b></p>
<button onclick="{pg.sparks++}">+1 (shared with the Playground page)</button>

<script>
  // created once in the app: store('playground', { sparks: 0 })
  const pg = useStore('playground');
<\/script>`,
  },
  {
    level: 'intermediate',
    title: 'Component imports & props',
    text: 'A component uses another with <div import="path-or-name">. Extra attributes become props — declared in the child with export let. This page pre-registers a "tut-badge" component so you can pass props to it.',
    task: 'change label/hue, add a third badge. tut-badge declares: export let label, export let hue.',
    code: `<p>Build your own badge row:</p>
<div import="tut-badge" label="reactive" hue="48"></div>
<div import="tut-badge" label="no build step" hue="150"></div>`,
  },
  {
    level: 'intermediate',
    title: 'Slots',
    text: 'Children of the import placeholder are projected into the child\'s <slot> outlets; name them to target <slot name="…">. This page pre-registers "tut-card", which has a "title" slot and a default slot.',
    task: 'swap the title slot content, then remove it to see the slot fallback ("Untitled").',
    code: `<div import="tut-card">
  <span slot="title">⚡ Slots</span>
  <p>This paragraph fills the card's default slot.</p>
</div>`,
  },
  {
    level: 'intermediate',
    title: 'Scoped styles',
    text: 'A component\'s <style> is automatically scoped to that component — selectors cannot leak out or in. Escape deliberately with :global(…).',
    task: 'restyle .msg, then try a bare "p { color: red }" — the page around the preview stays untouched.',
    code: `<p class="msg">I am scoped.</p>
<p>me too — but unstyled.</p>

<style>
  .msg {
    background: #ffd24a; color: #000;
    padding: 6px 12px; border-radius: 8px; font-weight: 700;
    display: inline-block;
  }
</style>`,
  },

  // ── Advanced ─────────────────────────────────────────────────────────
  {
    level: 'advanced',
    title: 'Motion (transitions)',
    text: 'spark-html-motion animates elements as if/each blocks add and remove them: transition="fade|slide|scale" on the element, tune with transition-duration (ms). One motion() call in your app JS switches it on — it is already on for this site.',
    task: 'switch slide to scale, then add transition-duration="600".',
    code: `<button onclick={flip}>{open ? 'hide' : 'show'}</button>

<template if="open">
  <p transition="slide" class="box">✨ I animate in and out.</p>
</template>

<script>
  let open = false;
  function flip() { open = !open; }
<\/script>

<style>
  .box { background: #ffd24a; color: #000; padding: 10px 14px;
         border-radius: 8px; display: inline-block; }
</style>`,
  },
  {
    level: 'advanced',
    title: 'Router (live route store)',
    text: 'spark-html-router mounts <template route="/path"> blocks and exposes a reactive "route" store — path, params (from "/post/:id"), and query. This preview reads the REAL route store of the site you are on right now.',
    task: 'click the buttons — they navigate with query strings and route.query updates live (you stay on /tutorials).',
    code: `<p>path: <b>{route.path}</b></p>
<p>query.step: <b>{route.query.step || '(none)'}</b></p>
<button onclick={one}>?step=one</button>
<button onclick={two}>?step=two</button>

<script>
  const route = useStore('route');
  const app = useStore('app');
  function one() { window.navigate(app.base + '/tutorials?step=one'); }
  function two() { window.navigate(app.base + '/tutorials?step=two'); }
<\/script>`,
  },
  {
    level: 'advanced',
    title: 'Query (fetch states)',
    text: 'spark-html-query wraps a fetcher in a store with loading / fetching / error / data — every state is just store state, no flags to hand-roll. This uses the site\'s "pg-fact" query (every 5th fetch fails on purpose).',
    task: 'click refetch until you hit the synthetic failure, then recover; try mutate() for an optimistic update.',
    code: `<p :hidden="!fact.loading">⏳ loading…</p>
<p :hidden="fact.loading">
  🎲 <b>{fact.data?.value}</b>
  <i :hidden="!fact.fetching">refetching…</i>
</p>
<p :hidden="!fact.error">✘ {fact.error?.message}</p>
<button onclick={fact.refetch}>refetch()</button>
<button onclick={optimistic}>mutate()</button>

<script>
  // created once in the app: query('pg-fact', fetcher)
  const fact = useStore('pg-fact');
  function optimistic() { fact.mutate({ value: 'optimistic!' }); }
<\/script>`,
  },
  {
    level: 'advanced',
    title: 'Persist (localStorage)',
    text: 'persist(name, initial) is a store that hydrates from localStorage on boot and saves on every change. This uses the site\'s "pg-prefs" store — type a note, reload the page, it is still there.',
    task: 'type a note, reload the browser tab, come back to this lesson.',
    code: `<p>demo visits: <b>{prefs.opens}</b></p>
<input bind:value="prefs.note" placeholder="type, then reload the page…" />
<p><i>saved on every keystroke — persist('pg-prefs', …)</i></p>

<script>
  // created once in the app: persist('pg-prefs', { opens: 0, note: '' })
  const prefs = useStore('pg-prefs');
<\/script>`,
  },
];

TUTORIAL_LESSONS.forEach((l, i) => { l.i = i; });
