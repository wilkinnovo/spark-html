/**
 * spark-ssr — the whole doc, exercised against real temp projects. Runs under
 * `bun` (Bun.serve / bun:sqlite are the product); the root `npm test` chain
 * invokes it through scripts/test-bun.mjs, which skips when bun is absent.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseHTML } from 'linkedom';

import {
  serve, rewriteParams, analyze, extractBlocks, dataPlan, singleShaped,
  extractForms, validateFields, parseFrontMatter, sqlTables,
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
  assert.ok(html.includes('"spark-html":"/@modules/spark-html/index.js"'), 'importmap');
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
  assert.ok(html.includes("let draft = ''"), 'local state');
  assert.ok(/async function add\(\)/.test(html), 'insert handler');
  assert.ok(html.includes('body.title = draft'), 'bind mapped to the text column');
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

await test('hydration e2e: the real runtime mounts the generated component and add() inserts', async () => {
  const pageHtml = await (await fetch(`${T}/`)).text();
  const { window, document } = parseHTML(pageHtml);
  try { if (document.readyState === 'loading') document.readyState = 'complete'; } catch { /* fine */ }

  let rafQueue = [];
  const pending = new Set();
  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); return p; };
  const awaits = [];
  const realFetch = globalThis.fetch; // the override must not call itself
  const globals = {
    window, document, Node: window.Node,
    requestAnimationFrame: (fn) => rafQueue.push(fn),
    __SPARK_PRERENDER__: true,
    __SPARK_AWAITS__: awaits,
    __SPARK_IMPORT__: async (spec) => {
      const text = await (await realFetch(T + spec)).text();
      return import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
    },
    fetch: (p, init) => track(realFetch(String(p).startsWith('/') ? T + p : p, init)),
  };
  const prev = {};
  for (const [k, v] of Object.entries(globals)) { prev[k] = globalThis[k]; globalThis[k] = v; }
  try {
    const spark = await import(import.meta.resolve('spark-html') + '?ssr=' + Math.random().toString(36).slice(2));
    await spark.mount(document.body);
    for (let i = 0; i < 20; i++) {
      const q = rafQueue; rafQueue = [];
      for (const fn of q) fn();
      if (pending.size) await Promise.all([...pending]);
      if (awaits.length) await Promise.allSettled(awaits.splice(0));
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(document.body.innerHTML.includes('Buy milk'), 'component rendered with init data');
    assert.equal((document.body.innerHTML.match(/placeholder="New task"/g) || []).length, 1,
      'exactly one live copy after hydration (no slot-projected duplicate)');
    const host = [...document.querySelectorAll('[name]')].find((h) => h.__sparkScope);
    assert.ok(host, 'component booted');
    const scope = host.__sparkScope;
    scope.draft = 'From hydration';
    await scope.add();
    const rows = await (await realFetch(`${T}/api/todos`)).json();
    assert.ok(rows.some((r) => r.title === 'From hydration'), 'add() POSTed through the generated handler');
    assert.equal(scope.todos.length, rows.length, '__refresh reassigned the list');
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  }
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

await test('auth table hygiene: no hashes over the wire, writes are own-account only', async () => {
  const cookie = globalThis.__sparkTestCookie;
  const rows = await (await fetch(`${S}/api/users`)).json();
  assert.ok(rows.length > 0 && rows.every((r) => !('password' in r)), 'GET strips password hashes');

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
  return root;
}

const layoutRoot = await makeLayoutApp();
const lay = await serve({ root: layoutRoot, port: 0, quiet: true });
const L = `http://localhost:${lay.port}`;
await lay.db.query('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)');
await lay.db.query("INSERT INTO authors (name) VALUES ('Ada')");
await lay.db.query('CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, title TEXT, published INTEGER DEFAULT 0)');
await lay.db.query("INSERT INTO posts (slug, title, published) VALUES ('one', 'Post One', 1), ('draft', 'Drafty', 0)");

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
  assert.ok(comp.includes('__refresh'), 'and refetches on a ping');

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

await sources.stop(true);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
