/**
 * Tier 2 — dependency tracking (O(changed), not O(all bindings)).
 *
 * Proven the same decisive way as Tier 1: after the first render, drop a
 * sentinel into a node that should NOT be touched, change an unrelated value,
 * and assert the sentinel survived (the node was skipped) while the value
 * that DID change updated. Plus correctness for ternaries, $: chains, and the
 * full-mode fallbacks (deep mutation, store, member-path bind).
 */
import './dom-shim.js';
import { body, parseHTML } from './dom-shim.js';
import { strict as assert } from 'node:assert';

const { mount, component, store } = await import('../src/index.js');

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
const txt = (el) => el.childNodes[0].textContent;

// ── independent fields: changing one must not re-evaluate the other ──
component('twofields', `
  <p class="a">{a}</p>
  <p class="b">{b}</p>
  <button class="ia" onclick="{bumpA}">a</button>
  <button class="ib" onclick="{bumpB}">b</button>
  <script>
    let a = 0;
    let b = 0;
    function bumpA() { a++; }
    function bumpB() { b++; }
  </script>
`);

parseHTML('<div import="twofields"></div>', body);
await mount();
await tick();

console.log('\ntargeted leaf updates');
await test('each binding records exactly the keys it reads', () => {
  const aText = body.querySelector('[name="twofields"] .a').childNodes[0];
  const bText = body.querySelector('[name="twofields"] .b').childNodes[0];
  assert.deepEqual([...aText.__sparkReadKeys], ['a']);
  assert.deepEqual([...bText.__sparkReadKeys], ['b']);
});
await test('changing a does NOT re-evaluate b (sentinel survives)', async () => {
  const c = body.querySelector('[name="twofields"]');
  const bText = c.querySelector('.b').childNodes[0];
  bText.textContent = 'SENTINEL'; // pretend b is showing something else

  fire(c.querySelector('.ia'), 'click'); // a++ → dirty {a} only
  await tick();

  assert.equal(txt(c.querySelector('.a')), '1', 'a updated');
  assert.equal(bText.textContent, 'SENTINEL', 'b binding was skipped (O(changed))');
});
await test('changing b DOES update b', async () => {
  const c = body.querySelector('[name="twofields"]');
  fire(c.querySelector('.ib'), 'click'); // b++ → dirty {b}
  await tick();
  assert.equal(txt(c.querySelector('.b')), '1', 'b updated');
});

// ── dependency-aware $: ──
component('reactivedeps', `
  <p class="d">{doubled}</p>
  <p class="t">{tripled}</p>
  <button class="ia" onclick="{bumpA}">a</button>
  <button class="ib" onclick="{bumpB}">b</button>
  <script>
    let a = 1;
    let b = 1;
    $: doubled = a * 2;
    $: tripled = b * 3;
    function bumpA() { a++; }
    function bumpB() { b++; }
  </script>
`);

parseHTML('<div import="reactivedeps"></div>', body);
await mount();
await tick();

console.log('\ndependency-aware $:');
await test('changing a runs only the doubled statement, not tripled', async () => {
  const c = body.querySelector('[name="reactivedeps"]');
  assert.equal(txt(c.querySelector('.d')), '2');
  assert.equal(txt(c.querySelector('.t')), '3');

  // If the `tripled` $: re-ran, it would re-dirty `tripled` and overwrite
  // this sentinel; if it's correctly skipped, the sentinel survives.
  const tText = c.querySelector('.t').childNodes[0];
  tText.textContent = 'SENTINEL';

  fire(c.querySelector('.ia'), 'click'); // a++ → dirty {a}
  await tick();

  assert.equal(txt(c.querySelector('.d')), '4', 'doubled recomputed');
  assert.equal(tText.textContent, 'SENTINEL', 'tripled $: and its binding skipped');
});
await test('changing b updates tripled', async () => {
  const c = body.querySelector('[name="reactivedeps"]');
  fire(c.querySelector('.ib'), 'click');
  await tick();
  assert.equal(txt(c.querySelector('.t')), '6');
});

