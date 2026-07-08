/**
 * spark-html-language-server — analyzer semantics (declarations, template
 * refs, diagnostics) and the LSP server end-to-end (in-process, no stdio).
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { analyze } from '../src/analyze.js';
import { SparkLanguageServer, offsetToPosition, positionToOffset } from '../src/server.js';
import { directiveDoc } from '../src/docs.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}

console.log('\nspark-html-language-server');

const byCode = (a, code) => a.diagnostics.filter((d) => d.code === code);

await test('declarations: let / export let / function / $: / imports, with offsets', () => {
  const src = `<h1>{title}</h1>
<script>
  import { fmt, other as alias } from './lib.js';
  export let title = 'Hi';
  let count = 0, extra = 1;
  $: doubled = count * 2;
  function inc() { count++; }
</script>`;
  const a = analyze(src);
  assert.deepEqual(
    [...a.declarations.keys()].sort(),
    ['alias', 'count', 'doubled', 'extra', 'fmt', 'inc', 'title'],
  );
  assert.equal(a.declarations.get('title').kind, 'prop');
  assert.equal(a.declarations.get('count').kind, 'let');
  assert.equal(a.declarations.get('extra').kind, 'let');
  assert.equal(a.declarations.get('doubled').kind, 'reactive');
  assert.equal(a.declarations.get('inc').kind, 'function');
  assert.equal(a.declarations.get('fmt').kind, 'import');
  assert.deepEqual(a.props.map((p) => p.name), ['title']);
  // offsets point at the declared name
  const d = a.declarations.get('count');
  assert.equal(src.slice(d.offset, d.offset + 5), 'count');
});

await test('undefined template binding flagged; declared ones are not', () => {
  const a = analyze(`<p>{count} {missing}</p>
<button onclick="{inc}">+</button>
<script>
  let count = 0;
  function inc() { count++; }
</script>`);
  const un = byCode(a, 'undefined-binding');
  assert.deepEqual(un.map((d) => d.message.match(/'(\w+)'/)[1]), ['missing']);
  assert.equal(un[0].severity, 2);
});

await test('each scope: item + index defined inside, not outside; key expr sees item', () => {
  const a = analyze(`<template each="todo, i in todos" key="todo.id">
  <li>{todo} #{i}</li>
</template>
<p>{todo}</p>
<script>
  let todos = ['a'];
</script>`);
  const un = byCode(a, 'undefined-binding');
  assert.deepEqual(un.map((d) => d.message.match(/'(\w+)'/)[1]), ['todo'], 'only the {todo} outside the block');
});

await test('await as="…" alias is in scope inside the block, not outside', () => {
  const a = analyze(`<template await="loadUser(id)" as="user">
  <p>Loading…</p>
  <template then><h1>Hi {user.name}</h1></template>
  <template catch><p>{user.message}</p></template>
</template>
<p>{user}</p>
<script>
  let id = 1;
  async function loadUser(id) { return { name: 'x' }; }
</script>`);
  const un = byCode(a, 'undefined-binding');
  assert.deepEqual(un.map((d) => d.message.match(/'(\w+)'/)[1]), ['user'],
    'only the {user} outside the await block is flagged');
});

await test('each without key= is a hint; malformed each is an error', () => {
  const ok = analyze(`<template each="t in items"><li>{t}</li></template>
<script>let items = [];</script>`);
  const hint = byCode(ok, 'each-no-key');
  assert.equal(hint.length, 1);
  assert.equal(hint[0].severity, 4);
  const bad = analyze(`<template each="items"><li>x</li></template>
<script>let items = [];</script>`);
  assert.equal(byCode(bad, 'each-malformed').length, 1);
  assert.equal(byCode(bad, 'each-no-key').length, 0);
});

await test('await blocks: `await` usable inside then/catch, flagged outside', () => {
  const a = analyze(`<template await="load(id)">
  <p>Loading…</p>
  <template then><b>{await.name}</b></template>
  <template catch><i>{await.message}</i></template>
</template>
<script>
  let id = 1;
  async function load(x) { return { name: 'x' + x }; }
</script>`);
  assert.equal(byCode(a, 'undefined-binding').length, 0);
});

await test('unused import warned (with Unnecessary tag semantics); used ones are not', () => {
  const a = analyze(`<p>{fmt(1)}</p>
<script>
  import { fmt, unused } from './lib.js';
</script>`);
  const un = byCode(a, 'unused-import');
  assert.deepEqual(un.map((d) => d.message.match(/'(\w+)'/)[1]), ['unused']);
});

await test('script syntax errors are reported as errors', () => {
  const a = analyze(`<p>hi</p>
<script>
  let count = ;
</script>`);
  const errs = byCode(a, 'script-syntax');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].severity, 1);
});

await test('spark-ignore subtrees and <style> are never analyzed', () => {
  const a = analyze(`<pre spark-ignore>{not.a.binding} {ghost}</pre>
<style>h1 { color: red; }</style>
<p>{real}</p>
<script>let real = 1;</script>`);
  assert.equal(byCode(a, 'undefined-binding').length, 0);
});

await test('dynamic :attrs, bind:, if/else-if refs are checked; strings/comments are not', () => {
  const a = analyze(`<button :disabled="count >= max" onclick="{inc}">x</button>
<input bind:value="draft" />
<template if="mode === 'on'"><p>on</p></template>
<template else-if="ghost > 1"><p>?</p></template>
<script>
  let count = 0, max = 10, draft = '';
  let mode = 'off';
  // {commented} should not count as a use of anything
  function inc() { count += 1; }
</script>`);
  const un = byCode(a, 'undefined-binding');
  assert.deepEqual(un.map((d) => d.message.match(/'(\w+)'/)[1]), ['ghost']);
});

await test('unstable-prop-name: hyphenated/uppercase import props flagged; lowercase and data-*/aria-* are not', () => {
  const a = analyze(`<div import="/components/nav"
  me-name="{a}"
  meUsername="{a}"
  mename="{a}"
  data-foo="{a}"
  aria-label="ok"
></div>
<script>let a = 1;</script>`);
  const bad = byCode(a, 'unstable-prop-name');
  assert.deepEqual(bad.map((d) => d.message.match(/^'([^']+)'/)[1]).sort(), ['me-name', 'meUsername']);
});

