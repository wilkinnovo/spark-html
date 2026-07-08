/**
 * Multi-line `$:` reactive statements. The extractor scans with bracket-depth
 * + ASI-lite continuation, so a `$:` can span lines when it sits inside
 * brackets, ends on an operator, or the next line starts with one.
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
function fire(el, type) {
  const e = { type, target: el };
  let n = el;
  while (n) { e.currentTarget = n; (n._listeners?.[type] || []).forEach((fn) => fn(e)); n = n.parentNode; }
}

// ternary split with the operators at the START of each line
component('mlternary', `
<p class="out">{label}</p>
<button class="t" onclick="{toggle}">t</button>
<script>
  let on = false;
  $: label = on
    ? 'YES'
    : 'NO';
  function toggle() { on = !on; }
</script>`);

// ternary split with the operators at the END of each line
component('mltrailing', `
<p class="out">{label}</p>
<button class="t" onclick="{bump}">t</button>
<script>
  let n = 0;
  $: label =
    n > 0 ?
    'positive' :
    'zero';
  function bump() { n = 1; }
</script>`);

// statement that spans lines because it's inside brackets (a callback with
// its own { } block), wrapped in a multi-line ternary
component('mlfilter', `
<p class="len">{visible.length}</p>
<button class="f" onclick="{flip}">f</button>
<script>
  let all = [1, 2, 3, 4];
  let evensOnly = false;
  $: visible = evensOnly
    ? all.filter((x) => {
        return x % 2 === 0;
      })
    : all;
  function flip() { evensOnly = true; }
</script>`);

// method chain across lines (leading-dot continuation)
component('mlchain', `
<p class="out">{shout}</p>
<script>
  let word = '  hi  ';
  $: shout = word
    .trim()
    .toUpperCase();
</script>`);

// boundary: a regular statement after a multi-line $: must survive, and a
// second $: after it must still be picked up
component('mlboundary', `
<p class="a">{doubled}</p>
<p class="b">{total}</p>
<script>
  let count = 3;
  let extra = 10;
  $: doubled = count
    * 2;
  $: total = doubled + extra;
</script>`);

// comments after a $: must not read as continuations: a trailing '.' in a
// comment is prose, not a member access, and a next line starting '//' is a
// comment, not division — the following declaration stays a real statement.
component('mlcomment', `
<p class="out">{label}</p>
<script>
  let n = 1;
  $: if (n > 99) { n = 0; }
  // this comment ends with a CONT_END char, a period.
  // and this line starts with slashes like an operator.
  let label = 'kept';
</script>`);

// control: single-line $: keeps working exactly as before
component('slcontrol', `
<p class="out">{d}</p>
<script>
  let c = 5;
  $: d = c * 2;
</script>`);

parseHTML(
  '<div import="mlternary"></div><div import="mltrailing"></div>' +
  '<div import="mlfilter"></div><div import="mlchain"></div>' +
  '<div import="mlboundary"></div><div import="mlcomment"></div><div import="slcontrol"></div>',
  body,
);
await mount();
await tick();

console.log('\nmulti-line $: reactive statements');
await test('ternary with operators at line start computes', () => {
  assert.equal(body.querySelector('[name="mlternary"] .out').textContent, 'NO');
});
await test('…and re-runs when a dependency changes', async () => {
  fire(body.querySelector('[name="mlternary"] .t'), 'click');
  await tick();
  assert.equal(body.querySelector('[name="mlternary"] .out').textContent, 'YES');
});
await test('ternary with operators at line end computes', () => {
  assert.equal(body.querySelector('[name="mltrailing"] .out').textContent, 'zero');
});
await test('…and re-runs when a dependency changes', async () => {
  fire(body.querySelector('[name="mltrailing"] .t'), 'click');
  await tick();
  assert.equal(body.querySelector('[name="mltrailing"] .out').textContent, 'positive');
});
await test('statement spanning a bracketed callback block computes', () => {
  assert.equal(body.querySelector('[name="mlfilter"] .len').textContent, '4');
});
await test('…and re-filters reactively', async () => {
  fire(body.querySelector('[name="mlfilter"] .f'), 'click');
  await tick();
  assert.equal(body.querySelector('[name="mlfilter"] .len').textContent, '2');
});
await test('method chain across lines computes', () => {
  assert.equal(body.querySelector('[name="mlchain"] .out').textContent, 'HI');
});
await test('a regular statement after a multi-line $: is not swallowed', () => {
  // total = doubled + extra; if `extra` had been eaten into the doubled
  // statement, total would be NaN. 6 + 10 = 16.
  assert.equal(body.querySelector('[name="mlboundary"] .a').textContent, '6');
  assert.equal(body.querySelector('[name="mlboundary"] .b').textContent, '16');
});
await test('a declaration after a $: + trailing-period comment is not swallowed', () => {
  assert.equal(body.querySelector('[name="mlcomment"] .out').textContent, 'kept');
});
await test('single-line $: still works (control)', () => {
  assert.equal(body.querySelector('[name="slcontrol"] .out').textContent, '10');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