// ── $: chain must propagate in dirty mode (fixpoint) ──
component('chaindeps', `
  <p class="out">{d}</p>
  <button class="go" onclick="{bump}">go</button>
  <script>
    let a = 1;
    $: c = a * 2;
    $: d = c + 1;
    function bump() { a++; }
  </script>
`);

parseHTML('<div import="chaindeps"></div>', body);
await mount();
await tick();

console.log('\n$: chain propagation');
await test('a → c → d propagates through the chain on a targeted update', async () => {
  const c = body.querySelector('[name="chaindeps"]');
  assert.equal(txt(c.querySelector('.out')), '3'); // a=1 → c=2 → d=3
  fire(c.querySelector('.go'), 'click'); // a=2 → c=4 → d=5
  await tick();
  assert.equal(txt(c.querySelector('.out')), '5');
});

// ── ternary: deps refresh when the branch key flips ──
component('ternarydeps', `
  <p class="out">{flag ? x : y}</p>
  <button class="fx" onclick="{setX}">x</button>
  <button class="fy" onclick="{setY}">y</button>
  <button class="ff" onclick="{toggle}">flip</button>
  <script>
    let flag = true;
    let x = 'X1';
    let y = 'Y1';
    function setX() { x = 'X2'; }
    function setY() { y = 'Y2'; }
    function toggle() { flag = !flag; }
  </script>
`);

parseHTML('<div import="ternarydeps"></div>', body);
await mount();
await tick();

console.log('\nconditional (ternary) correctness');
await test('changing the untaken branch does nothing; taken branch updates', async () => {
  const c = body.querySelector('[name="ternarydeps"]');
  assert.equal(txt(c.querySelector('.out')), 'X1');

  fire(c.querySelector('.fy'), 'click'); // y changes, but flag=true shows x
  await tick();
  assert.equal(txt(c.querySelector('.out')), 'X1', 'untaken branch ignored');

  fire(c.querySelector('.fx'), 'click'); // x changes, shown
  await tick();
  assert.equal(txt(c.querySelector('.out')), 'X2', 'taken branch updates');
});
await test('flipping the branch re-tracks deps and shows the other value', async () => {
  const c = body.querySelector('[name="ternarydeps"]');
  fire(c.querySelector('.ff'), 'click'); // flag=false → show y (now 'Y2')
  await tick();
  assert.equal(txt(c.querySelector('.out')), 'Y2');
});

// ── fallbacks: never stale ──
component('deepmut', `
  <p class="out">{obj.n}</p>
  <button class="go" onclick="{bump}">go</button>
  <script>
    let obj = { n: 0 };
    function bump() { obj.n++; }
  </script>
`);
parseHTML('<div import="deepmut"></div>', body);

store('counter', { n: 0 });
component('storedep', `
  <p class="out">{shown}</p>
  <button class="go" onclick="{bump}">go</button>
  <script>
    const s = useStore('counter');
    $: shown = s.n;
    function bump() { s.n = s.n + 1; }
  </script>
`);
parseHTML('<div import="storedep"></div>', body);

component('memberbind', `
  <input class="in" bind:value="form.name" />
  <p class="echo">{form.name}</p>
  <script>
    let form = { name: 'init' };
  </script>
`);
parseHTML('<div import="memberbind"></div>', body);

await mount();
await tick();

console.log('\nfull-mode fallbacks (correctness over speed)');
await test('deep mutation (obj.n++) still re-renders', async () => {
  const c = body.querySelector('[name="deepmut"]');
  fire(c.querySelector('.go'), 'click');
  await tick();
  assert.equal(txt(c.querySelector('.out')), '1');
});
await test('store notification still re-renders', async () => {
  const c = body.querySelector('[name="storedep"]');
  fire(c.querySelector('.go'), 'click');
  await tick();
  assert.equal(txt(c.querySelector('.out')), '1');
});
await test('member-path two-way bind still flows to the echo', async () => {
  const c = body.querySelector('[name="memberbind"]');
  const input = c.querySelector('.in');
  input.value = 'typed';
  fire(input, 'input');
  await tick();
  assert.equal(txt(c.querySelector('.echo')), 'typed');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
