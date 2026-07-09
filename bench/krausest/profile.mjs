// CPU attribution profiler (spark-speed-up-max.md §4-F0). Run with: bun profile.mjs
//
// Serves the REPO ROOT (so /packages/spark/src is importable unminified —
// real function names), drives the krausest ops over CDP, samples with
// Profiler at 100µs, and buckets self-time per op into the plan's
// attribution categories. Run it on a QUIET machine, never concurrently
// with a webdriver-ts benchmark.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PORT = 8017;

// The page fetches components/app.html relative to itself — mirror the impl's.
mkdirSync(join(HERE, 'profile', 'components'), { recursive: true });
copyFileSync(join(HERE, 'impl', 'public', 'components', 'app.html'),
  join(HERE, 'profile', 'components', 'app.html'));

// ── static server: repo root, correct MIME via Bun.file ──
const server = Bun.serve({
  port: PORT,
  fetch(req) {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    return new Response(Bun.file(join(ROOT, p)));
  },
  error() { return new Response('nf', { status: 404 }); },
});

// ── chromium with CDP ──
const tmp = mkdtempSync('/tmp/spark-prof-');
const chrome = spawn('/snap/bin/chromium', [
  `--user-data-dir=${tmp}`, '--headless=new', '--no-sandbox', '--no-first-run',
  '--remote-debugging-port=9333', 'about:blank',
], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl;
for (let i = 0; i < 30 && !wsUrl; i++) {
  await wait(500);
  try {
    const pages = await (await fetch('http://127.0.0.1:9333/json')).json();
    wsUrl = pages.find((p) => p.type === 'page')?.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) { console.error('no CDP page'); process.exit(1); }

const ws = new WebSocket(wsUrl);
let id = 1; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const m = id++;
  pending.set(m, { res, rej });
  ws.send(JSON.stringify({ id: m, method, params }));
});
const opened = new Promise((r) => (ws.onopen = r));
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    console.error('PAGE EXCEPTION:', msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
  }
};
await opened;
await send('Runtime.enable');
await send('Page.enable');
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 100 });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/bench/krausest/profile/index.html` });

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};
for (let i = 0; i < 40; i++) {
  if (await evalJs(`!!document.querySelector('#run') && !!document.querySelector('#main .container')`)) break;
  await wait(250);
}
const click = (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)}).click()`);
const rowCount = () => evalJs(`document.querySelectorAll('#tbody tr').length`);

// ── attribution buckets: function name (exact) → bucket. Unminified src
// names are stable anchors; everything else falls through by URL. ──
const BUCKET = {
  cloneNode: 'clone', importNode: 'clone',
  stampTree: 'stamp', textTpl: 'stamp', kindOf: 'stamp', wireElement: 'stamp',
  insertClones: 'stamp', analyzeElement: 'stamp', cloneTemplateNodes: 'stamp',
  patchLive: 'evals', patchText: 'evals', patchElement: 'evals',
  runElementPlan: 'evals', interpolate: 'evals', runExpr: 'evals',
  parseTemplate: 'evals', evaluate: 'evals', buildFast: 'evals',
  withCapture: 'capture', withSink: 'capture', makeLoopScope: 'capture', record: 'capture',
  patchEach: 'scan', lisMembers: 'scan', setsIntersect: 'scan', shouldEval: 'scan',
  blockEnd: 'scan', anchorOwnedNodes: 'scan',
  placeWithRendered: 'moves', after: 'moves', remove: 'moves',
  insertBefore: 'moves', appendChild: 'moves', removeChild: 'moves',
  addEventListener: 'listeners', removeEventListener: 'listeners',
  walkNode: 'walk', walkBlock: 'walk', patch: 'walk',
  reactify: 'reactivity', flush: 'reactivity', schedule: 'reactivity',
  runReactive: 'reactivity', enterNode: 'lifecycle', leaveNode: 'lifecycle',
  '(garbage collector)': 'GC', '(program)': 'program', '(idle)': 'idle',
};
const bucketOf = (cf) => {
  const b = BUCKET[cf.functionName];
  if (b) return b;
  if (cf.url.includes('/packages/spark/src/')) {
    // proxy traps + small closures inside src modules
    if (cf.url.includes('reactivity.js') || cf.url.includes('component.js')) return 'reactivity';
    return 'spark-other';
  }
  if (cf.url.includes('components/app')) return 'app';
  if (!cf.url) return 'native-other';
  return 'other';
};

async function profileOp(name, action) {
  await send('Profiler.start');
  await action();
  await wait(name.startsWith('create 10k') ? 1500 : 400); // flush + paint settle
  const { profile } = await send('Profiler.stop');
  const self = new Map(); // nodeId → µs (exact: sum of timeDeltas per sample)
  for (let i = 0; i < profile.samples.length; i++) {
    const n = profile.samples[i], d = profile.timeDeltas[i];
    self.set(n, (self.get(n) || 0) + d);
  }
  const byBucket = new Map();
  let scripted = 0;
  for (const node of profile.nodes) {
    const us = self.get(node.id) || 0;
    if (!us) continue;
    const b = bucketOf(node.callFrame);
    byBucket.set(b, (byBucket.get(b) || 0) + us);
    if (b !== 'idle' && b !== 'program') scripted += us;
  }
  const rows = [...byBucket].filter(([b]) => b !== 'idle' && b !== 'program')
    .sort((a, z) => z[1] - a[1]);
  console.log(`\n== ${name} — scripted ${(scripted / 1000).toFixed(1)} ms ==`);
  for (const [b, us] of rows) {
    console.log(`  ${b.padEnd(12)} ${(us / 1000).toFixed(2).padStart(8)} ms  ${((us / scripted) * 100).toFixed(1).padStart(5)}%`);
  }
}

// ── the ops (repeat tiny ops inside one window for signal) ──
await profileOp('create 1k', () => click('#run'));
if ((await rowCount()) !== 1000) console.error('create1k: row count wrong');
await profileOp('select ×30', async () => {
  for (let i = 0; i < 30; i++) { await click(`#tbody tr:nth-child(${100 + (i % 2) * 300}) td.col-md-4 a`); await wait(30); }
});
await profileOp('swap ×30', async () => {
  for (let i = 0; i < 30; i++) { await click('#swaprows'); await wait(30); }
});
await profileOp('update 10th ×10', async () => {
  for (let i = 0; i < 10; i++) { await click('#update'); await wait(40); }
});
await click('#clear'); await wait(300);
await profileOp('create 10k', () => click('#runlots'));
if ((await rowCount()) !== 10000) console.error('create10k: row count wrong');

ws.close(); chrome.kill(); server.stop(); rmSync(tmp, { recursive: true, force: true });
process.exit(0);
