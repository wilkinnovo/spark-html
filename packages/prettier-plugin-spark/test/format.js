// prettier-plugin-spark — formats <script>/<style>, leaves markup byte-identical.
import assert from 'node:assert';
import { format } from 'prettier';
import * as plugin from '../index.js';

const fmt = (src) => format(src, { parser: 'spark', plugins: [plugin] });

const stripBlocks = (s) =>
  s
    .replace(/(<script[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
    .replace(/(<style[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2')
    .replace(/\n+$/, '');

let n = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  n++;
};

const src = `<div class="card">
  <button onclick="{inc}">+ {count}</button>
  <button onclick="{() => (count += step)}">jump</button>
  <p>{count > 5 ? 'big number here' : 'small'}</p>
  <input :value="draft" @input="draft = $event.target.value">
  <template each="x, i in items">
    <li :key="i">{i}: {x}</li>
  </template>
</div>

<script>
let count=0
let step=2
let draft=''
let items=['a','b']
$: doubled=count*2
function inc(){count++}
</script>

<style>
.card{padding:1rem;color:red}
</style>
`;

const out = await fmt(src);

// 1. markup outside <script>/<style> is byte-for-byte identical (modulo the
//    single trailing newline Prettier guarantees at EOF).
ok(stripBlocks(out) === stripBlocks(src), 'markup must be byte-identical');

// 2. Spark-specific syntax that generic parsers corrupt is preserved exactly.
ok(out.includes('onclick="{inc}"'), 'inline handler {inc} preserved');
ok(out.includes('onclick="{() => (count += step)}"'), 'inline arrow handler preserved');
ok(out.includes(`{count > 5 ? 'big number here' : 'small'}`), 'text interpolation preserved (no string corruption)');
ok(out.includes(':value="draft"'), ':binding preserved');
ok(out.includes('@input="draft = $event.target.value"'), '@event preserved');
ok(out.includes('<template each="x, i in items">'), '<template each> preserved');

// 3. <script> / <style> ARE formatted (the safe, useful part).
ok(out.includes('let count = 0;'), 'script formatted as JS (semicolons + spacing)');
ok(out.includes('$: doubled = count * 2;'), 'reactive $: label formatted, still valid');
ok(/\.card\s*\{[\s\S]*padding: 1rem;/.test(out), 'style formatted as CSS');

// 4. idempotent — formatting the output again changes nothing.
ok((await fmt(out)) === out, 'idempotent');

// 5. empty / missing blocks don't throw and leave a pure-markup file untouched.
const markupOnly = `<p>{a && b}</p>\n`;
ok((await fmt(markupOnly)) === markupOnly, 'pure-markup file unchanged');

// 6. an unparseable <script> is left as-is rather than failing the whole file.
const broken = `<div>{x}</div>\n<script>\nlet = = =\n</script>\n`;
const brokenOut = await fmt(broken);
ok(brokenOut.includes('let = = ='), 'unparseable script left untouched, no throw');

console.log(`prettier-plugin-spark: ${n} assertions passed`);