await test('unquoted-handler-whitespace: whitespace inside an unquoted on*={…} is flagged; quoted or space-free is not', () => {
  const a = analyze(`<button onclick={doThing(a, b)}>x</button>
<button onclick={doThing(a,b)}>y</button>
<button onclick="{doThing(a, b)}">z</button>
<button onclick={remove}>w</button>
<script>
  function doThing() {}
  function remove() {}
  let a = 1, b = 2;
</script>`);
  const bad = byCode(a, 'unquoted-handler-whitespace');
  assert.equal(bad.length, 1, 'only the unquoted handler WITH internal whitespace is flagged');
});

await test('directive docs cover the core + package directives', () => {
  for (const w of ['each', 'if', 'else-if', 'await', 'then', 'catch', 'key',
    'bind:value', 'bind:group', 'route', 'transition', 'transition:fade',
    ':hidden', 'spark-ignore', 'import',
    'spark-ssr', 'table', 'live', 'seed', 'limit', 'search', 'cache', 'guard',
    'redirect', 'status', 'flash', 'job', 'every', 'auto',
    'spark-pager', 'spark-search', 'spark-flash']) {
    assert.ok(directiveDoc(w), `doc for ${w}`);
  }
});

// ── spark-ssr awareness ─────────────────────────────────────────────────────

await test('spark-ssr: table= declares the page var (and its singular)', () => {
  const a = analyze(`<template each="todo in todos"><li>{todo.title}</li></template>
<spark-ssr table="todos" live />`);
  assert.equal(byCode(a, 'undefined-binding').length, 0);
  assert.ok(a.isSSRPage);
  assert.ok(a.ssrVars.has('todos') && a.ssrVars.has('todo'));
});

await test('spark-ssr: named-data block declares vars, incl. the METHOD → name = form', () => {
  const a = analyze(`<h1>{post.title}</h1><p>{author.name}</p>
<spark-ssr>
  GET /api/posts → posts = SELECT * FROM posts WHERE published = 1
  author = SELECT id, name, bio FROM users LIMIT 1
</spark-ssr>`);
  assert.equal(byCode(a, 'undefined-binding').length, 0, 'post/author both resolved (post via singular(posts))');
});

