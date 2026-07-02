/**
 * <template if> / <template else-if> / <template else> chains.
 *
 * A chain is a run of consecutive sibling templates: one `if` head, any
 * number of `else-if` branches, and an optional bare `else`. Exactly one
 * branch renders — the first truthy expr, or the else when none is. Driven
 * entirely from the head's patch; follower templates render nothing alone.
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
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
function fire(el, type) {
  const e = { type, target: el };
  (el._listeners[type] || []).forEach((fn) => fn(e));
}
const text = (sel) => body.querySelectorAll(sel).map((n) => n.textContent.trim()).join('|');

// ─── basic selection ─────────────────────────────────────────────────────
console.log('\nbranch selection');
component('sel1', `
  <template if="x > 10"><p class="b">big</p></template>
  <template else-if="x > 5"><p class="b">medium</p></template>
  <template else><p class="b">small</p></template>
  <button class="set0" onclick="{x = 3}">0</button>
  <button class="set1" onclick="{x = 7}">1</button>
  <button class="set2" onclick="{x = 12}">2</button>
  <script>
    let x = 12;
  </script>
`);
parseHTML('<div import="sel1"></div>', body);
await mount(body, { quiet: true });

await test('if branch renders when truthy (others absent)', () => {
  assert.equal(text('[name="sel1"] .b'), 'big');
});
await test('else-if renders when if is false', async () => {
  fire(body.querySelector('[name="sel1"] .set1'), 'click');
  await tick();
  assert.equal(text('[name="sel1"] .b'), 'medium');
});
await test('bare else renders when nothing matched', async () => {
  fire(body.querySelector('[name="sel1"] .set0'), 'click');
  await tick();
  assert.equal(text('[name="sel1"] .b'), 'small');
});
await test('cycling back re-renders the if branch (full round trip)', async () => {
  fire(body.querySelector('[name="sel1"] .set2'), 'click');
  await tick();
  assert.equal(text('[name="sel1"] .b'), 'big');
});

console.log('\nfirst truthy wins');
component('sel2', `
  <template if="n >= 1"><p class="w">one</p></template>
  <template else-if="n >= 1"><p class="w">also-one</p></template>
  <template else-if="true"><p class="w">always</p></template>
  <script>
    let n = 1;
  </script>
`);
parseHTML('<div import="sel2"></div>', body);
await mount(body, { quiet: true });
await test('only the FIRST truthy branch renders', () => {
  assert.equal(text('[name="sel2"] .w'), 'one');
});

component('sel3', `
  <template if="false"><p class="w3">no</p></template>
  <template else-if="mode === 'a'"><p class="w3">A</p></template>
  <template else-if="mode === 'b'"><p class="w3">B</p></template>
  <button class="tob" onclick="{mode = 'b'}">b</button>
  <script>
    let mode = 'a';
  </script>
`);
parseHTML('<div import="sel3"></div>', body);
await mount(body, { quiet: true });
await test('multiple else-ifs without else — matching one renders', () => {
  assert.equal(text('[name="sel3"] .w3'), 'A');
});
await test('…and switches between else-if branches reactively', async () => {
  fire(body.querySelector('[name="sel3"] .tob'), 'click');
  await tick();
  assert.equal(text('[name="sel3"] .w3'), 'B');
});

// ─── reactive content inside branches ───────────────────────────────────
console.log('\nbranch content stays live');
component('live1', `
  <template if="on"><p class="c">count: {count}</p></template>
  <template else><p class="c">off ({count})</p></template>
  <button class="inc" onclick="{count++}">+</button>
  <button class="flip" onclick="{on = !on}">flip</button>
  <script>
    let on = true;
    let count = 0;
  </script>
`);
parseHTML('<div import="live1"></div>', body);
await mount(body, { quiet: true });
await test('bindings inside the active branch update in place', async () => {
  fire(body.querySelector('[name="live1"] .inc'), 'click');
  await tick();
  assert.equal(text('[name="live1"] .c'), 'count: 1');
});
await test('active-branch nodes are REUSED on refresh (no rebuild)', async () => {
  const before = body.querySelector('[name="live1"] .c');
  fire(body.querySelector('[name="live1"] .inc'), 'click');
  await tick();
  assert.equal(body.querySelector('[name="live1"] .c'), before);
});
await test('the else branch is live too', async () => {
  fire(body.querySelector('[name="live1"] .flip'), 'click');
  await tick();
  assert.equal(text('[name="live1"] .c'), 'off (2)');
  fire(body.querySelector('[name="live1"] .inc'), 'click');
  await tick();
  assert.equal(text('[name="live1"] .c'), 'off (3)');
});

// ─── chains inside each rows (clone + loop scope) ───────────────────────
console.log('\nchains inside each blocks');
component('loop1', `
  <ul>
    <template each="item in items">
      <template if="item.kind === 'fruit'"><li class="r">🍎 {item.name}</li></template>
      <template else-if="item.kind === 'veg'"><li class="r">🥕 {item.name}</li></template>
      <template else><li class="r">❓ {item.name}</li></template>
    </template>
  </ul>
  <button class="promote" onclick="{items[2].kind = 'fruit'}">promote</button>
  <script>
    let items = [
      { kind: 'fruit', name: 'apple' },
      { kind: 'veg', name: 'carrot' },
      { kind: 'rock', name: 'granite' },
    ];
  </script>
`);
parseHTML('<div import="loop1"></div>', body);
await mount(body, { quiet: true });
await test('each row picks its own branch from the loop scope', () => {
  assert.equal(text('[name="loop1"] .r'), '🍎 apple|🥕 carrot|❓ granite');
});
await test('a row mutation re-selects that row\'s branch', async () => {
  fire(body.querySelector('[name="loop1"] .promote'), 'click');
  await tick();
  assert.equal(text('[name="loop1"] .r'), '🍎 apple|🥕 carrot|🍎 granite');
});

// ─── nested chains inside an if branch ──────────────────────────────────
console.log('\nnested chains');
component('nest1', `
  <template if="outer">
    <div class="in">
      <template if="inner === 1"><p class="n">one</p></template>
      <template else-if="inner === 2"><p class="n">two</p></template>
      <template else><p class="n">other</p></template>
    </div>
  </template>
  <template else><p class="n">outer-off</p></template>
  <button class="two" onclick="{inner = 2}">2</button>
  <button class="off" onclick="{outer = false}">off</button>
  <script>
    let outer = true;
    let inner = 1;
  </script>
`);
parseHTML('<div import="nest1"></div>', body);
await mount(body, { quiet: true });
await test('a chain nested in an if branch selects correctly on first render', () => {
  assert.equal(text('[name="nest1"] .n'), 'one');
});
await test('nested chain re-selects reactively', async () => {
  fire(body.querySelector('[name="nest1"] .two'), 'click');
  await tick();
  assert.equal(text('[name="nest1"] .n'), 'two');
});
await test('outer else replaces the whole nested chain', async () => {
  fire(body.querySelector('[name="nest1"] .off'), 'click');
  await tick();
  assert.equal(text('[name="nest1"] .n'), 'outer-off');
});

// ─── non-template elements as branches ──────────────────────────────────
console.log('\nnon-template branches');
component('div1', `
  <section class="wrap">
    <div if="ok"><p class="d">yes: {v}</p></div>
    <div else><p class="d">no</p></div>
  </section>
  <button class="no" onclick="{ok = false}">no</button>
  <script>
    let ok = true;
    let v = 'v';
  </script>
`);
parseHTML('<div import="div1"></div>', body);
await mount(body, { quiet: true });
await test('plain elements work as chain branches (content → siblings, like if)', async () => {
  assert.equal(text('[name="div1"] .d'), 'yes: v');
  fire(body.querySelector('[name="div1"] .no'), 'click');
  await tick();
  assert.equal(text('[name="div1"] .d'), 'no');
});

// ─── malformed chains ───────────────────────────────────────────────────
console.log('\nmalformed chains');
component('orphan1', `
  <p class="o">before</p>
  <template else><p class="o">orphan</p></template>
  <script>let z = 1;</script>
`);
parseHTML('<div import="orphan1"></div>', body);
await mount(body, { quiet: true });
await test('an orphan else (no preceding if) renders nothing', () => {
  assert.equal(text('[name="orphan1"] .o'), 'before');
});

component('broken2', `
  <template if="false"><p class="k">if</p></template>
  <p class="k">interrupting prose</p>
  <template else><p class="k">else</p></template>
  <script>let q = 1;</script>
`);
parseHTML('<div import="broken2"></div>', body);
await mount(body, { quiet: true });
await test('a real element between branches breaks the chain (else orphaned)', () => {
  assert.equal(text('[name="broken2"] .k'), 'interrupting prose');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
