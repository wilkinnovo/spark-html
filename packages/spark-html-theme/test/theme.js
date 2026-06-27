/** spark-html-theme — store, data-theme attribute, persistence, system watch. */
import '../../spark/test/dom-shim.js';
import { Element } from '../../spark/test/dom-shim.js';
import { strict as assert } from 'node:assert';

// ── stubs the helper needs: <html>, localStorage, matchMedia ──
const html = new Element('html');
globalThis.document.documentElement = html;

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

let mqMatches = false;            // pretend the OS prefers light by default
let mqListener = null;
globalThis.matchMedia = () => ({
  get matches() { return mqMatches; },
  addEventListener: (_t, fn) => { mqListener = fn; },
  removeEventListener: () => { mqListener = null; },
});

const { store } = await import('spark-html');
const { theme } = await import('../src/index.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
const dataTheme = () => html.getAttribute('data-theme');

console.log('\nspark-html-theme');

// Saved choice is respected at startup.
mem.set('theme-mode', 'dark');
const t = theme();

test('reads the saved mode and applies data-theme', () => {
  assert.equal(t.mode, 'dark', 'mode from localStorage');
  assert.equal(t.resolved, 'dark');
  assert.equal(dataTheme(), 'dark', 'html data-theme set');
});

test('set(mode) updates the store, attribute, and localStorage', () => {
  t.set('light');
  assert.equal(t.mode, 'light');
  assert.equal(t.resolved, 'light');
  assert.equal(dataTheme(), 'light');
  assert.equal(mem.get('theme-mode'), 'light', 'persisted');
});

test('cycle() advances system → light → dark → system and persists', () => {
  t.set('system');
  assert.equal(t.mode, 'system');
  t.cycle();
  assert.equal(t.mode, 'light', 'system → light');
  t.cycle();
  assert.equal(t.mode, 'dark', 'light → dark');
  t.cycle();
  assert.equal(t.mode, 'system', 'dark → system');
  assert.equal(mem.get('theme-mode'), 'system');
});

test('toggle() always flips the VISIBLE theme (the double-click bug)', () => {
  // OS prefers dark; start in system → resolves dark.
  mqMatches = true;
  t.set('system');
  assert.equal(t.resolved, 'dark', 'system resolves dark');
  // One toggle must visibly flip to light — not land on an identical state.
  t.toggle();
  assert.equal(t.resolved, 'light', 'first toggle flips dark → light');
  assert.equal(dataTheme(), 'light');
  t.toggle();
  assert.equal(t.resolved, 'dark', 'second toggle flips light → dark');
  assert.equal(dataTheme(), 'dark');
  mqMatches = false;
});

test('system mode follows the OS preference (resolved)', () => {
  t.set('system');
  mqMatches = true;            // OS flips to dark
  if (mqListener) mqListener(); // matchMedia "change"
  assert.equal(t.resolved, 'dark', 'resolved tracks OS in system mode');
  assert.equal(dataTheme(), 'dark');
  mqMatches = false;
  if (mqListener) mqListener();
  assert.equal(t.resolved, 'light');
});

test('the store is the shared `theme` store (useStore reads it)', () => {
  assert.equal(store('theme').mode, t.mode, 'same store instance');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
