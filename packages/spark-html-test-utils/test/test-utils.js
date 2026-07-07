/**
 * spark-html-test-utils — exercised against the real spark-html runtime on
 * linkedom. Each test is what a consumer would write, so a break here is a
 * break in the documented recipe.
 */
import { strict as assert } from 'node:assert';
import { mount, fire, fireClick, fireInput, fireToggle, fireKey, fireDrag, inspect } from '../src/index.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.stack || e.message}`); }
}

console.log('\nspark-html-test-utils');

await test('mount renders a component and reflects reactive state', async () => {
  const h = await mount({
    root: '<div import="greet"></div>',
    components: { greet: '<h1>Hello {name}</h1><script>let name = "Ada";</script>' },
  });
  try {
    assert.match(h.html(), /Hello Ada/, 'initial render');
    h.scope().name = 'Grace';
    await h.settle();
    assert.match(h.html(), /Hello Grace/, 'scope write re-renders');
  } finally { h.cleanup(); }
});

await test('fireClick triggers a handler through addEventListener', async () => {
  const h = await mount({
    root: '<div import="counter"></div>',
    components: { counter: '<button onclick={inc}>{n}</button><script>let n = 0; function inc(){ n++; }</script>' },
  });
  try {
    assert.equal(h.query('button').textContent, '0');
    fireClick(h.query('button'));
    await h.settle();
    assert.equal(h.query('button').textContent, '1', 'click incremented');
    fireClick(h.query('button'));
    await h.settle();
    assert.equal(h.query('button').textContent, '2');
  } finally { h.cleanup(); }
});

await test('inspect.scope / inspect.deps read the same internals as the handle', async () => {
  const h = await mount({
    root: '<div import="c"></div>',
    components: { c: '<p>{n}</p><script>let n = 1;</script>' },
  });
  try {
    const host = h.el;
    assert.ok(host, 'a host booted');
    assert.equal(inspect.scope(host).n, 1, 'top-level inspect.scope matches');
    assert.equal(h.scope().n, 1, 'handle.scope matches');
    // deps() returns a Set (tracked keys) or null — never throws on a real node.
    const d = h.deps(h.query('p'));
    assert.ok(d === null || d instanceof Set, 'deps is a Set or null');
  } finally { h.cleanup(); }
});

await test('fireInput drives a bind:value', async () => {
  const h = await mount({
    root: '<div import="echo"></div>',
    components: { echo: '<input bind:value="text"><p class="out">{text}</p><script>let text = "";</script>' },
  });
  try {
    fireInput(h.query('input'), 'typed');
    await h.settle();
    assert.equal(h.query('.out').textContent, 'typed', 'bind:value reflected to {text}');
    assert.equal(h.scope().text, 'typed', 'scope updated');
  } finally { h.cleanup(); }
});

await test('fireToggle drives a bind:checked', async () => {
  const h = await mount({
    root: '<div import="chk"></div>',
    components: { chk: '<input type="checkbox" bind:checked="on"><p class="s">{on ? "on" : "off"}</p><script>let on = false;</script>' },
  });
  try {
    assert.equal(h.query('.s').textContent, 'off');
    fireToggle(h.query('input'), true);
    await h.settle();
    assert.equal(h.query('.s').textContent, 'on', 'checkbox change reflected');
  } finally { h.cleanup(); }
});

await test('fire passes custom props (key) to the handler', async () => {
  const h = await mount({
    root: '<div import="keys"></div>',
    components: { keys: '<input onkeydown={k}><p class="last">{last}</p><script>let last = ""; function k(e){ last = e.key; }</script>' },
  });
  try {
    fireKey(h.query('input'), 'Enter');
    await h.settle();
    assert.equal(h.query('.last').textContent, 'Enter', 'event.key reached the handler');
  } finally { h.cleanup(); }
});

await test('fireDrag delivers a pointerdown→move→up sequence with coordinates', async () => {
  const h = await mount({
    root: '<div import="drag"></div>',
    components: { drag:
      '<div class="box" onpointerdown={handle} onpointermove={handle} onpointerup={handle}>{log}</div>'
      + '<script>\nlet log = "idle";\nfunction handle(e){ log = e.type + "@" + e.clientX; }\n</script>' },
  });
  try {
    fireDrag(h.query('.box'), { from: { x: 5, y: 5 }, to: { x: 42, y: 9 } });
    await h.settle();
    assert.equal(h.query('.box').textContent, 'pointerup@42', 'the full drag ran, ending at the drop x');
  } finally { h.cleanup(); }
});

await test('cleanup restores globals so a second mount is isolated', async () => {
  const before = globalThis.document;
  const h1 = await mount('<p>one</p>');
  h1.cleanup();
  assert.equal(globalThis.document, before, 'globalThis.document restored after cleanup');
  const h2 = await mount({ root: '<div import="c2"></div>', components: { c2: '<b>{x}</b><script>let x = 2;</script>' } });
  try {
    assert.match(h2.html(), /<b>2<\/b>/, 'second mount works independently');
  } finally { h2.cleanup(); }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
