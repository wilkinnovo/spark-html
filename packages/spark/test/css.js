/**
 * CSS scoping tests — the proper-parser replacement for the old regex.
 * Covers every failure mode reported in comments-about-spark2.md:
 *   @media, @keyframes, comments, partial :global(), specificity balance.
 */
import { strict as assert } from 'node:assert';

// Minimal shims so the module can load outside a browser.
globalThis.document = {
  readyState: 'complete',
  createElement: () => ({ setAttribute() {}, attributes: [], childNodes: [] }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  head: { appendChild() {} },
  body: { querySelectorAll: () => [] },
};
globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.fetch = async () => ({ ok: false, status: 404 });

const { scopeCss } = await import('../src/index.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
// Normalize whitespace so assertions are about tokens, not formatting.
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const has = (css, needle) => assert.ok(norm(css).includes(needle), `expected to find:\n  ${needle}\nin:\n  ${norm(css)}`);
const hasnt = (css, needle) => assert.ok(!norm(css).includes(needle), `did NOT expect:\n  ${needle}\nin:\n  ${norm(css)}`);

const T = 'components/card';
const P = `[name="${T}"]`;

console.log('\nbasic scoping');
test('a single selector gets the scope prefix', () => {
  has(scopeCss(`.card { color: red; }`, T), `${P} .card { color: red; }`);
});
test('comma-separated selectors each get scoped', () => {
  const out = scopeCss(`.a, .b { color: red; }`, T);
  has(out, `${P} .a, ${P} .b {`);
});
test('descendant selector: prefix goes in front, once', () => {
  has(scopeCss(`.foo .bar { x: 1; }`, T), `${P} .foo .bar {`);
});
test('combinators (> + ~) are preserved', () => {
  has(scopeCss(`.a > .b + .c ~ .d { x: 1; }`, T), `${P} .a > .b + .c ~ .d {`);
});
test('commas inside :is()/:not() do not split the selector', () => {
  const out = scopeCss(`:is(.a, .b) .c { x: 1; }`, T);
  has(out, `${P} :is(.a, .b) .c {`);
  // exactly one scope prefix, not one per inner comma
  assert.equal(norm(out).split(P).length - 1, 1);
});

console.log('\n@media (was completely broken)');
test('selectors inside @media are scoped', () => {
  const out = scopeCss(`@media (max-width: 600px) { .card { color: red; } }`, T);
  has(out, `@media (max-width: 600px) {`);
  has(out, `${P} .card {`);
});
test('@media prelude itself is NOT scoped', () => {
  const out = scopeCss(`@media (max-width: 600px) { .card { x: 1; } }`, T);
  hasnt(out, `${P} @media`);
  hasnt(out, `[name="${T}"] (max-width`);
});
test('base + @media override end up with EQUAL specificity (source order wins)', () => {
  // The old bug: base rule got scoped (+specificity) but the @media selector
  // did not, so the responsive override lost. Now both carry [name], so the
  // later @media rule wins by cascade order — no :global() workaround needed.
  const out = scopeCss(
    `.card { width: 100%; } @media (min-width: 800px) { .card { width: 50%; } }`,
    T,
  );
  const base = norm(out).indexOf(`${P} .card { width: 100%`);
  const media = norm(out).indexOf(`${P} .card { width: 50%`);
  assert.ok(base !== -1 && media !== -1, 'both rules scoped');
  assert.ok(media > base, '@media override comes after the base rule');
});

console.log('\n@keyframes (steps must NOT be scoped)');
test('keyframe step selectors (0%/100%) are left untouched', () => {
  const out = scopeCss(`@keyframes spin { 0% { opacity: 0; } 100% { opacity: 1; } }`, T);
  has(out, `@keyframes spin {`);
  has(out, `0% { opacity: 0; }`);
  has(out, `100% { opacity: 1; }`);
  hasnt(out, `${P} 0%`);
  hasnt(out, `${P} 100%`);
});
test('from/to keyframes are left untouched', () => {
  const out = scopeCss(`@keyframes fade { from { opacity: 0 } to { opacity: 1 } }`, T);
  hasnt(out, `${P} from`);
  hasnt(out, `${P} to`);
});
test('@font-face body is not scoped', () => {
  const out = scopeCss(`@font-face { font-family: "X"; src: url(x.woff2); }`, T);
  has(out, `@font-face {`);
  hasnt(out, `${P}`);
});

console.log('\ncomments (must not leak into selectors)');
test('a comment between rules does not corrupt the next selector', () => {
  const out = scopeCss(`/* header */ .card { color: red; }`, T);
  has(out, `${P} .card {`);
  hasnt(out, 'header');
});
test('a comment inside a selector is stripped, not embedded', () => {
  const out = scopeCss(`.card /* hi */ .title { x: 1; }`, T);
  has(out, `${P} .card .title {`);
  hasnt(out, 'hi');
});

console.log('\n:global() (partial, not just whole-selector)');
test(':global() wrapping the whole selector is unscoped', () => {
  assert.equal(norm(scopeCss(`:global(body) { margin: 0; }`, T)), `body { margin: 0; }`);
});
test(':global() prefix + scoped descendant — the case that produced invalid CSS', () => {
  const out = scopeCss(`:global(.theme-dark) .card { color: #fff; }`, T);
  has(out, `.theme-dark ${P} .card {`);
  hasnt(out, ':global');
});
test(':global() in the middle of a selector', () => {
  const out = scopeCss(`.card :global(.icon) { x: 1; }`, T);
  has(out, `${P} .card .icon {`);
  hasnt(out, ':global');
});
test('a fully-global multi-part selector gets no scope at all', () => {
  const out = scopeCss(`:global([hidden]) { display: none !important; }`, T);
  assert.equal(norm(out), `[hidden] { display: none !important; }`);
  hasnt(out, P);
});

console.log('\n@supports (nested, should scope like @media)');
test('selectors inside @supports are scoped', () => {
  const out = scopeCss(`@supports (display: grid) { .card { display: grid; } }`, T);
  has(out, `@supports (display: grid) {`);
  has(out, `${P} .card {`);
});

console.log('\nstatement at-rules (left alone)');
test('@import is passed through untouched', () => {
  const out = scopeCss(`@import url("x.css"); .card { x: 1; }`, T);
  has(out, `@import url("x.css");`);
  has(out, `${P} .card {`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
