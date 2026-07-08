/** spark-html-motion — enter/leave transitions via the core lifecycle seam. */
import '../../spark/test/dom-shim.js';
import { Element, body, parseHTML } from '../../spark/test/dom-shim.js';
import { strict as assert } from 'node:assert';

// ── stub the Web Animations API on the shim's Element ──
// Records each .animate() call and lets the test settle it on demand.
const animations = [];
Element.prototype.animate = function (keyframes, opts) {
  let resolve;
  const finished = new Promise((r) => (resolve = r));
  const anim = { keyframes, opts, node: this, finished, settle: () => resolve() };
  animations.push(anim);
  return anim;
};
globalThis.matchMedia = () => ({ matches: false }); // not reduced-motion

const { mount, component } = await import('spark-html');
const { motion, presets } = await import('../src/index.js');

let pass = 0,
  fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const flushReady = async () => {
  await tick();
  await tick();
}; // past the double-rAF appear guard
function fire(el, type) {
  const e = { type, target: el };
  let n = el;
  while (n) {
    e.currentTarget = n;
    (n._listeners?.[type] || []).forEach((fn) => fn(e));
    n = n.parentNode;
  }
}

console.log('\nspark-html-motion');

motion({ appear: true, duration: 123, easing: 'ease-out' });

component(
  'list',
  `<ul><template each="t in items"><li transition="fade">{t}</li></template></ul>
   <button class="add" onclick="{add}">add</button>
   <button class="drop" onclick="{drop}">drop</button>
   <script>
   let items = ['a','b'];
   function add(){ items = [...items, 'c']; }
   function drop(){ items = items.slice(0, -1); }
   <\/script>`,
);
parseHTML('<div import="list"></div>', body);
await mount(body);
await flushReady();

const host = body.querySelector('[name="list"]');
const lis = () => host.querySelectorAll('li');

await test('initial enters animate with the "in" keyframes (appear:true)', () => {
  assert.equal(animations.length, 2, `expected 2 enter anims, got ${animations.length}`);
  assert.deepEqual(animations[0].keyframes, presets.fade.in);
  assert.equal(animations[0].opts.duration, 123);
  assert.equal(animations[0].opts.easing, 'ease-out');
});

await test('adding an item animates the new node in', async () => {
  animations.length = 0;
  fire(host.querySelector('.add'), 'click');
  await tick();
  assert.equal(lis().length, 3, 'item added');
  assert.equal(animations.length, 1, 'one enter animation');
  assert.deepEqual(animations[0].keyframes, presets.fade.in);
});

await test('removing an item runs "out" and DEFERS removal until finish', async () => {
  animations.length = 0;
  fire(host.querySelector('.drop'), 'click');
  await tick();
  assert.equal(animations.length, 1, 'one leave animation');
  assert.deepEqual(animations[0].keyframes, presets.fade.out);
  assert.equal(animations[0].opts.fill, 'forwards');
  assert.equal(lis().length, 3, 'leaving node held in DOM during exit anim');
  animations[0].settle();
  await tick();
  assert.equal(lis().length, 2, 'node removed after exit animation finished');
});

await test('a node WITHOUT a transition attribute is removed immediately', async () => {
  component(
    'plain',
    `<ul><template each="t in items"><li>{t}</li></template></ul>
     <button class="drop" onclick="{drop}">drop</button>
     <script>let items=['x','y']; function drop(){ items = items.slice(0,-1); }<\/script>`,
  );
  parseHTML('<div import="plain"></div>', body);
  await mount(body);
  await flushReady();
  const h2 = body.querySelectorAll('[name="plain"]')[0];
  animations.length = 0;
  fire(h2.querySelector('.drop'), 'click');
  await tick();
  assert.equal(animations.length, 0, 'no animation for non-transition nodes');
  assert.equal(h2.querySelectorAll('li').length, 1, 'removed synchronously');
});

await test('presets expose fade/slide/scale', () => {
  for (const k of ['fade', 'slide', 'scale']) {
    assert.ok(presets[k] && presets[k].in && presets[k].out, `${k} preset`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
