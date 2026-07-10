// Heap receipt for speed-max-pro P4/P7: load the built spark impl, create
// 1k rows, GC, take a heap snapshot over CDP, and aggregate self-size by
// constructor. Run: node heap-snap.mjs [url] (server from run.sh on :8080).
// Requires chromium with --remote-debugging-port launched by this script.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:8080/frameworks/keyed/spark-html/dist/index.html';
const CHROME = process.env.CHROME || '/snap/bin/chromium';
const dir = mkdtempSync(join(tmpdir(), 'heap-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${dir}`, '--headless=new', '--disable-gpu',
  '--remote-debugging-port=9223', 'about:blank',
], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageWs() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9223/json')).json();
      const p = list.find((x) => x.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await wait(500);
  }
  throw new Error('no CDP page');
}

const ws = new (globalThis.WebSocket)(await pageWs());
let id = 1; const pending = new Map(); const chunks = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(m.params.chunk);
};
const send = (method, params = {}) => new Promise((r) => { const m = id++; pending.set(m, r); ws.send(JSON.stringify({ id: m, method, params })); });
await new Promise((r) => { ws.onopen = r; });

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: URL_ });
await wait(3500); // load + hydrate + idle warmup
const clicked = await send('Runtime.evaluate', { expression: `(document.querySelector('#run')||{}).click ? (document.querySelector('#run').click(), true) : false`, returnByValue: true });
if (!clicked.result?.result?.value) { console.error('no #run button — wrong page?'); process.exit(1); }
await wait(1500);
const rows = await send('Runtime.evaluate', { expression: `document.querySelectorAll('tbody tr').length`, returnByValue: true });
console.log('rows:', rows.result.result.value);
await send('HeapProfiler.enable');
await send('HeapProfiler.collectGarbage');
await wait(500);
await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
await wait(1500);
ws.close(); chrome.kill(); rmSync(dir, { recursive: true, force: true });

const snap = JSON.parse(chunks.join(''));
const { node_fields, node_types } = snap.snapshot.meta;
const F = node_fields.length;
const TYPE = node_fields.indexOf('type');
const NAME = node_fields.indexOf('name');
const SELF = node_fields.indexOf('self_size');
const types = node_types[TYPE];
const nodes = snap.nodes; const strings = snap.strings;
const agg = new Map();
let total = 0;
for (let i = 0; i < nodes.length; i += F) {
  const t = types[nodes[i + TYPE]];
  const sz = nodes[i + SELF];
  total += sz;
  let key = t;
  if (t === 'object' || t === 'closure' || t === 'native') key = `${t}:${strings[nodes[i + NAME]]}`;
  if (t === 'array' || t === 'string' || t === 'code' || t === 'hidden' || t === 'object shape') key = t;
  const e = agg.get(key) || { sz: 0, n: 0 };
  e.sz += sz; e.n += 1;
  agg.set(key, e);
}
console.log(`total self-size: ${(total / 1024).toFixed(0)} KB`);
const rowsOut = [...agg.entries()].sort((a, b) => b[1].sz - a[1].sz).slice(0, 22);
for (const [k, v] of rowsOut) console.log(`${(v.sz / 1024).toFixed(1).padStart(8)} KB  ${String(v.n).padStart(7)}×  ${k}`);
console.log('\n— JS-side only (no native:/system) —');
const js = [...agg.entries()].filter(([k]) => !k.startsWith('native:') && !k.includes('system'));
let jsTotal = 0; for (const [, v] of js) jsTotal += v.sz;
console.log(`JS self-size: ${(jsTotal / 1024).toFixed(0)} KB`);
for (const [k, v] of js.sort((a, b) => b[1].sz - a[1].sz).slice(0, 24)) console.log(`${(v.sz / 1024).toFixed(1).padStart(8)} KB  ${String(v.n).padStart(7)}×  ${k}`);
