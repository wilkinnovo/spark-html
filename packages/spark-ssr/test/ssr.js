/**
 * spark-ssr — the whole doc, exercised against real temp projects. Runs under
 * `bun` (Bun.serve / bun:sqlite are the product); the root `npm test` chain
 * invokes it through scripts/test-bun.mjs, which skips when bun is absent.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseHTML } from 'linkedom';

import {
  serve, rewriteParams, analyze, extractBlocks, dataPlan, singleShaped,
  extractForms, validateFields, parseFrontMatter, sqlTables, renderFragment,
  makeSourceCache, handlerRoles, projectSchema,
} from '../src/index.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.stack || e.message}`); }
}

console.log('\nspark-ssr');

// ── parsing ─────────────────────────────────────────────────────────────
await test('rewriteParams: prefixes, quotes, casts, dashes', () => {
  const r = rewriteParams(
    "SELECT * FROM posts WHERE title LIKE '%' || :q || '%' AND at > '12:30' AND ip = :header.x-forwarded-for AND uid = :session.id::text",
  );
  assert.deepEqual(r.tokens, ['q', 'header.x-forwarded-for', 'session.id']);
  assert.ok(r.sql.includes("'12:30'"), 'quoted colon untouched');
  assert.ok(r.sql.includes('?::text'), ':: cast preserved');
  assert.equal((r.sql.match(/\?/g) || []).length, 3);
});

await test('extractBlocks: table mode, explicit routes, multi-line SQL', () => {
  const { blocks, html } = extractBlocks(`
    <h1>Hi</h1>
    <spark-ssr table="todos" />
    <spark-ssr>
      GET /api/videos/:id → SELECT v.* FROM videos v
        WHERE v.id = :id
      POST /api/videos -> INSERT INTO videos (title) VALUES (:body.title)
    </spark-ssr>`);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].table, 'todos');
  assert.equal(blocks[1].routes.length, 2);
  assert.equal(blocks[1].routes[0].method, 'GET');
  assert.ok(blocks[1].routes[0].sql.includes('WHERE v.id = :id'), 'multi-line SQL joined');
  assert.equal(blocks[1].routes[1].method, 'POST');
  assert.ok(!html.includes('spark-ssr'), 'blocks removed from markup');
});

await test('analyze + dataPlan: needs, handler roles, singular match, fallback', () => {
  const a = analyze(`
    <template await="todos">
      <input bind:value="draft"><button onclick={add}>Add</button>
      <template each="todo in todos">
        <input type="checkbox" bind:checked="todo.done" onchange={patch}>
        <button onclick={remove}>x</button>
      </template>
    </template>
    <h2>{video.title}</h2>
    <p>{q}</p>`);
  assert.ok(a.needs.has('todos') && a.needs.has('video') && a.needs.has('q'));
  assert.ok(!a.needs.has('draft') && !a.needs.has('add'), 'local state and handlers excluded');
  assert.deepEqual(a.topBinds.map((b) => b.v), ['draft']);
  assert.deepEqual(a.rowBinds, [{ loopVar: 'todo', field: 'done', kind: 'checked' }]);
  const roles = {
    insert: a.handlers.find((h) => !h.inEach).name,
    update: a.handlers.find((h) => h.inEach && h.withMemberBind).name,
    del: a.handlers.find((h) => h.inEach && !h.withMemberBind).name,
  };
  assert.deepEqual(roles, { insert: 'add', update: 'patch', del: 'remove' });

  const plan = dataPlan(a, [
    { table: 'todos', routes: [] },
    { table: null, routes: [{ method: 'GET', path: '/api/videos/:id', sql: 'SELECT 1' }] },
  ]);
  const byVar = Object.fromEntries(plan.map((p) => [p.var, p]));
  assert.equal(byVar.todos.source.table, 'todos');
  assert.equal(byVar.video.source.name, 'videos', 'singular matched plural endpoint');
  assert.equal(byVar.video.shape, 'row');
  assert.ok(!byVar.q, '{q} comes from the request, not a query');
});

await test('dataPlan: lone member-need binds the lone endpoint (blog case)', () => {
  const a = analyze('<h1>{post.title}</h1><p>{q}</p>');
  const plan = dataPlan(a, [{ table: null, routes: [{ method: 'GET', path: '/api/blog', sql: 'SELECT 1' }] }]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].var, 'post');
  assert.equal(plan[0].shape, 'row');
});

await test('dataPlan: {x.length}/{x.some(...)} don\'t mistake a list source for a single row', () => {
  // Regression: a plain-array/method read on a named source used to be
  // conflated with real per-row field access ({post.title}) because both
  // look identical to the "{x.y}" root-finder — savedIds.length/.some(...)
  // made shapeOf() treat savedIds as a single row (rows[0] ?? null),
  // silently handing the template `null` instead of the real array.
  const a = analyze(`
    <p>{savedIds.length}</p>
    <template each="b in boards"><p>{savedIds.some(s => s.id === b.id) ? '✓' : ''}</p></template>
  `);
  const plan = dataPlan(a, [
    { table: null, bindings: [{ var: 'savedIds', kind: 'sql', sql: 'SELECT id FROM saves WHERE pin_id = :id' }], routes: [] },
  ]);
  const byVar = Object.fromEntries(plan.map((p) => [p.var, p]));
  assert.equal(byVar.savedIds.shape, 'list', '.length/.some(...) must not imply single-row shape');

  // A REAL per-row field read still resolves to 'row' as before.
  const b = analyze('<p>{post.title}</p>');
  const planB = dataPlan(b, [{ table: null, bindings: [{ var: 'post', kind: 'sql', sql: 'SELECT * FROM posts WHERE id = :id' }], routes: [] }]);
  assert.equal(planB[0].shape, 'row', 'real member access ({post.title}) is unaffected');
});

await test('dataPlan: ANY method call on a source is list-safe, not just allowlisted names', () => {
  // Regression: the ARRAY_LIKE_MEMBERS allowlist is finite — a method not on
  // it (.hasOwnProperty(), .toLocaleString(), ...) still flipped a genuine
  // list source to 'row'. A member access followed by `(` is a CALL: rows
  // are plain SQL objects with no methods of their own, so a call can never
  // be a per-row field read and must never imply single-row shape.
  const a = analyze('<p>{a.hasOwnProperty(0)}</p><p>{b.toLocaleString()}</p>');
  const plan = dataPlan(a, [
    { table: null, bindings: [{ var: 'a', kind: 'sql', sql: 'SELECT id FROM saves' }], routes: [] },
    { table: null, bindings: [{ var: 'b', kind: 'sql', sql: 'SELECT id FROM saves LIMIT 5' }], routes: [] },
  ]);
  const byVar = Object.fromEntries(plan.map((p) => [p.var, p]));
  assert.equal(byVar.a.shape, 'list', 'x.hasOwnProperty(...) must not imply single-row shape');
  assert.equal(byVar.b.shape, 'list', 'LIMIT 5 is not single-shaped; x.toLocaleString() is a call');

  // A field read that is NOT a call still marks the root as a row — and a
  // chained call on a real field ({user.name.toUpperCase()}) keeps it one.
  const b2 = analyze('<p>{user.name.toUpperCase()}</p>');
  const planB = dataPlan(b2, [{ table: null, bindings: [{ var: 'user', kind: 'sql', sql: 'SELECT * FROM users WHERE id = :id' }], routes: [] }]);
  assert.equal(planB[0].shape, 'row', 'a chained call on a field read is still member access');

  // And a called member never becomes an inferred schema column.
  assert.ok(!(a.memberFields.get('a') || new Set()).has('hasOwnProperty'),
    'a method call must not register as a data field');
});

await test('dataPlan: a source referenced only from the page\'s own <script> still becomes real', () => {
  // Regression: dataPlan only walked analysis.needs (template-derived), so
  // a named source used ONLY in the script (`let following = !!amFollowing;`,
  // never `{amFollowing}` in the template) was silently dropped — the
  // generated client script never seeded it, and the author's own
  // reference threw a ReferenceError that killed the WHOLE script, not
  // just that one line.
  const a = analyze('<p>{profileUser.name}</p>'); // template never mentions amFollowing
  const authorScript = "let following = !!amFollowing;\nasync function toggleFollow() { following = !following; }";
  const plan = dataPlan(a, [
    { table: null, bindings: [{ var: 'profileUser', kind: 'sql', sql: 'SELECT * FROM users WHERE id = :id LIMIT 1' }], routes: [] },
    { table: null, bindings: [{ var: 'amFollowing', kind: 'sql', sql: 'SELECT id FROM follows WHERE follower_id = :session.id LIMIT 1' }], routes: [] },
  ], authorScript);
  const byVar = Object.fromEntries(plan.map((p) => [p.var, p]));
  assert.ok(byVar.amFollowing, 'a script-only reference still makes the source real');
  assert.equal(byVar.amFollowing.shape, 'row');
  assert.ok(byVar.profileUser, 'template-referenced sources are unaffected');

  // Without a script mentioning it, an unused source stays out of the plan
  // (declaring a source doesn't force it in — it must be reachable from
  // somewhere, template or script).
  const planNoScript = dataPlan(a, [
    { table: null, bindings: [{ var: 'profileUser', kind: 'sql', sql: 'SELECT * FROM users WHERE id = :id LIMIT 1' }], routes: [] },
    { table: null, bindings: [{ var: 'amFollowing', kind: 'sql', sql: 'SELECT id FROM follows WHERE follower_id = :session.id LIMIT 1' }], routes: [] },
  ]);
  assert.ok(!planNoScript.some((p) => p.var === 'amFollowing'), 'an unreferenced source is not force-included');
});

await test('singleShaped: aggregates and LIMIT 1, not grouped or plain', () => {
  assert.ok(singleShaped('SELECT COUNT(*) AS n FROM t'));
  assert.ok(singleShaped('SELECT * FROM t WHERE id = :id LIMIT 1'));
  assert.ok(!singleShaped('SELECT COUNT(*) FROM t GROUP BY kind'));
  assert.ok(!singleShaped('SELECT * FROM t'));
});

await test('named bindings + block attrs: var = SQL/URL/glob/module, guard, seed, live', () => {
  const { blocks } = extractBlocks(`
    <spark-ssr table="todos" seed="./seed/todos.json" live cache="60" limit="10" search="title,body" />
    <spark-ssr guard="session.is_admin" redirect="/login" />
    <spark-ssr>
      posts = SELECT * FROM posts
        WHERE published = 1
      repo = https://api.github.com/repos/x/y
      docs = ./content/docs/*.md
      weather = ./lib/weather.js
      GET /api/latest → latest = SELECT * FROM posts ORDER BY id DESC LIMIT 1
    </spark-ssr>`);
  assert.equal(blocks[0].table, 'todos');
  assert.equal(blocks[0].seed, './seed/todos.json');
  assert.ok(blocks[0].live, 'live attr');
  assert.equal(blocks[0].cache, 60);
  assert.equal(blocks[0].limit, 10);
  assert.deepEqual(blocks[0].search, ['title', 'body']);
  assert.equal(blocks[1].guard, 'session.is_admin');
  assert.equal(blocks[1].redirect, '/login');
  const byVar = Object.fromEntries(blocks[2].bindings.map((x) => [x.var, x]));
  assert.ok(byVar.posts.sql.includes('published = 1'), 'multi-line named SQL joined');
  assert.equal(byVar.repo.kind, 'url');
  assert.equal(byVar.docs.kind, 'glob');
  assert.equal(byVar.weather.kind, 'module');
  assert.equal(blocks[2].routes[0].var, 'latest', 'endpoint + named var');
  assert.ok(blocks[2].routes[0].sql.startsWith('SELECT'), 'var prefix stripped from the SQL');
});

await test('reflow tolerance: Prettier-refilled single-token bindings still parse', () => {
  // Prettier's HTML printer refills a column of `name = ./module.js` lines
  // into packed/wrapped lines (real TabTube damage). The chain and dangling-
  // value forms must yield the same bindings as the one-per-line original.
  const { blocks } = extractBlocks(`<spark-ssr>
  results = ./lib/search.js suggestions = ./lib/suggestion.js sharedVideo =
  ./lib/video.js searching = ./lib/ssr/false.js loadingMore = ./lib/ssr/false.js
  searchSkeletonRows = ./lib/ssr/search-skeleton.js moreSkeletonRows =
  ./lib/ssr/more-skeleton.js tabtube = ./lib/ssr/tabtube.js savedList =
  ./lib/ssr/saved-list.js isSaved = ./lib/ssr/is-saved.js
</spark-ssr>`);
  const byVar = Object.fromEntries(blocks[0].bindings.map((b) => [b.var, b]));
  assert.equal(blocks[0].bindings.length, 10, 'all ten bindings survive the reflow');
  assert.equal(byVar.results.value, './lib/search.js');
  assert.equal(byVar.sharedVideo.value, './lib/video.js', 'wrapped value rejoined');
  assert.equal(byVar.moreSkeletonRows.value, './lib/ssr/more-skeleton.js');
  assert.equal(byVar.isSaved.kind, 'module');

  // Mixed kinds pack too; multi-line SQL is untouched by the chain path.
  const mixed = extractBlocks(`<spark-ssr>
  repo = https://api.github.com/repos/x/y docs = ./content/*.md
  posts = SELECT * FROM posts
    WHERE published = 1
</spark-ssr>`).blocks[0];
  const mv = Object.fromEntries(mixed.bindings.map((b) => [b.var, b]));
  assert.equal(mv.repo.kind, 'url');
  assert.equal(mv.docs.kind, 'glob');
  assert.ok(mv.posts.sql.includes('published = 1'), 'SQL continuation still joins');
});

await test('loud failure: an ununderstood <spark-ssr> line warns instead of vanishing', () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    extractBlocks('<spark-ssr>\n  this line is nonsense prose\n</spark-ssr>');
  } finally { console.warn = orig; }
  assert.ok(warns.some((w) => w.includes('not understood') && w.includes('nonsense')),
    'dropped line produces a warning that quotes it');
});

await test('dataPlan: named bindings match exactly and report unresolved needs', () => {
  const a = analyze('<template each="post in posts"><p>{post.title}</p></template><p>{writer.name}</p><p>{missing.x}</p>');
  const plan = dataPlan(a, [{
    table: null,
    routes: [],
    bindings: [
      { var: 'posts', kind: 'sql', sql: 'SELECT * FROM posts' },
      { var: 'writer', kind: 'sql', sql: 'SELECT * FROM users LIMIT 1' },
    ],
  }]);
  const byVar = Object.fromEntries(plan.map((p) => [p.var, p]));
  assert.equal(byVar.posts.shape, 'list');
  assert.equal(byVar.writer.shape, 'row', 'LIMIT 1 → row');
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].name, 'missing');
  assert.ok(plan.unresolved[0].nearest, 'nearest source suggested');
});

await test('extractForms + validateFields: the markup constraints run server-side', () => {
  const forms = extractForms(`
    <form action="/api/posts" method="post" redirect="/admin">
      <input name="title" required maxlength="5">
      <input name="email" type="email">
      <input name="stars" type="number" min="1" max="5">
      <input type="hidden" name="_redirect" value="/x">
    </form>
    <form action="/elsewhere" method="post"><input name="ignored"></form>`);
  assert.equal(forms.length, 1, 'only /api/ POST forms count');
  assert.equal(forms[0].table, 'posts');
  assert.equal(forms[0].redirect, '/admin');
  const rules = forms[0].fields;
  assert.ok(!('_redirect' in rules), 'hidden inputs skipped');
  assert.equal(validateFields(rules, { title: 'ok', stars: '3' }), null);
  assert.equal(validateFields(rules, {}).title, 'required');
  const e = validateFields(rules, { title: 'toolong!', email: 'nope', stars: '9' });
  assert.ok(e.title.includes('max') && e.email && e.stars);
  assert.equal(validateFields(rules, { stars: '2' }, { partial: true }), null, 'partial skips required');
  assert.ok(validateFields(rules, { email: 'bad' }, { partial: true }).email);
});

await test('parseFrontMatter + sqlTables', () => {
  const { data, body } = parseFrontMatter('---\ntitle: Hello\nstars: 5\ndraft: false\n---\n# Body here');
  assert.deepEqual(data, { title: 'Hello', stars: 5, draft: false });
  assert.equal(body.trim(), '# Body here');
  assert.deepEqual([...sqlTables('SELECT * FROM posts p JOIN users u ON u.id = p.user_id')], ['posts', 'users']);
  assert.deepEqual([...sqlTables('INSERT INTO todos (t) VALUES (1)')], ['todos']);
});

// ── the zero-config todos app (the doc's opening example) ──────────────
function makeTodoApp() {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-todo-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  writeFileSync(join(root, 'index.html'), `<h1>Tasks</h1>
<template await="todos">
  <input bind:value="draft" placeholder="New task">
  <button onclick={add}>Add</button>
  <ul>
  <template each="todo in todos">
    <li>
      <input type="checkbox" bind:checked="todo.done" onchange={patch}>
      {todo.title}
      <button onclick={remove}>✕</button>
    </li>
  </template>
  </ul>
</template>

<spark-ssr table="todos" />
`);
  return root;
}

const todoRoot = makeTodoApp();
const todoServer = await serve({ root: todoRoot, port: 0, quiet: true });
const T = `http://localhost:${todoServer.port}`;
// No CREATE TABLE: the template is the schema (§7) — serve() inferred
// todos (title TEXT from {todo.title}, done INTEGER from bind:checked)
// and created it at startup.
await todoServer.db.query("INSERT INTO todos (title, done) VALUES ('Buy milk', 0), ('Walk dog', 0)");

await test('schema inference: the todos table was created from the template alone', async () => {
  const cols = await todoServer.db.columns('todos');
  const byName = Object.fromEntries(cols.map((c) => [c.name, c.type]));
  assert.ok('id' in byName && 'created_at' in byName, 'bookkeeping columns');
  assert.equal(byName.title, 'TEXT', '{todo.title} → TEXT');
  assert.equal(byName.done, 'INTEGER', 'bind:checked → INTEGER');
});

await test('SSR: / renders the seeded rows into HTML', async () => {
  const res = await fetch(`${T}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Buy milk') && html.includes('Walk dog'), 'rows rendered');
  assert.ok(html.includes('data-spark-ssr'), 'SSR wrapper present');
  assert.ok(!html.includes('<spark-ssr'), 'declaration stripped');
  assert.ok(!html.includes('onclick={'), 'handlers stripped from static HTML');
});

await test('hydration: page ships importmap + mount + component host with name', async () => {
  const html = await (await fetch(`${T}/`)).text();
  // The entry filename tracks the core's package `main` (src/index.js in the
  // old multi-file layout, dist/spark.js since the single-file build) — assert
  // the mapping, not the filename, so a core repackaging doesn't fail this.
  assert.ok(/"spark-html":"\/@modules\/spark-html\/[\w.-]+"/.test(html), 'importmap maps spark-html');
  assert.ok(html.includes('mount()'), 'mount call');
  // BOTH import and name — the runtime's hydrate contract. Without name the
  // pre-rendered HTML is treated as slot content and projected NEXT TO the
  // fresh render: two live copies of the whole UI.
  assert.ok(/import="\/__spark\/page\/index"[^>]*\bname="index"/.test(html), 'host carries import + name');
});

await test('auto CRUD: GET/POST/PATCH/DELETE /api/todos inferred from the template', async () => {
  let rows = await (await fetch(`${T}/api/todos`)).json();
  assert.equal(rows.length, 2);

  const created = await (await fetch(`${T}/api/todos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'New one', bogus: 'dropped' }),
  })).json();
  assert.equal(created.title, 'New one');
  assert.ok(created.id, 'RETURNING row');

  const patched = await (await fetch(`${T}/api/todos/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ done: 1 }),
  })).json();
  assert.equal(patched.done, 1);

  const del = await (await fetch(`${T}/api/todos/${created.id}`, { method: 'DELETE' })).json();
  assert.deepEqual(del, { ok: true });
  rows = await (await fetch(`${T}/api/todos`)).json();
  assert.equal(rows.length, 2);
});

await test('client component: await unwrapped, row handlers get their row, script synthesized', async () => {
  const res = await fetch(`${T}/__spark/page/index.html`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes('<template await'), 'await unwrapped');
  assert.ok(html.includes('{remove(todo)}'), 'delete handler carries the row');
  assert.ok(html.includes('{patch(todo)}'), 'update handler carries the row');
  assert.ok(html.includes("import __init from '/__spark/data/index.js'"), 'init data via module');
  assert.ok(html.includes('let todos = __init.todos'), 'list state');
  assert.ok(html.includes("__qs.has('draft')") && html.includes("__qs.get('draft')"), 'local state seeded from the live query string, with an empty fallback');
  assert.ok(/async function add\(\)/.test(html), 'insert handler');
  assert.ok(html.includes('__body.title = draft'), 'bind mapped to the text column');
  assert.ok(html.includes("method: 'PATCH'") && html.includes("method: 'DELETE'"), 'update+delete verbs');
  // linkedom can park template children in .content AND .childNodes — the
  // await unwrap must emit them ONCE (duplicated inputs were live twins).
  assert.equal((html.match(/placeholder="New task"/g) || []).length, 1, 'await content not duplicated');
});

await test('init data module: /__spark/data/index.js exports the rows', async () => {
  const res = await fetch(`${T}/__spark/data/index.js`);
  assert.equal(res.headers.get('content-type'), 'text/javascript');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const js = await res.text();
  assert.ok(js.startsWith('export default '));
  assert.ok(js.includes('Buy milk'));
});

await test('ambient helpers (§1): a page <script> gets api_* + refresh, auto-fills missing handlers', async () => {
  // The author writes ONLY toggle(); the framework injects api_create/update/
  // delete + refresh, and synthesizes add (insert) and remove (delete) — the
  // handlers the template references but the script left undefined.
  writeFileSync(join(todoRoot, 'manage.html'), `<input bind:value="draft" placeholder="New">
<button onclick={add}>Add</button>
<template each="t in todos">
  <input type="checkbox" bind:checked="t.done" onchange={toggle(t)}>
  <span>{t.title}</span>
  <button onclick={remove}>x</button>
</template>
<script>
  async function toggle(t) {
    await api_update(t.id, { done: t.done ? 1 : 0 });
    refresh();
  }
</script>
<spark-ssr table="todos" />
`);
  const page = await (await fetch(`${T}/manage`)).text();
  assert.ok(/import="\/__spark\/page\/manage"[^>]*\bname="manage"/.test(page), 'scripted page hydrates');
  assert.ok(page.includes('Buy milk'), 'SSR still renders the rows');

  const comp = await (await fetch(`${T}/__spark/page/manage.html`)).text();
  assert.ok(comp.includes('async function api_create') && comp.includes('async function api_update')
    && comp.includes('async function api_delete'), 'ambient CRUD helpers injected');
  assert.ok(comp.includes('async function refresh()'), 'ambient refresh injected');
  assert.ok(comp.includes('const __table = "todos"'), 'single table inferred');
  assert.ok(/async function add\(\)/.test(comp), 'insert handler synthesized');
  assert.ok(comp.includes('__body.title = draft'), 'bind mapped to the primary column');
  assert.ok(/async function remove\(__row\)/.test(comp), 'delete handler synthesized');
  assert.equal((comp.match(/function toggle\b/g) || []).length, 1, 'author toggle kept, not regenerated');
  assert.ok(comp.includes('api_update(t.id'), 'author toggle body preserved');
});

await test('ambient navigate (§1): a bare onclick={navigate} calls the framework helper, not a synthesized insert handler', async () => {
  // Regression: `navigate` is an ambient click-delegate the framework itself
  // injects (pushState + refresh() for same-page ?query links). Before the
  // fix, any bare non-loop handler literally named `navigate` was picked as
  // the page's "insert" role by handlerRoles() and got a SECOND, synthesized
  // `async function navigate()` appended — a duplicate declaration that
  // clobbered the ambient one. Found dogfooding spark-chat's own contact-nav.
  writeFileSync(join(todoRoot, 'nav.html'), `<div onclick={navigate}>
  <a href="/nav?with=1">one</a>
  <input bind:value="draft" placeholder="New">
  <button onclick={add}>Add</button>
  <template each="t in todos"><span>{t.title}</span></template>
</div>
<spark-ssr table="todos" />
`);
  const comp = await (await fetch(`${T}/__spark/page/nav.html`)).text();
  assert.equal((comp.match(/function navigate\b/g) || []).length, 1, 'only the ambient navigate() is emitted, not a synthesized duplicate');
  assert.ok(comp.includes("history.pushState({}, '', __a.href);"), 'the ambient implementation survives, unclobbered');
  assert.ok(/async function add\(\)/.test(comp), 'the real insert handler (add) is still synthesized normally');
});

await test('auto="none" (§1): suppresses synthesized handlers, keeps ambient helpers', async () => {
  writeFileSync(join(todoRoot, 'manual.html'), `<button onclick={add}>Add</button>
<template each="t in todos"><button onclick={remove}>x</button></template>
<script>
  async function add() { await api_create({ title: 'x' }); refresh(); }
  async function remove(t) { await api_delete(t.id); refresh(); }
</script>
<spark-ssr table="todos" auto="none" />
`);
  const comp = await (await fetch(`${T}/__spark/page/manual.html`)).text();
  assert.ok(comp.includes('async function api_create'), 'ambient helpers still present');
  assert.equal((comp.match(/function add\b/g) || []).length, 1, 'no synthesized add — author owns it');
  assert.equal((comp.match(/function remove\b/g) || []).length, 1, 'no synthesized remove — author owns it');
});

await test('§1 no state collision: generated locals never clobber page state (body/q/row)', async () => {
  // The spark-html rewriter turns a bare `body = …` into a write to the {body}
  // state (the textarea). A helper local named `body` would push the request
  // body object into the field — [object Object]. Every generated local/param
  // must be __-prefixed. A page with a `body` bind + a table exercises it.
  writeFileSync(join(todoRoot, 'collide.html'), `<input bind:value="body" placeholder="Body">
<button onclick={add}>Add</button>
<template each="t in todos"><span>{t.title}</span><button onclick={del}>x</button></template>
<spark-ssr table="todos" />
`);
  const comp = await (await fetch(`${T}/__spark/page/collide.html`)).text();
  assert.ok(comp.includes('let body ='), 'the page owns a {body} state var');
  // No bare `const body`/`const q`/`const row`/`const id` in the generated
  // helpers — those would collide with reactive state of the same name.
  for (const bad of [/\bconst body\b/, /\bconst q\b/, /\bconst r\b(?!\w)/, /\bconst d\b(?!\w)/, /\(row\)/, /\bconst id\b/]) {
    assert.ok(!bad.test(comp), `generated helper avoids ${bad}`);
  }
  assert.ok(comp.includes('__body') && comp.includes('__row.id'), 'helpers use __-prefixed internals');
});

await test('script-local <template await> on a hydrating page passes through, both sides', async () => {
  // The promise lives in the page's OWN <script> — which never runs on the
  // server. Pre-fix, the server flattened the block to then-content with
  // undefined bindings AND the client component unwrapped the block away,
  // so the client script's real resolution had nothing to patch (the I2a
  // relocation finding). Both halves must hold: the SERVER emits the
  // authored block verbatim; the CLIENT component keeps it. Data-source
  // awaits (todos) keep the old resolve-and-flatten path — covered by the
  // index.html assertions above.
  writeFileSync(join(todoRoot, 'awaitlocal.html'), `<button onclick={add}>Add</button>
<input bind:value="draft" placeholder="New">
<template each="t in todos"><span>{t.title}</span></template>
<template await="stats"><p class="pending">loading</p>
  <template then><p id="stats">total: {await.total}</p></template>
</template>
<script>
  const stats = Promise.resolve({ total: 42 });
</script>
<spark-ssr table="todos" />
`);
  const page = await (await fetch(`${T}/awaitlocal`)).text();
  assert.ok(page.includes('<template await="stats">'), 'server emits the authored await block verbatim');
  assert.ok(!/total: (?:42|<!--)/.test(page), 'server does not flatten the unresolvable block into then-content');
  const comp = await (await fetch(`${T}/__spark/page/awaitlocal.html`)).text();
  assert.ok(comp.includes('<template await="stats">'), 'client component keeps the block (script-declared promise)');
  assert.ok(comp.includes('const stats = Promise.resolve'), "the page's own script still ships");
});

await test('fail-loud dev layer (I3): live pages carry dev events + the diagnose module; the module serves', async () => {
  const page = await (await fetch(`${T}/`)).text();
  assert.ok(page.includes('id="__spark-dev-events"'), 'server-side warnings are mirrored into the page in live mode');
  assert.ok(page.includes('src="/__spark/diagnose.js"'), 'the diagnose module is injected in live mode');
  const diag = await (await fetch(`${T}/__spark/diagnose.js`)).text();
  assert.ok(diag.includes('RULES'), "diagnose served from spark-ssr's own devtools dep");
});

// Boot the real spark-html runtime against a hydrating page and return the
// mounted component's scope — the shared harness for the e2e mount tests.
async function mountHydratedPage(base, path) {
  const pageHtml = await (await fetch(`${base}${path}`)).text();
  const { window, document } = parseHTML(pageHtml);
  try { if (document.readyState === 'loading') document.readyState = 'complete'; } catch { /* fine */ }
  let rafQueue = [];
  const pending = new Set();
  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); return p; };
  const awaits = [];
  const realFetch = globalThis.fetch; // the override must not call itself
  const url = new URL(path, base);
  const globals = {
    window, document, Node: window.Node,
    // A bare `location` (not window.location — the generated client script
    // references it directly, matching what a real browser gives it) so
    // client-seeded ambients that read location.pathname/.search (path, and
    // any bind:value="name" matching a live ?name= query param) resolve
    // against the actual mounted URL instead of silently no-op'ing.
    location: { pathname: url.pathname, search: url.search, href: url.href },
    requestAnimationFrame: (fn) => rafQueue.push(fn),
    __SPARK_PRERENDER__: true,
    __SPARK_AWAITS__: awaits,
    __SPARK_IMPORT__: async (spec) => {
      const text = await (await realFetch(base + spec)).text();
      return import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
    },
    fetch: (p, init) => track(realFetch(String(p).startsWith('/') ? base + p : p, init)),
  };
  const prev = {};
  for (const [k, v] of Object.entries(globals)) { prev[k] = globalThis[k]; globalThis[k] = v; }
  const spark = await import(import.meta.resolve('spark-html') + '?ssr=' + Math.random().toString(36).slice(2));
  await spark.mount(document.body);
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      const q = rafQueue; rafQueue = [];
      for (const fn of q) fn();
      if (pending.size) await Promise.all([...pending]);
      if (awaits.length) await Promise.allSettled(awaits.splice(0));
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  await settle();
  const host = [...document.querySelectorAll('[name]')].find((h) => h.__sparkScope);
  const restore = () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } };
  return { document, host, scope: host && host.__sparkScope, settle, realFetch, restore };
}

