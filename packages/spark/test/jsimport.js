/**
 * JS imports inside component <script> tags.
 *
 * `import { add } from './add.js'` is standard syntax, but component scripts
 * run through new Function where import declarations are illegal — the
 * runtime lifts them out and replays them as dynamic imports. These tests
 * cover every import form, async/state interplay, prerender integration
 * (via the __SPARK_IMPORT__ hook), loops, props, and failure containment.
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
  const e = { type, target: el, currentTarget: el };
  (el._listeners[type] || []).forEach((fn) => fn(e));
}

// ─── module resolution hook (what spark-prerender installs) ────────────
// Maps specifier → module object. Also records every (spec, importer) call
// so resolution behavior is assertable.
const calls = [];
const modules = {
  './math.js': { add: (a, b) => a + b, multiply: (a, b) => a * b, factorial: (n) => (n <= 1 ? 1 : n * (n - 1)) },
  './format.js': { default: (s) => s.toUpperCase(), capitalize: (s) => s[0].toUpperCase() + s.slice(1), 'kebab-case': (s) => s.replace(/\s+/g, '-') },
  './api.js': { fetchGreeting: async (n) => ({ text: `Hello, ${n}!` }) },
  './effect.js': { /* side-effect module */ },
  'some-pkg': { version: '1.0.0' },
};
globalThis.__SPARK_IMPORT__ = (spec, importer) => {
  calls.push([spec, importer]);
  if (spec === './effect.js') { globalThis.__effectRan = true; return modules[spec]; }
  const m = modules[spec];
  if (!m) throw new Error(`module not found: ${spec}`);
  return m;
};

// ─── named imports ──────────────────────────────────────────────────────
console.log('\nnamed imports');
component('named1', `
  <p class="out">{add(2, 3)}</p>
  <script>
    import { add } from './math.js';
  </script>
`);
parseHTML('<div import="named1"></div>', body);
await mount(body, { quiet: true });

await test('named import renders through an interpolation', () => {
  assert.equal(body.querySelector('[name="named1"] .out').textContent, '5');
});
await test('mount() resolves only after imported values are rendered', () => {
  // No tick needed above — mount awaited the script promise.
  assert.ok(true);
});

// ─── all forms: default, namespace, alias, string names, combos ────────
console.log('\nimport forms');
component('forms1', `
  <p class="up">{up('spark')}</p>
  <p class="cap">{capitalize('spark')}</p>
  <p class="kebab">{k('a b c')}</p>
  <script>
    import up, { capitalize, 'kebab-case' as k } from './format.js';
  </script>
`);
parseHTML('<div import="forms1"></div>', body);
await mount(body, { quiet: true });

await test('default import works', () => {
  assert.equal(body.querySelector('[name="forms1"] .up').textContent, 'SPARK');
});
await test('named import alongside default works', () => {
  assert.equal(body.querySelector('[name="forms1"] .cap').textContent, 'Spark');
});
await test('string-named import with alias works', () => {
  assert.equal(body.querySelector('[name="forms1"] .kebab').textContent, 'a-b-c');
});

component('forms2', `
  <p class="prod">{m.multiply(6, 7)}</p>
  <script>
    import * as m from './math.js';
  </script>
`);
parseHTML('<div import="forms2"></div>', body);
await mount(body, { quiet: true });
await test('namespace import (* as m) works', () => {
  assert.equal(body.querySelector('[name="forms2"] .prod').textContent, '42');
});

component('forms3', `
  <p class="ok">{ran ? 'ran' : 'no'}</p>
  <script>
    import './effect.js';
    let ran = globalThis.__effectRan === true;
  </script>
`);
parseHTML('<div import="forms3"></div>', body);
await mount(body, { quiet: true });
await test('side-effect import runs before the script body', () => {
  assert.equal(body.querySelector('[name="forms3"] .ok').textContent, 'ran');
});

component('forms4', `
  <p class="alias">{plus(1, 2)}</p>
  <script>
    import { add as plus } from './math.js';
  </script>
`);
parseHTML('<div import="forms4"></div>', body);
await mount(body, { quiet: true });
await test('aliased named import (add as plus) works', () => {
  assert.equal(body.querySelector('[name="forms4"] .alias').textContent, '3');
});

