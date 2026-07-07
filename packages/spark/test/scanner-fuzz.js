/**
 * Script-scanner fuzz dimension (plan §5.1, M3.1 tail).
 *
 * The convergence fuzzer (fuzz.js) can't catch scanner corruption: if
 * analyzeScript rewrites code-like text INSIDE a string literal, the patched
 * mount and the fresh mount corrupt identically and the oracle passes. This
 * suite uses a KNOWN-VALUE oracle instead: generate random component scripts
 * whose strings/template literals contain code-like text (let/function/$:/
 * import/export-let lines, stray braces, quotes), mount them, and assert the
 * rendered value is byte-identical to the literal's real JS value.
 *
 * Usage: node packages/spark/test/scanner-fuzz.js [N scenarios]  (default 200)
 */
import './dom-shim.js';
import { body, parseHTML } from './dom-shim.js';
import { strict as assert } from 'node:assert';

const { mount, component } = await import('../src/index.js');
const { analyzeScript } = await import('../src/script.js');

function mulberry32(a) {
  return () => {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const settle = () => new Promise((r) => setTimeout(r, 5));

async function mountComponent(name, source) {
  component(name, source);
  body.childNodes = [];
  parseHTML(`<div import="${name}"></div>`, body);
  await mount(body);
  await settle();
  return body.querySelector(`[name="${name}"]`);
}

// ── Fixed regressions (each was silent corruption before the M3.1 tail) ──
let fixed = 0;

{ // 1. Top-level template literal with code-like lines stays byte-intact,
  //    leaks no scope keys, and declares no phantom props.
  const raw = '\nlet hidden = 1;\nfunction gone() { return 2; }\nexport let ghost = 3;\n$: bogus = hidden;\n';
  const a = analyzeScript('let code = `' + raw.replace(/`/g, '\\`') + '`;\nlet n = 7;');
  assert.ok(a.rewritten.includes('let hidden = 1;'), 'template-literal content must not be rewritten');
  assert.ok(a.rewritten.includes('function gone()'), 'function line inside string must survive');
  assert.ok(a.rewritten.includes('export let ghost'), 'export-let line inside string must survive');
  assert.ok(!a.propNames.has('ghost'), 'no phantom prop from string content');
  assert.ok(!a.seedNames.includes('hidden') && !a.seedNames.includes('gone'), 'no seed leak from string content');
  assert.ok(a.seedNames.includes('code') && a.seedNames.includes('n'), 'real declarations still seeded');
  assert.equal(a.reactiveStmts.length, 0, '$: inside a string is not a reactive statement');
  const el = await mountComponent('scregr1', `<p class="c">{code.length}</p><p class="n">{n}</p><script>let code = \`${raw.replace(/`/g, '\\`')}\`; let n = 7;</script>`);
  assert.equal(el.querySelector('.c').textContent, String(raw.length), 'rendered string length matches the real literal value');
  assert.equal(el.querySelector('.n').textContent, '7');
  fixed++;
}

{ // 2. Commented-out `export let` is not a prop.
  const a = analyzeScript('// export let old = 1\nlet live = 2;');
  assert.ok(!a.propNames.has('old'), 'commented export-let must not register a prop');
  assert.ok(a.seedNames.includes('live'));
  fixed++;
}

{ // 3. A string containing `/*` must not eat following declarations
  //    (the old regex comment-strip was not string-aware).
  const a = analyzeScript('let a = "/*"; let b = 2;\n/* real comment */\nlet c = 3;');
  assert.ok(a.seedNames.includes('a') && a.seedNames.includes('b') && a.seedNames.includes('c'),
    'declarations after a "/*" string must stay seeded');
  const el = await mountComponent('scregr3', '<p class="b">{b}</p><p class="c">{c}</p><script>let a = "/*"; let b = 2;\n/* x */\nlet c = 3;</script>');
  assert.equal(el.querySelector('.b').textContent, '2');
  assert.equal(el.querySelector('.c').textContent, '3');
  fixed++;
}

{ // 4. Regex literal containing a quote: loud warn naming the fix, and the
  //    NEXT line still rewrites correctly.
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const a = analyzeScript('let re = /"/;\nlet z = 5;');
    assert.ok(a.seedNames.includes('z'), 'declaration after the misparsed line still seeds');
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warns.some((w) => w.includes('regex') && w.includes('new RegExp')),
    'unparseable regex-with-quote must warn loudly and name the fix');
  fixed++;
}

{ // 5. `//` inside strings is content, not a comment (URLs included).
  const a = analyzeScript("let url = 'http://x.test/a'; let note = '// let z = 9'; let k = 1;");
  assert.ok(a.seedNames.includes('url') && a.seedNames.includes('note') && a.seedNames.includes('k'));
  assert.ok(!a.seedNames.includes('z'), 'no seed from comment-looking string content');
  const el = await mountComponent('scregr5', `<p class="u">{url}</p><p class="k">{k}</p><script>let url = 'http://x.test/a'; let note = '// let z = 9'; let k = 1;</script>`);
  assert.equal(el.querySelector('.u').textContent, 'http://x.test/a');
  assert.equal(el.querySelector('.k').textContent, '1');
  fixed++;
}

