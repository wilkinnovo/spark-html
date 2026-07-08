/** Regression tests for reported quirks: comma-let, template-literal/nested
 *  interpolation, and :class merging — all end-to-end on the real runtime. */
import './dom-shim.js';
import { body, parseHTML } from './dom-shim.js';
import { strict as assert } from 'node:assert';

const { mount, component, interpolate } = await import('../src/index.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const fire = (el, t) => { const e = { type: t, target: el }; let n = el; while (n) { e.currentTarget = n; (n._listeners?.[t] || []).forEach((f) => f(e)); n = n.parentNode; } };
const txt = (el) => (el ? el.textContent : '');

console.log('\ninterpolate — brace-aware');
await test('template literal with ${} inside {…}', () => {
  assert.equal(interpolate('{`hi ${who}!`}', { who: 'you' }), 'hi you!');
});
await test('object literal inside {…}', () => {
  assert.equal(interpolate('{ (cond ? {a:1} : {a:2}).a }', { cond: true }), '1');
});
await test('multiple exprs + literals', () => {
  assert.equal(interpolate('a={x}, b={y}', { x: 1, y: 2 }), 'a=1, b=2');
});
await test('\\{ \\} escape a literal brace (entities cannot)', () => {
  assert.equal(interpolate('press \\{enter\\}', {}), 'press {enter}');
  assert.equal(interpolate('\\{x\\} shows {x}', { x: 5 }), '{x} shows 5');
  assert.equal(interpolate('lone \\} brace', {}), 'lone } brace');
  // a backslash not before a brace is untouched
  assert.equal(interpolate('path C:\\\\dir', {}), 'path C:\\\\dir');
});

console.log('\ncomma-separated let');
component('commalet', `
  <p class="o">{a}|{b}|{c}</p>
  <button class="go" onclick="{bump}">x</button>
  <script>
    let a = 'A', b = 'B', c = 'C';
    function bump() { b = 'B2'; }
  </script>
`);
parseHTML('<div import="commalet"></div>', body);
await mount();
await tick();
await test('all comma-chained vars are component state (no global leak)', () => {
  assert.equal(txt(body.querySelector('[name="commalet"] .o')), 'A|B|C');
  assert.equal(globalThis.b, undefined, 'b must not leak to globalThis');
});
await test('a non-first comma var is reactive', async () => {
  fire(body.querySelector('[name="commalet"] .go'), 'click');
  await tick();
  assert.equal(txt(body.querySelector('[name="commalet"] .o')), 'A|B2|C');
});

console.log('\n:class merges with static class');
component('clsmerge', `
  <div class="card big" :class="state">x</div>
  <button class="go" onclick="{flip}">x</button>
  <script>
    let state = 'active';
    function flip() { state = 'done'; }
  </script>
`);
parseHTML('<div import="clsmerge"></div>', body);
await mount();
await tick();
await test('static class is preserved and merged with :class', () => {
  assert.equal(body.querySelector('[name="clsmerge"] div').getAttribute('class'), 'card big active');
});
await test(':class update re-merges with the static class', async () => {
  fire(body.querySelector('[name="clsmerge"] .go'), 'click');
  await tick();
  assert.equal(body.querySelector('[name="clsmerge"] div').getAttribute('class'), 'card big done');
});

console.log('\nliteral braces in a component');
component('literalbrace', `<p class="o">use \\{name\\} for {label}</p><script>let label = 'the field';</script>`);
parseHTML('<div import="literalbrace"></div>', body);
await mount();
await tick();
await test('\\{…\\} renders literal braces alongside real interpolation', () => {
  assert.equal(txt(body.querySelector('[name="literalbrace"] .o')), 'use {name} for the field');
});

// ── let name shadowing + onsubmit reactivity ──
component('namevar', `<p class="o">{name}</p><script>let name = 'Ada';<\/script>`);
component('submitform', `<form onsubmit="{go}"><button>x</button></form><p class="o">{n}</p><script>let n = 0; function go(e) { e && e.preventDefault && e.preventDefault(); n++; }<\/script>`);
parseHTML('<div import="namevar"></div><div import="submitform"></div>', body);
await mount(body);
await tick();

console.log('\nscope + events');
await test('let name does not collide with window.name', () => {
  assert.equal(txt(body.querySelector('[name="namevar"] .o')), 'Ada');
});
await test('onsubmit handler fires and re-renders', async () => {
  fire(body.querySelector('[name="submitform"] form'), 'submit');
  await tick();
  assert.equal(txt(body.querySelector('[name="submitform"] .o')), '1');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