await test('hydration e2e: the real runtime mounts the generated component and add() inserts', async () => {
  const m = await mountHydratedPage(T, '/');
  try {
    assert.ok(m.document.body.innerHTML.includes('Buy milk'), 'component rendered with init data');
    assert.equal((m.document.body.innerHTML.match(/placeholder="New task"/g) || []).length, 1,
      'exactly one live copy after hydration (no slot-projected duplicate)');
    assert.ok(m.host, 'component booted');
    m.scope.draft = 'From hydration';
    await m.scope.add();
    const rows = await (await m.realFetch(`${T}/api/todos`)).json();
    assert.ok(rows.some((r) => r.title === 'From hydration'), 'add() POSTed through the generated handler');
    assert.equal(m.scope.todos.length, rows.length, 'refresh reassigned the list');
  } finally {
    m.restore();
  }
});

await test('hydration e2e (§1): author <script> + ambient helpers mount and run', async () => {
  // /manage writes only toggle(); add (insert) and remove (delete) are
  // synthesized. Mounting proves the folded author script executes and the
  // ambient api_* + refresh() are wired into the same reactive scope.
  const m = await mountHydratedPage(T, '/manage');
  try {
    assert.ok(m.host, 'scripted page component booted');
    assert.ok(m.document.body.innerHTML.includes('Buy milk'), 'SSR rows hydrated');
    // synthesized insert, through the ambient api_create → POST /api/todos
    m.scope.draft = 'via ambient';
    await m.scope.add();
    await m.settle();
    let rows = await (await m.realFetch(`${T}/api/todos`)).json();
    const added = rows.find((r) => r.title === 'via ambient');
    assert.ok(added, 'synthesized add() inserted through api_create');
    // author toggle(), through the ambient api_update → PATCH (the row's
    // bind:checked has already flipped done to 1; toggle persists it)
    await m.scope.toggle({ id: added.id, done: 1 });
    await m.settle();
    rows = await (await m.realFetch(`${T}/api/todos`)).json();
    assert.equal(rows.find((r) => r.id === added.id).done, 1, 'author toggle() PATCHed via api_update');
    // synthesized delete, through the ambient api_delete → DELETE
    await m.scope.remove({ id: added.id });
    await m.settle();
    rows = await (await m.realFetch(`${T}/api/todos`)).json();
    assert.ok(!rows.some((r) => r.id === added.id), 'synthesized remove() deleted via api_delete');
  } finally {
    m.restore();
  }
});

