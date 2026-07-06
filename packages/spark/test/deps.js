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

// ── each-loop gating: a clean loop is skipped; relevant changes still apply ──
component('loopgate', `
  <ul>
    <template each="r in rows" key="r.id">
      <li class="row">{r.t}{sel === r.id ? '*' : ''}</li>
    </template>
  </ul>
  <p class="n">{n}</p>
  <button class="bn" onclick="{bumpN}">n</button>
  <button class="bsel" onclick="{pick}">sel</button>
  <button class="badd" onclick="{add}">add</button>
  <script>
    let rows = [{ id: 1, t: 'a' }, { id: 2, t: 'b' }];
    let sel = 0;
    let n = 0;
    function bumpN() { n++; }
    function pick() { sel = 2; }
    function add() { rows = [...rows, { id: 3, t: 'c' }]; }
  </script>
`);
parseHTML('<div import="loopgate"></div>', body);
await mount();
await tick();

console.log('\neach-loop gating');
await test('an unrelated change does NOT re-reconcile the loop', async () => {
  const c = body.querySelector('[name="loopgate"]');
  const li0 = c.querySelectorAll('.row')[0].childNodes[0];
  li0.textContent = 'SENTINEL'; // corrupt a row; if the loop re-walks, it's overwritten
  fire(c.querySelector('.bn'), 'click'); // n++ — nothing to do with rows/sel
  await tick();
  assert.equal(txt(c.querySelector('.n')), '1', 'n updated');
  assert.equal(li0.textContent, 'SENTINEL', 'loop skipped (row not re-walked)');
});
await test('a per-row dependency (sel) re-walks the rows', async () => {
  const c = body.querySelector('[name="loopgate"]');
  fire(c.querySelector('.bsel'), 'click'); // sel = 2 → row 2 gets '*'
  await tick();
  const rows = c.querySelectorAll('.row');
  assert.equal(rows[1].textContent, 'b*', 'row 2 marked selected');
  assert.equal(rows[0].textContent, 'a', 'row 1 unchanged');
});
await test('changing the array reconciles (new row appears)', async () => {
  const c = body.querySelector('[name="loopgate"]');
  fire(c.querySelector('.badd'), 'click');
  await tick();
  const rows = c.querySelectorAll('.row');
  assert.equal(rows.length, 3);
  assert.equal(rows[2].textContent, 'c');
});

// ── regression: an each-loop wrapped in a <template if> stops reconciling
// after an UNRELATED sibling change, even though the array it loops over
// keeps changing ──
// `withSink()` records, on an each/if/await anchor's own `__sparkReadKeys`,
// every key read anywhere in its content — including nested each/if/await,
// so the WHOLE block can be gated in one piece. It used to `.clear()` that
// set before every re-run. A pass triggered by an UNRELATED key (here:
// `searching`, which the OUTER `<template if>` depends on) still re-runs
// the outer if (its own deps matched) — but the INNER each is independently
// gated too, and its deps (just `items`) don't match `searching`, so it's
// SKIPPED this pass. Skipped means its array expression is never read —
// which means the outer if's freshly-`.clear()`'d sink never sees `items`
// this time, and overwrites its own recorded deps to just `searching`
// (whatever WAS actually touched) — permanently forgetting that its
// content also depends on `items`. The NEXT time only `items` changes, the
// outer if's (now wrong) deps don't include it, so the whole block —
// outer if AND the inner each inside it — is skipped, and the loop never
// reflects the new array again, for the rest of the component's life.
component('nestedloopgate', `
<template if="!hideAll && unrelated >= 0">
  <template each="v in items" key="v.id">
    <p class="row2">{v.name}</p>
  </template>
</template>
<button class="bump-unrelated" onclick="{bumpUnrelated}">bump</button>
<button class="grow-items" onclick="{growItems}">grow</button>
<script>
  let items = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
  let hideAll = false;
  let unrelated = 0;
  function bumpUnrelated() { unrelated++; }
  function growItems() { items = [...items, { id: items.length + 1, name: String.fromCharCode(97 + items.length) }]; }
</script>
`);
parseHTML('<div import="nestedloopgate"></div>', body);
await mount();
await tick();

await test('an each wrapped in <template if> keeps reconciling after an unrelated sibling change', async () => {
  const c = body.querySelector('[name="nestedloopgate"]');
  // Trigger a pass gated on a DIFFERENT key than the loop's own array — the
  // outer if's own deps match (it reads nothing else here, but in the app
  // this found it in, the outer if ALSO read the unrelated key directly),
  // while the inner each's deps (`items`) don't, so it's skipped THIS pass.
  fire(c.querySelector('.bump-unrelated'), 'click');
  await tick();
  assert.equal(c.querySelectorAll('.row2').length, 2, 'sanity: still 2 rows after the unrelated bump');

  // NOW change only the array the loop depends on — this used to silently
  // no-op forever after the unrelated bump above corrupted the outer if's
  // recorded deps.
  fire(c.querySelector('.grow-items'), 'click');
  await tick();
  const rows = c.querySelectorAll('.row2');
  assert.equal(rows.length, 3, 'the loop must still reconcile after an unrelated sibling change');
  assert.equal(rows[2].textContent, 'c');
});

// ── a nested helper's OWN local variable must stay a true local ──
// Regression: analyzeScript()'s let/const/var-stripping (which exposes a
// component's TOP-LEVEL state as reactive scope keys) used to run as a
// flat, brace-depth-blind regex over the whole script — it ALSO stripped a
// declaration inside a nested helper FUNCTION's body, turning that true
// local into an implicit write to the reactive scope proxy. A helper that
// both reads and writes such a "local" in one call (an entirely ordinary
// pattern: compute an intermediate value, use it) picks up a dependency on
// it via that same read — and since evaluating the expression ALSO writes
// it, every evaluation re-triggers itself: a genuine infinite patch loop
// (a real hang), not just a stale value. Guarded with a timeout so a
// regression fails this test instead of hanging the whole suite.
component('nestedlocal', `
  <button class="setweek" onclick="{setFilter('week')}">week</button>
  <template each="v in items" key="v.id">
    <p class="row" :hidden="!matchesFilter(v, activeFilter)">{v.name}</p>
  </template>
  <script>
    let items = [{ id: 1, name: 'a', ago: '2 days ago' }, { id: 2, name: 'b', ago: '3 years ago' }];
    let activeFilter = 'all';
    function agoDays(ago) {
      const m = String(ago || '').match(/(\\d+)\\s*(day|year)/);
      if (!m) return Infinity;
      const n = Number(m[1]);
      const unit = m[2];
      const perDay = { day: 1, year: 365 };
      return n * perDay[unit];
    }
    function matchesFilter(v, filter) {
      if (filter === 'all') return true;
      return agoDays(v.ago) <= 7;
    }
    function setFilter(f) { activeFilter = f; }
  </script>
`);
parseHTML('<div import="nestedlocal"></div>', body);
await mount(body, { quiet: true });
await test('a helper function\'s own local var (read + written in one call) does not infinite-loop the patch cycle', async () => {
  const c = body.querySelector('[name="nestedlocal"]');
  fire(c.querySelector('.setweek'), 'click');
  await Promise.race([
    tick(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out — infinite patch loop')), 2000)),
  ]);
  const rows = [...c.querySelectorAll('.row')];
  assert.equal(rows.find((r) => r.textContent === 'a').hasAttribute('hidden'), false, 'within a week — stays visible');
  assert.equal(rows.find((r) => r.textContent === 'b').hasAttribute('hidden'), true, 'years old — hidden by the filter');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
