/**
 * Regression tests for the 0.27.12-0.27.14 reactivity trilogy.
 *
 * Each bug is exercised by the fuzzer or caught by a dev-mode invariant;
 * these tests confirm the scenario is handled correctly today. If a fix
 * regresses, one of these tests (or the fuzzer) catches it.
 */
import './dom-shim.js';
import { body, parseHTML } from './dom-shim.js';
import { strict as assert } from 'node:assert';

const { mount, component } = await import('../src/index.js');

// --- 0.27.12 - Infinite reactive loop ---------------------------------
// Root cause: analyzeScript rewrote let/const/var declarations INSIDE
// nested function bodies (depth > 0), even when the local shared a name
// with a scope variable. A $: block calling such a function would trigger
// a scope write from INSIDE the function (the rewritten local), causing
// the $: block to re-evaluate -> infinite patch loop (real hang).
// Fixed by: braceDepths() - rewrites only at brace depth 0.
async function test_bug_0_27_12() {
  // The inner `let result = helper()` shares a name with the outer scope
  // `result`. With the bug, it gets rewritten to `result = helper()`,
  // writing to the reactive proxy from inside compute() -> re-triggers
  // $: and creates an infinite loop.
  var src = '<p class="r">{result}</p><script>' +
    "let result = '';\n" +
    "$: result = compute();\n" +
    'function compute() {\n' +
    "  let result = helper();\n" +
    '  return result;\n' +
    '}\n' +
    "function helper() { return 'completed'; }\n" +
    '</script>';

  var timedOut = false;
  var timer = setTimeout(function() { timedOut = true; }, 5000);

  component('bug2712', src);
  body.childNodes = [];
  parseHTML('<div import="bug2712"></div>', body);
  await mount();
  clearTimeout(timer);

  assert.ok(!timedOut, '0.27.12: must not hang (infinite loop without braceDepths)');
  var el = body.querySelector('.r');
  assert.equal(el.textContent, 'completed', '0.27.12: must produce correct value');
  console.log('  0.27.12 -- no infinite loop, value correct');
}

// --- 0.27.13 - Prop stringification -----------------------------------
// Root cause: <div import v="{expr}"> props went through the string
// interpolation code path, so an object prop became "[object Object]".
// Fixed by: evalPropValue evaluates whole-value {expr} directly.
async function test_bug_0_27_13() {
  component('inner2713', '<p class="pv">{typeof v}</p><script>let v = props.v;</script>');
  component('bug2713', '<div import="inner2713" v="{obj}"></div><script>let obj = { a: 1, b: 2 };</script>');
  body.childNodes = [];
  parseHTML('<div import="bug2713"></div>', body);
  await mount();
  await new Promise(r => setTimeout(r, 10));
  var pv = body.querySelector('.pv');
  assert.equal(pv.textContent, 'object', '0.27.13: prop must be object, not stringified');
  console.log('  0.27.13 -- object prop is not stringified');
}

// --- 0.27.14 - each-in-if permanently dead ----------------------------
// Root cause: withSink CLEARED the outer directive's dep set before every
// run instead of accumulating, so an unrelated sibling mutation could
// corrupt an outer if's recorded deps and a nested each silently stopped
// reconciling.
// Fixed by: dep sets only grow within a run (invariant at index.js:1034).
async function test_bug_0_27_14() {
  component('bug2714', '<template if="show">' +
    '<template each="x in items"><span class="ie">{x}</span></template>' +
    '</template>' +
    '<p class="ct">{count}</p>' +
    '<script>' +
    'let show = true;\n' +
    "let items = ['a', 'b'];\n" +
    'let count = 0;\n' +
    '</script>');
  body.childNodes = [];
  parseHTML('<div import="bug2714"></div>', body);
  await mount();
  await new Promise(r => setTimeout(r, 10));
  var scope = body.querySelector('[name="bug2714"]').__sparkScope;
  assert.ok(scope, '0.27.14: component must boot');
  scope.items = ['x', 'y', 'z'];
  scope.count = 5;
  await new Promise(r => setTimeout(r, 10));
  var spans = body.querySelectorAll('.ie');
  assert.equal(spans.length, 3, '0.27.14: each must reconcile after sibling mutation');
  assert.equal(spans[0].textContent, 'x', '0.27.14: first item');
  assert.equal(spans[1].textContent, 'y', '0.27.14: second item');
  assert.equal(spans[2].textContent, 'z', '0.27.14: third item');
  var ct = body.querySelector('.ct');
  assert.equal(ct.textContent, '5', '0.27.14: sibling count must also update');
  console.log('  0.27.14 -- nested each-in-if reconciles after sibling mutation');
}

// --- 1.0.2 - whole-value {expr} prop coerced '' -> true -----------------
// Root cause: 0.27.13 made a whole-value {expr} prop (v="{obj}") evaluate
// directly via evalPropValue instead of going through the string
// interpolation path, so it stopped being stringified into "[object
// Object]" — but buildProps() still ran EVERY string-typed result through
// coerce(), and coerce('') means "bare boolean attribute" (e.g. <div
// disabled>, attr.value === '' with no {} at all). An {expr} that legally
// evaluates to the empty string — e.g. photo="{c.avatar}" inside an
// each-loop where c.avatar is '' — got silently upgraded to `true`, a
// completely different value/type than what the data source produced.
// Found building examples/spark-chat: an avatar component's `if="photo"`
// always took the truthy branch for users with no photo, because `photo`
// arrived as boolean `true`, never the empty string that was actually
// selected. Server-rendered HTML (curl) was unaffected — SSR's page.js
// evaluates page-level data sources independently of buildProps() — only
// client-side hydration/mount of an IMPORTED COMPONENT went through this
// code path, so the SSR-vs-browser split made it easy to misdiagnose as a
// server/client sync issue rather than an attribute-coercion bug.
// Fixed by: buildProps() only calls coerce() on a literal (non-{}) attribute
// or a MIXED interpolation ("{a}-{b}", always a real string) — a WHOLE
// single {expr} result is used exactly as evaluated, string or not.
async function test_bug_1_0_2_empty_string_prop() {
  component('inner102', '<p class="pv">[{typeof photo}:{photo}]</p><script>let photo = props.photo;</script>');
  component('bug102', '<template each="c in items">' +
    '<div import="inner102" photo="{c.photo}"></div>' +
    '</template>' +
    "<script>let items = [{ photo: '' }, { photo: 'x.png' }];</script>");
  body.childNodes = [];
  parseHTML('<div import="bug102"></div>', body);
  await mount();
  await new Promise(r => setTimeout(r, 10));
  var pvs = body.querySelectorAll('.pv');
  assert.equal(pvs.length, 2, '1.0.2: both rows must render');
  assert.equal(pvs[0].textContent, '[string:]', "1.0.2: '' prop must stay the empty string, not become boolean true");
  assert.equal(pvs[1].textContent, '[string:x.png]', '1.0.2: a real string prop must still work');
  console.log('  1.0.2 -- empty-string {expr} prop is not coerced to true');
}

// --- Run ---------------------------------------------------------------
var passed = 0, failed = 0;
var fns = [test_bug_0_27_12, test_bug_0_27_13, test_bug_0_27_14, test_bug_1_0_2_empty_string_prop];
for (var i = 0; i < fns.length; i++) {
  try {
    await fns[i]();
    passed++;
  } catch (e) {
    failed++;
    console.log('  X ' + fns[i].name + ': ' + e.message);
  }
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