await test('handler synthesis: two plain in-loop call handlers (docs\' own "Ambient helpers" shape) — the DEFINED one keeps its role, the UNDEFINED one still gets synthesized', () => {
  // toggle(p) and remove(p) are structurally identical to the role heuristic
  // (both inEach, neither has a companion bind:* on the same node — that's
  // what distinguishes "update" from "delete" when there IS one). Found by
  // the M4.6 audit: reproducing the docs' own example verbatim synthesized
  // nothing for remove(), because .find() picked whichever came first
  // (toggle) for the "del" slot, and toggle is already author-defined so
  // wants(del) never fired for the handler that actually needed it.
  const a = analyze(
    `<button onclick={create}>Save</button>
     <template each="p in posts">
       <button onclick={toggle(p)}>Toggle</button>
       <button onclick={remove(p)}>Delete</button>
     </template>`);
  const definedByAuthor = new Set(['create', 'toggle']); // remove is left out — synthesized
  const { del } = handlerRoles(a, definedByAuthor);
  assert.equal(del && del.name, 'remove', 'the role picks the handler that still needs synthesis, not whichever is first');
});

await test('live reload: dev pages carry the client; editing a file pings SSE', async () => {
  const html = await (await fetch(`${T}/`)).text();
  assert.ok(html.includes('/__spark/reload'), 'reload client injected in dev HTML');

  const res = await fetch(`${T}/__spark/reload`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const read = async () => dec.decode((await reader.read()).value || new Uint8Array());
  assert.ok((await read()).includes(': connected'), 'SSE channel opens');

  writeFileSync(join(todoRoot, 'index.html'),
    readFileSync(join(todoRoot, 'index.html'), 'utf8') + '\n<!-- touched -->\n');
  const ping = await Promise.race([
    read(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('no reload ping within 3s')), 3000)),
  ]);
  assert.ok(ping.includes('reload'), 'file edit broadcasts a reload event');
  await reader.cancel();
});

await test('watch: false serves without the reload client or SSE channel', async () => {
  const prodRoot = makeTodoApp();
  const prod = await serve({ root: prodRoot, port: 0, quiet: true, watch: false });
  try {
    const P = `http://localhost:${prod.port}`;
    const html = await (await fetch(`${P}/`)).text();
    assert.ok(!html.includes('/__spark/reload'), 'no reload client in production HTML');
    assert.equal((await fetch(`${P}/__spark/reload`)).status, 404, 'no SSE channel');
    assert.ok(!html.includes('diagnose'), 'no dev diagnostics layer in production HTML (I3 hard rule)');
    assert.ok(!html.includes('__spark-dev-events'), 'no dev-events blob in production HTML');
  } finally {
    await prod.stop(true);
  }
});

await todoServer.stop(true);

// ── pages/, params, components, middleware, api/, auth, uploads ────────
async function makeSiteApp() {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-site-'));
  process.env.SPARK_TEST_SECRET = 'squirrel';
  writeFileSync(join(root, 'spark.json'), JSON.stringify({
    db: 'sqlite://./dev.db',
    auth: { table: 'users', identity: 'email', secret: 'ENV.SPARK_TEST_SECRET' },
    cors: true,
    fonts: [{ family: 'Inter', google: true, weights: [400, 700] }],
  }));
  // Tables that predate the server (a hand-managed schema): startup
  // inference must leave them alone.
  const { Database } = await import('bun:sqlite');
  const sdb = new Database(join(root, 'dev.db'), { create: true });
  sdb.run('CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, title TEXT, views INTEGER DEFAULT 0)');
  sdb.run('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, password TEXT)');
  sdb.run('CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, text TEXT)');
  sdb.run('CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, url TEXT)');
  sdb.close();
  // Family deps: the server maps each into the importmap, serves it at
  // /@modules/<name>, and inlines spark-html-theme's no-flash init snippet.
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'site', dependencies: { 'spark-html-theme': '*', 'spark-html-font': '*' },
  }));
  // moduleEntry() (src/static.js) resolves each family dep from `root` first;
  // Bun's workspace linker doesn't hoist to the monorepo root node_modules,
  // so symlink the sibling workspace packages in directly rather than relying
  // on incidental global-cache resolution (the same fix as spark-html-bun's
  // test/bun.js makeProject()).
  const testDir = dirname(fileURLToPath(import.meta.url));
  const siteNodeModules = join(root, 'node_modules');
  mkdirSync(siteNodeModules);
  for (const dep of ['spark-html-theme', 'spark-html-font']) {
    symlinkSync(join(testDir, '..', '..', dep), join(siteNodeModules, dep));
  }
  mkdirSync(join(root, 'pages', 'blog'), { recursive: true });
  mkdirSync(join(root, 'components'));
  mkdirSync(join(root, 'api'));
  mkdirSync(join(root, 'public'));

  writeFileSync(join(root, 'pages', 'index.html'),
    '<h1>Home</h1>\n<div import="/components/card" title="Welcome"><em>slotted</em></div>\n');
  writeFileSync(join(root, 'pages', 'index.css'), 'h1 { color: gold; }');
  writeFileSync(join(root, 'components', 'card.html'),
    '<div class="card"><h2>{title}</h2><slot></slot></div>\n<script>let ignored = 1;</script>');
  writeFileSync(join(root, 'pages', 'blog', '[slug].html'), `<h1>{post.title}</h1>
<template if="post.views > 100"><p class="hot">Hot!</p></template>
<template else><p class="cold">Quiet.</p></template>
<spark-ssr>
  GET /api/blog → SELECT * FROM posts WHERE slug = :slug
</spark-ssr>`);
  writeFileSync(join(root, 'pages', 'search.html'), `<h1>Results for "{q}"</h1>
<template each="result in results"><p class="r">{result.title}</p></template>
<spark-ssr>
  GET /api/search → SELECT * FROM posts WHERE title LIKE '%' || :q || '%'
</spark-ssr>`);
  writeFileSync(join(root, 'pages', 'notes.html'), `<template each="note in notes"><p class="n">{note.text}</p></template>
<spark-ssr table="notes" />`);
  writeFileSync(join(root, 'pages', 'login.html'), '<h1>Login</h1>\n<spark-ssr table="users" />');
  // #7: the auth table used as a raw SSR source must scope to the caller's own
  // row, not leak every account (like /api/<authTable> already does).
  writeFileSync(join(root, 'pages', 'roster.html'),
    '<template each="u in users"><span class="ru">{u.email}</span></template>\n<spark-ssr table="users" />');
  // A `live` page + a custom endpoint that writes the SAME table with a raw
  // db.query() (not the auto-CRUD route) — the bugs.md #18 case.
  writeFileSync(join(root, 'pages', 'live-notes.html'),
    '<template each="note in notes"><p class="ln">{note.text}</p></template>\n<spark-ssr table="notes" live />');
  writeFileSync(join(root, 'api', 'addnote.html'), `<script>
  const body = await req.json();
  await db.query('INSERT INTO notes (text) VALUES (?)', [body.text]);
  return { ok: true };
</script>`);
  writeFileSync(join(root, 'pages', 'upload.html'), `<h1>Upload</h1>
<spark-ssr>
  POST /api/upload → INSERT INTO files (name, url) VALUES (:body.name, :file.url)
</spark-ssr>`);

  writeFileSync(join(root, 'pages', 'broken.html'),
    '<p>{thing.x}</p>\n<spark-ssr>\n  GET /api/broken → SELECT * FROM does_not_exist\n</spark-ssr>');

  writeFileSync(join(root, 'api', 'stats.html'), `<spark-ssr>
  GET → SELECT COUNT(*) AS posts FROM posts
</spark-ssr>`);
  writeFileSync(join(root, 'api', 'echo.html'), `<script>
  let body = await req.json();
  return { got: body.x, method: req.method, header: req.headers['x-probe'] };
</script>`);

  writeFileSync(join(root, 'middleware.html'), `<script>
  res.headers['x-mw'] = 'ran';
  if (req.query.blocked) return { status: 429, body: 'Too many requests' };
</script>`);
  writeFileSync(join(root, '404.html'), '<h1>Custom not found</h1>');
  writeFileSync(join(root, '500.html'), '<h1>Custom boom</h1>');
  writeFileSync(join(root, 'public', 'style.css'), 'body { margin: 0; }');
  return root;
}

const siteRoot = await makeSiteApp();
const site = await serve({ root: siteRoot, port: 0, quiet: true });
const S = `http://localhost:${site.port}`;
await site.db.query("INSERT INTO posts (slug, title, views) VALUES ('hello', 'Hello World', 500), ('quiet', 'Quiet Post', 3)");

await test('pages/: filesystem routing + component composition + slots + co-located css', async () => {
  const html = await (await fetch(`${S}/`)).text();
  assert.ok(html.includes('<h2>Welcome</h2>'), 'component prop rendered');
  assert.ok(html.includes('<em>slotted</em>'), 'slot content survives');
  assert.ok(!html.includes('let ignored'), 'component script stripped');
  assert.ok(html.includes('href="/index.css"'), 'co-located css linked');
  assert.equal((await fetch(`${S}/index.css`)).status, 200, 'co-located css served');
});

await test('dynamic route: [slug] binds :slug; if/else renders per row', async () => {
  const hot = await (await fetch(`${S}/blog/hello`)).text();
  assert.ok(hot.includes('Hello World') && hot.includes('class="hot"') && !hot.includes('class="cold"'));
  const cold = await (await fetch(`${S}/blog/quiet`)).text();
  assert.ok(cold.includes('Quiet Post') && cold.includes('class="cold"'));
});

await test('query-string params: {q} interpolates, :q binds into SQL', async () => {
  const html = await (await fetch(`${S}/search?q=Hello`)).text();
  assert.ok(html.includes('Results for "Hello"'));
  assert.ok(html.includes('Hello World') && !html.includes('Quiet Post'));
});

await test('explicit GET endpoint served over HTTP too', async () => {
  const one = await (await fetch(`${S}/api/blog?slug=hello`)).json();
  assert.equal(one[0].title, 'Hello World');
});

await test('api/ folder: pure <spark-ssr> aggregate → single JSON object', async () => {
  const stats = await (await fetch(`${S}/api/stats`)).json();
  assert.deepEqual(stats, { posts: 2 });
});

await test('api/ folder: <script> endpoint gets req and returns JSON', async () => {
  const out = await (await fetch(`${S}/api/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-probe': 'yes' },
    body: JSON.stringify({ x: 42 }),
  })).json();
  assert.deepEqual(out, { got: 42, method: 'POST', header: 'yes' });
});

await test('live (§9): a raw db.query() write in a custom endpoint pings /__spark/live for a live table (bugs.md #18)', async () => {
  const res = await fetch(`${S}/__spark/live`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const read = async () => dec.decode((await reader.read()).value || new Uint8Array());
  assert.ok((await read()).includes(': connected'), 'live SSE channel opens');

  // A hand-written INSERT through the custom endpoint — never touches the
  // auto-CRUD route — must still fan out to the live channel.
  await fetch(`${S}/api/addnote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'live!' }),
  });
  const ping = await Promise.race([
    read(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('no live ping within 3s')), 3000)),
  ]);
  assert.ok(ping.includes('data: notes'), 'raw endpoint write broadcasts the touched table');
  await reader.cancel();
});

await test('middleware.html: header on every response, short-circuit works', async () => {
  const res = await fetch(`${S}/`);
  assert.equal(res.headers.get('x-mw'), 'ran');
  const blocked = await fetch(`${S}/?blocked=1`);
  assert.equal(blocked.status, 429);
  assert.equal(await blocked.text(), 'Too many requests');
});

await test('CORS: enabled in spark.json → headers on /api/*, preflight ok', async () => {
  const res = await fetch(`${S}/api/stats`, { headers: { origin: 'https://elsewhere.dev' } });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const pre = await fetch(`${S}/api/stats`, { method: 'OPTIONS', headers: { origin: 'https://elsewhere.dev' } });
  assert.equal(pre.status, 204);
  assert.ok(pre.headers.get('access-control-allow-methods').includes('PATCH'));
});

await test('static: public/ served; 404.html for unknown routes', async () => {
  assert.equal(await (await fetch(`${S}/style.css`)).text(), 'body { margin: 0; }');
  const nf = await fetch(`${S}/definitely-not-here`);
  assert.equal(nf.status, 404);
  assert.ok((await nf.text()).includes('Custom not found'));
});

await test('auth: signup hashes the password; ?auth logs in and sets the session cookie', async () => {
  const created = await (await fetch(`${S}/api/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.c', password: 'hunter2' }),
  })).json();
  assert.ok(!('password' in created), 'password never echoed');
  const stored = (await site.db.query('SELECT password FROM users'))[0].password;
  assert.ok(stored.startsWith('$'), 'hashed at rest');

  const bad = await fetch(`${S}/api/users?auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.c', password: 'wrong' }),
  });
  assert.equal(bad.status, 401);

  const good = await fetch(`${S}/api/users?auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.c', password: 'hunter2' }),
  });
  assert.equal(good.status, 200);
  const cookie = good.headers.get('set-cookie');
  assert.ok(cookie && cookie.includes('spark_session=') && cookie.includes('HttpOnly'));
  globalThis.__sparkTestCookie = cookie.split(';')[0];
});

await test('auth scoping: user_id column → 401 without session, own rows with it', async () => {
  const cookie = globalThis.__sparkTestCookie;
  assert.equal((await fetch(`${S}/api/notes`)).status, 401, 'anonymous blocked');

  const note = await (await fetch(`${S}/api/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text: 'mine', user_id: 999 }),
  })).json();
  assert.equal(note.user_id, 1, 'user_id injected from the session, spoof ignored');

  await site.db.query("INSERT INTO notes (user_id, text) VALUES (2, 'not mine')");
  const rows = await (await fetch(`${S}/api/notes`, { headers: { cookie } })).json();
  assert.deepEqual(rows.map((r) => r.text), ['mine'], 'query scoped to the session');

  const page = await (await fetch(`${S}/notes`, { headers: { cookie } })).text();
  assert.ok(page.includes('mine') && !page.includes('not mine'), 'SSR page scoped too');
});

