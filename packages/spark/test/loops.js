/**
 * Tests for the reconciling each-loop, destroy lifecycle, store cleanup,
 * batching, and the FOUC cloak.
 */
import './dom-shim.js';
import { body, head, parseHTML } from './dom-shim.js';
import { strict as assert } from 'node:assert';

const { mount, unmount, component, store } = await import('../src/index.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 5));
function fire(el, type) {
  const e = { type, target: el };
  (document.__listeners?.[type] || []).forEach((fn) => fn(e)); // capture-phase delegates
  let n = el;
  while (n) { e.currentTarget = n; (n._listeners?.[type] || []).forEach((fn) => fn(e)); n = n.parentNode; }
}

// ── reconciling loop ──
component('looplist', `
<ul>
  <template each="item, i in items">
    <li><span class="label">{i}:{item}</span></li>
  </template>
</ul>
<button class="append" onclick="{append}">add</button>
<button class="dropfirst" onclick="{dropFirst}">drop</button>
<script>
  let items = ['a', 'b'];
  let n = 0;
  function append() { items = [...items, 'x' + (n++)]; }
  function dropFirst() { items = items.slice(1); }
</script>
`);

// ── keyed loop ──
component('keyedlist', `
<ul>
  <template each="row in rows" key="row.id">
    <li class="row">{row.id}:{row.text}</li>
  </template>
</ul>
<button class="reorder" onclick="{reorder}">reorder</button>
<script>
  let rows = [{ id: 1, text: 'one' }, { id: 2, text: 'two' }];
  function reorder() { rows = [rows[1], rows[0]]; }
</script>
`);

// ── batching: one patch per handler tick ──
let patchCounter = 0;
globalThis.__sparkTestOnPatch = () => patchCounter++;
component('batchtest', `
<p class="out">{a}-{b}-{sum}</p>
<button class="go" onclick="{go}">go</button>
<script>
  let a = 1;
  let b = 1;
  $: sum = a + b;
  function go() { a = 10; b = 20; }
</script>
`);

// ── two-way bind to a member path inside a loop ──
component('editrows', `
<template each="row in rows" key="row.id">
  <input class="edit" bind:value="row.text" />
</template>
<p class="joined">{rows.map(r => r.text).join(',')}</p>
<script>
  let rows = [{ id: 1, text: 'a' }, { id: 2, text: 'b' }];
</script>
`);

// ── destroy lifecycle: store unsub + onMount cleanup ──
store('leaktest', { v: 0 });
let cleanupRan = 0;
globalThis.__sparkTestCleanup = () => cleanupRan++;
component('leaky', `
<p class="v">{shared.v}</p>
<script>
  const shared = useStore('leaktest');
  let shared2 = shared;
  onMount(() => { return () => { __sparkTestCleanup(); }; });
</script>
`);

// ── an each-loop's rows nested inside an if-block, torn down by the if ──
// Regression: <template each> tracks its rendered rows on ITSELF
// (__sparkEachBlocks) as SIBLING nodes, not children — a <template>
// anchor is invisible either way. An enclosing <template if> that goes
// false used to call leaveNode() on just the each-anchor it directly
// rendered, removing that (already-invisible) tag but leaving every row
// the each-loop had inserted as siblings behind, orphaned: still in the
// DOM, and any child component in those rows never got its onDestroy/
// store-unsubscribe cleanup run either.
let rowCleanupRan = 0;
globalThis.__sparkRowCleanup = () => rowCleanupRan++;
component('togglerow', `
  <p class="row">{x}</p>
  <script>
    export let x;
    onMount(() => () => { __sparkRowCleanup(); });
  </script>
`);
component('iftoggle', `
  <button class="flip" onclick="{flip}">{show ? 'on' : 'off'}</button>
  <template if="show">
    <template each="x in items"><div class="rowhost" import="togglerow" x="{x}"></div></template>
  </template>
  <script>
    let show = true;
    let items = ['a', 'b'];
    function flip() { show = !show; }
  </script>
`);

parseHTML(
  '<div import="looplist"></div>' +
  '<div import="keyedlist"></div>' +
  '<div import="batchtest"></div>' +
  '<div import="editrows"></div>' +
  '<div id="host"><div import="leaky"></div></div>' +
  '<div import="iftoggle"></div>',
  body,
);
await mount();
await tick();

console.log('\nreconciling each-loop');
await test('renders initial items', () => {
  const labels = body.querySelectorAll('[name="looplist"] .label');
  assert.equal(labels.length, 2);
  assert.equal(labels[0].textContent, '0:a');
  assert.equal(labels[1].textContent, '1:b');
});

let firstLiBefore;
await test('appending REUSES existing DOM nodes (identity preserved)', async () => {
  firstLiBefore = body.querySelectorAll('[name="looplist"] li')[0];
  fire(body.querySelector('[name="looplist"] .append'), 'click');
  await tick();
  const lis = body.querySelectorAll('[name="looplist"] li');
  assert.equal(lis.length, 3, 'should now have 3 items');
  assert.equal(lis[0], firstLiBefore, 'first <li> must be the SAME node object');
  assert.equal(lis[2].querySelector('.label').textContent, '2:x0');
});

await test('dropping first item updates content in reused nodes', async () => {
  fire(body.querySelector('[name="looplist"] .dropfirst'), 'click');
  await tick();
  const labels = body.querySelectorAll('[name="looplist"] .label');
  assert.equal(labels.length, 2);
  // items are now ['b','x0'] → indices reindex
  assert.equal(labels[0].textContent, '0:b');
  assert.equal(labels[1].textContent, '1:x0');
});

console.log('\nkeyed each-loop');
await test('reorder keeps node identity by key', async () => {
  const rowsBefore = body.querySelectorAll('[name="keyedlist"] .row');
  const rowOne = rowsBefore[0]; // id 1
  const rowTwo = rowsBefore[1]; // id 2
  fire(body.querySelector('[name="keyedlist"] .reorder'), 'click');
  await tick();
  const rowsAfter = body.querySelectorAll('[name="keyedlist"] .row');
  assert.equal(rowsAfter[0], rowTwo, 'id 2 node should now be first (moved, not recreated)');
  assert.equal(rowsAfter[1], rowOne, 'id 1 node should now be second');
  assert.equal(rowsAfter[0].textContent, '2:two');
});

console.log('\nbatching');
await test('multiple writes + reactive in one handler => one patch', async () => {
  patchCounter = 0;
  fire(body.querySelector('[name="batchtest"] .go'), 'click');
  await tick();
  const out = body.querySelector('[name="batchtest"] .out');
  assert.equal(out.textContent, '10-20-30', 'derived value recomputed correctly');
  assert.equal(patchCounter, 1, `expected exactly 1 patch, got ${patchCounter}`);
});

console.log('\ntwo-way bind to member path in loop');
await test('editing a loop input mutates the item and re-renders derived text', async () => {
  const inputs = body.querySelectorAll('[name="editrows"] .edit');
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].value, 'a');
  inputs[0].value = 'AA';
  fire(inputs[0], 'input');
  await tick();
  const joined = body.querySelector('[name="editrows"] .joined');
  assert.equal(joined.textContent, 'AA,b', 'derived text must reflect the member write');
});

