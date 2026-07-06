/**
 * Tests for slots (default + named + fallback, parent-scoped & reactive)
 * and deep reactivity (in-place array/object mutation).
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
  while (n) { (n._listeners?.[type] || []).forEach((fn) => fn(e)); n = n.parentNode; }
}

// ── a reusable wrapper component with default + named slots + fallback ──
component('card', `
<div class="card">
  <header class="hd"><slot name="title">Untitled</slot></header>
  <div class="body"><slot>nothing here</slot></div>
</div>
`);

// ── a page that fills the card's slots with parent-scoped content ──
component('cardpage', `
<div import="card">
  <span slot="title">{heading}</span>
  <p class="content">Count is {count}</p>
  <button class="inc" onclick="{inc}">+</button>
</div>
<div import="card"></div>
<script>
  let heading = 'Hello';
  let count = 0;
  function inc() { count++; }
</script>
`);

// ── deep reactivity ──
component('deeptest', `
<p class="len">{items.length}</p>
<p class="first">{items[0].n}</p>
<button class="push" onclick="{add}">add</button>
<button class="bump" onclick="{bump}">bump</button>
<script>
  let items = [{ n: 1 }];
  function add() { items.push({ n: items.length + 1 }); }
  function bump() { items[0].n = 99; }
</script>
`);

// ── regression: a script ending in a // line comment must still parse ──
// (the with(){} wrapper's closing brace must not be swallowed by the comment)
component('trailingcomment', `
<p class="tc">{msg}</p>
<script>
  let msg = 'parsed';
  function noop() { msg = 'changed'; } // trailing line comment with no newline
</script>`);

// ── regression: a SCRIPT-LESS component still renders its props ──
// (pure-UI components "render what they receive"; the no-script boot path
// used to install an empty scope and drop the props on the floor)
component('purecard', `<p class="pc">{label}</p>`);

// ── regression: an HTML comment mentioning <script> must not start an
// extraction that swallows the markup up to the real </script> ──
component('commented', `
<!-- prose that mentions <script> tags and even </script> in passing -->
<p class="cm">{msg}</p>
<script>
  let msg = 'intact';
</script>`);

// ── regression: a TOP-LEVEL (non-loop) import prop reading its OWN
// enclosing component's state must evaluate, not render literal braces.
// resolveImports() resolves the whole tree before any bootComponent() runs,
// so at the moment this prop is first read there's no scope yet to read
// `author` from — the fix retries once the parent (here: `navhost`) boots.
component('navchild', `<a class="brand">{blog}</a>`);

// ── regression: a server-baked '∅' prop (spark-ssr/spark-prerender's
// escape for a real empty STRING) must coerce to '', not boolean true.
// coerce() alone can't tell a bare attribute (<div import x>, HTML's
// "present with no value" convention == true) from one explicitly set to
// '' (a value a {expr} legitimately evaluated to) — both attributes read
// back identically as ''. The escape breaks that tie.
component('emptypropcard', `<p class="epc">{typeof label}:{JSON.stringify(label)}</p>`);
component('navhost', `
<div import="navchild" blog="{author.name}"></div>
<script>
  let author = { name: 'Ada' };
</script>`);

parseHTML('<div import="cardpage"></div><div import="deeptest"></div><div import="trailingcomment"></div><div import="purecard" label="From props"></div><div import="commented"></div><div import="navhost"></div><div import="emptypropcard" label="∅"></div>', body);
await mount();
await tick();

console.log('\nslots');
await test('default slot content renders (in parent scope)', () => {
  const content = body.querySelector('[name="cardpage"] .content');
  assert.ok(content, 'projected content should exist inside the card');
  assert.equal(content.childNodes[0].textContent, 'Count is 0');
});
await test('named slot content renders', () => {
  const hd = body.querySelectorAll('[name="cardpage"] .hd')[0];
  assert.equal(hd.textContent.trim(), 'Hello');
});
await test('fallback content shows when a slot is not filled', () => {
  // second card has no provided content → fallbacks
  const cards = body.querySelectorAll('[name="cardpage"] [name="card"]');
  assert.equal(cards.length, 2);
  const empty = cards[1];
  assert.equal(empty.querySelector('.body').textContent.trim(), 'nothing here');
  assert.equal(empty.querySelector('.hd').textContent.trim(), 'Untitled');
});
await test('slot handler runs in parent scope and re-renders slot content', async () => {
  fire(body.querySelector('[name="cardpage"] .inc'), 'click');
  await tick();
  const content = body.querySelector('[name="cardpage"] .content');
  assert.equal(content.childNodes[0].textContent, 'Count is 1');
});

console.log('\ndeep reactivity');
await test('initial values', () => {
  assert.equal(body.querySelector('[name="deeptest"] .len').textContent, '1');
  assert.equal(body.querySelector('[name="deeptest"] .first').textContent, '1');
});
await test('array.push() re-renders without replacing the array', async () => {
  fire(body.querySelector('[name="deeptest"] .push'), 'click');
  await tick();
  assert.equal(body.querySelector('[name="deeptest"] .len').textContent, '2');
});
await test('nested object property mutation re-renders', async () => {
  fire(body.querySelector('[name="deeptest"] .bump'), 'click');
  await tick();
  assert.equal(body.querySelector('[name="deeptest"] .first').textContent, '99');
});

console.log('\nrobustness');
await test('script ending in a // comment still parses and renders', () => {
  const el = body.querySelector('[name="trailingcomment"] .tc');
  assert.equal(el.textContent, 'parsed');
});
await test('a script-less component renders its props (props ARE its scope)', () => {
  const el = body.querySelector('[name="purecard"] .pc');
  assert.equal(el.textContent, 'From props');
});
await test('a "∅"-escaped prop coerces to an empty string, not boolean true', () => {
  const el = body.querySelector('[name="emptypropcard"] .epc');
  assert.equal(el.textContent, 'string:""', 'a real empty string, not the bare-attribute true');
});
await test('a comment mentioning <script> never swallows markup', () => {
  // (the dom-shim drops comment nodes at parse time, so only the markup
  // integrity is assertable here — spark-ssr's suite covers survival)
  const host = body.querySelector('[name="commented"]');
  assert.equal(host.querySelector('.cm').textContent, 'intact', 'script extracted, markup kept');
});
await test('a top-level import prop reading its own component\'s state evaluates', () => {
  const el = body.querySelector('[name="navhost"] [name="navchild"] .brand');
  assert.equal(el.textContent, 'Ada', 'must not render the literal "{author.name}"');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
