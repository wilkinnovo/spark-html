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
const { mount, component, store, derived } = await import('../src/index.js');

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

// 9: Store-based reactivity
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const sn = `fzst${id}`;
    const v = Math.floor(rng() * 100);
    store(sn, { v });
    return { name, source: `<p class="sv">{s.v}</p><script>let s = useStore('${sn}');</script>`, mutators: [
      { desc: 'set store v', apply: () => { const nv = Math.floor(rng() * 100); store(sn).v = nv; return { v: nv }; } },
    ], schema: { v, sn } };
  },
  rebuild(state) {
    store(state.sn, { v: state.v });
    return { name: state.sn, source: `<p class="sv">{s.v}</p><script>let s = useStore('${state.sn}');</script>` };
  },
});

// 10: Derived store (computed from a source store)
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const src = `fzds${id}`;
    const dst = `fzdd${id}`;
    const n = Math.floor(rng() * 50);
    store(src, { n });
    derived(dst, [src], (s) => ({ d: s.n * 2 }));
    return { name, source: `<p class="sd">{s.d}</p><script>let s = useStore('${dst}');</script>`, mutators: [
      { desc: 'set source store n', apply: () => { const nv = Math.floor(rng() * 50); store(src).n = nv; return { n: nv }; } },
    ], schema: { n, src, dst } };
  },
  rebuild(state) {
    store(state.src, { n: state.n });
    derived(state.dst, [state.src], (s) => ({ d: s.n * 2 }));
    return { name: state.src, source: `<p class="sd">{s.d}</p><script>let s = useStore('${state.dst}');</script>` };
  },
});

// 11: Deep object mutation (nested property, replaced at root)
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const a = Math.floor(rng() * 50);
    const c = Math.floor(rng() * 50);
    const obj = { a, nested: { c } };
    return { name, source: `<p class="da">{obj.a}</p><p class="dc">{obj.nested.c}</p><script>let obj = ${JSON.stringify(obj)};</script>`, mutators: [
      { desc: 'set obj.a', apply: (el) => { const nv = Math.floor(rng() * 50); const o = { ...el.__sparkScope?.obj, a: nv }; setScopeVar(el, 'obj', o); return { obj: o }; } },
      { desc: 'set obj.nested.c (deep)', apply: (el) => { const nv = Math.floor(rng() * 50); const o = { ...el.__sparkScope?.obj, nested: { c: nv } }; setScopeVar(el, 'obj', o); return { obj: o }; } },
    ], schema: { obj } };
  },
  rebuild(state) {
    return { name: 'deep', source: `<p class="da">{obj.a}</p><p class="dc">{obj.nested.c}</p><script>let obj = ${JSON.stringify(state.obj)};</script>` };
  },
});

// 12: Form binding (input value)
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const txt = pick(rng, ['hello', 'hi', '']);
    return { name, source: `<input value="{txt}" class="fi" /><p class="ft">{txt}</p><script>let txt = ${JSON.stringify(txt)};</script>`, mutators: [
      { desc: 'set txt', apply: (el) => { const nv = pick(rng, ['a', 'bc', 'xyz']); setScopeVar(el, 'txt', nv); return { txt: nv }; } },
    ], schema: { txt } };
  },
  rebuild(state) {
    return { name: 'form', source: `<input value="{txt}" class="fi" /><p class="ft">{txt}</p><script>let txt = ${JSON.stringify(state.txt)};</script>` };
  },
});

