// E3 evidence (speed-up-extended.md): render-pipeline trace of single ops,
// spark vs vanilla. Counts Layout/Paint/Commit/frame events and the wall span
// click→last commit, to test the "structural ops pay an extra frame" theory.
// Run: bun trace.mjs   (serves repo root + the jfb clone; quiet machine)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const JFB = process.env.JFB_DIR || join(process.env.HOME, '.cache/spark-bench/jfb');
const PORT = 8019;

mkdirSync(join(HERE, 'profile', 'components'), { recursive: true });
copyFileSync(join(HERE, 'impl', 'public', 'components', 'app.html'),
  join(HERE, 'profile', 'components', 'app.html'));

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    let p = decodeURIComponent(new URL(req.url).pathname);
    const root = p.startsWith('/jfb/') ? (p = p.slice(4), JFB) : ROOT;
    if (p.endsWith('/')) p += 'index.html';
    return new Response(Bun.file(join(root, p)));
  },
  error() { return new Response('nf', { status: 404 }); },
});

const tmp = mkdtempSync('/tmp/spark-trace-');
const chrome = spawn('/snap/bin/chromium', [
  `--user-data-dir=${tmp}`, '--headless=new', '--no-sandbox', '--no-first-run',
  '--remote-debugging-port=9334', 'about:blank',
], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl;
for (let i = 0; i < 30 && !wsUrl; i++) {
  await wait(500);
  try {
    const pages = await (await fetch('http://127.0.0.1:9334/json')).json();
    wsUrl = pages.find((p) => p.type === 'page')?.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) { console.error('no CDP page'); process.exit(1); }

const ws = new WebSocket(wsUrl);
let id = 1; const pending = new Map();
let traceEvents = [];
let traceDone;
const send = (method, params = {}) => new Promise((res, rej) => {
  const m = id++;
  pending.set(m, { res, rej });
  ws.send(JSON.stringify({ id: m, method, params }));
});
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
  }
  if (msg.method === 'Tracing.dataCollected') traceEvents.push(...msg.params.value);
  if (msg.method === 'Tracing.tracingComplete') traceDone?.();
};
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable');
await send('Page.enable');

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};
const click = (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)}).click()`);

const CATS = 'devtools.timeline,disabled-by-default-devtools.timeline.frame';

async function traceOp(name, action) {
  traceEvents = [];
  await send('Tracing.start', { categories: CATS, transferMode: 'ReportEvents' });
  await wait(150);
  const t0 = Date.now();
  await action();
  await wait(600); // settle: capture every trailing frame
  const done = new Promise((r) => (traceDone = r));
  await send('Tracing.end');
  await done;
  // bucket events after the click; count pipeline stages
  const counts = new Map(); const dur = new Map();
  let first = Infinity, lastCommit = 0, clickTs = Infinity;
  for (const e of traceEvents) {
    if (e.name === 'EventDispatch' && e.args?.data?.type === 'click') clickTs = Math.min(clickTs, e.ts);
  }
  for (const e of traceEvents) {
    if (!e.ts || e.ts < clickTs) continue;
    const n = e.name;
    if (!['Layout', 'UpdateLayoutTree', 'Paint', 'PrePaint', 'Commit', 'CompositeLayers', 'BeginMainThreadFrame', 'DrawFrame', 'FunctionCall', 'TimerFire', 'FireIdleCallback', 'FireAnimationFrame', 'HitTest', 'EventDispatch', 'RunMicrotasks'].includes(n)) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
    if (e.dur) dur.set(n, (dur.get(n) || 0) + e.dur);
    if (['Paint', 'Commit', 'Layout'].includes(n)) { first = Math.min(first, e.ts); lastCommit = Math.max(lastCommit, e.ts + (e.dur || 0)); }
  }
  const span = lastCommit > 0 ? ((lastCommit - clickTs) / 1000).toFixed(1) : '?';
  console.log(`\n== ${name} — click→lastCommit ${span} ms ==`);
  for (const [n, c] of [...counts].sort((a, z) => (dur.get(z[0]) || 0) - (dur.get(a[0]) || 0))) {
    console.log(`  ${n.padEnd(22)} ×${String(c).padStart(3)}  ${((dur.get(n) || 0) / 1000).toFixed(2).padStart(8)} ms`);
  }
}

async function drive(label, url, ready) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 40; i++) {
    if (await evalJs(ready).catch(() => 0)) break;
    await wait(250);
  }
  await click('#run'); await wait(800);
  const rows = await evalJs(`document.querySelectorAll('#tbody tr').length`);
  if (rows !== 1000) console.error(`${label}: rows=${rows}`);
  await traceOp(`${label} swap ×1`, () => click('#swaprows'));
  await traceOp(`${label} swap ×1 (2nd)`, () => click('#swaprows'));
  await traceOp(`${label} remove ×1`, () => click('#tbody tr:nth-child(5) td.col-md-1 a'));
  await traceOp(`${label} select ×1`, () => click('#tbody tr:nth-child(300) td.col-md-4 a'));
  await traceOp(`${label} update ×1`, () => click('#update'));
}

await drive('spark', `http://127.0.0.1:${PORT}/bench/krausest/profile/index.html`,
  `!!document.querySelector('#run') && !!document.querySelector('#main .container')`);
await drive('vanilla', `http://127.0.0.1:${PORT}/jfb/frameworks/keyed/vanillajs/index.html`,
  `!!document.querySelector('#run')`);

ws.close(); chrome.kill(); server.stop(); rmSync(tmp, { recursive: true, force: true });
process.exit(0);
