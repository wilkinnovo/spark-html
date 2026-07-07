/**
 * Convergence fuzzer for the Spark reactivity engine.
 *
 * Generates random component trees (each/if/await/import to depth 4–5),
 * runs random mutation sequences, then ORACLE-checks: does the patched DOM
 * match a from-scratch mount of the same final state? Any divergence means
 * a reconciliation bug — minimized and checked into fuzz-corpus/.
 *
 * Usage:  node packages/spark/test/fuzz.js [N scenarios]
 *                             default 500  (CI seed run)
 *                             use 10000+ for the nightly soak
 */
import './dom-shim.js';
import { body, parseHTML } from './dom-shim.js';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const { mount, component, store } = await import('../src/index.js');

function mulberry32(a) {
  return () => {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

function serializeDOM(el) {
  const parts = [];
  walk(el, parts);
  return parts.join('|');
}
function walk(el, parts) {
  for (const node of el.childNodes) {
    if (node.nodeType === 3) {
      const t = node.textContent;
      if (t.length > 0) parts.push('T:' + t);
    } else if (node.nodeType === 1) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'template') continue;
      const cls = node.getAttribute('class') || '';
      const name = node.getAttribute('name') || '';
      parts.push('E:' + (name || cls || tag));
      walk(node, parts);
    }
  }
}

function setScopeVar(el, name, val) {
  if (el.__sparkScope) el.__sparkScope[name] = val;
}

// ── Template library ───────────────────────────────────────────────────
// Each template has gen(rng,id)→{name,source,mutators,schema}
// and rebuild(state,name)→{name,source} for fresh mounting.

const templates = [];

// 0: Simple scalar
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const x = Math.floor(rng() * 100);
    return { name, source: `<p class="o">{x}</p><script>let x = ${x};</script>`, mutators: [
      { desc: 'set x', apply: (el) => { const nv = Math.floor(rng() * 100); setScopeVar(el, 'x', nv); return { x: nv }; } },
    ], schema: { x } };
  },
  rebuild(state, name) {
    return { name, source: `<p class="o">{x}</p><script>let x = ${state.x};</script>` };
  },
});

// 1: Boolean toggle (if)
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const show = rng() > 0.5;
    return { name, source: `<template if="show"><p class="in">vis</p></template><p class="st">{show?'on':'off'}</p><script>let show = ${show};</script>`, mutators: [
      { desc: 'toggle show', apply: (el) => { const nv = !el.__sparkScope?.show; setScopeVar(el, 'show', nv); return { show: nv }; } },
    ], schema: { show } };
  },
  rebuild(state, name) {
    return { name, source: `<template if="show"><p class="in">vis</p></template><p class="st">{show?'on':'off'}</p><script>let show = ${state.show};</script>` };
  },
});

// 2: Array each
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const len = Math.floor(rng() * 4) + 1;
    const items = [];
    for (let i = 0; i < len; i++) items.push(pick(rng, ['a', 'b', 'c']));
    return { name, source: `<template each="x in items"><span class="rw">{x}</span></template><p class="ln">{items.length}</p><script>let items = ${JSON.stringify(items)};</script>`, mutators: [
      { desc: 'replace items', apply: (el) => { const nv = [pick(rng, ['m', 'n']), pick(rng, ['m', 'n'])]; setScopeVar(el, 'items', nv); return { items: nv }; } },
    ], schema: { items } };
  },
  rebuild(state, name) {
    return { name, source: `<template each="x in items"><span class="rw">{x}</span></template><p class="ln">{items.length}</p><script>let items = ${JSON.stringify(state.items)};</script>` };
  },
});

// 3: Nested if→each
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const show = rng() > 0.5;
    const len = Math.floor(rng() * 3) + 1;
    const items = [];
    for (let i = 0; i < len; i++) items.push(pick(rng, ['x', 'y']));
    return { name, source: `<template if="show"><template each="v in items"><span class="nv">{v}</span></template></template><script>let show = ${show}; let items = ${JSON.stringify(items)};</script>`, mutators: [
      { desc: 'toggle show', apply: (el) => { const nv = !el.__sparkScope?.show; setScopeVar(el, 'show', nv); return { show: nv }; } },
      { desc: 'replace items', apply: (el) => { const nv = [pick(rng, ['p', 'q'])]; setScopeVar(el, 'items', nv); return { items: nv }; } },
    ], schema: { show, items } };
  },
  rebuild(state, name) {
    return { name, source: `<template if="show"><template each="v in items"><span class="nv">{v}</span></template></template><script>let show = ${state.show}; let items = ${JSON.stringify(state.items)};</script>` };
  },
});