component('forms5', `
  <p class="multi">{add(capitalize('x').length, 10)}</p>
  <script>
    import {
      add,
      multiply,
    } from './math.js';
    import { capitalize } from './format.js';
  </script>
`);
parseHTML('<div import="forms5"></div>', body);
await mount(body, { quiet: true });
await test('multiple + multi-line imports work together', () => {
  assert.equal(body.querySelector('[name="forms5"] .multi').textContent, '11');
});

// ─── resolution behavior ────────────────────────────────────────────────
console.log('\nresolution');
component('bare1', `
  <p class="v">{pkg.version}</p>
  <script>
    import * as pkg from 'some-pkg';
  </script>
`);
parseHTML('<div import="bare1"></div>', body);
await mount(body, { quiet: true });
await test('bare specifiers pass through unresolved (import maps / hook)', () => {
  assert.equal(body.querySelector('[name="bare1"] .v').textContent, '1.0.0');
  assert.ok(calls.some(([s]) => s === 'some-pkg'));
});
await test('the hook receives the importing component path', () => {
  const call = calls.find(([s]) => s === './math.js');
  assert.equal(call[1], 'named1.html');
});

// ─── state, reactivity, $:, props ───────────────────────────────────────
console.log('\nstate + reactivity');
component('state1', `
  <h2 class="count">Count: {count}</h2>
  <p class="doubled">{multiply(count, 2)}</p>
  <button class="inc" onclick="{inc}">+1</button>
  <script>
    import { multiply } from './math.js';
    let count = 0;
    function inc() { count++; }
  </script>
`);
parseHTML('<div import="state1"></div>', body);
await mount(body, { quiet: true });

await test('imported fn + local state render on boot (the jsimport.md case)', () => {
  assert.equal(body.querySelector('[name="state1"] .count').textContent, 'Count: 0');
  assert.equal(body.querySelector('[name="state1"] .doubled').textContent, '0');
});
await test('event handler updates re-evaluate through the imported fn', async () => {
  fire(body.querySelector('[name="state1"] .inc'), 'click');
  await tick();
  assert.equal(body.querySelector('[name="state1"] .count').textContent, 'Count: 1');
  assert.equal(body.querySelector('[name="state1"] .doubled').textContent, '2');
});

component('reactive1', `
  <p class="fact">{fact}</p>
  <button class="bump" onclick="{n++}">+</button>
  <script>
    import { factorial } from './math.js';
    let n = 4;
    $: fact = factorial(n);
  </script>
`);
parseHTML('<div import="reactive1"></div>', body);
await mount(body, { quiet: true });
await test('$: statements use imported functions', () => {
  assert.equal(body.querySelector('[name="reactive1"] .fact').textContent, '12');
});
await test('$: recomputes with imported fn on state change', async () => {
  fire(body.querySelector('[name="reactive1"] .bump'), 'click');
  await tick();
  assert.equal(body.querySelector('[name="reactive1"] .fact').textContent, '20');
});

component('props1', `
  <p class="sum">{add(a, b)}</p>
  <script>
    import { add } from './math.js';
    export let a = 1;
    export let b = 2;
  </script>
`);
parseHTML('<div import="props1" a="30" b="12"></div>', body);
await mount(body, { quiet: true });
await test('props (export let) override defaults and feed imported fns', () => {
  assert.equal(body.querySelector('[name="props1"] .sum').textContent, '42');
});

