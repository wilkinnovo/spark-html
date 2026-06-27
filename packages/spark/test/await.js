/**
 * <template await="promise"> — declarative async blocks.
 *   pending → <template then> (await = value) / <template catch> (await = error)
 */
import './dom-shim.js';
import { body, parseHTML } from './dom-shim.js';
import { strict as assert } from 'node:assert';

const { mount, component } = await import('../src/index.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.stack || e.message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 10));
function defer() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const fire = (el, type) => (el._listeners[type] || []).forEach((f) => f({ type, target: el }));
const text = () => body.textContent.replace(/\s+/g, ' ').trim();
const has = (s) => assert.ok(text().includes(s), `expected "${s}" in: ${text()}`);
const hasnt = (s) => assert.ok(!text().includes(s), `did NOT expect "${s}" in: ${text()}`);

console.log('\n<template await>');

// ── 1. pending → then ──────────────────────────────────────────────────
await test('shows pending, then resolves to <template then> with await.value', async () => {
  const d = defer();
  globalThis.__d1 = d;
  component('await-then', `
    <template await="data">
      <p>loading…</p>
      <template then><p>val:{await.value}</p></template>
      <template catch><p>err:{await.message}</p></template>
    </template>
    <script>let data = globalThis.__d1.promise;<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-then"></div>`, body);
  await mount(body);
  await tick();
  has('loading…');
  hasnt('val:');

  d.resolve({ value: 42 });
  await tick();
  has('val:42');
  hasnt('loading…');
});

// ── 2. pending → catch ─────────────────────────────────────────────────
await test('a rejected promise renders <template catch> with await.message', async () => {
  const d = defer();
  globalThis.__d2 = d;
  component('await-catch', `
    <template await="data">
      <p>loading…</p>
      <template then><p>val:{await.value}</p></template>
      <template catch><p>err:{await.message}</p></template>
    </template>
    <script>let data = globalThis.__d2.promise;<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-catch"></div>`, body);
  await mount(body);
  await tick();
  has('loading…');

  d.reject(new Error('boom'));
  await tick();
  has('err:boom');
  hasnt('loading…');
});

// ── 3. a non-thenable value resolves immediately ───────────────────────
await test('a plain (non-promise) value renders the then branch immediately', async () => {
  component('await-value', `
    <template await="data">
      <p>loading…</p>
      <template then><p>val:{await.value}</p></template>
    </template>
    <script>let data = { value: 7 };<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-value"></div>`, body);
  await mount(body);
  await tick();
  has('val:7');
  hasnt('loading…');
});

// ── 4. reactive: a dependency change cancels + refetches ───────────────
await test('await="expr" re-fires when a dependency changes (cancels prior)', async () => {
  const a = defer(), b = defer();
  globalThis.__pair = { a: a.promise, b: b.promise };
  component('await-reactive', `
    <button onclick="{swap}">swap</button>
    <template await="pick === 'a' ? globalThis.__pair.a : globalThis.__pair.b">
      <p>loading…</p>
      <template then><p>got:{await.value}</p></template>
    </template>
    <script>let pick = 'a'; function swap() { pick = 'b'; }<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-reactive"></div>`, body);
  await mount(body);
  await tick();

  a.resolve({ value: 'A' });
  await tick();
  has('got:A');

  // switch dep → shows pending for promise b, ignores the (already-resolved) a
  fire(body.querySelector('button'), 'click');
  await tick();
  has('loading…');
  hasnt('got:A');

  b.resolve({ value: 'B' });
  await tick();
  has('got:B');
});

// ── 5. once(expr) does NOT re-fire on dependency change ────────────────
await test('await="once(expr)" fires on mount only', async () => {
  globalThis.__onceCalls = 0;
  globalThis.__makePromise = () => { globalThis.__onceCalls++; return Promise.resolve({ value: globalThis.__onceCalls }); };
  component('await-once', `
    <button onclick="{inc}">inc</button>
    <template await="once(globalThis.__makePromise(dep))">
      <p>loading…</p>
      <template then><p>n:{await.value}</p></template>
    </template>
    <script>let dep = 0; function inc() { dep = dep + 1; }<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-once"></div>`, body);
  await mount(body);
  await tick();
  has('n:1');
  assert.equal(globalThis.__onceCalls, 1, 'expr evaluated once on mount');

  fire(body.querySelector('button'), 'click'); // change a real dep
  await tick();
  assert.equal(globalThis.__onceCalls, 1, 'once() did not re-evaluate the expr');
  has('n:1');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