// 4: Multi-var with $:
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const a = Math.floor(rng() * 50);
    const b = Math.floor(rng() * 50);
    return { name, source: `<p class="a">{a}</p><p class="b">{b}</p><p class="s">{sum}</p><script>let a = ${a}; let b = ${b}; $: sum = a + b;</script>`, mutators: [
      { desc: 'set a', apply: (el) => { const nv = Math.floor(rng() * 100); setScopeVar(el, 'a', nv); return { a: nv }; } },
      { desc: 'set b', apply: (el) => { const nv = Math.floor(rng() * 100); setScopeVar(el, 'b', nv); return { b: nv }; } },
    ], schema: { a, b } };
  },
  rebuild(state, name) {
    return { name, source: `<p class="a">{a}</p><p class="b">{b}</p><p class="s">{sum}</p><script>let a = ${state.a}; let b = ${state.b}; $: sum = a + b;</script>` };
  },
});

// 5: Each with index
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const len = Math.floor(rng() * 3) + 1;
    const items = [];
    for (let i = 0; i < len; i++) items.push(pick(rng, ['d', 'e', 'f']));
    return { name, source: `<template each="x, i in items"><span class="ri">{i}:{x}</span></template><script>let items = ${JSON.stringify(items)};</script>`, mutators: [
      { desc: 'replace items', apply: (el) => { const nv = [pick(rng, ['g', 'h']), pick(rng, ['g', 'h'])]; setScopeVar(el, 'items', nv); return { items: nv }; } },
    ], schema: { items } };
  },
  rebuild(state, name) {
    return { name, source: `<template each="x, i in items"><span class="ri">{i}:{x}</span></template><script>let items = ${JSON.stringify(state.items)};</script>` };
  },
});

// 6: Composite — count + if + each
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const count = Math.floor(rng() * 10);
    const show = rng() > 0.5;
    const len = Math.floor(rng() * 3);
    const items = [];
    for (let i = 0; i < len; i++) items.push(pick(rng, ['a', 'b']));
    return { name, source: `<p class="ct">{count}</p><template if="show"><template each="v in items"><span class="cv">{v}</span></template></template><script>let count = ${count}; let show = ${show}; let items = ${JSON.stringify(items)};</script>`, mutators: [
      { desc: 'set count', apply: (el) => { const nv = Math.floor(rng() * 20); setScopeVar(el, 'count', nv); return { count: nv }; } },
      { desc: 'toggle show', apply: (el) => { const nv = !el.__sparkScope?.show; setScopeVar(el, 'show', nv); return { show: nv }; } },
      { desc: 'replace items', apply: (el) => { const nv = [pick(rng, ['x', 'y'])]; setScopeVar(el, 'items', nv); return { items: nv }; } },
    ], schema: { count, show, items } };
  },
  rebuild(state, name) {
    return { name, source: `<p class="ct">{count}</p><template if="show"><template each="v in items"><span class="cv">{v}</span></template></template><script>let count = ${state.count}; let show = ${state.show}; let items = ${JSON.stringify(state.items)};</script>` };
  },
});

// 7: Await with plain value
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const val = Math.floor(rng() * 100);
    return { name, source: `<template await="data"><p class="pd">wait</p><template then><p class="gt">{await.value}</p></template></template><script>let data = { value: ${val} };</script>`, mutators: [
      { desc: 'set data', apply: (el) => { const nv = { value: Math.floor(rng() * 100) }; setScopeVar(el, 'data', nv); return { data: nv }; } },
    ], schema: { data: { value: val } } };
  },
  rebuild(state, name) {
    return { name, source: `<template await="data"><p class="pd">wait</p><template then><p class="gt">{await.value}</p></template></template><script>let data = ${JSON.stringify(state.data)};</script>` };
  },
});

// 8: Component import with reactive prop
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const childName = `cp${id}`;
    const val = Math.floor(rng() * 100);
    component(childName, `<p class="pv">{v}</p>`);
    return { name, childName, source: `<div import="${childName}" v="{x}"></div><p class="px">{x}</p><script>let x = ${val};</script>`, mutators: [
      { desc: 'set x', apply: (el) => { const nv = Math.floor(rng() * 100); setScopeVar(el, 'x', nv); return { x: nv }; } },
    ], schema: { x: val, childName } };
  },
  rebuild(state, name) {
    const childName = state.childName;
    component(childName, `<p class="pv">{v}</p>`);
    return { name, source: `<div import="${childName}" v="{x}"></div><p class="px">{x}</p><script>let x = ${state.x};</script>` };
  },
});

