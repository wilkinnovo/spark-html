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

import { serve, rewriteParams, analyze, extractBlocks, dataPlan, singleShaped } from '../src/index.js';

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
  assert.deepEqual(a.rowBinds, [{ loopVar: 'todo', field: 'done' }]);
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
await todoServer.db.query('CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, done INTEGER DEFAULT 0)');
await todoServer.db.query("INSERT INTO todos (title) VALUES ('Buy milk'), ('Walk dog')");

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
  assert.ok(html.includes('"spark-html":"/@modules/spark-html"'), 'importmap');
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

await todoServer.stop(true);

// ── pages/, params, components, middleware, api/, auth, uploads ────────
function makeSiteApp() {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-site-'));
  process.env.SPARK_TEST_SECRET = 'squirrel';
  writeFileSync(join(root, 'spark.json'), JSON.stringify({
    db: 'sqlite::memory:',
    auth: { table: 'users', identity: 'email', secret: 'ENV.SPARK_TEST_SECRET' },
    cors: true,
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

const siteRoot = makeSiteApp();
const site = await serve({ root: siteRoot, port: 0, quiet: true });
const S = `http://localhost:${site.port}`;
await site.db.query('CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, title TEXT, views INTEGER DEFAULT 0)');
await site.db.query("INSERT INTO posts (slug, title, views) VALUES ('hello', 'Hello World', 500), ('quiet', 'Quiet Post', 3)");
await site.db.query('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, password TEXT)');
await site.db.query('CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, text TEXT)');
await site.db.query('CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, url TEXT)');

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
  assert.ok(!/<script>[\s\S]*let count/.test(html.split('importmap')[0]), 'component script never in the SSR body');

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

await site.stop(true);

// ── CLI: build assembles a deployable dist/ ─────────────────────────────
await test('cli build --no-compile: dist/ carries pages, config, and a server entry', async () => {
  const root = makeTodoApp();
  const cli = join(import.meta.dir, '..', 'bin', 'cli.js');
  const r = Bun.spawnSync(['bun', cli, 'build', '--no-compile', '--root', root]);
  assert.equal(r.exitCode, 0, String(r.stderr));
  assert.ok(existsSync(join(root, 'dist', 'index.html')), 'page copied');
  assert.ok(existsSync(join(root, 'dist', 'spark.json')), 'config copied');
  const entry = readFileSync(join(root, 'dist', '__server.js'), 'utf8');
  assert.ok(entry.includes("from 'spark-ssr'"), 'server entry written');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