// 13: KEYED each over object rows — reorders (swap/reverse/shuffle), remove,
// insert, immutable single-row replacement, deep in-place mutation, an outer
// key (sel) read inside every row via :class, and a mixed same-tick write.
// Pins the keyed reconciler (LIS placement + identity-skip): the patched DOM
// after any permutation sequence must converge with a fresh mount.
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    let nid = 1;
    const mk = () => ({ id: nid++, label: pick(rng, ['aa', 'bb', 'cc', 'dd']) });
    const rows = Array.from({ length: Math.floor(rng() * 6) + 2 }, mk);
    const src = (rowsJson, selVal) => `<template each="r in rows" key="r.id"><span :class="r.id === sel ? 'on' : 'off'">{r.id}:{r.label}</span></template><p class="kl">{rows.length}</p><script>let rows = ${rowsJson}; let sel = ${selVal};</script>`;
    // Reorders reuse the SAME live row values (identity-preserving, like app
    // code doing rows.slice() + swap) — the raw items round-trip through the
    // scope proxy so patchEach sees stable identities.
    const live = (el) => [...el.__sparkScope.rows];
    return { name, source: src(JSON.stringify(rows), 0), mutators: [
      { desc: 'swap extremes', apply: (el) => { const rs = live(el); if (rs.length > 1) { const t = rs[0]; rs[0] = rs[rs.length - 1]; rs[rs.length - 1] = t; } setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'reverse', apply: (el) => { const rs = live(el).reverse(); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'shuffle', apply: (el) => { const rs = live(el); for (let j = rs.length - 1; j > 0; j--) { const k = Math.floor(rng() * (j + 1)); const t = rs[j]; rs[j] = rs[k]; rs[k] = t; } setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'remove one', apply: (el) => { const rs = live(el); if (rs.length) rs.splice(Math.floor(rng() * rs.length), 1); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'insert one', apply: (el) => { const rs = live(el); rs.splice(Math.floor(rng() * (rs.length + 1)), 0, mk()); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'replace one immutably', apply: (el) => { const rs = live(el); if (rs.length) { const j = Math.floor(rng() * rs.length); rs[j] = { id: rs[j].id, label: pick(rng, ['zz', 'ww']) }; } setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'deep-mutate one', apply: (el) => { const rows = el.__sparkScope.rows; if (rows.length) rows[Math.floor(rng() * rows.length)].label = pick(rng, ['mm', 'nn']); return { rows: [...el.__sparkScope.rows] }; } },
      { desc: 'set sel', apply: (el) => { const rows = el.__sparkScope.rows; const nv = rows.length ? rows[Math.floor(rng() * rows.length)].id : 0; setScopeVar(el, 'sel', nv); return { sel: nv }; } },
      { desc: 'mixed same tick', apply: (el) => { const rows = el.__sparkScope.rows; let nv = 0; if (rows.length) { rows[0].label = pick(rng, ['qq', 'rr']); nv = rows[rows.length - 1].id; } setScopeVar(el, 'sel', nv); return { rows: [...el.__sparkScope.rows], sel: nv }; } },
    ], schema: { rows, sel: 0 } };
  },
  rebuild(state, name) {
    return { name, source: `<template each="r in rows" key="r.id"><span :class="r.id === sel ? 'on' : 'off'">{r.id}:{r.label}</span></template><p class="kl">{rows.length}</p><script>let rows = ${JSON.stringify(state.rows)}; let sel = ${state.sel};</script>` };
  },
});

// 14: KEYED each rendering the INDEX — any reorder/remove must re-render the
// index text of every displaced row (pins the index-sensitivity guard: a row
// whose item is identity-unchanged still re-walks when its index moved).
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    let nid = 1;
    const mk = () => ({ id: nid++ });
    const rows = Array.from({ length: Math.floor(rng() * 5) + 2 }, mk);
    const live = (el) => [...el.__sparkScope.rows];
    return { name, source: `<template each="r, i in rows" key="r.id"><span class="ix">{i}={r.id}</span></template><script>let rows = ${JSON.stringify(rows)};</script>`, mutators: [
      { desc: 'rotate', apply: (el) => { const rs = live(el); if (rs.length) rs.push(rs.shift()); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'remove first', apply: (el) => { const rs = live(el); rs.shift(); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'swap extremes', apply: (el) => { const rs = live(el); if (rs.length > 1) { const t = rs[0]; rs[0] = rs[rs.length - 1]; rs[rs.length - 1] = t; } setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'insert front', apply: (el) => { const rs = live(el); rs.unshift(mk()); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
    ], schema: { rows } };
  },
  rebuild(state, name) {
    return { name, source: `<template each="r, i in rows" key="r.id"><span class="ix">{i}={r.id}</span></template><script>let rows = ${JSON.stringify(state.rows)};</script>` };
  },
});

// 15: Branch-divergent scope reads — {p ? a : b} only captures the taken
// branch's key on first eval. Pins the fast-expression self-heal (expr.js):
// switching branches must ReferenceError-fallback, relearn, and stay correct.
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    const p = rng() > 0.5;
    const a = Math.floor(rng() * 50);
    const b = Math.floor(rng() * 50);
    return { name, source: `<p class="br">{p ? a : b}</p><script>let p = ${p}; let a = ${a}; let b = ${b};</script>`, mutators: [
      { desc: 'toggle p', apply: (el) => { const nv = !el.__sparkScope?.p; setScopeVar(el, 'p', nv); return { p: nv }; } },
      { desc: 'set a', apply: (el) => { const nv = Math.floor(rng() * 100); setScopeVar(el, 'a', nv); return { a: nv }; } },
      { desc: 'set b', apply: (el) => { const nv = Math.floor(rng() * 100); setScopeVar(el, 'b', nv); return { b: nv }; } },
    ], schema: { p, a, b } };
  },
  rebuild(state, name) {
    return { name, source: `<p class="br">{p ? a : b}</p><script>let p = ${state.p}; let a = ${state.a}; let b = ${state.b};</script>` };
  },
});

// 16: Nested each INSIDE keyed rows — pins the reconcile-skip × rowForce
// interplay: replacing a row immutably (new nested array, same tick's dirty
// key is only the OUTER array's) must still re-reconcile the nested each;
// an outer-key-only change (sel) must skip both reconciles yet refresh the
// :class; deep pushes into a nested array take the full-pass route.
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    let nid = 1;
    const mkTags = () => Array.from({ length: Math.floor(rng() * 3) }, () => pick(rng, ['t1', 't2', 't3']));
    const mk = () => ({ id: nid++, tags: mkTags() });
    const rows = Array.from({ length: Math.floor(rng() * 4) + 1 }, mk);
    const src = (rowsJson, selVal) => `<template each="r in rows" key="r.id"><div :class="r.id === sel ? 'on' : 'off'"><b>{r.id}</b><template each="t in r.tags"><i>{t}</i></template></div></template><script>let rows = ${rowsJson}; let sel = ${selVal};</script>`;
    const live = (el) => [...el.__sparkScope.rows];
    return { name, source: src(JSON.stringify(rows), 0), mutators: [
      { desc: 'replace row w/ new tags', apply: (el) => { const rs = live(el); if (rs.length) { const j = Math.floor(rng() * rs.length); rs[j] = { id: rs[j].id, tags: mkTags() }; } setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'reverse rows', apply: (el) => { const rs = live(el).reverse(); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'set sel', apply: (el) => { const rows = el.__sparkScope.rows; const nv = rows.length ? rows[Math.floor(rng() * rows.length)].id : 0; setScopeVar(el, 'sel', nv); return { sel: nv }; } },
      { desc: 'deep-push tag', apply: (el) => { const rows = el.__sparkScope.rows; if (rows.length) rows[Math.floor(rng() * rows.length)].tags.push(pick(rng, ['t8', 't9'])); return { rows: [...el.__sparkScope.rows] }; } },
      { desc: 'insert row', apply: (el) => { const rs = live(el); rs.splice(Math.floor(rng() * (rs.length + 1)), 0, mk()); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'remove row', apply: (el) => { const rs = live(el); if (rs.length) rs.splice(Math.floor(rng() * rs.length), 1); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
    ], schema: { rows, sel: 0 } };
  },
  rebuild(state, name) {
    return { name, source: `<template each="r in rows" key="r.id"><div :class="r.id === sel ? 'on' : 'off'"><b>{r.id}</b><template each="t in r.tags"><i>{t}</i></template></div></template><script>let rows = ${JSON.stringify(state.rows)}; let sel = ${state.sel};</script>` };
  },
});

// 18: SHALLOW keyed rows with a delegated handler, a spark-ignore island
// (literal braces stay byte-intact), and an interpolated attribute — pins
// the stamp-time live-node recipe (walkBlock's no-descent fast path) and
// delegated wiring: handler attrs stripped, ignore content untouched, and
// external-key (sel) updates re-render only via the recipe.
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    let nid = 1;
    const mk = () => ({ id: nid++, label: pick(rng, ['aa', 'bb', 'cc']) });
    const rows = Array.from({ length: Math.floor(rng() * 5) + 2 }, mk);
    const src = (rowsJson, selVal) => `<template each="r in rows" key="r.id"><div class="rw" :class="r.id === sel ? 'on' : 'off'" onclick="{sel = r.id}" data-lab="{r.label}!"><em>{r.label}</em><span spark-ignore>{not.code}</span></div></template><p class="sl">{sel}</p><script>let rows = ${rowsJson}; let sel = ${selVal};</script>`;
    const live = (el) => [...el.__sparkScope.rows];
    return { name, source: src(JSON.stringify(rows), 0), mutators: [
      { desc: 'swap extremes', apply: (el) => { const rs = live(el); if (rs.length > 1) { const t = rs[0]; rs[0] = rs[rs.length - 1]; rs[rs.length - 1] = t; } setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'shuffle', apply: (el) => { const rs = live(el); for (let j = rs.length - 1; j > 0; j--) { const k = Math.floor(rng() * (j + 1)); const t = rs[j]; rs[j] = rs[k]; rs[k] = t; } setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'set sel', apply: (el) => { const rows = el.__sparkScope.rows; const nv = rows.length ? rows[Math.floor(rng() * rows.length)].id : 0; setScopeVar(el, 'sel', nv); return { sel: nv }; } },
      { desc: 'replace one immutably', apply: (el) => { const rs = live(el); if (rs.length) { const j = Math.floor(rng() * rs.length); rs[j] = { id: rs[j].id, label: pick(rng, ['zz', 'ww']) }; } setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'remove one', apply: (el) => { const rs = live(el); if (rs.length) rs.splice(Math.floor(rng() * rs.length), 1); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'insert one', apply: (el) => { const rs = live(el); rs.splice(Math.floor(rng() * (rs.length + 1)), 0, mk()); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'deep-mutate one', apply: (el) => { const rows = el.__sparkScope.rows; if (rows.length) rows[Math.floor(rng() * rows.length)].label = pick(rng, ['mm', 'nn']); return { rows: [...el.__sparkScope.rows] }; } },
    ], schema: { rows, sel: 0 } };
  },
  rebuild(state, name) {
    return { name, source: `<template each="r in rows" key="r.id"><div class="rw" :class="r.id === sel ? 'on' : 'off'" onclick="{sel = r.id}" data-lab="{r.label}!"><em>{r.label}</em><span spark-ignore>{not.code}</span></div></template><p class="sl">{sel}</p><script>let rows = ${JSON.stringify(state.rows)}; let sel = ${state.sel};</script>` };
  },
});

// 19: branch-divergent row deps — :class reads `theme` ONLY while its row is
// selected, so the first capture never sees it; selecting later heals the
// fast fn (ReferenceError → union re-capture → mask/dep growth), and a theme
// change after that must still re-render the selected row. Never staleness.
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    let nid = 1;
    const mk = () => ({ id: nid++, label: pick(rng, ['aa', 'bb', 'cc']) });
    const rows = Array.from({ length: Math.floor(rng() * 5) + 2 }, mk);
    const src = (rowsJson, selVal, themeVal) => `<template each="r in rows" key="r.id"><div :class="r.id === sel ? theme : 'base'"><i>{r.label}</i></div></template><script>let rows = ${rowsJson}; let sel = ${selVal}; let theme = ${JSON.stringify(themeVal)};</script>`;
    const live = (el) => [...el.__sparkScope.rows];
    return { name, source: src(JSON.stringify(rows), 0, 'on'), mutators: [
      { desc: 'select', apply: (el) => { const rows = el.__sparkScope.rows; const nv = rows.length ? rows[Math.floor(rng() * rows.length)].id : 0; setScopeVar(el, 'sel', nv); return { sel: nv }; } },
      { desc: 'theme', apply: (el) => { const nv = pick(rng, ['t-a', 't-b', 't-c']); setScopeVar(el, 'theme', nv); return { theme: nv }; } },
      { desc: 'swap extremes', apply: (el) => { const rs = live(el); if (rs.length > 1) { const t = rs[0]; rs[0] = rs[rs.length - 1]; rs[rs.length - 1] = t; } setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'replace one immutably', apply: (el) => { const rs = live(el); if (rs.length) { const j = Math.floor(rng() * rs.length); rs[j] = { id: rs[j].id, label: pick(rng, ['zz', 'ww']) }; } setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'remove one', apply: (el) => { const rs = live(el); if (rs.length) rs.splice(Math.floor(rng() * rs.length), 1); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
    ], schema: { rows, sel: 0, theme: 'on' } };
  },
  rebuild(state, name) {
    return { name, source: `<template each="r in rows" key="r.id"><div :class="r.id === sel ? theme : 'base'"><i>{r.label}</i></div></template><script>let rows = ${JSON.stringify(state.rows)}; let sel = ${state.sel}; let theme = ${JSON.stringify(state.theme)};</script>` };
  },
});

// 20: >30 external keys in one row template — the dependency-mask registry
// overflows (wide) and the anchor falls back to full-row refresh. Results
// must stay byte-identical; overflow may only cost speed, never an update.
const wideSum = Array.from({ length: 32 }, (_, i) => `k${i}`).join('+');
const wideSrc = (rowsJson, kdecl) => `<template each="r in rows" key="r.id"><div><b>{r.id}</b><i>{${wideSum}}</i></div></template><script>let rows = ${rowsJson}; ${kdecl}</script>`;
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    let nid = 1;
    const ks = Array.from({ length: 32 }, () => Math.floor(rng() * 9));
    const mk = () => ({ id: nid++ });
    const rows = Array.from({ length: Math.floor(rng() * 3) + 1 }, mk);
    const live = (el) => [...el.__sparkScope.rows];
    return { name, source: wideSrc(JSON.stringify(rows), ks.map((v, i) => `let k${i} = ${v};`).join(' ')), mutators: [
      { desc: 'bump k', apply: (el) => { const i = Math.floor(rng() * 32); const nv = Math.floor(rng() * 9); setScopeVar(el, 'k' + i, nv); return { ['k' + i]: nv }; } },
      { desc: 'insert row', apply: (el) => { const rs = live(el); rs.splice(Math.floor(rng() * (rs.length + 1)), 0, mk()); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'remove row', apply: (el) => { const rs = live(el); if (rs.length) rs.splice(Math.floor(rng() * rs.length), 1); setScopeVar(el, 'rows', rs); return { rows: rs }; } },
    ], schema: { rows, ...Object.fromEntries(ks.map((v, i) => ['k' + i, v])) } };
  },
  rebuild(state, name) {
    return { name, source: wideSrc(JSON.stringify(state.rows), Array.from({ length: 32 }, (_, i) => `let k${i} = ${state['k' + i]};`).join(' ')) };
  },
});

// 21: a PINNED expression in keyed rows ('=' inside a string defeats the
// fast-variant scan by design, so it has no observed key set) — gated passes
// must treat its point as always-hot; sel churn and reorders never strand it.
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    let nid = 1;
    const mk = () => ({ id: nid++, label: pick(rng, ['aa', 'bb', 'cc']) });
    const rows = Array.from({ length: Math.floor(rng() * 5) + 2 }, mk);
    const src = (rowsJson, selVal) => `<template each="r in rows" key="r.id"><div :class="r.id === sel ? 'on' : 'off'"><i>{r.label + '='}</i></div></template><p>{sel}</p><script>let rows = ${rowsJson}; let sel = ${selVal};</script>`;
    const live = (el) => [...el.__sparkScope.rows];
    return { name, source: src(JSON.stringify(rows), 0), mutators: [
      { desc: 'select', apply: (el) => { const rows = el.__sparkScope.rows; const nv = rows.length ? rows[Math.floor(rng() * rows.length)].id : 0; setScopeVar(el, 'sel', nv); return { sel: nv }; } },
      { desc: 'replace one immutably', apply: (el) => { const rs = live(el); if (rs.length) { const j = Math.floor(rng() * rs.length); rs[j] = { id: rs[j].id, label: pick(rng, ['zz', 'ww']) }; } setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'shuffle', apply: (el) => { const rs = live(el); for (let j = rs.length - 1; j > 0; j--) { const k = Math.floor(rng() * (j + 1)); const t = rs[j]; rs[j] = rs[k]; rs[k] = t; } setScopeVar(el, 'rows', rs); return { rows: rs }; } },
      { desc: 'deep-mutate label', apply: (el) => { const rows = el.__sparkScope.rows; if (rows.length) rows[Math.floor(rng() * rows.length)].label = pick(rng, ['mm', 'nn']); return { rows: [...el.__sparkScope.rows] }; } },
    ], schema: { rows, sel: 0 } };
  },
  rebuild(state, name) {
    return { name, source: `<template each="r in rows" key="r.id"><div :class="r.id === sel ? 'on' : 'off'"><i>{r.label + '='}</i></div></template><p>{sel}</p><script>let rows = ${JSON.stringify(state.rows)}; let sel = ${state.sel};</script>` };
  },
});

// 22: same-tick mixes — immutable replacement + external-key write in ONE
// microtask (reconcile and gated dispatch in a single flush), and a deep
// mutation + key write (classified as a full pass). The dispatch families
// must compose without dropping either update. `theme` sits in BOTH :class
// branches so every row tracks it unconditionally.
templates.push({
  gen(rng, id) {
    const name = `fz${id}`;
    let nid = 1;
    const mk = () => ({ id: nid++, label: pick(rng, ['aa', 'bb', 'cc']) });
    const rows = Array.from({ length: Math.floor(rng() * 5) + 2 }, mk);
    const src = (rowsJson, selVal, themeVal) => `<template each="r in rows" key="r.id"><div :class="r.id === sel ? 'on ' + theme : theme"><i>{r.label}</i></div></template><script>let rows = ${rowsJson}; let sel = ${selVal}; let theme = ${JSON.stringify(themeVal)};</script>`;
    const live = (el) => [...el.__sparkScope.rows];
    return { name, source: src(JSON.stringify(rows), 0, 'th0'), mutators: [
      { desc: 'replace+sel same tick', apply: (el) => { const rs = live(el); let nv = 0; if (rs.length) { const j = Math.floor(rng() * rs.length); rs[j] = { id: rs[j].id, label: pick(rng, ['zz', 'ww']) }; nv = rs[Math.floor(rng() * rs.length)].id; } setScopeVar(el, 'rows', rs); setScopeVar(el, 'sel', nv); return { rows: rs, sel: nv }; } },
      { desc: 'deep+sel same tick', apply: (el) => { const rows = el.__sparkScope.rows; let nv = 0; if (rows.length) { rows[Math.floor(rng() * rows.length)].label = 'mx'; nv = rows[Math.floor(rng() * rows.length)].id; } setScopeVar(el, 'sel', nv); return { rows: [...el.__sparkScope.rows], sel: nv }; } },
      { desc: 'reverse+theme same tick', apply: (el) => { const rs = live(el).reverse(); const nv = pick(rng, ['th1', 'th2']); setScopeVar(el, 'rows', rs); setScopeVar(el, 'theme', nv); return { rows: rs, theme: nv }; } },
      { desc: 'select', apply: (el) => { const rows = el.__sparkScope.rows; const nv = rows.length ? rows[Math.floor(rng() * rows.length)].id : 0; setScopeVar(el, 'sel', nv); return { sel: nv }; } },
    ], schema: { rows, sel: 0, theme: 'th0' } };
  },
  rebuild(state, name) {
    return { name, source: `<template each="r in rows" key="r.id"><div :class="r.id === sel ? 'on ' + theme : theme"><i>{r.label}</i></div></template><script>let rows = ${JSON.stringify(state.rows)}; let sel = ${state.sel}; let theme = ${JSON.stringify(state.theme)};</script>` };
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
