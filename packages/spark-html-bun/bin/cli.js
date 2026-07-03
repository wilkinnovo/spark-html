#!/usr/bin/env bun
/**
 * spark — dev / build / preview for spark-html apps, on Bun.
 *
 *   spark dev      [--port 3000] [--base /]
 *   spark build    [--base /repo/]
 *   spark preview  [--port 4173] [--strict-port]
 */
import { dev, build, preview } from '../src/index.js';

const [cmd, ...rest] = process.argv.slice(2);

function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') out.port = Number(args[++i]);
    else if (args[i] === '--base') out.base = args[++i];
    else if (args[i] === '--strict-port') out.strictPort = true;
    else if (args[i] === '--out-dir') out.outDir = args[++i];
  }
  return out;
}

const opts = flags(rest);

try {
  if (cmd === 'dev') await dev(opts);
  else if (cmd === 'build') { await build(opts); process.exit(0); }
  else if (cmd === 'preview') await preview(opts);
  else {
    console.log('spark <dev|build|preview> [--port N] [--base /path/] [--out-dir dist]');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`[spark] ${e.message}`);
  process.exit(1);
}
