/**
 * Fault isolation + dev error overlay.
 *
 * A failure in one component must never blank the page or block a sibling.
 * And with { devOverlay: true }, failures surface in a dismissible overlay.
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
const fire = (el, type) => {
  let n = el;
  while (n) { (n._listeners?.[type] || []).forEach((f) => f({ type, target: el })); n = n.parentNode; }
};
const txt = (el) => (el ? el.textContent : '');

// Quiet the expected console noise but keep a record.
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(' '));

component('goodsib', `<p class="ok">{msg}</p><script>let msg = 'I rendered';</script>`);
component('badscript', `<p class="x">{y}</p><script>let y = nope.deep.value;</script>`);
component('badscript2', `<p class="x">{z}</p><script>let z = alsoNope.deep;</script>`);
component('badhandler', `
  <button class="b" onclick="{boom}">go</button>
  <script>function boom() { throw new Error('handler kaboom'); }</script>
`);

const overlays = () => body.querySelectorAll('[data-spark-overlay]');

// ── Phase 1: isolation, overlay OFF (default) ──
parseHTML('<div import="badscript"></div><div import="goodsib"></div>', body);
await mount();
await tick();

console.log('\nfault isolation (overlay off by default)');
await test('a broken component does not block a sibling from rendering', () => {
  assert.equal(txt(body.querySelector('[name="goodsib"] .ok')), 'I rendered');
});
await test('the broken component is revealed, not stranded cloaked', () => {
  const bad = body.querySelector('[name="badscript"]');
  assert.ok(bad.hasAttribute('data-spark-ready'), 'should be revealed');
  assert.ok(!bad.hasAttribute('data-spark-cloak'), 'should not stay cloaked');
});
await test('the failure was reported to the console (component named)', () => {
  assert.ok(warnings.some((w) => w.includes('badscript')), 'console should name it');
});
await test('NO overlay is created when devOverlay is off', () => {
  assert.equal(overlays().length, 0);
});

// ── Phase 2: overlay ON ──
const c2 = document.createElement('div');
body.appendChild(c2);
parseHTML('<div import="badscript2"></div>', c2);
await mount(c2, { devOverlay: true });
await tick();

console.log('\ndev error overlay (opt-in)');
await test('an overlay appears on failure when devOverlay is on', () => {
  assert.equal(overlays().length, 1, 'one overlay element');
});
await test('the overlay names the failing component and shows the message', () => {
  const ov = overlays()[0];
  assert.ok(ov.textContent.includes('badscript2'), 'names component');
  assert.ok(/is not defined|alsoNope/.test(ov.textContent), 'shows the error');
});
await test('a throwing event handler is contained and surfaced', async () => {
  const c3 = document.createElement('div');
  body.appendChild(c3);
  parseHTML('<div import="badhandler"></div>', c3);
  await mount(c3, { devOverlay: true });
  await tick();
  // page still alive: the button exists and clicking it does not throw
  const btn = body.querySelector('[name="badhandler"] .b');
  assert.doesNotThrow(() => fire(btn, 'click'));
  await tick();
  assert.ok(overlays()[0].textContent.includes('handler kaboom'), 'handler error surfaced');
});
await test('dismiss removes the overlay', () => {
  const ov = overlays()[0];
  // the dismiss button is the one with a click listener in the header
  const btn = ov.querySelectorAll('button').find((b) => b._listeners?.click?.length);
  fire(btn, 'click');
  assert.equal(overlays().length, 0, 'overlay removed after dismiss');
});

console.warn = realWarn;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