console.log('\ndestroy lifecycle');
await test('store starts with one subscriber', () => {
  store('leaktest', {}).v = 1; // mutate to confirm wired
});
await test('unmount runs onMount cleanup and unsubscribes from store', async () => {
  const host = body.querySelector('[id="host"]');
  const leakyEl = body.querySelector('[name="leaky"]');
  cleanupRan = 0;
  unmount(leakyEl);
  host.removeChild(leakyEl);
  assert.equal(cleanupRan, 1, 'onMount cleanup must run exactly once');
  // mutating the store must NOT throw or patch the dead component
  store('leaktest', {}).v = 999;
  await tick();
  assert.ok(true);
});

await test('an if-block going false tears down its nested each-loop\'s rows, not just the each anchor', async () => {
  assert.equal(body.querySelectorAll('[name="iftoggle"] .row').length, 2, 'both rows rendered while show is true');
  rowCleanupRan = 0;
  fire(body.querySelector('[name="iftoggle"] .flip'), 'click');
  await tick();
  assert.equal(body.querySelector('[name="iftoggle"] .flip').textContent, 'off', 'show flipped');
  assert.equal(body.querySelectorAll('[name="iftoggle"] .row').length, 0, 'rows removed from the DOM, not orphaned as dangling siblings');
  assert.equal(rowCleanupRan, 2, 'each row\'s child component ran its own onDestroy, not just the each anchor tag being removed');
});

console.log('\nFOUC cloak');
await test('cloak style injected at module load', () => {
  const styles = head.querySelectorAll('style');
  const cloak = styles.find((s) => (s.textContent || '').includes('visibility:hidden'));
  assert.ok(cloak, 'a cloak style should exist in <head>');
});
await test('booted components are revealed (data-spark-ready)', () => {
  const comp = body.querySelector('[name="looplist"]');
  assert.equal(comp.getAttribute('data-spark-ready'), '');
  assert.equal(comp.hasAttribute('data-spark-cloak'), false);
});