await test('spark-ssr: URL/glob/module sources also declare their var name', () => {
  const a = analyze(`<p>{repo.name} {weather.temp}</p>
<template each="p in posts"><p>{p.body}</p></template>
<spark-ssr>
  repo    = https://api.github.com/repos/wilkinnovo/spark-html
  posts   = ./content/posts/*.md
  weather = ./lib/weather.js
</spark-ssr>`);
  assert.equal(byCode(a, 'undefined-binding').length, 0);
});

await test('spark-ssr: ambient globals (session/path/flash/errors/values) never flagged', () => {
  const a = analyze(`<p>{session} {path} {flash} {errors.title} {values.title}</p>
<spark-ssr table="posts" />`);
  assert.equal(byCode(a, 'undefined-binding').length, 0);
});

await test('spark-ssr: undeclared handler refs are assumed synthesized; non-SSR pages still flag them', () => {
  const ssr = analyze(`<button onclick={remove}>x</button>\n<spark-ssr table="todos" />`);
  assert.equal(byCode(ssr, 'undefined-binding').length, 0);
  const core = analyze(`<button onclick={remove}>x</button>`);
  assert.equal(byCode(core, 'undefined-binding').length, 1);
});

await test('spark-ssr: hover on ambient helpers and page data', () => {
  const src = `<p>{posts.length} {session}</p>\n<spark-ssr table="posts" />`;
  const a = analyze(src);
  assert.ok(a.ssrVars.has('posts'));
});

await test('position mapping round-trips', () => {
  const text = 'ab\ncde\n\nf';
  for (let o = 0; o <= text.length; o++) {
    assert.equal(positionToOffset(text, offsetToPosition(text, o)), o, `offset ${o}`);
  }
});

// ── LSP server end-to-end (in-process) ─────────────────────────────────────

function makeServer() {
  const sent = [];
  const server = new SparkLanguageServer({ send: (m) => sent.push(m) });
  const request = (method, params) => {
    const id = sent.length + 1000;
    server.handle({ jsonrpc: '2.0', id, method, params });
    return sent.find((m) => m.id === id)?.result;
  };
  const notify = (method, params) => server.handle({ jsonrpc: '2.0', method, params });
  const lastDiagnostics = () =>
    [...sent].reverse().find((m) => m.method === 'textDocument/publishDiagnostics')?.params;
  return { server, sent, request, notify, lastDiagnostics };
}

// A tiny on-disk project: app.html imports card.html (which declares props).
const dir = mkdtempSync(join(tmpdir(), 'spark-lsp-'));
mkdirSync(join(dir, 'components'));
writeFileSync(join(dir, 'components/card.html'), `<h2>{name} — {price}</h2>
<script>
  export let name = 'Widget';
  export let price = 0;
</script>`);
const appSrc = `<div import="components/card" name="Ada"></div>
<div import="components/nope"></div>
<p>{greeting}</p>
<script>
  let greeting = 'hi';
</script>`;
writeFileSync(join(dir, 'app.html'), appSrc);
const appUri = pathToFileURL(join(dir, 'app.html')).href;

await test('server: initialize → didOpen publishes diagnostics incl. missing component file', () => {
  const { request, notify, lastDiagnostics } = makeServer();
  const init = request('initialize', { rootUri: pathToFileURL(dir).href });
  assert.equal(init.capabilities.hoverProvider, true);
  assert.ok(init.capabilities.completionProvider.triggerCharacters.includes('{'));
  notify('textDocument/didOpen', { textDocument: { uri: appUri, text: appSrc } });
  const diags = lastDiagnostics();
  assert.equal(diags.uri, appUri);
  const notFound = diags.diagnostics.filter((d) => d.code === 'component-not-found');
  assert.equal(notFound.length, 1);
  assert.match(notFound[0].message, /components\/nope/);
});

await test('server: go-to-definition jumps to the imported component file', () => {
  const { request, notify } = makeServer();
  request('initialize', { rootUri: pathToFileURL(dir).href });
  notify('textDocument/didOpen', { textDocument: { uri: appUri, text: appSrc } });
  const pos = offsetToPosition(appSrc, appSrc.indexOf('components/card') + 3);
  const def = request('textDocument/definition', { textDocument: { uri: appUri }, position: pos });
  assert.ok(def.uri.endsWith('components/card.html'), def.uri);
});

