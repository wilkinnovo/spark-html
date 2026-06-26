/**
 * Tier 1 performance tests — static-subtree skipping + binding-plan cache.
 *
 * These assert the OPTIMIZATION actually happens (static subtrees are not
 * re-walked) without changing any observable behavior. The decisive trick:
 * after the first render, corrupt a static node's cached interpolation
 * template; if the subtree is truly skipped on the next patch, the
 * corruption is never processed, so the node keeps its sentinel text.
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
  (el._listeners[type] || []).forEach((fn) => fn(e));
}

component('perfbox', `
  <header class="static-region">
    <h1>Sparksplash</h1>
    <nav><a>one</a><a>two</a><a>three</a></nav>
  </header>
  <p class="dyn">{count}</p>
  <button class="inc" onclick="{inc}">+1</button>
  <script>
    let count = 0;
    function inc() { count++; }
  </script>
`);

parseHTML('<div import="perfbox"></div>', body);
await mount();
await tick();

const root = body.querySelector('[name="perfbox"]');
const header = body.querySelector('[name="perfbox"] .static-region');
const dynP = body.querySelector('[name="perfbox"] .dyn');
const incBtn = body.querySelector('[name="perfbox"] .inc');

console.log('\nstatic flags');
await test('a fully-static subtree is marked __sparkStatic', () => {
  assert.equal(header.__sparkStatic, true);
});
await test('the dynamic node is NOT marked static', () => {
  assert.notEqual(dynP.__sparkStatic, true);
});
await test('an element with only an event handler stays live (not static)', () => {
  assert.equal(incBtn.__sparkLive, true);
  assert.notEqual(incBtn.__sparkStatic, true);
});
await test('the component root is never marked static', () => {
  assert.notEqual(root.__sparkStatic, true);
});
await test('a static element has an empty binding plan', () => {
  assert.equal(header.__sparkPlan.length, 0);
});

console.log('\nskipping really happens');
await test('a static subtree is not re-walked on the next patch', async () => {
  // Corrupt the static header's text node: pretend it became dynamic AND
  // give it sentinel text. If the subtree is skipped, nothing touches it.
  const h1Text = body.querySelector('[name="perfbox"] h1').childNodes[0];
  h1Text.__sparkTpl = '{count}';      // would interpolate to a number if walked
  h1Text.textContent = 'SENTINEL';

  fire(incBtn, 'click');
  await tick();

  assert.equal(dynP.childNodes[0].textContent, '1', 'dynamic node still updates');
  assert.equal(
    h1Text.textContent,
    'SENTINEL',
    'static subtree was skipped (sentinel survived the re-patch)',
  );
});

console.log('\ncorrectness after the optimization');
await test('event handler still fires correctly across re-patches', async () => {
  fire(incBtn, 'click');
  await tick();
  fire(incBtn, 'click');
  await tick();
  assert.equal(dynP.childNodes[0].textContent, '3');
});

// ── loops: static cell skipped, dynamic cell tracks the item ──
component('perflist', `
  <ul>
    <template each="row in rows" key="row.id">
      <li><span class="label">item:</span><span class="val">{row.text}</span></li>
    </template>
  </ul>
  <button class="bump" onclick="{bump}">bump</button>
  <script>
    let rows = [{ id: 1, text: 'a' }, { id: 2, text: 'b' }];
    function bump() { rows[0].text = 'A'; }
  </script>
`);

parseHTML('<div import="perflist"></div>', body);
await mount();
await tick();

console.log('\nloops');
await test('dynamic cell tracks the item; static label is skippable', async () => {
  const list = body.querySelector('[name="perflist"]');
  let vals = list.querySelectorAll('.val');
  assert.equal(vals[0].childNodes[0].textContent, 'a');
  assert.equal(vals[1].childNodes[0].textContent, 'b');

  // The static label cell inside a reused row is marked static.
  const label = list.querySelector('.label');
  assert.equal(label.__sparkStatic, true);

  fire(list.querySelector('.bump'), 'click');
  await tick();

  vals = list.querySelectorAll('.val');
  assert.equal(vals[0].childNodes[0].textContent, 'A', 'changed row updates');
  assert.equal(vals[1].childNodes[0].textContent, 'b', 'untouched row stays');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