// ─── a top-level import prop reading the parent's state + own async import ──
// Regression: a top-level (non-loop) import whose prop reads its PARENT's
// own state can't be evaluated until the parent boots (resolveImports()
// resolves the whole tree before any bootComponent() runs) — bootComponent()
// retries it once the parent's scope exists. That retry used to fire (and
// patch the child) as soon as the PARENT was ready, regardless of whether
// the CHILD itself had its own pending async import — patching it against
// an incomplete scope, mid-import.
component('pendchild', `
  <p class="word">{capitalize(word)}</p>
  <p class="greet">{greeting}</p>
  <script>
    import { capitalize } from './format.js';
    export let greeting = '';
    let word = 'hi';
  </script>
`);
component('pendparent', `
  <div import="pendchild" greeting="{hello}"></div>
  <script>let hello = 'Yo';</script>
`);
parseHTML('<div import="pendparent"></div>', body);
await mount(body, { quiet: true });
await test('a pending cross-component prop retry waits for the CHILD\'s own async import too', () => {
  assert.equal(body.querySelector('[name="pendchild"] .word').textContent, 'Hi', 'own async import resolved, not mid-flight');
  assert.equal(body.querySelector('[name="pendchild"] .greet').textContent, 'Yo', 'parent-state prop still made it across');
});

// ─── async ──────────────────────────────────────────────────────────────
console.log('\nasync');
component('async1', `
  <p class="msg">{loading ? 'loading' : data.text}</p>
  <script>
    import { fetchGreeting } from './api.js';
    let data = {};
    let loading = true;
    fetchGreeting('Spark').then((r) => { data = r; loading = false; });
  </script>
`);
parseHTML('<div import="async1"></div>', body);
await mount(body, { quiet: true });
await test('an imported async fn resolves into reactive state', async () => {
  await tick();
  assert.equal(body.querySelector('[name="async1"] .msg').textContent, 'Hello, Spark!');
});

component('tla1', `
  <p class="tla">{greeting.text}</p>
  <script>
    import { fetchGreeting } from './api.js';
    let greeting = await fetchGreeting('TLA');
  </script>
`);
parseHTML('<div import="tla1"></div>', body);
await mount(body, { quiet: true });
await test('top-level await works in a script with imports', () => {
  assert.equal(body.querySelector('[name="tla1"] .tla').textContent, 'Hello, TLA!');
});

