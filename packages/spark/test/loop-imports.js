/**
 * Imports inside each-loops (and if-blocks).
 *
 * querySelectorAll('[import]') never descends into <template> content, so
 * mount()'s one-shot resolveImports can't see placeholders cloned out of a
 * loop. They have to be resolved+booted when the block renders — otherwise
 * the cloaked placeholder sits empty and the import fails silently.
 */
import './dom-shim.js';
import { body, parseHTML } from './dom-shim.js';
import { strict as assert } from 'node:assert';

const { mount, component } = await import('../src/index.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 5));
function fire(el, type) {
  const e = { type, target: el };
  let n = el;
  while (n) { (n._listeners?.[type] || []).forEach((fn) => fn(e)); n = n.parentNode; }
}

// Child component receiving per-item props.
component('usercard', `
<div class="card">{uname}={power}</div>
<script>
  export let uname = '';
  export let power = '';
</script>
`);

// Parent: imports the child once per loop item, with interpolated props.
component('userlist', `
<template each="u in users" key="u.name">
  <div import="usercard" uname="{u.name}" power="{u.power}"></div>
</template>
<button class="add" onclick="{add}">add</button>
<script>
  let users = [
    { name: 'wilkin', power: 'All' },
    { name: 'Burro',  power: 'Patear' },
  ];
  function add() { users = [...users, { name: 'Mike', power: 'Nada' }]; }
</script>
`);

// Import inside an if-block.
component('togglecard', `
<template if="show">
  <div import="usercard" uname="ifname" power="ifpow"></div>
</template>
<button class="toggle" onclick="{flip}">toggle</button>
<script>
  let show = false;
  function flip() { show = !show; }
</script>
`);

parseHTML(
  '<div import="userlist"></div>' +
  '<div import="togglecard"></div>',
  body,
);
await mount();
await tick();
await tick();

console.log('\nimports inside each-loop');
await test('each item renders its imported component', () => {
  const cards = body.querySelectorAll('[name="userlist"] [name="usercard"]');
  assert.equal(cards.length, 2, `expected 2 cards, got ${cards.length}`);
});

await test('per-item props are interpolated against the loop scope', () => {
  const cards = body.querySelectorAll('[name="userlist"] .card');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].textContent, 'wilkin=All');
  assert.equal(cards[1].textContent, 'Burro=Patear');
});

await test('imported loop components are revealed (not left cloaked)', () => {
  const card = body.querySelector('[name="userlist"] [name="usercard"]');
  assert.equal(card.getAttribute('data-spark-ready'), '');
  assert.equal(card.hasAttribute('data-spark-cloak'), false);
});

await test('appending an item imports a new component', async () => {
  fire(body.querySelector('[name="userlist"] .add'), 'click');
  await tick();
  await tick();
  const cards = body.querySelectorAll('[name="userlist"] .card');
  assert.equal(cards.length, 3, `expected 3 cards, got ${cards.length}`);
  assert.equal(cards[2].textContent, 'Mike=Nada');
});

console.log('\nimports inside if-block');
await test('import appears only when the branch is shown', async () => {
  assert.equal(body.querySelectorAll('[name="togglecard"] .card').length, 0);
  fire(body.querySelector('[name="togglecard"] .toggle'), 'click');
  await tick();
  await tick();
  const cards = body.querySelectorAll('[name="togglecard"] .card');
  assert.equal(cards.length, 1, `expected 1 card after toggle, got ${cards.length}`);
  assert.equal(cards[0].textContent, 'ifname=ifpow');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
