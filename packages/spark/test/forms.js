/** Form bindings: bind:group (radio), number/range coercion, contenteditable. */
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
const fire = (el, type) => (el._listeners[type] || []).forEach((f) => f({ type, target: el, currentTarget: el }));
const txt = (el) => (el ? el.textContent : '');

// ── radio group ──
component('radio', `
  <input class="a" type="radio" bind:group="pick" value="a" />
  <input class="b" type="radio" bind:group="pick" value="b" />
  <p class="out">{pick}</p>
  <script>let pick = 'b';</script>
`);
parseHTML('<div import="radio"></div>', body);

// ── number coercion ──
component('num', `
  <input class="n" type="number" bind:value="age" />
  <p class="out">{age} is {typeof age}</p>
  <script>let age = 0;</script>
`);
parseHTML('<div import="num"></div>', body);

// ── contenteditable ──
component('editable', `
  <div class="ed" contenteditable bind:value="bio">x</div>
  <p class="out">{bio}</p>
  <script>let bio = 'hello';</script>
`);
parseHTML('<div import="editable"></div>', body);

await mount();
await tick();

console.log('\nbind:group (radio)');
await test('initial scope value checks the matching radio', () => {
  const c = body.querySelector('[name="radio"]');
  assert.equal(c.querySelector('.a').checked, false);
  assert.equal(c.querySelector('.b').checked, true);
});
await test('selecting a radio writes its value to scope', async () => {
  const c = body.querySelector('[name="radio"]');
  const a = c.querySelector('.a');
  a.checked = true; // user picks "a"
  fire(a, 'change');
  await tick();
  assert.equal(txt(c.querySelector('.out')), 'a');
  assert.equal(c.querySelector('.b').checked, false, 'b unchecked after patch');
});

console.log('\nnumber coercion');
await test('a number input writes a NUMBER (not a string) to scope', async () => {
  const c = body.querySelector('[name="num"]');
  assert.equal(txt(c.querySelector('.out')), '0 is number');
  const n = c.querySelector('.n');
  n.value = '42';
  fire(n, 'input');
  await tick();
  assert.equal(txt(c.querySelector('.out')), '42 is number');
});

console.log('\ncontenteditable');
await test('bind:value on a contenteditable uses textContent', async () => {
  const c = body.querySelector('[name="editable"]');
  assert.equal(txt(c.querySelector('.ed')), 'hello'); // scope pushed in
  const ed = c.querySelector('.ed');
  ed.textContent = 'new bio';
  fire(ed, 'input');
  await tick();
  assert.equal(txt(c.querySelector('.out')), 'new bio');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