await test('uploads: multipart file streams to uploads/, :file.url binds into the INSERT', async () => {
  const fd = new FormData();
  fd.append('name', 'pic');
  fd.append('file', new Blob(['PNGDATA'], { type: 'image/png' }), 'pic.png');
  const out = await (await fetch(`${S}/api/upload`, { method: 'POST', body: fd })).json();
  const row = (await site.db.query('SELECT * FROM files'))[0];
  assert.equal(row.name, 'pic');
  assert.ok(row.url.startsWith('/uploads/') && row.url.endsWith('.png'));
  const served = await fetch(`${S}${row.url}`);
  assert.equal(await served.text(), 'PNGDATA', 'stored file served back');
  assert.ok(out, 'endpoint answered');
});

await test('500.html: a failing query surfaces the custom error page', async () => {
  const res = await fetch(`${S}/broken`);
  assert.equal(res.status, 500);
  assert.ok((await res.text()).includes('Custom boom'));
});

await test('new page + endpoint created AFTER startup serve without a restart', async () => {
  assert.equal((await fetch(`${S}/later`)).status, 404, 'not there yet');
  writeFileSync(join(siteRoot, 'pages', 'later.html'), `<h1>{post.title}</h1>
<spark-ssr>
  GET /api/later → SELECT * FROM posts WHERE slug = 'hello'
</spark-ssr>`);
  const res = await fetch(`${S}/later`);
  assert.equal(res.status, 200, 'picked up on the next request');
  assert.ok((await res.text()).includes('Hello World'), 'its query ran too');
  const api = await (await fetch(`${S}/api/later`)).json();
  assert.equal(api[0].slug, 'hello', 'its endpoint registered too');
});

await test('head lifting: <title>/<meta>/<link> reach <head>, {expr} interpolated', async () => {
  writeFileSync(join(siteRoot, 'pages', 'seo.html'), `<title>{post.title} · Site</title>
<meta name="description" content="{post.title} has {post.views} views">
<link rel="stylesheet" href="/style.css">
<h1>{post.title}</h1>
<spark-ssr>
  GET /api/seo → SELECT * FROM posts WHERE slug = 'hello' LIMIT 1
</spark-ssr>`);
  const html = await (await fetch(`${S}/seo`)).text();
  const [head, body] = html.split('</head>');
  assert.ok(head.includes('<title>Hello World · Site</title>'), 'title interpolated in head');
  assert.ok(head.includes('content="Hello World has 500 views"'), 'meta interpolated');
  assert.ok(head.includes('href="/style.css"'), 'link lifted');
  assert.ok(!head.includes('<title>seo</title>'), 'default title suppressed');
  assert.ok(!body.includes('description'), 'head tags gone from the body');
});

await test('family packages: theme init inlined, fonts in head, modules served, importmap first', async () => {
  writeFileSync(join(siteRoot, 'pages', 'client.html'),
    '<h1>Client</h1>\n<div import="/components/card" title="hi"></div>\n'
    + '<script type="module">import { theme } from \'spark-html-theme\'; theme();</script>\n');
  const html = await (await fetch(`${S}/client`)).text();
  const [head, body] = html.split('</head>');
  assert.ok(head.includes('data-theme'), 'spark-html-theme no-flash init inlined');
  assert.ok(/fonts\.googleapis|--font-inter/.test(head), 'spark-html-font tags from spark.json');
  assert.ok(head.includes("import { theme }"), 'inline module script lifted to head');
  assert.ok(!body.includes('import { theme }'), 'client script not left in the body');
  assert.ok(head.indexOf('importmap') !== -1 && head.indexOf('importmap') < head.indexOf("import { theme }"),
    'importmap precedes module scripts');
  assert.ok(head.includes('"spark-html-theme":"/@modules/spark-html-theme/index.js"'), 'family dep in the importmap');
  const mod = await fetch(`${S}/@modules/spark-html-theme/index.js`);
  assert.equal(mod.status, 200, 'family module served');
  assert.equal((await fetch(`${S}/@modules/spark-html-theme/init.js`)).status, 200,
    'sibling files resolve (relative imports inside a package)');
  assert.equal((await fetch(`${S}/@modules/left-pad`)).status, 404, 'non-family modules refused');
});

await test('#7 auth table as SSR source scopes to the caller (no cross-account leak)', async () => {
  const cookie = globalThis.__sparkTestCookie;
  // Ensure a SECOND account exists so an unscoped read would visibly leak it.
  await fetch(`${S}/api/users`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'leak@probe.c', password: 'pw3' }),
  });
  const mine = await (await fetch(`${S}/roster`, { headers: { cookie } })).text();
  const emails = [...mine.matchAll(/class="ru">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(emails, ['a@b.c'], 'a non-admin sees only their own auth-table row');
  assert.ok(!mine.includes('leak@probe.c'), 'other accounts are not leaked into the page');
});

await test('#13 dev analyzer: each over a JS-global call is not a "missing source"', () => {
  const plan = dataPlan(analyze('<template each="n in Array(3).fill(0)"><i>{n}</i></template>'), []);
  const names = (plan.unresolved || []).map((u) => u.name);
  assert.ok(!names.includes('Array'), 'Array (a global call) is not flagged as an unresolved data source');
  const plan2 = dataPlan(analyze('<template each="k in Object.keys(o)"><i>{k}</i></template>'), []);
  assert.ok(!(plan2.unresolved || []).some((u) => u.name === 'Object'), 'Object.keys(...) is not a source either');
});

await test('auth table hygiene: no hashes over the wire, writes are own-account only', async () => {
  const cookie = globalThis.__sparkTestCookie;
  assert.equal((await fetch(`${S}/api/users`)).status, 401, 'anonymous GET is closed — emails are not public');
  const rows = await (await fetch(`${S}/api/users`, { headers: { cookie } })).json();
  assert.ok(rows.length === 1 && rows[0].email === 'a@b.c', 'a session reads only its own row');
  assert.ok(rows.every((r) => !('password' in r)), 'GET strips password hashes');

  const anon = await fetch(`${S}/api/users/1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pwned' }),
  });
  assert.equal(anon.status, 401, 'anonymous cannot reset a password');

  const other = await (await fetch(`${S}/api/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x@y.z', password: 'pw2' }),
  })).json();
  const cross = await fetch(`${S}/api/users/${other.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ password: 'pwned' }),
  });
  assert.equal(cross.status, 401, 'a session cannot touch another account');
  assert.equal((await fetch(`${S}/api/users/${other.id}`, { method: 'DELETE', headers: { cookie } })).status, 401,
    'nor delete it');

  const own = await fetch(`${S}/api/users/1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ password: 'hunter3' }),
  });
  assert.equal(own.status, 200, 'own account is editable');
  assert.ok(!('password' in await own.json()), 'response carries no hash');
  const stored = (await site.db.query('SELECT password FROM users WHERE id = 1'))[0].password;
  assert.ok(stored.startsWith('$') && stored !== 'hunter3', 'new password hashed at rest');
});

await test('project internals never served: spark.json, package.json, dotfiles', async () => {
  writeFileSync(join(siteRoot, '.env'), 'SECRET=x');
  assert.equal((await fetch(`${S}/spark.json`)).status, 404);
  assert.equal((await fetch(`${S}/package.json`)).status, 404);
  assert.equal((await fetch(`${S}/.env`)).status, 404);
  assert.equal((await fetch(`${S}/style.css`)).status, 200, 'public/ still serves');
});

await test('comments mentioning <spark-ssr>/<script>/<title> never break extraction', async () => {
  writeFileSync(join(siteRoot, 'components', 'notecard.html'),
    '<!-- pure UI: mention <script> and even </script> in prose -->\n<p class="nc">{note}</p>\n');
  writeFileSync(join(siteRoot, 'pages', 'commented.html'), `<!-- this page declares data in <spark-ssr>,
  sets its <title>, and has no server <script> at all -->
<title>Commented · Site</title>
<h1>{post.title}</h1>
<div import="/components/notecard" note="ok"></div>
<spark-ssr>
  GET /api/commented → SELECT * FROM posts WHERE slug = 'hello' LIMIT 1
</spark-ssr>`);
  const html = await (await fetch(`${S}/commented`)).text();
  assert.ok(html.includes('<title>Commented · Site</title>'), 'title lifted despite the comment');
  assert.ok(html.includes('Hello World'), 'the block parsed and its query ran');
  assert.ok(html.includes('class="nc">ok'), 'component rendered past its comment');
  assert.ok(html.includes('this page declares data'), 'page comment survives verbatim');
  assert.ok(html.includes('mention <script>'), 'component comment survives verbatim');
});

await test('extractBlocks: a <script>\'s own JS comment mentioning "<spark-ssr>" does not start a fake block', () => {
  // Regression, the mirror image of the test above: extractBlocks only
  // masked HTML comments before scanning for <spark-ssr>, not <script>
  // content — a JS comment (or string) inside a REAL <script> mentioning
  // the literal text "<spark-ssr>" opened a fake block that ate everything
  // up to the next actual </spark-ssr>, corrupting (or here, truncating)
  // the author's own script and swallowing the real data block into a
  // garbled "inner" — its query line still parsed by accident (parseBody
  // matches "name = source" wherever it lands), which is exactly why this
  // was hard to notice from the data alone: masking it at the HTTP/data
  // layer, only the markup itself shows the damage.
  const { blocks, html } = extractBlocks(`<h1 id="sc">{item.title}</h1>
<script>
  // reads data declared in <spark-ssr> below — must not be mistaken for a
  // real block opening
  let real = 1;
</script>
<spark-ssr>
  item = SELECT * FROM posts WHERE slug = 'hello' LIMIT 1
</spark-ssr>`);
  assert.equal(blocks.length, 1, 'exactly one real block, not a fake one opened mid-comment');
  assert.equal(blocks[0].bindings[0]?.var, 'item', 'the real binding still parsed');
  assert.ok(html.includes('let real = 1;'), 'the rest of the script survives, not eaten as fake block "inner"');
  assert.ok(html.includes('</script>'), 'the script tag itself is still closed, not consumed by the fake match');
});

await test('a kept host serializes a real empty-string prop as "∅", not a bare attribute', async () => {
  // Regression: a non-hydrating page's top-level import keeps its host
  // (import + name + evaluated props) for the client to re-resolve. The
  // props get baked into plain attributes via serializeProp() — a prop
  // that evaluates to a real empty string used to serialize as `label=""`,
  // indistinguishable from a bare `<div import label>` (HTML's own "present
  // with no value" convention), so the client's coerce() read it back as
  // boolean `true` instead of ''.
  writeFileSync(join(siteRoot, 'components', 'labelcard.html'), '<p class="lc">{typeof label}:{JSON.stringify(label)}</p>');
  writeFileSync(join(siteRoot, 'pages', 'labeldemo.html'), `<h1>Demo</h1>\n<div import="/components/labelcard" label="{''}"></div>\n`);
  const html = await (await fetch(`${S}/labeldemo`)).text();
  assert.ok(html.includes('string:""'), 'the SSR-rendered content itself is correct regardless');
  const hostTag = (html.match(/<div[^>]*import="\/components\/labelcard"[^>]*>/) || [''])[0];
  assert.ok(hostTag.includes('label="∅"'), 'kept host escapes the real empty string as ∅, not a bare label=""');
});

await test('imported component with its own <script> comes alive (counter)', async () => {
  writeFileSync(join(siteRoot, 'components', 'counter.html'),
    '<h2 class="c">Count: {count}</h2>\n<button onclick={inc}>+1</button>\n<script>\nlet count = 0;\nfunction inc() { count++; }\n</script>');
  writeFileSync(join(siteRoot, 'pages', 'counterdemo.html'),
    '<h1>Demo</h1>\n<div import="/components/counter"></div>\n');
  const html = await (await fetch(`${S}/counterdemo`)).text();
  assert.ok(html.includes('Count: 0'), 'script literals feed the SSR output');
  const hostTag = (html.match(/<div[^>]*import="\/components\/counter"[^>]*>/) || [''])[0];
  assert.ok(hostTag.includes('name="counter"'), 'host keeps import + name for client takeover');
  assert.ok(html.includes('mount()'), 'page mounts because it has component imports');
  assert.ok(!html.includes('let count'), 'component script never in the SSR output');

  // The real runtime takes the counter over and inc() re-renders.
  const { window, document } = parseHTML(html);
  try { if (document.readyState === 'loading') document.readyState = 'complete'; } catch { /* fine */ }
  let rafQueue = [];
  const realFetch = globalThis.fetch;
  const globals = {
    window, document, Node: window.Node,
    requestAnimationFrame: (fn) => rafQueue.push(fn),
    __SPARK_PRERENDER__: true, __SPARK_AWAITS__: [],
    fetch: (p, init) => realFetch(String(p).startsWith('/') ? S + p : p, init),
  };
  const prev = {};
  for (const [k, v] of Object.entries(globals)) { prev[k] = globalThis[k]; globalThis[k] = v; }
  try {
    const spark = await import(import.meta.resolve('spark-html') + '?ssr=' + Math.random().toString(36).slice(2));
    await spark.mount(document.body);
    for (let i = 0; i < 15; i++) {
      const q = rafQueue; rafQueue = [];
      for (const fn of q) fn();
      await new Promise((r) => setTimeout(r, 5));
    }
    const host = [...document.querySelectorAll('[name]')].find((h) => h.__sparkScope && h.__sparkScope.inc);
    assert.ok(host, 'counter booted with its own script');
    host.__sparkScope.inc();
    for (let i = 0; i < 10; i++) {
      const q = rafQueue; rafQueue = [];
      for (const fn of q) fn();
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(document.body.innerHTML.includes('Count: 1'), 'inc() re-rendered');
    assert.equal((document.body.innerHTML.match(/Count:/g) || []).length, 1, 'one counter, not a projected twin');
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  }
});

await test('no-JS auth (§5): login form post → 303 + session cookie; logout form → 303', async () => {
  const good = await fetch(`${S}/api/users?auth`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', referer: `${S}/login` },
    body: 'email=a%40b.c&password=hunter3',
  });
  assert.equal(good.status, 303, 'browser form post answers a redirect');
  assert.equal(good.headers.get('location'), '/login', 'back to the referrer');
  assert.ok((good.headers.get('set-cookie') || '').includes('spark_session='), 'cookie rides the 303');

  const bad = await fetch(`${S}/api/users?auth`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', referer: `${S}/login` },
    body: 'email=a%40b.c&password=wrong',
  });
  assert.equal(bad.status, 401, 'failed login keeps its status');
  assert.ok((bad.headers.get('content-type') || '').includes('text/html'), 're-renders the referring page');
  assert.ok((await bad.text()).includes('Login'), 'the login page, not bare JSON');

  const out = await fetch(`${S}/api/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', referer: `${S}/` },
    body: '',
  });
  assert.equal(out.status, 303);
  assert.ok((out.headers.get('set-cookie') || '').includes('Max-Age=0'), 'session cleared');
});

await test('built-in auth (§): /login, /signup, /logout, guard redirect — no page written', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-auth-'));
  writeFileSync(join(root, 'spark.json'),
    JSON.stringify({ db: 'sqlite::memory:', auth: { table: 'users', identity: 'email', secret: 'test-secret-xyz' } }));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'index.html'), '<h1>Home</h1>');
  // Bare guard, no redirect/status → defaults to /login when auth is configured.
  writeFileSync(join(root, 'pages', 'admin.html'), '<h1 id="a">Admin</h1>\n<spark-ssr guard="session" />');
  const s = await serve({ root, port: 0, quiet: true });
  const B = `http://localhost:${s.port}`;
  // Configuring auth auto-registers the users table; create the account through
  // the signup endpoint (hashes the password), the same path the form uses.
  await fetch(`${B}/api/users`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'me@x.com', password: 'secret' }),
  });
  try {
    const login = await fetch(`${B}/login`);
    assert.equal(login.status, 200);
    const lh = await login.text();
    assert.ok(lh.includes('Sign in') && lh.includes('action="/api/users?auth"'), 'default login form');
    assert.ok((await (await fetch(`${B}/signup`)).text()).includes('Create account'), 'default signup form');

    // A guarded page with no session bounces to /login with a ?next back.
    const g = await fetch(`${B}/admin`, { redirect: 'manual' });
    assert.equal(g.status, 303);
    assert.equal(g.headers.get('location'), '/login?next=%2Fadmin');

    // Bad login (browser form) bounces back to /login?error=1.
    const bad = await fetch(`${B}/api/users?auth`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', referer: `${B}/login` },
      body: 'email=me%40x.com&password=nope',
    });
    assert.equal(bad.status, 303);
    assert.equal(bad.headers.get('location'), '/login?error=1', 'error shown on the built-in form');

    // Good login sets the session cookie.
    const good = await fetch(`${B}/api/users?auth`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', referer: `${B}/login` },
      body: 'email=me%40x.com&password=secret',
    });
    assert.equal(good.status, 303);
    const cookie = (good.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie.startsWith('spark_session='), 'cookie issued');

    // Signed in: /login redirects home, and the guarded page renders.
    const loggedInLogin = await fetch(`${B}/login`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(loggedInLogin.status, 303, 'no login form for a signed-in visitor');
    const admin = await fetch(`${B}/admin`, { headers: { cookie } });
    assert.equal(admin.status, 200);
    assert.ok((await admin.text()).includes('id="a"'), 'guard passes with a session');

    // Logout clears the cookie.
    const out = await fetch(`${B}/logout`, { redirect: 'manual' });
    assert.equal(out.status, 303);
    assert.ok((out.headers.get('set-cookie') || '').includes('Max-Age=0'), 'session cleared');

    // A user page always overrides the built-in.
    writeFileSync(join(root, 'pages', 'login.html'), '<h1 id="mine">My login</h1>');
    assert.ok((await (await fetch(`${B}/login`)).text()).includes('id="mine"'), 'pages/login.html wins');
  } finally { await s.stop?.(); }
});