// ── delegated loop-row handlers + live-node recipes ──
// Handlers inside stamped row clones attach NO listener at all: the shared
// analysis descriptor rides `el.__sparkH` and ONE document-level capture
// delegate per event type dispatches to it (creating 1,000 rows registers
// zero listeners). Clicking a row must run the handler with the ROW's
// scope (loop var resolved per row), user code must still see
// e.currentTarget = the handling element, and external-key updates must
// re-render only through the row's recorded live-node recipe.
component('dlgrows', `
  <template each="r in rows" key="r.id">
    <span class="dr" :class="r.id === sel ? 'hot' : ''" onclick="{choose(r.id)}">{r.label}</span>
  </template>
  <p class="dsel">{sel}</p>
  <script>
    let rows = [{ id: 1, label: 'one' }, { id: 2, label: 'two' }, { id: 3, label: 'three' }];
    let sel = 0;
    function choose(id) { sel = id; }
  </script>
`);
parseHTML('<div import="dlgrows"></div>', body);
await mount();
await tick();

console.log('\ndelegated loop-row handlers');
await test('row handlers delegate: zero per-row listeners, one shared descriptor', () => {
  const spans = body.querySelectorAll('[name="dlgrows"] .dr');
  assert.equal(spans.length, 3);
  assert.ok(!spans[0]._listeners?.click, 'stamped rows attach NO direct click listener');
  assert.ok(spans[0].__sparkH.click, 'the handler rides __sparkH instead');
  assert.equal(spans[0].__sparkH.click, spans[1].__sparkH.click, 'same shared descriptor, no per-clone state');
  assert.equal(spans[1].__sparkH.click, spans[2].__sparkH.click);
  assert.equal(document.__listeners.click.length, 1, 'exactly ONE document delegate for the type');
  assert.ok(!spans[0].getAttribute('onclick'), 'raw onclick attribute stripped from the clone');
});
await test('clicking a row runs the handler with that row\'s loop scope', async () => {
  const spans = body.querySelectorAll('[name="dlgrows"] .dr');
  fire(spans[1], 'click');
  await tick();
  assert.equal(body.querySelector('[name="dlgrows"] .dsel').textContent, '2');
  const after = body.querySelectorAll('[name="dlgrows"] .dr');
  assert.equal(after[1].getAttribute('class').includes('hot'), true, 'clicked row gains the class');
  assert.equal(after[0].getAttribute('class').includes('hot'), false);
});
await test('a second click moves the selection (old row un-selects via its live recipe)', async () => {
  const spans = body.querySelectorAll('[name="dlgrows"] .dr');
  fire(spans[2], 'click');
  await tick();
  const after = body.querySelectorAll('[name="dlgrows"] .dr');
  assert.equal(after[2].getAttribute('class').includes('hot'), true);
  assert.equal(after[1].getAttribute('class').includes('hot'), false, 'previously selected row cleared');
  assert.equal(body.querySelector('[name="dlgrows"] .dsel').textContent, '3');
});

// ── delegated dispatch semantics: e.currentTarget ──
component('cturows', `
  <template each="r in rs" key="r">
    <b class="ct" onclick="{grab(event)}"><i class="inner">{r}</i></b>
  </template>
  <p class="cto">{tag}</p>
  <script>
    let rs = ['one', 'two'];
    let tag = '';
    function grab(e) { tag = e.currentTarget.getAttribute('class') + '/' + e.target.getAttribute('class'); }
  </script>
`);
// ── duplicate keys hitting the bounded-mismatch path (user error, must degrade sanely) ──
component('dupkeys', `
  <ul><template each="t in ts" key="t.k">
    <li class="dk">{t.k}:{t.v}</li>
  </template></ul>
  <button class="mut" onclick="{mut}">m</button>
  <script>
    let ts = [{ k: 'k', v: 1 }, { k: 'q', v: 2 }, { k: 'r', v: 3 }];
    function mut() { ts = [{ k: 'q', v: 2 }, { k: 'k', v: 1 }, { k: 'k', v: 9 }]; }
  </script>
`);
parseHTML('<div import="cturows"></div><div import="dupkeys"></div>', body);
await mount();
await tick();

await test('delegated handler sees e.currentTarget = the handling element, not document', async () => {
  const inner = body.querySelector('[name="cturows"] .inner');
  fire(inner, 'click'); // target is the CHILD; the delegate walks up to the row <b>
  await tick();
  assert.equal(body.querySelector('[name="cturows"] .cto').textContent, 'ct/inner');
});
await test('duplicate new-side keys degrade to a correct render (no block lands in two slots)', async () => {
  fire(body.querySelector('[name="dupkeys"] .mut'), 'click');
  await tick();
  const lis = body.querySelectorAll('[name="dupkeys"] .dk');
  assert.equal(lis.length, 3, 'three rows rendered');
  assert.equal(lis[0].textContent, 'q:2');
  assert.equal(lis[1].textContent, 'k:1');
  assert.equal(lis[2].textContent, 'k:9');
  assert.notEqual(lis[1], lis[2], 'the two k-rows are distinct DOM nodes');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
