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

// ── <spark-ssr> block formatting ─────────────────────────────────────────

// The oracle: spark-ssr's own extractBlocks must see the SAME data before and
// after formatting (SQL whitespace-normalized — insignificant outside strings,
// and the runtime is reflow-tolerant by design).
import { extractBlocks } from '../../spark-ssr/src/parse.js';
const normSql = (b) => JSON.parse(JSON.stringify(b, (k, v) =>
  (k === 'sql' && typeof v === 'string') ? v.replace(/\s+/g, ' ').trim() : v));
const sameBlocks = (a, b) =>
  JSON.stringify(normSql(extractBlocks(a).blocks)) ===
  JSON.stringify(normSql(extractBlocks(b).blocks));

const ssrSrc = `<h1>{me.name}</h1>
<spark-ssr guard="session" redirect="/login" />
<spark-ssr table="messages" seed="./seed/messages.json" live />
<spark-ssr>
  me = SELECT id, name, email, COALESCE(bio, '') AS bio, avatar FROM users WHERE id = :session.id
  contacts = SELECT id, name FROM users WHERE id != :session.id ORDER BY name
  repo = https://api.github.com/repos/x/y
  posts = ./content/posts/*.md
  weather = ./lib/weather.js
  GET /api/search → found = SELECT * FROM users WHERE name LIKE '%' || :q || '%' AND bio IS NOT NULL AND email != '' ORDER BY name LIMIT 20
</spark-ssr>
`;
const ssrOut = await fmt(ssrSrc);

// 7. spark-ssr sees identical data before and after.
ok(sameBlocks(ssrSrc, ssrOut), '<spark-ssr> round-trips through extractBlocks');

// 8. bindings got one line each with = aligned to the longest name.
ok(ssrOut.includes('  me       = SELECT'), 'short name padded to alignment column');
ok(ssrOut.includes('  contacts = SELECT'), 'longest name defines the column');
ok(ssrOut.includes('  repo     = https://api.github.com/repos/x/y'), 'url binding aligned');
ok(ssrOut.includes('  posts    = ./content/posts/*.md'), 'glob binding aligned');
ok(ssrOut.includes('  weather  = ./lib/weather.js'), 'module binding aligned');

// 9. long SQL breaks before top-level clauses, indented past the binding.
ok(/ {2}me {7}= SELECT id, name, email, COALESCE\(bio, ''\) AS bio, avatar\n {4}FROM users\n {4}WHERE id = :session\.id/.test(ssrOut),
  'long SQL breaks at FROM/WHERE with house-style continuation indent');

// 10. route lines keep METHOD/path/arrow and format their SQL too.
ok(ssrOut.includes('GET /api/search → found = SELECT *'), 'route head preserved');
ok(ssrOut.includes('FROM users'), 'route SQL present');

// 11. clause keywords inside SQL strings never cause a break.
const strSrc = `<spark-ssr>\n  x = SELECT 'keep FROM here' AS a, b FROM t WHERE b = 'a  ORDER BY b' AND c > 0 AND d < 9 AND e != 3 AND f IS NOT NULL\n</spark-ssr>\n`;
const strOut = await fmt(strSrc);
ok(strOut.includes(`'keep FROM here'`), 'FROM inside a string not treated as a clause');
ok(strOut.includes(`'a  ORDER BY b'`), 'string interior whitespace and keywords untouched');
ok(sameBlocks(strSrc, strOut), 'string-heavy SQL round-trips');

// 12. multi-line SQL that ALREADY continues is re-flowed and still parses.
const multiSrc = `<spark-ssr>\n  pins = SELECT p.*, u.name AS owner_name\n    FROM pins p JOIN users u ON u.id = p.user_id\n    WHERE p.title LIKE '%' || :q || '%'\n    ORDER BY p.created_at DESC\n</spark-ssr>\n`;
const multiOut = await fmt(multiSrc);
ok(sameBlocks(multiSrc, multiOut), 'authored multi-line SQL round-trips');

// 13. a SQL comment disables reflow (whitespace is significant after `--`).
const cmtSrc = `<spark-ssr>\n  a = SELECT x -- picks the row\n    FROM t\n</spark-ssr>\n`;
const cmtOut = await fmt(cmtSrc);
ok(cmtOut.includes('-- picks the row'), 'SQL comment preserved');
ok(sameBlocks(cmtSrc, cmtOut), 'commented SQL round-trips (structure kept)');

// 14. unknown lines pass through byte-identical; self-closing tags untouched.
ok(ssrOut.includes('<spark-ssr guard="session" redirect="/login" />'), 'self-closing tag untouched');
ok(ssrOut.includes('<spark-ssr table="messages" seed="./seed/messages.json" live />'), 'table tag untouched');

// 15. idempotent on ssr blocks too.
ok((await fmt(ssrOut)) === ssrOut, 'ssr formatting idempotent');

console.log(`prettier-plugin-spark: ${n} assertions passed`);