await test('server: definition on a symbol lands on its declaration', () => {
  const { request, notify } = makeServer();
  request('initialize', {});
  notify('textDocument/didOpen', { textDocument: { uri: appUri, text: appSrc } });
  const pos = offsetToPosition(appSrc, appSrc.indexOf('{greeting}') + 2);
  const def = request('textDocument/definition', { textDocument: { uri: appUri }, position: pos });
  assert.equal(def.uri, appUri);
  const declOffset = positionToOffset(appSrc, def.range.start);
  assert.equal(appSrc.slice(declOffset, declOffset + 8), 'greeting');
});

await test('server: prop completion inside an import placeholder reads export let', () => {
  const { request, notify } = makeServer();
  request('initialize', { rootUri: pathToFileURL(dir).href });
  notify('textDocument/didOpen', { textDocument: { uri: appUri, text: appSrc } });
  const pos = offsetToPosition(appSrc, appSrc.indexOf(' name="Ada"'));
  const result = request('textDocument/completion', { textDocument: { uri: appUri }, position: pos });
  const labels = result.items.map((i) => i.label);
  assert.ok(labels.includes('name') && labels.includes('price'), `props in ${labels.slice(0, 8)}`);
  assert.ok(labels.includes('each') && labels.includes('bind:value'), 'directives offered too');
});

await test('server: {expr} completion offers script symbols + builtins', () => {
  const { request, notify } = makeServer();
  request('initialize', {});
  const src = `<p>{gr}</p>\n<script>\n  let greeting = 'hi';\n</script>`;
  notify('textDocument/didOpen', { textDocument: { uri: 'file:///t.html', text: src } });
  const pos = offsetToPosition(src, src.indexOf('{gr}') + 3);
  const result = request('textDocument/completion', { textDocument: { uri: 'file:///t.html' }, position: pos });
  const labels = result.items.map((i) => i.label);
  assert.ok(labels.includes('greeting'), 'declared symbol');
  assert.ok(labels.includes('useStore'), 'spark builtin');
});

await test('server: hover documents directives and declarations', () => {
  const { request, notify } = makeServer();
  request('initialize', {});
  const src = `<input bind:value="draft" />\n<template each="t in items"></template>\n<script>\n  let draft = '';\n  let items = [];\n</script>`;
  notify('textDocument/didOpen', { textDocument: { uri: 'file:///h.html', text: src } });
  const hoverAt = (needle, delta = 1) => request('textDocument/hover', {
    textDocument: { uri: 'file:///h.html' },
    position: offsetToPosition(src, src.indexOf(needle) + delta),
  });
  assert.match(hoverAt('bind:value').contents.value, /Two-way binding/);
  assert.match(hoverAt('each=').contents.value, /Repeat/);
  assert.match(hoverAt('draft = ').contents.value, /component state/);
});

await test('server: spark-ssr hover + completion surface ambient helpers and page data', () => {
  const { request, notify } = makeServer();
  request('initialize', {});
  const src = `<p>{posts.length}</p>\n<button onclick={create}>Add</button>\n<spark-ssr table="posts" />`;
  notify('textDocument/didOpen', { textDocument: { uri: 'file:///ssr.html', text: src } });
  const hoverAt = (needle, delta = 1) => request('textDocument/hover', {
    textDocument: { uri: 'file:///ssr.html' },
    position: offsetToPosition(src, src.indexOf(needle) + delta),
  });
  assert.match(hoverAt('table=').contents.value, /Backs this page with a table/);
  assert.match(hoverAt('posts.length').contents.value, /spark-ssr page data/);

  const pos = offsetToPosition(src, src.indexOf('{posts') + 1);
  const result = request('textDocument/completion', { textDocument: { uri: 'file:///ssr.html' }, position: pos });
  const labels = result.items.map((i) => i.label);
  assert.ok(labels.includes('posts'), 'ssr page var offered');
  assert.ok(labels.includes('api_create') && labels.includes('refresh'), `ssr ambients offered in ${labels}`);
});