// ── Run one scenario ───────────────────────────────────────────────────
async function runScenario(rng, seed, id) {
  const tpl = pick(rng, templates);
  const { name, source, mutators, schema } = tpl.gen(rng, id);

  component(name, source);
  body.childNodes = [];
  parseHTML(`<div import="${name}"></div>`, body);
  await mount(body);
  await new Promise(r => setTimeout(r, 5));

  // Track state
  const state = {};
  for (const [k, v] of Object.entries(schema)) {
    state[k] = structuredClone ? structuredClone(v) : JSON.parse(JSON.stringify(v));
  }

  // Apply mutations
  const log = [];
  const nMutations = Math.floor(rng() * 5) + 1;
  for (let m = 0; m < nMutations; m++) {
    const mut = pick(rng, mutators);
    const result = mut.apply(body.querySelector(`[name="${name}"]`) || body);
    log.push(mut.desc + ' ' + JSON.stringify(result));
    for (const [k, v] of Object.entries(result)) state[k] = v;
    await new Promise(r => setTimeout(r, 5));
  }

  const root = body.querySelector(`[name="${name}"]`);
  if (!root) return { ok: false, error: 'no root', seed, id };
  const patched = serializeDOM(root);

  // Fresh mount with final state
  const freshName = `fr${id}`;
  const fresh = tpl.rebuild(state, freshName);
  component(freshName, fresh.source);
  body.childNodes = [];
  parseHTML(`<div import="${freshName}"></div>`, body);
  await mount(body);
  await new Promise(r => setTimeout(r, 5));
  const freshRoot = body.querySelector(`[name="${freshName}"]`);
  const freshSer = freshRoot ? serializeDOM(freshRoot) : '';

  if (patched !== freshSer) {
    return { ok: false, seed, id, patched, fresh: freshSer, state, log };
  }
  return { ok: true, seed, id };
}

// ── Main ────────────────────────────────────────────────────────────────
const NUM = parseInt(process.argv[2] || '500', 10);
const SEED = parseInt(process.argv[3] || '42', 10);
const CDIR = join(__dir, 'fuzz-corpus');
let passed = 0, failed = 0, cpass = 0, ctotal = 0;

try {
  for (const cf of readdirSync(CDIR).filter(f => f.endsWith('.json'))) {
    ctotal++;
    const data = JSON.parse(readFileSync(join(CDIR, cf), 'utf8'));
    try {
      const rng = mulberry32(data.seed || SEED);
      const r = await runScenario(rng, data.seed || SEED, `corp_${cf}`);
      if (r.ok) cpass++; else { failed++; console.log(`  ❌ corpus ${cf}`); }
    } catch (e) { failed++; console.log(`  ❌ corpus ${cf}: ${e.message}`); }
  }
} catch (e) { /* empty */ }

if (ctotal > 0) console.log(`\nCorpus: ${cpass}/${ctotal}\n`);

for (let i = 0; i < NUM; i++) {
  const seed = SEED + i;
  const rng = mulberry32(seed);
  try {
    const r = await runScenario(rng, seed, i);
    if (r.ok) { passed++; }
    else {
      failed++;
      console.log(`\n  ❌ ${i} (seed=${seed})`);
      console.log(`  patched: ${r.patched}`);
      console.log(`  fresh:   ${r.fresh}`);
      console.log(`  mutations: ${r.log.join(', ')}`);
      writeFileSync(join(CDIR, `seed_${seed}.json`), JSON.stringify({ seed, state: r.state, mutations: r.log }, null, 2));
      if (failed >= 20) { console.log('\n≥20 failures'); break; }
    }
  } catch (e) {
    failed++;
    console.log(`\n  ❌ ${i} (seed=${seed}) — ${e.message}`);
    if (failed >= 20) break;
  }
  if ((passed + failed) % 100 === 0) console.log(`  ${passed}/${passed + failed}`);
}

console.log(`\n${passed} passed, ${failed} failed (${NUM} scenarios, ${ctotal} corpus)`);
process.exit(failed ? 1 : 0);
