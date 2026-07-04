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

// ── the /bun pipeline step (no-flash injection) ──────────────────────────
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const sparkTheme = (await import('../src/bun.js')).default;

const PAGE = '<!doctype html>\n<html><head><title>x</title></head><body>hi</body></html>';
const FRAGMENT = '<h1>{msg}</h1>\n<script>let msg = "hi";</script>';

await (async () => {
  const step = sparkTheme();
  const out = mkdtempSync(join(tmpdir(), 'spark-theme-'));
  mkdirSync(join(out, 'components'));
  writeFileSync(join(out, 'index.html'), PAGE);
  writeFileSync(join(out, 'components', 'card.html'), FRAGMENT);
  await step.run({ outDir: out });

  test('bun step: injects the init script at the top of <head> in built pages', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    assert.ok(html.includes('<script data-spark-theme>'), 'script injected');
    assert.ok(/<head>\s*<script data-spark-theme>/.test(html), 'at head start (before styles)');
    assert.ok(html.includes('prefers-color-scheme'), 'the real init logic');
  });

  test('bun step: component fragments (no <head>) ship untouched', () => {
    assert.equal(readFileSync(join(out, 'components', 'card.html'), 'utf8'), FRAGMENT);
  });

  test('bun step: a fragment with a <header> element is NOT mistaken for a page', () => {
    const frag = '<header><h1>{title}</h1></header>\n<script>let title = "x";</script>';
    assert.equal(step.transformHtml(frag, { dev: true }), frag, '<header> is not <head>');
  });

  test('bun step: idempotent — a second run leaves one script', () => {
    return step.run({ outDir: out }).then(() => {
      const html = readFileSync(join(out, 'index.html'), 'utf8');
      assert.equal(html.split('data-spark-theme').length - 1, 1, 'exactly one marker');
    });
  });

  test('bun step: dev transformHtml injects the same script (and only in dev)', () => {
    const devHtml = step.transformHtml(PAGE, { dev: true });
    assert.ok(devHtml.includes('data-spark-theme'), 'injected in dev');
    assert.equal(step.transformHtml(PAGE, { dev: false }), PAGE, 'build path untouched (run() owns it)');
    assert.equal(step.transformHtml(devHtml, { dev: true }), devHtml, 'idempotent in dev');
  });

  test('bun step: custom key/attribute reach the injected script', () => {
    const custom = sparkTheme({ key: 'my-theme', attribute: 'data-mode' }).transformHtml(PAGE, { dev: true });
    assert.ok(custom.includes('"my-theme"'), 'custom key');
    assert.ok(custom.includes('"data-mode"'), 'custom attribute');
  });
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
