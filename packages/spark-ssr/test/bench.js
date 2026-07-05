/**
 * spark-ssr — performance & memory bench (§0 of ssr-improvements.md).
 * Not part of `bun test`; run it by hand around any render-path change:
 *
 *   bun test/bench.js               # full run
 *   bun test/bench.js --micro       # renderFragment microbench only
 *   bun test/bench.js --http        # HTTP bench only
 *
 * Reports p50/p99 latency and RSS before/after each stage (and after a
 * forced Bun.gc), so "faster" is a number, not a feeling.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { serve } from '../src/index.js';
import { renderFragment } from '../src/render.js';

const args = new Set(process.argv.slice(2));
const RUN_MICRO = !args.has('--http');
const RUN_HTTP = !args.has('--micro');

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
const rss = () => process.memoryUsage().rss;
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

function report(label, samplesMs, before, after) {
  const s = [...samplesMs].sort((a, b) => a - b);
  const total = s.reduce((a, b) => a + b, 0);
  Bun.gc(true);
  const settled = rss();
  console.log(
    `  ${label.padEnd(38)} p50 ${quantile(s, 0.5).toFixed(2).padStart(7)} ms` +
    `  p99 ${quantile(s, 0.99).toFixed(2).padStart(7)} ms` +
    `  ${(s.length / (total / 1000) * 0).toFixed(0) === '0' ? '' : ''}rss ${mb(before)} → ${mb(after)} (gc ${mb(settled)})`,
  );
}

// ── microbench: renderFragment alone, no HTTP ─────────────────────────
async function micro() {
  console.log('\nrenderFragment(html, scope) — render cost isolated from I/O');
  const page = (n) => `
<h1>{title}</h1>
<template if="rows.length > 100"><p>big list</p></template>
<ul>
<template each="row, i in rows">
  <li class="row" :data-id="row.id" :class="row.done ? 'done' : ''">
    <span>{i}: {row.title}</span> <em>{row.body}</em>
  </li>
</template>
</ul>`;
  for (const n of [1, 100, 1000]) {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: i, title: 'Row ' + i, body: 'Body text for row ' + i, done: i % 3 === 0,
    }));
    const scope = { title: 'Bench', rows };
    const html = page(n);
    // Warm caches (compiled expressions, template program) before timing.
    for (let i = 0; i < 3; i++) await renderFragment(html, scope);
    const iters = n >= 1000 ? 50 : n >= 100 ? 300 : 2000;
    Bun.gc(true);
    const before = rss();
    const samples = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      await renderFragment(html, scope);
      samples.push(performance.now() - t0);
    }
    report(`${String(n).padStart(4)} rows × ${iters} renders`, samples, before, rss());
  }
}

// ── HTTP bench: a real project through Bun.serve's fetch ──────────────
function makeBenchApp() {
  const root = mkdtempSync(join(tmpdir(), 'spark-ssr-bench-'));
  writeFileSync(join(root, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }));
  // 1. The doc's todo app — small interactive page (hydrates).
  writeFileSync(join(root, 'index.html'), `<h1>Tasks</h1>
<template await="todos">
  <input bind:value="draft" placeholder="New task">
  <button onclick={add}>Add</button>
  <ul>
  <template each="todo in todos">
    <li><input type="checkbox" bind:checked="todo.done" onchange={patch}> {todo.title}
      <button onclick={remove}>✕</button></li>
  </template>
  </ul>
</template>
<spark-ssr table="todos" />`);
  // 2. A 1,000-row list page — the allocation-churn worst case.
  writeFileSync(join(root, 'big.html'), `<h1>Big list</h1>
<table><tbody>
<template each="item, i in items">
  <tr :data-id="item.id"><td>{i}</td><td>{item.title}</td><td>{item.body}</td>
    <td :class="item.done ? 'done' : ''">{item.done ? 'yes' : 'no'}</td></tr>
</template>
</tbody></table>
<spark-ssr>
  GET /api/items → items = SELECT * FROM items
</spark-ssr>`);
  // 3. A markdown-glob page — the no-DB content story (§4/§8 of sources).
  mkdirSync(join(root, 'content', 'posts'), { recursive: true });
  for (let i = 0; i < 40; i++) {
    writeFileSync(join(root, 'content', 'posts', `post-${String(i).padStart(2, '0')}.md`),
      `---\ntitle: Post ${i}\ndate: 2026-0${(i % 9) + 1}-01\n---\nBody of post ${i}. `.repeat(1) + 'Lorem ipsum dolor sit amet. '.repeat(20));
  }
  writeFileSync(join(root, 'blog.html'), `<h1>Blog</h1>
<template each="post in posts">
  <article><h2>{post.title}</h2><time>{post.date}</time><p>{post.body}</p></article>
</template>
<spark-ssr>
  posts = ./content/posts/*.md
</spark-ssr>`);
  return root;
}

async function httpBench() {
  console.log('\nHTTP — concurrent requests through Bun.serve fetch (watch:false, like production)');
  const root = makeBenchApp();
  const s = await serve({ root, port: 0, quiet: true, watch: false });
  const base = `http://localhost:${s.port}`;
  // Seed: todos small, items big.
  await s.db.query("INSERT INTO todos (title, done) VALUES ('Buy milk', 0), ('Walk dog', 1)");
  await s.db.query('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, title TEXT, body TEXT, done INTEGER)');
  for (let i = 0; i < 1000; i += 100) {
    const values = Array.from({ length: 100 }, (_, j) =>
      `('Item ${i + j}', 'Body for item ${i + j}', ${(i + j) % 2})`).join(',');
    await s.db.query(`INSERT INTO items (title, body, done) VALUES ${values}`);
  }

  const CONCURRENCY = 32;
  async function stage(label, path, total) {
    // Warm.
    await (await fetch(base + path)).text();
    Bun.gc(true);
    const before = rss();
    const samples = [];
    let next = 0;
    async function worker() {
      while (next < total) {
        next++;
        const t0 = performance.now();
        const res = await fetch(base + path);
        await res.text();
        samples.push(performance.now() - t0);
        if (res.status !== 200) throw new Error(`${path} → ${res.status}`);
      }
    }
    const t0 = performance.now();
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const wall = performance.now() - t0;
    const after = rss();
    report(`${label} ×${total} (c=${CONCURRENCY})`, samples, before, after);
    return { wall, rps: total / (wall / 1000) };
  }

  const todo = await stage('GET /      (todo app)   ', '/', 2000);
  const big = await stage('GET /big   (1,000 rows) ', '/big', 300);
  const blog = await stage('GET /blog  (40 md files)', '/blog', 1000);
  console.log(`  throughput: todo ${todo.rps.toFixed(0)} req/s · big ${big.rps.toFixed(0)} req/s · blog ${blog.rps.toFixed(0)} req/s`);
  await s.stop(true);
}

console.log('spark-ssr bench — Bun ' + Bun.version);
if (RUN_MICRO) await micro();
if (RUN_HTTP) await httpBench();
console.log('');