{ // 6. import-like text in a string is not extracted as an import.
  const a = analyzeScript(`let s = 'import { a } from "b";'; let ok = 1;`);
  assert.equal(a.hasImports, false, 'import inside a string must not be replayed');
  assert.ok(a.rewritten.includes('import { a } from "b";'), 'string content intact');
  fixed++;
}

console.log(`  fixed regressions: ${fixed}/6`);

// ── Random dimension ─────────────────────────────────────────────────────
// Code-like raw fragments that must survive inside string literals.
const FRAGMENTS = [
  'let hidden = 1;',
  'const gone = 2, twin = 3;',
  'var v4 = 4;',
  'function fake() { return 5; }',
  'async function fk() {}',
  '$: bogus = hidden + 1',
  'import { x } from "mod";',
  'import * as ns from "m2";',
  'export let ghost = 6;',
  'if (a) { let b = 7 }',
  '} else {',
  'for (const k of ks) {}',
  '/* not a comment */',
  '// not a line comment',
  'a } b { c',
  "it's got quotes",
  'say "hi" twice',
  'tick ` and ${notInterp}',
  'plain text with no code',
];
// Names that fragments *look like* they declare — none may leak into scope.
const LEAK_NAMES = ['hidden', 'gone', 'twin', 'v4', 'fake', 'fk', 'bogus', 'ns', 'ghost'];

function literalFor(style, raw) {
  if (style === '"') return JSON.stringify(raw);
  if (style === "'") {
    return "'" + raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
  }
  // template literal — newlines stay real (the multi-line case IS the bug class)
  return '`' + raw.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
}

function genScenario(rng, id) {
  const style = pick(rng, ['"', "'", '`']);
  const nFrags = 1 + Math.floor(rng() * 4);
  const parts = [];
  for (let i = 0; i < nFrags; i++) parts.push(pick(rng, FRAGMENTS));
  let raw = parts.join(style === '`' ? '\n' : ' | ');
  let lit = literalFor(style, raw);
  // Sometimes add a live interpolation to a template literal.
  if (style === '`' && rng() > 0.5) {
    raw += '\n42';
    lit = lit.slice(0, -1) + '\n${ 6 * 7 }`';
  }
  const num = Math.floor(rng() * 1000);
  const source =
    `<p class="s">{s}</p><p class="n">{n}</p><p class="t">{t}</p><p class="g">{get()}</p>` +
    `<script>let s = ${lit};\nlet n = ${num};\n$: t = s.length;\nfunction get() { return s; }</script>`;
  return { name: `scfz${id}`, source, lit, raw, num };
}

const NUM = parseInt(process.argv[2] || '200', 10);
const SEED = parseInt(process.argv[3] || '1337', 10);
let passed = 0;
let failed = 0;

for (let i = 0; i < NUM; i++) {
  const rng = mulberry32(SEED + i);
  const sc = genScenario(rng, i);
  try {
    // Generator self-check: the literal really evaluates to the raw value,
    // so any mismatch below indicts the scanner, not this test.
    assert.equal((0, eval)('(' + sc.lit + ')'), sc.raw, 'generator produced a bad literal');

    const el = await mountComponent(sc.name, sc.source);
    assert.ok(el, 'component mounted');
    assert.equal(el.querySelector('.s').textContent, sc.raw, 'string value byte-intact');
    assert.equal(el.querySelector('.n').textContent, String(sc.num));
    assert.equal(el.querySelector('.t').textContent, String(sc.raw.length), '$: sees the real value');
    assert.equal(el.querySelector('.g').textContent, sc.raw, 'function reading the string sees the real value');
    for (const leak of LEAK_NAMES) {
      assert.ok(!(leak in el.__sparkScope) || el.__sparkScope[leak] === undefined,
        `scope leak: "${leak}" from string content`);
    }
    // Mutate an unrelated var; the string must survive the repatch.
    el.__sparkScope.n = sc.num + 1;
    await settle();
    assert.equal(el.querySelector('.n').textContent, String(sc.num + 1), 'reactivity intact');
    assert.equal(el.querySelector('.s').textContent, sc.raw, 'string survives repatch');
    passed++;
  } catch (e) {
    failed++;
    console.log(`\n  ❌ scanner-fuzz ${i} (seed=${SEED + i}) — ${e.message}`);
    console.log(`  literal: ${sc.lit.slice(0, 120)}`);
    if (failed >= 10) break;
  }
}

console.log(`\nscanner-fuzz: ${passed} passed, ${failed} failed (${NUM} scenarios, 6 fixed regressions)`);
process.exit(failed ? 1 : 0);
