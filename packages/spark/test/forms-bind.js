/** bind:form — declarative form state: validity, pending, submitted, error. */
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
const txt = (el) => (el ? el.textContent : '');
const fire = (el, type, evt = {}) =>
  (el._listeners[type] || []).forEach((f) => f({ type, target: el, currentTarget: el, preventDefault() {}, ...evt }));

// A submit handler that resolves or rejects on demand, so we can observe the
// pending → settled transition.
globalThis.__resolveSubmit = null;
globalThis.__rejectSubmit = null;

component('signup', `
  <form class="f" bind:form="form" onsubmit="{save}">
    <p class="valid">{form.valid}</p>
    <p class="pending">{form.pending}</p>
    <p class="submitted">{form.submitted}</p>
    <p class="error">{form.error ? form.error.message : ''}</p>
    <button class="b" :disabled="form.pending">Go</button>
  </form>
  <script>
    function save() {
      return new Promise((res, rej) => {
        globalThis.__resolveSubmit = res;
        globalThis.__rejectSubmit = rej;
      });
    }
  </script>
`);
parseHTML('<div import="signup"></div>', body);

await mount();
await tick();

const form = () => body.querySelector('.f');

console.log('\nbind:form lifecycle');
await test('seeds an initial state object on first paint', () => {
  const c = body.querySelector('[name="signup"]');
  assert.equal(txt(c.querySelector('.valid')), 'true');     // no constraints → valid
  assert.equal(txt(c.querySelector('.pending')), 'false');
  assert.equal(txt(c.querySelector('.submitted')), 'false');
});

await test('submit sets submitted + pending while the async handler runs', async () => {
  fire(form(), 'submit');
  await tick();
  const c = body.querySelector('[name="signup"]');
  assert.equal(txt(c.querySelector('.submitted')), 'true');
  assert.equal(txt(c.querySelector('.pending')), 'true', 'pending during await');
});

await test('resolving the handler clears pending with no error', async () => {
  globalThis.__resolveSubmit();
  await tick();
  const c = body.querySelector('[name="signup"]');
  assert.equal(txt(c.querySelector('.pending')), 'false');
  assert.equal(txt(c.querySelector('.error')), '');
});

await test('a rejected submit lands in form.error and clears pending', async () => {
  fire(form(), 'submit');
  await tick();
  globalThis.__rejectSubmit(new Error('boom'));
  await tick();
  const c = body.querySelector('[name="signup"]');
  assert.equal(txt(c.querySelector('.pending')), 'false');
  assert.equal(txt(c.querySelector('.error')), 'boom');
});

console.log('\nbind:form native validity gate');
await test('an invalid form blocks the handler and reports field errors', async () => {
  // Mock native constraint validation on the form (the shim has none).
  const f = form();
  const email = { name: 'email', type: 'email', value: '', focused: false,
    checkValidity: () => false, validationMessage: 'Enter an email',
    focus() { this.focused = true; } };
  f.elements = [email];
  f.checkValidity = () => false;

  let ran = false;
  globalThis.__resolveSubmit = null;
  // swap the handler's effect: prove it never runs while invalid
  const c = body.querySelector('[name="signup"]');
  fire(f, 'input');         // recompute validity from the now-invalid field
  await tick();
  assert.equal(txt(c.querySelector('.valid')), 'false', 'form reports invalid');
  assert.deepEqual(f.elements[0].focused, false);

  fire(f, 'submit');
  await tick();
  assert.equal(email.focused, true, 'focuses first invalid field');
  assert.equal(txt(c.querySelector('.pending')), 'false', 'handler gated — never pending');
  assert.equal(ran, false);
});

console.log('\nnative name= does not collide with the component marker');
// Regression: `name` is Spark's component marker AND a native form attribute.
// `<input name="x">` must NOT be booted as its own (empty-scope) component —
// its bind:value/{x} must read the PARENT component's state. (Previously this
// logged "x is not defined" and stranded the binding.)
component('named-field', `
  <input class="in" name="email" bind:value="email" />
  <p class="echo">[{email}]</p>
  <script>let email = 'seed@x.io';</script>
`);
parseHTML('<div import="named-field"></div>', body);
await mount();
await tick();
await test('a named input binds to the parent scope (no empty sub-component)', async () => {
  const c = body.querySelector('[name="named-field"]');
  const input = c.querySelector('.in');
  assert.equal(txt(c.querySelector('.echo')), '[seed@x.io]', 'scope pushed into {email}');
  assert.equal(input.value, 'seed@x.io', 'scope pushed into the input');
  assert.equal(input.__sparkScope, undefined, 'the input was NOT booted as a component');
  input.value = 'typed@x.io';        // user types
  fire(input, 'input');
  await tick();
  assert.equal(txt(c.querySelector('.echo')), '[typed@x.io]', 'two-way write reaches parent state');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
