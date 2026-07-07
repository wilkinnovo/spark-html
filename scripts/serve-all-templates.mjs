/**
 * Scaffold, build, and serve all 4 create-spark-html-app templates on
 * dedicated ports.  Designed as a Playwright `webServer.command` — it
 * keeps running until Playwright kills it.
 *
 * Ports: basic=5100, prerender=5101, ssr=5102, ssr-nodb=5103
 *
 * The script exits only on error; Playwright sends SIGTERM when done.
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER = join(__dirname, 'serve-template-for-e2e.mjs');

const TEMPLATES = [
  { name: 'basic',    port: 5100 },
  { name: 'prerender', port: 5101 },
  { name: 'ssr',       port: 5102 },
  { name: 'ssr-nodb',  port: 5103 },
];

const children = [];
let allReady = false;

function startOne(tpl) {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [HELPER, tpl.name, String(tpl.port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    children.push(child);

    let ready = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(`[${tpl.name}] ${text}`);
      if (!ready && (text.includes('ready') || text.includes('preview') || text.includes('serving'))) {
        ready = true;
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!ready) reject(new Error(`${tpl.name} exited (${code}) before ready`));
    });
    child.on('error', reject);
  });
}

async function main() {
  console.log('[serve-all] Starting 4 template servers…');
  const results = await Promise.allSettled(TEMPLATES.map(startOne));
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    console.error('[serve-all] Some templates failed to start:');
    failed.forEach((r, i) => console.error(`  ${TEMPLATES[i].name}: ${r.reason}`));
    // Keep running even if some failed — tests will fail on those.
  } else {
    allReady = true;
    console.log('[serve-all] All 4 template servers ready');
  }
}

main().catch(err => {
  console.error('[serve-all] Fatal:', err);
  process.exit(1);
});

// Keep-alive — Playwright sends SIGTERM when tests finish.
process.on('SIGTERM', () => {
  for (const c of children) { try { c.kill('SIGTERM'); } catch {} }
});
process.on('SIGINT', () => {
  for (const c of children) { try { c.kill('SIGTERM'); } catch {} }
});