await test('flash (§): flash="…" on a form → one-shot {flash} + <spark-flash> on the next page', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-flash-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'index.html'),
    '<spark-flash></spark-flash>\n<p id="f">{flash}</p>\n<p id="s">{session ? \'in\' : \'out\'}</p>\n'
    + '<form action="/api/notes" method="post" redirect="/" flash="Saved!"><input name="text"><button>Add</button></form>\n'
    + '<spark-ssr table="notes" />');
  const s = await serve({ root, port: 0, quiet: true });
  const B = `http://localhost:${s.port}`;
  try {
    // The flash="…" attribute became a hidden _flash field; session is ambient.
    const page = await (await fetch(`${B}/`)).text();
    assert.ok(page.includes('name="_flash"') && page.includes('value="Saved!"'), 'flash attr → hidden field');
    assert.ok(page.includes('id="s">out<'), '{session} ambient (signed out)');
    assert.ok(!/<spark-flash/i.test(page), '<spark-flash> replaced (empty when no message)');

    // Submit as a browser: success 303 carries the signed flash cookie.
    const post = await fetch(`${B}/api/notes`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', referer: `${B}/` },
      body: 'text=hi&_redirect=/&_flash=' + encodeURIComponent('Saved!'),
    });
    assert.equal(post.status, 303);
    const flashCookie = (post.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(flashCookie.startsWith('spark_flash='), 'flash cookie set');

    // The next page shows it once, renders the toast, and clears the cookie.
    const shown = await fetch(`${B}/`, { headers: { cookie: flashCookie } });
    const shownHtml = await shown.text();
    assert.ok(shownHtml.includes('id="f">Saved!<'), '{flash} interpolates the message');
    assert.ok(shownHtml.includes('role="status"') && shownHtml.includes('Saved!'), '<spark-flash> toast rendered');
    assert.ok((shown.headers.get('set-cookie') || '').includes('spark_flash=; Path=/; SameSite=Lax; Max-Age=0'), 'flash cleared after showing');
  } finally { await s.stop?.(); }
});

await test('list UI (§10): <spark-pager> and <spark-search> drive ?page/?q with no wiring', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-list-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'index.html'),
    '<spark-search placeholder="Find posts"></spark-search>\n'
    + '<template each="p in posts"><p class="p">{p.title}</p></template>\n'
    + '<spark-pager for="posts"></spark-pager>\n'
    + '<spark-ssr table="posts" limit="2" search="title" />');
  const s = await serve({ root, port: 0, quiet: true });
  for (let i = 1; i <= 5; i++) await s.db.query('INSERT INTO posts (title) VALUES (?)', [`Post ${i}`]);
  const B = `http://localhost:${s.port}`;
  const count = (h, re) => (h.match(re) || []).length;
  try {
    const p1 = await (await fetch(`${B}/`)).text();
    assert.equal(count(p1, /<p class="p">/g), 2, 'page size honored (limit=2)');
    assert.ok(p1.includes('class="spark-pager"'), 'pager rendered');
    assert.ok(p1.includes('aria-current="page"') && />1<\/span>/.test(p1), 'page 1 is current');
    assert.ok(p1.includes('page=2'), 'a link to page 2 exists');
    assert.ok(p1.includes('name="q"') && p1.includes('Find posts'), 'search box rendered');

    const p2 = await (await fetch(`${B}/?page=2`)).text();
    assert.ok(/aria-current="page"[^>]*>2<\/span>/.test(p2), 'page 2 becomes current');
    assert.equal(count(p2, /<p class="p">/g), 2, 'second page also full');

    const q = await (await fetch(`${B}/?q=Post%203`)).text();
    assert.ok(q.includes('value="Post 3"'), 'search input reflects ?q');
    assert.ok(q.includes('>Post 3<'), 'results filtered by ?q');
  } finally { await s.stop?.(); }
});

await test('await (§): a rejected <template await> with no catch shows a default error boundary', async () => {
  // No catch branch → the zero-config error boundary, never a blank section.
  const bare = await renderFragment('<template await="p"><p id="ok">ok</p></template>',
    { p: Promise.reject(new Error('boom')) }, { dev: false });
  assert.ok(bare.includes('data-spark-await-error'), 'default boundary rendered');
  assert.ok(!bare.includes('id="ok"'), 'the resolved branch did not render');
  assert.ok(bare.includes('could not be loaded'), 'generic message in production');

  // dev surfaces the real reason.
  const dev = await renderFragment('<template await="p"><p>ok</p></template>',
    { p: Promise.reject(new Error('boom')) }, { dev: true });
  assert.ok(dev.includes('boom'), 'dev shows the failure reason');

  // An explicit <template catch> still wins over the default.
  const caught = await renderFragment(
    '<template await="p"><template catch><p id="caught">caught</p></template></template>',
    { p: Promise.reject(new Error('x')) }, { dev: false });
  assert.ok(caught.includes('id="caught"') && !caught.includes('data-spark-await-error'), 'catch branch wins');

  // A resolved promise still renders its content.
  const ok = await renderFragment('<template await="p" as="v"><p id="ok">{v}</p></template>',
    { p: Promise.resolve('yes') }, { dev: false });
  assert.ok(ok.includes('id="ok">yes<'), 'resolved value renders');
});

await test('source cache (§5): LRU bound, table-indexed invalidation, sweep frees expired entries', () => {
  const c = makeSourceCache({ max: 3 });
  c.set('a', 1, 60, new Set(['todos']));
  c.set('b', 2, 60, new Set(['todos', 'users']));
  c.set('c', 3, 60, new Set(['posts']));
  assert.equal(c.size(), 3);
  c.get('a'); // refresh a's recency — b is now the oldest
  c.set('d', 4, 60, new Set());
  assert.equal(c.size(), 3, 'bounded at max');
  assert.equal(c.get('b'), undefined, 'LRU entry evicted');
  assert.ok(c.get('a') && c.get('c') && c.get('d'), 'recent entries survive');

  c.invalidate('todos');
  assert.equal(c.get('a'), undefined, 'write through todos sweeps its readers');
  assert.ok(c.get('c'), 'other tables untouched');

  c.set('e', 5, -1, new Set(['posts'])); // already expired
  c.sweep();
  assert.equal(c.get('e'), undefined, 'sweep frees expired entries');
  assert.ok(c.get('c'), 'live entries survive the sweep');
});

await test('renderer (§1): precompiled-program parity — slots, :class merge, spark-ignore, booleans, if-chain', async () => {
  // A literal <slot> on a PAGE (outside any component) stays a real element.
  const pageSlot = await renderFragment('<slot name="x">fallback {y}</slot>', { y: 'Y' });
  assert.ok(pageSlot.includes('<slot name="x">fallback Y</slot>'), 'page-level slot kept + interpolated');

  // :class merges into an existing static class; false/null dynamic attrs
  // vanish; true renders bare for boolean attributes.
  const attrs = await renderFragment(
    '<li class="a" :class="on ? \'b\' : null" :data-id="id" :required="yes" :hidden="no">x</li>',
    { on: true, id: 7, yes: true, no: false });
  assert.ok(attrs.includes('class="a b"'), ':class merged into static class');
  assert.ok(attrs.includes('data-id="7"'), 'dynamic attr rendered');
  assert.ok(/\brequired[\s>]/.test(attrs) && !attrs.includes('required="'), 'true → bare boolean attr');
  assert.ok(!attrs.includes('hidden'), 'false → attribute omitted');

  // spark-ignore subtrees render verbatim — no interpolation, handlers kept.
  const ignored = await renderFragment('<div spark-ignore><b onclick={x}>{raw}</b></div>', { raw: 'NO' });
  assert.ok(ignored.includes('{raw}') && ignored.includes('onclick="{x}"'), 'spark-ignore untouched');

  // if / else-if / else chain: exactly one branch renders, and the chain
  // can set the response status declaratively.
  const ctx = {};
  const chain = await renderFragment(
    '<template if="n === 1"><p>one</p></template>\n'
    + '<template else-if="n === 2"><p>two</p></template>\n'
    + '<template else status="404"><p>fallback</p></template>', { n: 5 }, ctx);
  assert.ok(chain.includes('fallback') && !chain.includes('one') && !chain.includes('two'), 'else branch wins');
  assert.equal(ctx.status, 404, 'winning branch sets ctx.status');

  // Interpolated text is HTML-escaped (the XSS floor the old DOM path had).
  const escaped = await renderFragment('<p>{evil}</p>', { evil: '<script>alert(1)</script>' });
  assert.ok(!escaped.includes('<script>') && escaped.includes('&lt;script&gt;'), 'interpolation escapes HTML');
});

await test('response cache (§6): anonymous GETs serve from memory; a write through the server invalidates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-rescache-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  writeFileSync(join(root, 'index.html'),
    '<ul><template each="todo in todos"><li class="t">{todo.title}</li></template></ul>\n'
    + '<spark-ssr table="todos" />');
  const s = await serve({ root, port: 0, quiet: true, watch: false }); // production: cache on
  const B = `http://localhost:${s.port}`;
  try {
    await s.db.query("INSERT INTO todos (title) VALUES ('First')");
    const p1 = await (await fetch(`${B}/`)).text();
    assert.ok(p1.includes('First'), 'first render');

    // A direct db write the server never saw — the cached page still serves.
    await s.db.query("INSERT INTO todos (title) VALUES ('Sneaky')");
    const p2 = await (await fetch(`${B}/`)).text();
    assert.ok(!p2.includes('Sneaky'), 'served from cache (direct write invisible within TTL)');

    // A write THROUGH the server invalidates by table.
    const w = await fetch(`${B}/api/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Loud' }),
    });
    assert.equal(w.status, 201);
    const p3 = await (await fetch(`${B}/`)).text();
    assert.ok(p3.includes('Loud') && p3.includes('Sneaky'), 'cache invalidated, fresh render');

    // A request carrying a spark_ cookie bypasses the cache entirely.
    await s.db.query("INSERT INTO todos (title) VALUES ('ForUser')");
    const p4 = await (await fetch(`${B}/`, { headers: { cookie: 'spark_session=x.y' } })).text();
    assert.ok(p4.includes('ForUser'), 'cookie-carrying request rendered fresh');
  } finally { await s.stop(true); }
});

await test('streaming (§7): a production list page streams — full document arrives intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-stream-'));
  // responseCache off so the streaming path (not the §6 cache) serves the page.
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:', responseCache: false }));
  writeFileSync(join(root, 'rows.html'),
    '<h1>{title ?? "Rows"}</h1><ul><template each="r in rows"><li class="r">{r.title}</li></template></ul>\n'
    + '<spark-ssr>\n  GET /api/rows → rows = SELECT * FROM rows\n</spark-ssr>');
  const s = await serve({ root, port: 0, quiet: true, watch: false });
  const B = `http://localhost:${s.port}`;
  try {
    await s.db.query('CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, title TEXT)');
    for (let i = 0; i < 50; i++) await s.db.query('INSERT INTO rows (title) VALUES (?)', ['Row ' + i]);
    const res = await fetch(`${B}/rows`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal((html.match(/class="r"/g) || []).length, 50, 'all rows streamed');
    assert.ok(html.includes('Row 0') && html.includes('Row 49'), 'first and last rows present');
    assert.ok(html.trimEnd().endsWith('</html>'), 'document closed cleanly');
    assert.ok(html.includes('<head>'), 'shell prefix flushed');
  } finally { await s.stop(true); }
});

await test('relations (§): each="c in post.comments" infers a comments table (post_id FK) and joins it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-rel-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  mkdirSync(join(root, 'pages', 'post'), { recursive: true });
  writeFileSync(join(root, 'pages', 'post', '[id].html'),
    '<h1 id="t">{post.title}</h1>\n'
    + '<template each="c in post.comments"><p class="c">{c.body}</p></template>\n'
    + '<spark-ssr>\n  post = SELECT * FROM posts WHERE id = :id LIMIT 1\n</spark-ssr>');
  const s = await serve({ root, port: 0, quiet: true });
  await s.db.query('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)');
  await s.db.query("INSERT INTO posts (id, title) VALUES (1, 'Hello')");
  const B = `http://localhost:${s.port}`;
  try {
    // The comments table was inferred + created at startup — insert related rows.
    const cols = (await s.db.columns('comments')).map((c) => c.name);
    assert.ok(cols.includes('post_id') && cols.includes('body'), 'inferred FK + field columns');
    await s.db.query("INSERT INTO comments (post_id, body) VALUES (1, 'first'), (1, 'second'), (2, 'other')");
    const html = await (await fetch(`${B}/post/1`)).text();
    assert.ok(html.includes('id="t">Hello<'), 'the parent row renders');
    assert.ok(html.includes('>first<') && html.includes('>second<'), 'related rows joined onto the parent');
    assert.ok(!html.includes('>other<'), 'only this post’s comments (FK scoped)');
  } finally { await s.stop?.(); }
});

await test('SEO (T3): og:title/og:description derive from the lifted head', async () => {
  const html = await (await fetch(`${S}/seo`)).text();
  const [head] = html.split('</head>');
  assert.ok(head.includes('<meta property="og:title" content="Hello World · Site">'), 'og:title derived');
  assert.ok(head.includes('og:description') && head.includes('Hello World has 500 views'), 'og:description derived');
});

await test('SEO (T3): sitemap.xml enumerates [param] routes from their bound query', async () => {
  const res = await fetch(`${S}/sitemap.xml`);
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.ok(xml.includes(`<loc>${S}/</loc>`), 'static routes listed');
  assert.ok(xml.includes(`${S}/blog/hello`) && xml.includes(`${S}/blog/quiet`), 'dynamic route enumerated via SQL');
  assert.ok(!xml.includes('[slug]'), 'no raw params leak');
});

