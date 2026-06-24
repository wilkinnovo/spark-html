/**
 * Tests for consumer-facing debug warnings: silent failures should now warn
 * (once, deduped) and degrade gracefully instead of rendering blank in silence.
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

// Capture console.warn output across the run.
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(' ')); };
const sparkWarns = (needle) => warnings.filter((w) => w.includes('[spark]') && w.includes(needle));

component('badexpr', `
<p class="out">Hi {user.name.first}</p>
<span class="ok">{greeting}</span>
<script>
  let greeting = 'hello';
  let user = null;           // user.name.first will throw on every patch
</script>`);

component('badeach', `
<template each="x of items"><li>{x}</li></template>
<script>
  let items = [1, 2, 3];
</script>`);

component('badscript', `
<p>{whatever}</p>
<script>
  let whatever = (((;       // syntax error — whole script fails
</script>`);

parseHTML(
  '<div import="badexpr"></div><div import="badeach"></div><div import="badscript"></div>',
  body,
);
await mount();
await tick();
// extra patches to prove dedupe (would re-warn per patch without warnOnce)
const ok = body.querySelector('[name="badexpr"] .ok');
await tick(); await tick();

console.warn = realWarn;

console.log('\nconsumer debug warnings');
await test('a throwing expression warns (with the expression text) and renders empty', () => {
  const out = body.querySelector('[name="badexpr"] .out');
  assert.equal(out.textContent, 'Hi ', 'broken interpolation degrades to empty');
  const w = sparkWarns('{user.name.first}');
  assert.ok(w.length >= 1, 'should warn about the broken expression');
});
await test('the same broken expression warns ONCE despite many patches', () => {
  const w = sparkWarns('{user.name.first}');
  assert.equal(w.length, 1, `expected exactly 1 warning, got ${w.length}`);
});
await test('unaffected siblings still render', () => {
  assert.equal(body.querySelector('[name="badexpr"] .ok').textContent, 'hello');
});
await test('malformed each="x of items" warns with the expected syntax', () => {
  const w = sparkWarns('Invalid each');
  assert.ok(w.length >= 1 && w[0].includes('item in items'), 'should explain each syntax');
});
await test('a script syntax error names the component and says state is unavailable', () => {
  const w = sparkWarns('failed to run');
  assert.ok(w.some((x) => x.includes('badscript')), 'should name the component');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
