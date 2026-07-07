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

// ── arrow function as an on* handler (the React/Vue instinct): constructed
// and discarded as an inert statement, not called — must warn loudly naming
// the fix instead of just doing nothing on click.
component('arrowhandler', `
<button class="go" onclick="{() => bump(1)}">go</button>
<p class="n">{n}</p>
<script>
  let n = 0;
  function bump(by) { n += by; }
</script>`);

await test('an arrow function used as an on* handler warns and names the direct-call fix', async () => {
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    parseHTML('<div import="arrowhandler"></div>', body);
    await mount(body, { quiet: true });
    await tick();
  } finally {
    console.warn = realWarn;
  }
  const w = sparkWarns('constructed and discarded');
  assert.ok(w.length >= 1, 'should warn about the arrow-function footgun');
  assert.ok(w[0].includes('onclick={bump(1)}'), 'should name the direct-call fix');
});

// ── async onMount: a rejection is contained + reported, and a resolved
// cleanup function still registers (it used to escape as an unhandled
// promise rejection and the cleanup was dropped).
component('asyncmount', `
<p class="am">{msg}</p>
<script>
  let msg = 'up';
  onMount(async () => {
    globalThis.__asyncCleanupRegistered = false;
    if (globalThis.__asyncMountThrow) throw new Error('socket exploded');
    return () => { globalThis.__asyncCleanupRegistered = true; };
  });
</script>`);

await test('an async onMount rejection is reported, not an unhandled rejection', async () => {
  globalThis.__asyncMountThrow = true;
  const captured = [];
  const onUnhandled = (e) => captured.push(e);
  process.on('unhandledRejection', onUnhandled);
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    parseHTML('<div import="asyncmount"></div>', body);
    await mount(body, { quiet: true });
    await tick(); await tick();
  } finally {
    console.warn = realWarn;
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(captured.length, 0, 'no unhandled rejection escaped');
  const w = sparkWarns('socket exploded');
  assert.ok(w.some((x) => x.includes('onMount') && x.includes('asyncmount')),
    `expected an onMount warning naming the component, got: ${w.join(' | ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