await test('SEO (T3): robots.txt honors noindex pages and links the sitemap', async () => {
  writeFileSync(join(siteRoot, 'pages', 'secret.html'),
    '<meta name="robots" content="noindex">\n<h1>Secret</h1>');
  const txt = await (await fetch(`${S}/robots.txt`)).text();
  assert.ok(txt.includes('User-agent: *'));
  assert.ok(txt.includes('Disallow: /secret'), 'noindex page disallowed');
  assert.ok(txt.includes(`Sitemap: ${S}/sitemap.xml`));
  const xml = await (await fetch(`${S}/sitemap.xml`)).text();
  assert.ok(!xml.includes('/secret'), 'noindex page stays out of the sitemap');
});

await test('/__spark/plan (§4): the inferred backend, on one dev page', async () => {
  const res = await fetch(`${S}/__spark/plan`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('/blog/[slug]'), 'routes listed');
  assert.ok(html.includes('GET /api/blog'), 'var → source bindings shown');
  assert.ok(html.includes('notes'), 'tables listed');
});

await test('dev banner (§4): unmatched data-shaped vars are named on the page', async () => {
  writeFileSync(join(siteRoot, 'pages', 'lonely.html'),
    '<p>{stuff.x}</p>\n<p>{other.y}</p>\n<spark-ssr>\n  things = SELECT 1 AS x\n</spark-ssr>');
  const html = await (await fetch(`${S}/lonely`)).text();
  assert.ok(html.includes('no source provides it'), 'banner injected in dev');
  assert.ok(html.includes('{stuff}') && html.includes('{other}'), 'both vars named');
  assert.ok(html.includes('nearest source'), 'suggestion offered');
});

await test('dev error overlay (§4): a failing query shows the real error to a browser', async () => {
  const res = await fetch(`${S}/broken`, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 500);
  const html = await res.text();
  assert.ok(html.includes('does_not_exist'), 'the actual SQL error, not a bare 500');
  assert.ok(html.includes('/__spark/reload'), 'reload client rides along');
});

await site.stop(true);

// ── layouts, guards, declarative status (§2, §3) ────────────────────────
async function makeLayoutApp() {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-layout-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  mkdirSync(join(root, 'pages', 'admin'), { recursive: true });
  mkdirSync(join(root, 'pages', 'blog'), { recursive: true });
  mkdirSync(join(root, 'components'));
  writeFileSync(join(root, 'components', 'nav.html'), '<nav id="nav">{who}</nav>');
  writeFileSync(join(root, 'pages', '_layout.html'), `<title>Site</title>
<link rel="stylesheet" href="/style.css">
<div import="/components/nav" who="{author.name}"></div>
<slot></slot>
<footer id="foot">© {author.name}</footer>
<spark-ssr>
  author = SELECT name FROM authors LIMIT 1
</spark-ssr>`);
  writeFileSync(join(root, 'pages', 'index.html'), `<title>Home · {author.name}</title>
<main id="home">
  <template each="post in posts"><h2 class="p">{post.title}</h2></template>
</main>
<spark-ssr>
  posts = SELECT * FROM posts WHERE published = 1 ORDER BY id
</spark-ssr>`);
  writeFileSync(join(root, 'pages', 'admin', '_layout.html'), '<div id="adminwrap"><slot></slot></div>');
  writeFileSync(join(root, 'pages', 'admin', 'index.html'),
    '<h1 id="adm">Admin</h1>\n<spark-ssr guard="session" redirect="/login" />');
  writeFileSync(join(root, 'pages', 'vip.html'),
    '<h1>VIP</h1>\n<spark-ssr guard="session" status="401" />');
  writeFileSync(join(root, 'pages', 'blog', '[slug].html'), `<template if="post">
  <article><h1>{post.title}</h1></article>
</template>
<template else status="404"><h1 id="gone">Gone.</h1></template>
<spark-ssr>
  post = SELECT * FROM posts WHERE slug = :slug AND published = 1 LIMIT 1
</spark-ssr>`);
  // An interactive (hydrating) page under the SAME root layout — regression
  // coverage for the layout's `<div import="nav" who="{author.name}">`: that
  // prop must evaluate on the CLIENT too, not just in the SSR string, once
  // the page becomes a client component (see hydration e2e test below).
  writeFileSync(join(root, 'pages', 'tasks.html'), `<input bind:value="draft" placeholder="New">
<button onclick={add}>Add</button>
<template each="todo in todos"><li class="t">{todo.title}</li></template>
<spark-ssr table="todos" />`);
  // A HYDRATING [param] page whose own named data depends on :id — the
  // regression case for the route-param-lost-on-hydrate bug: :id is a path
  // segment, never in the query string, so it can't ride along the way
  // ?q/?sort/?page do. `note` (a bind:) is enough to make the page
  // interactive without needing a handler.
  mkdirSync(join(root, 'pages', 'widget'), { recursive: true });
  writeFileSync(join(root, 'pages', 'widget', '[id].html'), `<h1 id="wt">{widget.name}</h1>
<input bind:value="note">
<spark-ssr>
  widget = SELECT * FROM widgets WHERE id = :id LIMIT 1
</spark-ssr>`);
  return root;
}

const layoutRoot = await makeLayoutApp();
const lay = await serve({ root: layoutRoot, port: 0, quiet: true });
const L = `http://localhost:${lay.port}`;
await lay.db.query('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)');
await lay.db.query("INSERT INTO authors (name) VALUES ('Ada')");
await lay.db.query('CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, title TEXT, published INTEGER DEFAULT 0)');
await lay.db.query("INSERT INTO posts (slug, title, published) VALUES ('one', 'Post One', 1), ('draft', 'Drafty', 0)");
await lay.db.query('CREATE TABLE widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
await lay.db.query("INSERT INTO widgets (name) VALUES ('First'), ('Second'), ('Third')");

await test('layouts (§2): the folder wraps its pages; layout vars are in page scope', async () => {
  const html = await (await fetch(`${L}/`)).text();
  assert.ok(html.includes('<nav id="nav">Ada</nav>'), 'layout component rendered with the layout query');
  assert.ok(html.includes('id="foot">© Ada'), 'layout markup after the slot');
  assert.ok(html.includes('Post One'), 'page content inside the layout');
  const [head] = html.split('</head>');
  assert.ok(head.includes('<title>Home · Ada</title>'), 'page title wins the conflict');
  assert.ok(!head.includes('<title>Site</title>'), "layout title lost — the page's wins");
  assert.ok(head.includes('href="/style.css"'), "layout's stylesheet lifted");
});

await test('layouts (§2): a hydrating page still evaluates the layout\'s own import props', async () => {
  // Regression: `pages/_layout.html`'s <div import="/components/nav"
  // who="{author.name}"> reads the LAYOUT's own <spark-ssr> data. On a
  // static page that's baked server-side and never touched again. On an
  // INTERACTIVE page (this one), the whole layout+page markup becomes one
  // client component and the browser's mount() re-resolves that top-level
  // import — which used to render the literal string "{author.name}"
  // instead of "Ada" (spark-html core bug: resolveImports() resolves the
  // whole tree before any bootComponent() runs, so there was no scope yet
  // to read `author` from).
  const m = await mountHydratedPage(L, '/tasks');
  try {
    assert.ok(m.host, 'the interactive page mounted as a client component');
    assert.equal(m.document.querySelector('#nav').textContent, 'Ada',
      'layout nav prop evaluated, not left as literal "{author.name}"');
  } finally {
    m.restore();
  }
});

await test('hydration (§2): a [param] page keeps its :id on the client, not just SSR', async () => {
  // Regression: a [param] route's :id is a PATH segment, never in the query
  // string — so unlike ?q/?sort/?page it can't ride along via
  // location.search. Every instance of /widget/[id] shares the exact same
  // /__spark/page/widget/[id] and /__spark/data/widget/[id] URLs, so
  // without the server forwarding req.params along as a query string (see
  // shell()'s routeParamsQS), the client-side hydration fetch has no way to
  // know which row this instance is for — :id silently resolved to null,
  // and the second/third widget's page would hydrate showing the FIRST
  // widget's data (or blank), never its own.
  for (const [id, name] of [[1, 'First'], [2, 'Second'], [3, 'Third']]) {
    const m = await mountHydratedPage(L, `/widget/${id}`);
    try {
      assert.equal(m.document.querySelector('#wt').textContent, name, `/widget/${id} hydrates as "${name}", not another row`);
    } finally {
      m.restore();
    }
  }
});

await test('hydration (§2): a bind:value="q" local var is seeded from a LIVE ?q=, not reset to \'\'', async () => {
  // Regression: unlike a [param]'s :id, ?q IS in the query string — but the
  // generated client script is static and shared by every visit to this
  // route (one /__spark/page/<key>), so it can't bake a per-request value in
  // server-side either. It used to just hardcode `let q = '';` for any
  // bind:value target the author didn't declare themselves — a bookmarked
  // or shared `/?q=...` URL rendered its filtered view correctly at SSR,
  // then hydration silently reset the search box (and the list) back to
  // unfiltered the moment JS took over. Reproduced even in
  // create-spark-html-app's own ssr-nodb template (/?q=... loses its filter
  // on hydration).
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-qbind-'));
  writeFileSync(join(root, 'spark.json'), '{}');
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'index.html'),
    '<input class="q" bind:value="q">\n' +
    '<template each="item in items">\n' +
    '  <template if="!q || item.toLowerCase().includes(q.toLowerCase())"><p class="item">{item}</p></template>\n' +
    '</template>\n' +
    '<spark-ssr>\n  items = ./items.js\n</spark-ssr>');
  writeFileSync(join(root, 'items.js'), "export default () => ['Alpha', 'Beta', 'Gamma'];");
  const s = await serve({ root, port: 0, quiet: true });
  const base = `http://localhost:${s.port}`;
  try {
    const ssrHtml = await (await fetch(`${base}/?q=al`)).text();
    assert.ok(ssrHtml.includes('Alpha') && !ssrHtml.includes('Beta'), 'SSR itself filters correctly (sanity check)');

    const m = await mountHydratedPage(base, '/?q=al');
    try {
      assert.equal(m.scope.q, 'al', 'q seeded from the live ?q=, not reset to \'\'');
      const items = [...m.document.querySelectorAll('.item')].map((n) => n.textContent);
      assert.deepEqual(items, ['Alpha'], 'the filtered view survives hydration, not reset to the full list');
    } finally {
      m.restore();
    }
  } finally {
    await s.stop?.();
  }
});

await test('hydration (§2): a MODULE source reading req.query gets the live ?q= on its OWN initial fetch, not just refresh()', async () => {
  // Regression: routeParamsQS (baked onto the host import path, threaded
  // through /__spark/page/ and /__spark/data/) used to carry req.params
  // ONLY — a [param]'s :id. A source that reads req.query directly (a
  // module/URL source, not a table's own ?q=/?sort=/?page= auto-CRUD
  // convention) rendered correctly at SSR (this request's real query
  // string) but the client's OWN initial `import __init from
  // '/__spark/data/<key>.js'` carried none of it, so the very first paint
  // after hydration silently reset to whatever req.query.q gives an EMPTY
  // string (here: everything, since the source treats a missing q as "no
  // filter"). A later refresh() already reads location.search live and
  // gets this right — only the initial boot was wrong.
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-queryreq-'));
  writeFileSync(join(root, 'spark.json'), '{}');
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'index.html'),
    // A page with no handler/bind at all never qualifies for hydration in
    // the first place (see shouldHydrate) and would just keep showing its
    // SSR output forever — this unused bind forces the client component
    // path so the test actually exercises the client's OWN __init fetch.
    '<input bind:value="unused">\n' +
    '<template each="item in items"><p class="item">{item}</p></template>\n' +
    '<spark-ssr>\n  items = ./items.js\n</spark-ssr>');
  writeFileSync(join(root, 'items.js'),
    "export default (req) => {\n" +
    "  const all = ['Alpha', 'Beta', 'Gamma'];\n" +
    "  const q = String(req.query.q || '').toLowerCase();\n" +
    "  return q ? all.filter((s) => s.toLowerCase().includes(q)) : all;\n" +
    "};");
  const s = await serve({ root, port: 0, quiet: true });
  const base = `http://localhost:${s.port}`;
  try {
    const m = await mountHydratedPage(base, '/?q=al');
    try {
      const items = [...m.document.querySelectorAll('.item')].map((n) => n.textContent);
      assert.deepEqual(items, ['Alpha'], 'the client\'s own initial data fetch used the live ?q=, not an empty one');
    } finally {
      m.restore();
    }
  } finally {
    await s.stop?.();
  }
});

await test('layouts (§2): nested folders nest their layouts', async () => {
  // Signed-out /admin redirects — check the nesting on the redirect target
  // being followed manually is beside the point; render with a session-free
  // guard removed page instead: the vip page shares only the root layout.
  const res = await fetch(`${L}/admin`, { redirect: 'manual' });
  assert.equal(res.status, 303, 'guard redirect');
  assert.equal(res.headers.get('location'), '/login');
});

await test('layouts (§2): a <slot> written inside a layout comment is not the slot', async () => {
  // Regression: the starter layout's explainer comment mentions "<slot>". Slot
  // composition must mask comments, or the page gets injected inside the comment
  // (nav ends up after the content and the comment text leaks onto the page).
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-slotcomment-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', '_layout.html'),
    '<!-- <slot> is the page; its <spark-ssr> vars are in scope. -->\n' +
    '<nav id="chrome">nav</nav>\n<slot></slot>');
  writeFileSync(join(root, 'pages', 'index.html'), '<main id="page">hello</main>');
  const s = await serve({ root, port: 0, quiet: true });
  try {
    const body = (await (await fetch(`http://localhost:${s.port}/`)).text())
      .split(/<body[^>]*>/)[1] || '';
    assert.ok(body.indexOf('id="chrome"') < body.indexOf('id="page"'),
      'nav (before the real slot) renders before the page content');
    // The comment survives intact — its "<slot>" was not consumed as the slot.
    assert.ok(/<!--[^]*?<slot>[^]*?-->/.test(body), 'comment kept its literal <slot>');
  } finally {
    await s.stop?.();
  }
});

await test('guard (§3): status variant answers 401; named binding exposes no endpoint', async () => {
  assert.equal((await fetch(`${L}/vip`)).status, 401);
  assert.equal((await fetch(`${L}/api/author`)).status, 404, 'var = SELECT … is page data only');
  assert.equal((await fetch(`${L}/_layout`)).status, 404, '_layout.html is not a page');
});

await test('declarative status (§3): the rendered else-branch sets 404', async () => {
  const ok = await fetch(`${L}/blog/one`);
  assert.equal(ok.status, 200);
  assert.ok((await ok.text()).includes('Post One'));
  const gone = await fetch(`${L}/blog/nope`);
  assert.equal(gone.status, 404, 'a missing row is no longer a 200');
  assert.ok((await gone.text()).includes('id="gone"'), 'the branch still renders');
  assert.equal((await fetch(`${L}/blog/draft`)).status, 404, 'unpublished stays invisible');
});

await test('errors: unknown route gets a styled default 404; pages/404.html overrides it', async () => {
  // No 404.html anywhere → the built-in styled default (not bare text).
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-404-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'index.html'), '<h1>Home</h1>');
  let s = await serve({ root, port: 0, quiet: true });
  let res = await fetch(`http://localhost:${s.port}/does-not-exist`);
  assert.equal(res.status, 404);
  let body = await res.text();
  assert.ok(res.headers.get('content-type').includes('text/html'), 'served as HTML');
  assert.ok(body.includes('<!doctype html>') && body.includes('>404<'), 'the built-in default renders');
  assert.ok(!/^Not found$/.test(body.trim()), 'not the bare text response');
  await s.stop?.();

  // Drop pages/404.html → it wins.
  writeFileSync(join(root, 'pages', '404.html'), '<h1 id="custom">Nothing here</h1>');
  s = await serve({ root, port: 0, quiet: true });
  res = await fetch(`http://localhost:${s.port}/nope`);
  assert.equal(res.status, 404, 'still a 404 status');
  assert.ok((await res.text()).includes('id="custom"'), 'the app 404 page overrides the default');
  assert.equal((await fetch(`http://localhost:${s.port}/404`)).status, 404, '404.html is not itself a route');
  await s.stop?.();
});