await test('server: didChange re-publishes; didClose clears; unknown requests answered', () => {
  const { request, notify, lastDiagnostics, sent } = makeServer();
  request('initialize', {});
  const uri = 'file:///x.html';
  notify('textDocument/didOpen', { textDocument: { uri, text: '<p>{nope}</p>' } });
  assert.equal(lastDiagnostics().diagnostics.length, 1);
  notify('textDocument/didChange', {
    textDocument: { uri },
    contentChanges: [{ text: '<p>{ok}</p>\n<script>let ok = 1;</script>' }],
  });
  assert.equal(lastDiagnostics().diagnostics.length, 0);
  notify('textDocument/didClose', { textDocument: { uri } });
  assert.equal(lastDiagnostics().diagnostics.length, 0);
  const before = sent.length;
  const res = request('workspace/executeCommand', {});
  assert.equal(res, null);
  assert.equal(sent.length, before + 1, 'unknown request got a response');
});

await test('semantic tokens: <spark-ssr> SQL, params, sources, routes', async () => {
  const { request, notify } = makeServer();
  request('initialize', {});
  const uri = 'file:///ssr.html';
  const text = `<spark-ssr guard="session" redirect="/login" />
<spark-ssr>
  me = SELECT id, name FROM users WHERE id = :session.id
  posts = ./content/*.md
  GET /api/x → found = SELECT 'a FROM b' AS s, 42 FROM t
    WHERE t.n > 10 -- keep top
</spark-ssr>
<p>{me.name}</p>`;
  notify('textDocument/didOpen', { textDocument: { uri, text } });
  const res = request('textDocument/semanticTokens/full', { textDocument: { uri } });
  assert.ok(res && Array.isArray(res.data) && res.data.length > 0, 'tokens returned');
  assert.equal(res.data.length % 5, 0, 'wire format is 5-tuples');
  // Decode back to absolute {line,char,len,type} for assertions.
  const { TOKEN_TYPES } = await import('../src/semantic.js');
  const toks = [];
  for (let i = 0, line = 0, char = 0; i < res.data.length; i += 5) {
    line += res.data[i];
    char = res.data[i] === 0 ? char + res.data[i + 1] : res.data[i + 1];
    toks.push({ line, char, len: res.data[i + 2], type: TOKEN_TYPES[res.data[i + 3]] });
  }
  const lines = text.split('\n');
  const at = (t) => lines[t.line].slice(t.char, t.char + t.len);
  const of = (type) => toks.filter((t) => t.type === type).map(at);
  assert.ok(of('keyword').includes('SELECT') && of('keyword').includes('FROM') && of('keyword').includes('WHERE'), 'SQL keywords');
  assert.ok(of('keyword').includes('GET'), 'HTTP method is a keyword');
  assert.ok(of('parameter').includes(':session.id'), ':param token');
  assert.ok(of('variable').includes('me') && of('variable').includes('posts') && of('variable').includes('found'), 'binding names');
  assert.ok(of('string').includes('./content/*.md'), 'glob source is a string');
  assert.ok(of('string').includes('/api/x'), 'route path is a string');
  assert.ok(of('string').includes(`'a FROM b'`), 'SQL string literal (keyword inside NOT tokenized)');
  assert.ok(of('number').includes('42') && of('number').includes('10'), 'numbers, incl. on a continuation line');
  assert.ok(of('comment').includes('-- keep top'), 'SQL -- comment');
  // no token overlaps the self-closing tag's line (line 0)
  assert.ok(toks.every((t) => t.line !== 0), 'self-closing tag produces no tokens');
});

await test('formatting: delegates to prettier-plugin-spark when resolvable', async () => {
  const { server, request, notify, sent } = makeServer();
  request('initialize', { rootUri: pathToFileURL(join(process.cwd())).href });
  const uri = 'file:///fmt.html';
  const text = `<spark-ssr>\n  me = SELECT id FROM users WHERE id = :session.id\n  contacts = SELECT id FROM users\n</spark-ssr>\n`;
  notify('textDocument/didOpen', { textDocument: { uri, text } });
  const id = 777;
  server.handle({ jsonrpc: '2.0', id, method: 'textDocument/formatting', params: {
    textDocument: { uri }, options: { tabSize: 2, insertSpaces: true },
  } });
  await new Promise((r) => setTimeout(r, 300)); // async respond
  const res = sent.find((m) => m.id === id)?.result;
  // In this monorepo the plugin resolves from the workspace root, so the
  // aligned `=` column must come back; if the resolver ever breaks, res is
  // null and this fails loudly rather than silently skipping.
  assert.ok(Array.isArray(res) && res.length === 1, 'one whole-document edit');
  assert.ok(res[0].newText.includes('me       = SELECT'), '= aligned across the block');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
