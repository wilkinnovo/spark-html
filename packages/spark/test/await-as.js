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
const text = () => body.textContent.replace(/\s+/g, ' ').trim();
const has = (s) => assert.ok(text().includes(s), `expected "${s}" in: ${text()}`);
const hasnt = (s) => assert.ok(!text().includes(s), `did NOT expect "${s}" in: ${text()}`);
const fire = (el, type) => (el._listeners[type] || []).forEach((f) => f({ type, target: el }));

console.log('\n<template await … as>');

// ── 1. as="name" in then branch ────────────────────────────────────────
await test('await … as="user" exposes the resolved value as {user.value}', async () => {
  const d = defer();
  globalThis.__ad1 = d;
  component('await-as-then', `
    <template await="data" as="user">
      <p>loading…</p>
      <template then><p>val:{user.value}</p></template>
      <template catch><p>err:{user.message}</p></template>
    </template>
    <script>let data = globalThis.__ad1.promise;<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-as-then"></div>`, body);
  await mount(body);
  await tick();
  has('loading…');
  hasnt('val:');

  d.resolve({ value: 42 });
  await tick();
  has('val:42');
  hasnt('loading…');
});

// ── 2. as="name" in catch branch ───────────────────────────────────────
await test('as="user" exposes the rejection error as {user.message} in the catch branch', async () => {
  const d = defer();
  globalThis.__ad2 = d;
  component('await-as-catch', `
    <template await="data" as="user">
      <p>loading…</p>
      <template then><p>val:{user.value}</p></template>
      <template catch><p>err:{user.message}</p></template>
    </template>
    <script>let data = globalThis.__ad2.promise;<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-as-catch"></div>`, body);
  await mount(body);
  await tick();
  has('loading…');

  d.reject(new Error('nope'));
  await tick();
  has('err:nope');
  hasnt('loading…');
});

// ── 3. backward compat: no as= still uses the bare `await` identifier ───
await test('without as=, {await.value} still works (backward compat)', async () => {
  const d = defer();
  globalThis.__ad3 = d;
  component('await-no-as', `
    <template await="data">
      <p>loading…</p>
      <template then><p>val:{await.value}</p></template>
    </template>
    <script>let data = globalThis.__ad3.promise;<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-no-as"></div>`, body);
  await mount(body);
  await tick();
  d.resolve({ value: 99 });
  await tick();
  has('val:99');
});

// ── 4. plain value (non-promise) with as= ──────────────────────────────
await test('as="user" with a plain value resolves immediately', async () => {
  component('await-as-plain', `
    <template await="data" as="user">
      <template then><p>val:{user.value}</p></template>
    </template>
    <script>let data = { value: 'plain' };<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-as-plain"></div>`, body);
  await mount(body);
  await tick();
  has('val:plain');
});

// ── 5. as="result" with a different name ────────────────────────────────
await test('as can use any name, e.g. as="result"', async () => {
  const d = defer();
  globalThis.__ad5 = d;
  component('await-as-result', `
    <template await="data" as="result">
      <template then><p>val:{result.value}</p></template>
    </template>
    <script>let data = globalThis.__ad5.promise;<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-as-result"></div>`, body);
  await mount(body);
  await tick();
  d.resolve({ value: 'hello' });
  await tick();
  has('val:hello');
});

// ── 6. once() with as= ──────────────────────────────────────────────────
await test('once(expr) with as="user" fires once on mount', async () => {
  globalThis.__ad6_calls = 0;
  globalThis.__ad6 = () => { globalThis.__ad6_calls++; return Promise.resolve({ name: 'once' }); };
  component('await-as-once', `
    <template await="once(globalThis.__ad6())" as="user">
      <template then><p>name:{user.name}</p></template>
    </template>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-as-once"></div>`, body);
  await mount(body);
  await tick();
  has('name:once');
  assert.equal(globalThis.__ad6_calls, 1);
});

// ── 7. both bare `await` and as= name work inside the branch ──────────
await test('both {await.value} and {user.value} are available when as="user"', async () => {
  const d = defer();
  globalThis.__ad7 = d;
  component('await-both', `
    <template await="data" as="user">
      <template then><p>a:{await.value}/u:{user.value}</p></template>
    </template>
    <script>let data = globalThis.__ad7.promise;<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-both"></div>`, body);
  await mount(body);
  await tick();
  d.resolve({ value: 'dual' });
  await tick();
  has('a:dual/u:dual');
});

// ── 8. reactive dependency change with as= ─────────────────────────────
await test('await="expr" with as="user" re-fires on dependency change, keeps the name', async () => {
  const a = defer(), b = defer();
  globalThis.__ad8 = { a: a.promise, b: b.promise };
  component('await-as-reactiv', `
    <button onclick="{swap}">swap</button>
    <template await="which === 'a' ? globalThis.__ad8.a : globalThis.__ad8.b" as="user">
      <p>loading…</p>
      <template then><p>got:{user.value}</p></template>
    </template>
    <script>let which = 'a'; function swap() { which = 'b'; }<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-as-reactiv"></div>`, body);
  await mount(body);
  await tick();

  a.resolve({ value: 'A' });
  await tick();
  has('got:A');

  fire(body.querySelector('button'), 'click');
  await tick();
  has('loading…');
  hasnt('got:A');

  b.resolve({ value: 'B' });
  await tick();
  has('got:B');
});

// ── 9. as= name shadows a parent scope variable ──────────────────────
await test('as="user" shadows a parent-scope let user inside then/catch', async () => {
  const d = defer();
  globalThis.__ad9 = d;
  component('await-shadow', `
    <template await="data" as="user">
      <template then><p>from-await:{user.value}</p></template>
    </template>
    <script>let user = 'parent'; let data = globalThis.__ad9.promise;<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-shadow"></div>`, body);
  await mount(body);
  await tick();
  d.resolve({ value: 'shadowed' });
  await tick();
  has('from-await:shadowed');
});

// ── 10. as= inside catch branch with a named error ───────────────────
await test('as="err" with a caught error resolves to the error object', async () => {
  const d = defer();
  globalThis.__ad10 = d;
  component('await-as-err', `
    <template await="data" as="err">
      <p>loading…</p>
      <template then><p>val:{err.value}</p></template>
      <template catch><p>msg:{err.message}</p></template>
    </template>
    <script>let data = globalThis.__ad10.promise;<\/script>
  `);
  body.childNodes = [];
  parseHTML(`<div import="await-as-err"></div>`, body);
  await mount(body);
  await tick();

  d.reject(new Error('oops'));
  await tick();
  has('msg:oops');
  hasnt('loading…');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