await test('auto-404 (§3): a [param] page with an empty single-row lookup 404s without an else branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-auto404-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  mkdirSync(join(root, 'pages', 'item'), { recursive: true });
  // No <template else> — the page just reads {item.title}.
  writeFileSync(join(root, 'pages', 'item', '[id].html'),
    '<h1 id="t">{item.title}</h1>\n<spark-ssr>\n  item = SELECT * FROM posts WHERE id = :id LIMIT 1\n</spark-ssr>');
  const s = await serve({ root, port: 0, quiet: true });
  await s.db.query('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)');
  await s.db.query("INSERT INTO posts (id, title) VALUES (1, 'Real')");
  try {
    const ok = await fetch(`http://localhost:${s.port}/item/1`);
    assert.equal(ok.status, 200, 'an existing row renders');
    assert.ok((await ok.text()).includes('id="t">Real<'));
    const gone = await fetch(`http://localhost:${s.port}/item/999`);
    assert.equal(gone.status, 404, 'a missing row is an automatic 404');
    assert.ok((await gone.text()).includes('Page not found'), 'the default 404 renders');
  } finally { await s.stop?.(); }
});

await test('auto-404 (§3): a LAYOUT\'s own if/else does not opt every [param] page under it out', async () => {
  // Regression: the else/else-if scan used to run against the merged
  // layout+page text (pd.html) — a shared layout's own conditional (nav's
  // logged-in/out branch, say) shared that "else" with every page it
  // wraps, silently disabling auto-404 site-wide even for pages that never
  // wrote an if/else of their own.
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-auto404-layout-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  mkdirSync(join(root, 'pages', 'item'), { recursive: true });
  writeFileSync(join(root, 'pages', '_layout.html'),
    '<template if="1"><nav>chrome</nav></template><template else><nav>other</nav></template>\n<slot></slot>');
  // No <template else> in the PAGE itself — just the layout has one.
  writeFileSync(join(root, 'pages', 'item', '[id].html'),
    '<h1 id="t">{item.title}</h1>\n<spark-ssr>\n  item = SELECT * FROM posts WHERE id = :id LIMIT 1\n</spark-ssr>');
  const s = await serve({ root, port: 0, quiet: true });
  await s.db.query('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)');
  await s.db.query("INSERT INTO posts (id, title) VALUES (1, 'Real')");
  try {
    const ok = await fetch(`http://localhost:${s.port}/item/1`);
    assert.equal(ok.status, 200, 'an existing row still renders through the layout');
    const gone = await fetch(`http://localhost:${s.port}/item/999`);
    assert.equal(gone.status, 404, 'a missing row still auto-404s despite the layout\'s own else');
  } finally { await s.stop?.(); }
});

await test('ambient {path}: the current request path is page scope (nav highlighting)', async () => {
  writeFileSync(join(layoutRoot, 'pages', 'where.html'),
    '<p id="pth">{path}</p><p id="on">{path === \'/where\' ? \'yes\' : \'no\'}</p>');
  const html = await (await fetch(`${L}/where`)).text();
  assert.ok(html.includes('id="pth">/where<'), '{path} interpolates');
  assert.ok(html.includes('id="on">yes<'), 'expressions over path work');
});

await test('sitemap (T3): guarded pages out, [slug] enumerated respecting the query WHERE', async () => {
  const xml = await (await fetch(`${L}/sitemap.xml`)).text();
  assert.ok(xml.includes(`${L}/blog/one`), 'published post listed');
  assert.ok(!xml.includes('/blog/draft'), 'the neutralized query keeps its published=1 clause');
  assert.ok(!xml.includes('/admin') && !xml.includes('/vip'), 'guarded pages excluded');
});

await lay.stop(true);

// ── forms, validation, seeds, live, lists, cache (§5–§7, §9, §10, T3) ──
async function makeFormsApp() {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-forms-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  mkdirSync(join(root, 'pages'));
  mkdirSync(join(root, 'seed'));
  writeFileSync(join(root, 'seed', 'todos.json'), JSON.stringify([
    { title: 'First' }, { title: 'Second' }, { title: 'Third' },
  ]));
  writeFileSync(join(root, 'pages', 'index.html'), `<p id="total">{todos.total}</p>
<template each="todo in todos"><li class="td">{todo.title}</li></template>
<input bind:value="draft"><button onclick={add}>Add</button>
<form action="/api/todos" method="post" redirect="/thanks">
  <input name="title" required maxlength="8">
  <button>Save</button>
</form>
<template if="errors"><p class="err">{errors.title}</p></template>
<spark-ssr table="todos" seed="./seed/todos.json" live limit="2" search="title" cache="60" />`);
  writeFileSync(join(root, 'pages', 'thanks.html'), '<h1 id="ty">Thanks</h1>');
  writeFileSync(join(root, 'pages', 'stats.html'), `<p id="n">{stats.n}</p>
<spark-ssr cache="60">
  stats = SELECT COUNT(*) AS n FROM todos
</spark-ssr>`);
  return root;
}

const formsRoot = await makeFormsApp();
const forms = await serve({ root: formsRoot, port: 0, quiet: true });
const F = `http://localhost:${forms.port}`;

await test('seeds (§7): table created and seeded at startup; seed file never served', async () => {
  const rows = await (await fetch(`${F}/api/todos?page=1`)).json();
  assert.equal(rows.length, 2, 'limit="2" paginates');
  const all = await forms.db.query('SELECT * FROM todos');
  assert.equal(all.length, 3, 'seeded once from seed/todos.json');
  assert.equal((await fetch(`${F}/seed/todos.json`)).status, 404, 'seed data is internal');
});

await test('lists (§10): ?page, ?sort, ?q and {list.total} on the page', async () => {
  const page2 = await (await fetch(`${F}/api/todos?page=2`)).json();
  assert.equal(page2.length, 1, 'second page has the remainder');
  const sorted = await (await fetch(`${F}/api/todos?sort=title:desc`)).json();
  assert.equal(sorted[0].title, 'Third', '?sort validated and applied');
  const found = await (await fetch(`${F}/api/todos?q=Fir`)).json();
  assert.equal(found.length, 1, '?q LIKEs across search="…" columns');
  assert.equal(found[0].title, 'First');
  const html = await (await fetch(`${F}/`)).text();
  assert.ok(html.includes('id="total">3<'), '{todos.total} rendered');
  assert.equal((html.match(/class="td"/g) || []).length, 2, 'page data paginated too');
});

await test('no-JS forms (§5): urlencoded post → 303 to the redirect attr target', async () => {
  const html = await (await fetch(`${F}/`)).text();
  assert.ok(html.includes('name="_redirect"') && html.includes('value="/thanks"'),
    'redirect attr became a hidden field');
  assert.ok(!/<form[^>]*redirect=/.test(html), 'the attr itself never ships');
  const res = await fetch(`${F}/api/todos`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', referer: `${F}/` },
    body: 'title=NoJS&_redirect=%2Fthanks',
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/thanks');
  const rows = await forms.db.query("SELECT * FROM todos WHERE title = 'NoJS'");
  assert.equal(rows.length, 1, 'the write happened');
});

await test('form validation (§6): 422 as JSON, re-render with {errors.title} as HTML', async () => {
  const j = await fetch(`${F}/api/todos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(j.status, 422);
  assert.equal((await j.json()).errors.title, 'required');

  const h = await fetch(`${F}/api/todos`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', referer: `${F}/` },
    body: 'title=WayTooLongForTheRule',
  });
  assert.equal(h.status, 422);
  const html = await h.text();
  assert.ok(html.includes('class="err"') && html.includes('max 8'), 'page re-rendered with the field error');
});

await test('live (§9): a write pings /__spark/live; the hydration client subscribes', async () => {
  const comp = await (await fetch(`${F}/__spark/page/index.html`)).text();
  assert.ok(comp.includes("new EventSource('/__spark/live')"), 'generated component subscribes');
  assert.ok(/onmessage[\s\S]*refresh\(\)/.test(comp), 'and refetches on a ping');

  const res = await fetch(`${F}/__spark/live`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const read = async () => dec.decode((await reader.read()).value || new Uint8Array());
  assert.ok((await read()).includes(': connected'));
  await fetch(`${F}/api/todos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'ping' }),
  });
  const ping = await Promise.race([
    read(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('no live ping within 3s')), 3000)),
  ]);
  assert.ok(ping.includes('todos'), 'the table name broadcast to every tab');
  await reader.cancel();
});