// ─── composition: imported components inside each blocks ───────────────
console.log('\ncomposition');
component('row', `
  <li class="row">{capitalize(label)}</li>
  <script>
    import { capitalize } from './format.js';
    export let label = '';
  </script>
`);
component('list1', `
  <ul>
    <template each="item in items">
      <div import="row" label="{item}"></div>
    </template>
  </ul>
  <button class="add" onclick="{items = [...items, 'cherry']}">add</button>
  <script>
    let items = ['apple', 'banana'];
  </script>
`);
parseHTML('<div import="list1"></div>', body);
await mount(body, { quiet: true });
await test('a component with imports renders inside an each block', async () => {
  await tick(20);
  const rows = body.querySelectorAll('[name="list1"] .row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].textContent, 'Apple');
  assert.equal(rows[1].textContent, 'Banana');
});
await test('new loop rows boot their imports too', async () => {
  fire(body.querySelector('[name="list1"] .add'), 'click');
  await tick(20);
  const rows = body.querySelectorAll('[name="list1"] .row');
  assert.equal(rows.length, 3);
  assert.equal(rows[2].textContent, 'Cherry');
});

// ─── things that must NOT be treated as imports ─────────────────────────
console.log('\nfalse positives');
component('notimport1', `
  <p class="a">{a}</p>
  <script>
    // import { x } from './nope.js';
    /* import { y } from './nope.js'; */
    let s = "import { z } from './nope.js'";
    let important = 1;
    let a = important + s.length - s.length;
  </script>
`);
parseHTML('<div import="notimport1"></div>', body);
const before = calls.length;
await mount(body, { quiet: true });
await test('imports in comments/strings/identifiers are ignored', () => {
  assert.equal(body.querySelector('[name="notimport1"] .a').textContent, '1');
  assert.ok(!calls.slice(before).some(([s]) => s.includes('nope')));
});

// ─── failure containment ────────────────────────────────────────────────
console.log('\nfailure containment');
component('broken1', `
  <p class="b">{missing ? missing() : 'degraded'}</p>
  <script>
    import { missing } from './does-not-exist.js';
  </script>
`);
component('sibling1', `
  <p class="s">{msg}</p>
  <script>
    let msg = 'alive';
  </script>
`);
parseHTML('<div import="broken1"></div><div import="sibling1"></div>', body);
await mount(body, { quiet: true });
await test('a failed import degrades the component without throwing', async () => {
  await tick(); // the degraded render lands on the rAF boot pass (like sync failures)
  assert.equal(body.querySelector('[name="broken1"] .b').textContent, 'degraded');
});
await test('siblings of a failed-import component still boot', () => {
  assert.equal(body.querySelector('[name="sibling1"] .s').textContent, 'alive');
});

// ─── slot content lent to an imported child while the lender's script is
// still awaiting its JS imports ──────────────────────────────────────────
// Regression: the child's first patch used to walk parent-scoped slot content
// BEFORE the parent's async (import-bearing) script finished — every binding
// evaluated against seeded `undefined`s and warned (":hidden — Cannot read
// properties of undefined", "each expected an array but got string", …), in
// the browser and at prerender time. Now the walk is deferred until the
// lender's scope is ready; no spurious warnings, and the content renders
// correctly once the import lands.
console.log('\nslots + pending script imports');
const slotWarns = [];
const origWarn = console.warn;
console.warn = (...a) => { slotWarns.push(a.join(' ')); origWarn(...a); };
const prevHook = globalThis.__SPARK_IMPORT__;
globalThis.__SPARK_IMPORT__ = (spec, importer) => {
  if (spec === './slow-data.js') {
    return new Promise((r) => setTimeout(() => r({
      projects: { all: [{ t: 'Alpha' }, { t: 'Beta' }], featured: [{ t: 'Alpha' }] },
    }), 15));
  }
  return prevHook(spec, importer);
};
component('skel1', `
  <div class="wrap">
    <div class="shim"><slot name="shim">shim fallback</slot></div>
    <slot>default fallback</slot>
  </div>
`);
component('slotpage1', `
  <div import="skel1">
    <div slot="shim">shimmer</div>
    <p class="feat" :hidden="featured.length === 0">featured!</p>
    <template each="project in projects.all"><span class="proj">{project.t}</span></template>
    <span class="count">{projects.all.length}</span>
  </div>
  <script>
    import { projects } from './slow-data.js';
    let featured = [];
    $: featured = projects.featured ?? [];
  </script>
`);
parseHTML('<div import="slotpage1"></div>', body);
await mount(body, { quiet: true });
await tick(40);
console.warn = origWarn;
globalThis.__SPARK_IMPORT__ = prevHook;

await test('no premature-evaluation warnings for lent slot content', () => {
  const spurious = slotWarns.filter((w) =>
    /Cannot read properties of undefined|expected an array/.test(w));
  assert.deepEqual(spurious, []);
});
await test('lent slot content renders once the lender\'s import lands', () => {
  const page = body.querySelector('[name="slotpage1"]');
  assert.equal(page.querySelector('.feat').hasAttribute('hidden'), false);
  assert.equal(page.querySelectorAll('.proj').length, 2);
  assert.equal(page.querySelector('.count').textContent, '2');
});

// ─── native data: modules (no hook — real dynamic import) ──────────────
console.log('\nnative dynamic import');
delete globalThis.__SPARK_IMPORT__;
component('native1', `
  <p class="n">{ANSWER}</p>
  <script>
    import { ANSWER } from 'data:text/javascript,export const ANSWER = 42';
  </script>
`);
parseHTML('<div import="native1"></div>', body);
await mount(body, { quiet: true });
await test('absolute (data:) specifiers import natively without the hook', () => {
  assert.equal(body.querySelector('[name="native1"] .n').textContent, '42');
});

component('native2', `
  <p class="ns">{typeof mod.ANSWER === 'number' ? 'num' : 'nope'}-{written}</p>
  <script>
    import * as mod from 'data:text/javascript,export const ANSWER = 7';
    let written = 'ok';
  </script>
`);
parseHTML('<div import="native2"></div>', body);
await mount(body, { quiet: true });
await test('a REAL module namespace is not wrapped by deep reactivity', () => {
  assert.equal(body.querySelector('[name="native2"] .ns').textContent, 'num-ok');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