await test('cache (T3): cache="60" holds until a write through the server invalidates', async () => {
  const n0 = Number(((await (await fetch(`${F}/stats`)).text()).match(/id="n">(\d+)</) || [])[1]);
  await forms.db.query("INSERT INTO todos (title) VALUES ('sneaky')"); // bypasses the server
  const n1 = Number(((await (await fetch(`${F}/stats`)).text()).match(/id="n">(\d+)</) || [])[1]);
  assert.equal(n1, n0, 'cached value survives a direct DB write');
  await fetch(`${F}/api/todos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'seen' }),
  });
  const n2 = Number(((await (await fetch(`${F}/stats`)).text()).match(/id="n">(\d+)</) || [])[1]);
  assert.equal(n2, n0 + 2, 'a write through the API swept the cache');
});

await forms.stop(true);

// ── sources beyond SQL (§8) ─────────────────────────────────────────────
async function makeSourcesApp() {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-sources-'));
  mkdirSync(join(root, 'pages'));
  mkdirSync(join(root, 'content', 'posts'), { recursive: true });
  mkdirSync(join(root, 'lib'));
  mkdirSync(join(root, 'api'));
  writeFileSync(join(root, 'content', 'posts', 'alpha.md'),
    '---\ntitle: Alpha\ndate: 2026-01-02\n---\nBody A');
  writeFileSync(join(root, 'content', 'posts', 'beta.md'),
    '---\ntitle: Beta\ndate: 2026-01-01\n---\nBody B');
  writeFileSync(join(root, 'lib', 'info.js'),
    "export default (req, db) => ({ who: 'mod', x: req.query.x ?? null });\n");
  writeFileSync(join(root, 'api', 'pi.html'), '<script>return { pi: 314 };</script>');
  writeFileSync(join(root, 'pages', 'index.html'), `<template each="doc in docs">
  <h2 class="doc">{doc.title}</h2><p class="body">{doc.body}</p>
</template>
<p id="who">{info.who}</p>
<spark-ssr>
  docs = ./content/posts/*.md
  info = ./lib/info.js
</spark-ssr>`);
  return root;
}

const sourcesRoot = await makeSourcesApp();
const sources = await serve({ root: sourcesRoot, port: 0, quiet: true });
const SR = `http://localhost:${sources.port}`;

await test('glob source (§8): markdown files become rows — no database at all', async () => {
  const html = await (await fetch(`${SR}/`)).text();
  const docs = [...html.matchAll(/class="doc">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(docs, ['Alpha', 'Beta'], 'front-matter parsed, date-sorted desc');
  assert.ok(html.includes('Body A'), 'body text rendered');
});

await test('module source (§8): default export (req, db) => value', async () => {
  const html = await (await fetch(`${SR}/`)).text();
  assert.ok(html.includes('id="who">mod<'), 'module value in page scope');
});

await test('url source (§8): server-side fetch, JSON in page scope', async () => {
  writeFileSync(join(sourcesRoot, 'pages', 'remote.html'), `<p id="pi">{data.pi}</p>
<spark-ssr>
  data = http://localhost:${sources.port}/api/pi
</spark-ssr>`);
  const html = await (await fetch(`${SR}/remote`)).text();
  assert.ok(html.includes('id="pi">314<'), 'fetched, parsed, rendered');
});

await test('hydration (§2): an interactive non-table page (glob) hydrates + JSON mirror', async () => {
  // A markdown blog with a client-side search — no table, no db writes. §2
  // lifts the table gate: the glob source becomes client state and refresh()
  // refetches through the JSON mirror.
  writeFileSync(join(sourcesRoot, 'pages', 'notes.html'), `<input bind:value="q" placeholder="Filter">
<template each="doc in docs">
  <template if="!q || doc.title.toLowerCase().includes(q.toLowerCase())">
    <p class="hit">{doc.title}</p>
  </template>
</template>
<spark-ssr>
  docs = ./content/posts/*.md
</spark-ssr>`);
  const page = await (await fetch(`${SR}/notes`)).text();
  assert.ok(/import="\/__spark\/page\/notes"[^>]*\bname="notes"/.test(page), 'non-table page hydrates');
  assert.ok(page.includes('Alpha') && page.includes('Beta'), 'SSR renders the glob rows');

  const comp = await (await fetch(`${SR}/__spark/page/notes.html`)).text();
  assert.ok(comp.includes("import __init from '/__spark/data/notes.js'"), 'init module import');
  assert.ok(comp.includes('let docs = __init.docs'), 'glob source is client state');
  assert.ok(comp.includes('async function refresh()'), 'refresh() present without a table');
  assert.ok(!comp.includes('api_create'), 'no CRUD helpers without a table');

  const mirror = await fetch(`${SR}/__spark/data/notes.json`);
  assert.equal(mirror.headers.get('content-type'), 'application/json');
  assert.equal(mirror.headers.get('cache-control'), 'no-store');
  const data = await mirror.json();
  assert.deepEqual(data.docs.map((d) => d.title), ['Alpha', 'Beta'], 'JSON mirror re-runs the glob');
});

await sources.stop(true);

// ── Tier 3/4: jobs & mail, config-less start, OpenAPI ───────────────────
await test('config-less start (T4.9): no spark.json → db defaults to SQLite, table + CRUD work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-nocfg-'));
  // A single index.html, no spark.json, no pages/ — the whole app.
  writeFileSync(join(root, 'index.html'),
    '<template each="t in tasks"><p class="t">{t.label}</p></template>\n<spark-ssr table="tasks" />');
  const s = await serve({ root, port: 0, quiet: true });
  const B = `http://localhost:${s.port}`;
  try {
    assert.equal(s.config.db, 'sqlite://./dev.db', 'db defaulted with no spark.json');
    const post = await fetch(`${B}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'first' }),
    });
    assert.equal(post.status, 201, 'table auto-created, insert works');
    const html = await (await fetch(`${B}/`)).text();
    assert.ok(html.includes('class="t">first<'), 'row renders — SQLite was wired with zero config');
  } finally { await s.stop?.(); assert.ok(existsSync(join(root, 'dev.db')), 'dev.db created in the project'); }
});

await test('jobs + mail (T3.8): on="insert:orders" fires jobs/notify.js; req.mail() reaches the module sender', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-jobs-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:', mail: './lib/mail.js' }));
  mkdirSync(join(root, 'pages'), { recursive: true });
  mkdirSync(join(root, 'lib'));
  mkdirSync(join(root, 'jobs'));
  // The mail sender: a module whose default export records every message.
  writeFileSync(join(root, 'lib', 'mail.js'),
    "import { writeFileSync, existsSync, readFileSync } from 'node:fs';\n"
    + "import { join } from 'node:path';\n"
    + "const out = join(import.meta.dir, 'outbox.json');\n"
    + 'export default (msg) => {\n'
    + '  const box = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : [];\n'
    + '  box.push(msg); writeFileSync(out, JSON.stringify(box));\n'
    + '  return { ok: true };\n};\n');
  // Two jobs: one triggered by a write, one on a fast schedule.
  writeFileSync(join(root, 'jobs', 'notify.js'),
    'export default async (req, db) => { await req.mail({ to: "ops@x.co", subject: "New order " + (req.row?.item ?? "") }); };\n');
  writeFileSync(join(root, 'jobs', 'beat.js'),
    "export default async (req, db) => { await db.query(\"INSERT INTO beats (label) VALUES ('x')\"); };\n");
  writeFileSync(join(root, 'pages', 'index.html'),
    '<template each="o in orders"><p>{o.item}</p></template>\n'
    + '<template each="b in beats"><p>{b.label}</p></template>\n'
    + '<spark-ssr table="orders" />\n<spark-ssr table="beats" />\n'
    + '<spark-ssr job="notify" on="insert:orders" />\n'
    + '<spark-ssr job="beat" every="40ms" />');
  const s = await serve({ root, port: 0, quiet: true });
  const B = `http://localhost:${s.port}`;
  try {
    // A write to orders fires the notify job, which calls req.mail().
    await fetch(`${B}/api/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: 'book' }),
    });
    const outbox = join(root, 'lib', 'outbox.json');
    let box = [];
    for (let i = 0; i < 30 && !box.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (existsSync(outbox)) box = JSON.parse(readFileSync(outbox, 'utf8'));
    }
    assert.equal(box.length, 1, 'notify job ran once on the insert');
    assert.equal(box[0].subject, 'New order book', 'req.mail delivered to the module sender with the row');

    // The scheduled job keeps inserting; poll until it has run.
    let beats = [];
    for (let i = 0; i < 30 && beats.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 20));
      beats = await (await fetch(`${B}/api/beats`)).json();
    }
    assert.ok(beats.length >= 1, 'every="40ms" job fired on schedule');
  } finally { await s.stop?.(); }
});

await test('OpenAPI + typed client (T4.10): /__spark/openapi.json and /__spark/client.ts from the plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-oapi-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  writeFileSync(join(root, 'index.html'),
    '<template each="t in todos"><p>{t.title}</p></template>\n<spark-ssr table="todos" />');
  const s = await serve({ root, port: 0, quiet: true });
  const B = `http://localhost:${s.port}`;
  try {
    const doc = await (await fetch(`${B}/__spark/openapi.json`)).json();
    assert.ok(String(doc.openapi).startsWith('3.'), 'OpenAPI 3.x document');
    assert.ok(doc.paths['/api/todos'] && doc.paths['/api/todos'].get, 'GET /api/todos enumerated');
    assert.ok(doc.paths['/api/todos'].post, 'POST /api/todos enumerated');
    const byId = doc.paths['/api/todos/{id}'];
    assert.ok(byId && byId.patch && byId.patch.parameters?.some((p) => p.name === 'id'), '{id} path param typed');

    const client = await (await fetch(`${B}/__spark/client.ts`)).text();
    assert.ok(client.includes('export function createClient'), 'client exports createClient');
    assert.ok(/getApiTodos\s*\(/.test(client), 'a generated method per route');
    assert.ok(client.includes('patchApiTodosById'), 'path-param route → By<Param> method');
  } finally { await s.stop?.(); }
});

// ── spark-ssr db / db push (§7) ─────────────────────────────────────────
await test('cli db: shows the inferred schema; db push creates it; then it matches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-db-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite://./dev.db' }));
  mkdirSync(join(root, 'seed'));
  writeFileSync(join(root, 'seed', 'books.json'), JSON.stringify([{ title: 'Dune', stars: 5 }]));
  writeFileSync(join(root, 'index.html'), `<template each="book in books"><p>{book.title} {book.stars}</p></template>
<spark-ssr table="books" seed="./seed/books.json" />`);
  const cli = join(import.meta.dir, '..', 'bin', 'cli.js');

  const show = Bun.spawnSync(['bun', cli, 'db', '--root', root]);
  const out1 = String(show.stdout);
  assert.equal(show.exitCode, 0, String(show.stderr));
  assert.ok(out1.includes('books:') && out1.includes('title') && out1.includes('stars'), 'inferred columns listed');
  assert.ok(out1.includes('will create books'), 'diff says create');

  const push = Bun.spawnSync(['bun', cli, 'db', 'push', '--root', root]);
  assert.equal(push.exitCode, 0, String(push.stderr));
  assert.ok(String(push.stdout).includes('created table books'));
  assert.ok(String(push.stdout).includes('seeded books'));

  const { Database } = await import('bun:sqlite');
  const sdb = new Database(join(root, 'dev.db'));
  const cols = sdb.query('PRAGMA table_info(books)').all().map((c) => `${c.name}:${c.type}`);
  assert.ok(cols.includes('title:TEXT') && cols.includes('stars:INTEGER'), 'seed sharpened the types');
  assert.equal(sdb.query('SELECT COUNT(*) AS n FROM books').get().n, 1, 'seeded');
  sdb.close();

  const again = Bun.spawnSync(['bun', cli, 'db', '--root', root]);
  assert.ok(String(again.stdout).includes('already matches'), 'idempotent');
});

await test('schema inference: a loop over a `$:`-derived filtered array still finds its table, and an unrelated {table.length} does not become a column', async () => {
  // Found by the M4.6 audit: each="p in filteredPosts" (filteredPosts =
  // posts.filter(…)) has no direct link back to the `posts` table var, so
  // {p.title}/{p.body} were silently dropped from the inferred schema — AND
  // {posts.length} elsewhere on the page (reading the ARRAY, not a row) got
  // treated as a real column, inferring a bogus `length` field.
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-schema-derived-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite://./dev.db' }));
  writeFileSync(join(root, 'index.html'), `<h1>Posts ({posts.length} total)</h1>
<template each="p in filteredPosts">
  <article><h2>{p.title}</h2><p>{p.body}</p></article>
</template>
<script>
  $: filteredPosts = posts.filter(p => p.published);
</script>
<spark-ssr table="posts" />`);
  const { schema } = await projectSchema(root);
  assert.ok(schema.posts, 'posts table inferred at all');
  assert.deepEqual(Object.keys(schema.posts.columns).sort(), ['body', 'title'],
    `expected exactly [body, title], got ${JSON.stringify(schema.posts.columns)}`);
});

await test('safe schema evolution (T3.7): retype needs --force; db push --force rebuilds and keeps data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-evolve-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite://./dev.db' }));
  mkdirSync(join(root, 'seed'));
  const cli = join(import.meta.dir, '..', 'bin', 'cli.js');
  const page = '<template each="p in products"><p>{p.price}</p></template>\n'
    + '<spark-ssr table="products" seed="./seed/products.json" />';
  writeFileSync(join(root, 'index.html'), page);

  // v1: the seed's string value makes `price` TEXT. Create + seed one row.
  writeFileSync(join(root, 'seed', 'products.json'), JSON.stringify([{ price: 'cheap' }]));
  Bun.spawnSync(['bun', cli, 'db', 'push', '--root', root]);
  const { Database } = await import('bun:sqlite');
  let sdb = new Database(join(root, 'dev.db'));
  assert.equal(sdb.query('PRAGMA table_info(products)').all().find((c) => c.name === 'price').type, 'TEXT', 'price starts TEXT');
  sdb.close();

  // v2: a numeric seed value now implies INTEGER — a destructive retype.
  writeFileSync(join(root, 'seed', 'products.json'), JSON.stringify([{ price: 5 }]));
  const diff = Bun.spawnSync(['bun', cli, 'db', 'diff', '--root', root]);
  assert.ok(String(diff.stdout).includes('will change products.price TEXT → INTEGER (needs --force)'), 'diff flags the retype as needing --force');

  // Plain push must NOT change the type — never silently retype.
  Bun.spawnSync(['bun', cli, 'db', 'push', '--root', root]);
  sdb = new Database(join(root, 'dev.db'));
  assert.equal(sdb.query('PRAGMA table_info(products)').all().find((c) => c.name === 'price').type, 'TEXT', 'push (no force) kept TEXT');
  sdb.close();

  // --force rebuilds the table to INTEGER, preserving the existing row.
  const forced = Bun.spawnSync(['bun', cli, 'db', 'push', '--force', '--root', root]);
  assert.ok(String(forced.stdout).includes('changed price TEXT → INTEGER'), 'force logs the change');
  sdb = new Database(join(root, 'dev.db'));
  assert.equal(sdb.query('PRAGMA table_info(products)').all().find((c) => c.name === 'price').type, 'INTEGER', 'price retyped to INTEGER');
  assert.equal(sdb.query('SELECT COUNT(*) AS n FROM products').get().n, 1, 'the seeded row survived the rebuild');
  sdb.close();
});

// ── CLI: build assembles a deployable dist/ ─────────────────────────────
await test('cli build --no-compile: dist/ carries pages, config, a server entry; public/ flattens', async () => {
  const root = makeTodoApp();
  mkdirSync(join(root, 'public'));
  writeFileSync(join(root, 'public', 'style.css'), 'body{}');
  const cli = join(import.meta.dir, '..', 'bin', 'cli.js');
  const r = Bun.spawnSync(['bun', cli, 'build', '--no-compile', '--docker', '--root', root]);
  assert.equal(r.exitCode, 0, String(r.stderr));
  assert.ok(existsSync(join(root, 'dist', 'index.html')), 'page copied');
  assert.ok(existsSync(join(root, 'dist', 'spark.json')), 'config copied');
  assert.ok(existsSync(join(root, 'dist', 'style.css')), 'public/ flattened into dist root');
  assert.ok(!existsSync(join(root, 'dist', 'public')), 'no dist/public — assets keep their dev URLs');
  const entry = readFileSync(join(root, 'dist', '__server.js'), 'utf8');
  assert.ok(entry.includes("from 'spark-ssr'") && entry.includes('watch: false'), 'production server entry written');
  const docker = readFileSync(join(root, 'dist', 'Dockerfile'), 'utf8');
  assert.ok(docker.includes('oven/bun') && docker.includes('__server.js'), '--docker wrote a runnable Dockerfile');
});


// ── 2026-07-10 field-report fixes (spark-ssr-check.md §5) ──────────────

await test('data endpoint gives module sources identical req (params/path/query parity)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-params-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  mkdirSync(join(root, 'lib'));
  writeFileSync(join(root, 'lib', 'file.js'),
    'export default (req) => ({ id: req.params.id ?? null, path: req.path, sort: req.query.sort ?? null, qid: req.query.id ?? null });');
  mkdirSync(join(root, 'files'));
  writeFileSync(join(root, 'files', '[id].html'), `<h1>{file.id}</h1><button onclick={noop}>x</button>
<script>function noop() {}</script>
<spark-ssr>
  file = ./lib/file.js
</spark-ssr>`);
  const s = await serve({ root, port: 0, quiet: true, watch: false });
  const base = 'http://localhost:' + s.port;
  const ssr = await (await fetch(base + '/files/3?sort=asc')).text();
  assert.ok(ssr.includes('<h1>3</h1>'), 'SSR page sees req.params.id');
  // The hydration boot fetch: template-keyed URL + the forwarded QS the
  // shell bakes onto the import path (page.js routeParamsQS).
  const data = await (await fetch(base + '/__spark/data/files/%5Bid%5D.js?sort=asc&id=3')).text();
  assert.ok(data.includes('"id":"3"'), 'module sees req.params.id on the data endpoint — got: ' + data.slice(0, 200));
  assert.ok(data.includes('"path":"/files/3"'), 'module sees the PAGE path, not the data-endpoint path — got: ' + data.slice(0, 200));
  assert.ok(data.includes('"sort":"asc"'), 'real query keys still visible');
  assert.ok(data.includes('"qid":null'), 'param keys are params again, not query');
});

await test('declared source beats a same-named table= auto source, loudly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-shadow-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  writeFileSync(join(root, 'index.html'), `<ul><template each="f in files"><li>{f.name}</li></template></ul>
<spark-ssr table="files" />
<spark-ssr>
  files = SELECT * FROM files WHERE shared = 1 ORDER BY id
</spark-ssr>`);
  const warns = [];
  const ow = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  let s, html;
  try {
    s = await serve({ root, port: 0, quiet: true, watch: false });
    await s.db.query('DROP TABLE IF EXISTS files');
    await s.db.query('CREATE TABLE files (id INTEGER PRIMARY KEY, name TEXT, shared INTEGER)');
    await s.db.query("INSERT INTO files (name, shared) VALUES ('private.txt', 0), ('shared.txt', 1)");
    html = await (await fetch('http://localhost:' + s.port + '/')).text();
  } finally { console.warn = ow; }
  assert.ok(html.includes('shared.txt'), 'declared (filtered) source feeds {files}');
  assert.ok(!html.includes('private.txt'), 'auto table source no longer steals the declared name — got: ' + html.slice(0, 300));
  assert.ok(warns.some((w) => w.includes('files') && w.includes('table="files"')),
    'the shadowing is loud and names both origins — warns: ' + JSON.stringify(warns));
});

// ── API-only mode (improve-spark-ssr) ──────────────────────────────────────
await test('api mode: branded index at / (hero HTML + JSON) when no page owns /', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-api-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:', api: true }));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'notes.html'), `<h1>{n}</h1>\n<spark-ssr table="notes" />`);
  const s = await serve({ root, port: 0, quiet: true, watch: false });
  try {
    const jr = await fetch(`http://localhost:${s.port}/`, { headers: { accept: 'application/json' } });
    assert.equal((await jr.json()).powered_by, 'spark-ssr', 'JSON index identifies the service');
    const hr = await fetch(`http://localhost:${s.port}/`, { headers: { accept: 'text/html' } });
    const html = await hr.text();
    assert.ok(html.includes('Powered by spark-ssr') && html.includes('fast API'), 'browser gets the hero');
    // health check is generated.
    assert.equal((await (await fetch(`http://localhost:${s.port}/api/health`)).json()).ok, true, 'health ok');
  } finally { await s.stop(true); }
});

await test('api mode: a named page path serves its data as JSON (no HTML)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-api2-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:', api: true }));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'ping.html'), `<h1>{msg}</h1>\n<spark-ssr>\n  msg = SELECT 'pong' AS v\n</spark-ssr>`);
  const s = await serve({ root, port: 0, quiet: true, watch: false });
  try {
    const r = await fetch(`http://localhost:${s.port}/ping`);
    const body = await r.text();
    assert.ok(!body.includes('<h1>'), 'HTML is withheld in api mode — got: ' + body.slice(0, 120));
    const j = JSON.parse(body);
    assert.equal(j.msg[0].v, 'pong', 'the page data is the JSON response');
  } finally { await s.stop(true); }
});

await test('api mode: per-page `render` opts one page back into HTML', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-api3-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:', api: true }));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'admin.html'), `<h1>Admin</h1>\n<spark-ssr render />`);
  const s = await serve({ root, port: 0, quiet: true, watch: false });
  try {
    const body = await (await fetch(`http://localhost:${s.port}/admin`)).text();
    assert.ok(body.includes('<h1>Admin</h1>'), 'render= restores HTML — got: ' + body.slice(0, 120));
  } finally { await s.stop(true); }
});

await test('non-conflict: with no api/rate attrs, pages render exactly as before', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-noconf-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  writeFileSync(join(root, 'index.html'), `<h1>Hello</h1>\n<spark-ssr table="notes" />`);
  const s = await serve({ root, port: 0, quiet: true, watch: false });
  try {
    const body = await (await fetch(`http://localhost:${s.port}/`)).text();
    assert.ok(body.includes('<h1>Hello</h1>'), 'HTML still renders when no api signal is present');
    // The /api/notes CRUD surface is still inferred (unchanged behavior).
    const r = await fetch(`http://localhost:${s.port}/api/notes`);
    assert.equal(r.status, 200, 'auto-CRUD endpoint unchanged');
  } finally { await s.stop(true); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
