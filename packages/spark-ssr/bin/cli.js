#!/usr/bin/env bun
/**
 * spark-ssr CLI
 *
 *   bun spark-ssr                serve the current directory (default)
 *   bun spark-ssr --port 3000    pick a port
 *   bun spark-ssr build          assemble dist/ (+ compiled binary)
 *   bun spark-ssr start          serve dist/ if built, else the project
 *
 * Options:
 *   --port <n>      Port (default 3000, or PORT env).
 *   --root <dir>    Project root (default cwd).
 *   --no-compile    build: skip the single-binary compile, copy only.
 *   -h, --help      Show this help.
 */
import { join, resolve } from 'node:path';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { serve } from '../src/index.js';

function parseArgs(argv) {
  const opts = { cmd: 'serve', compile: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--no-compile') opts.compile = false;
    else if (a === 'build' || a === 'start' || a === 'serve') opts.cmd = a;
    else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(2); }
  }
  return opts;
}

const HELP = `spark-ssr — zero-config SSR for spark-html on Bun

Usage:
  bun spark-ssr [serve] [--port <n>] [--root <dir>]
  bun spark-ssr build [--no-compile]
  bun spark-ssr start
`;

// The project files a deployment needs — pages, components, api, public,
// error pages, middleware, config. node_modules/dist/uploads stay behind.
const SHIP_DIRS = ['pages', 'components', 'api', 'public'];
const SHIP_FILES = ['404.html', '500.html', 'middleware.html', 'spark.json', 'package.json'];

async function build(root, compile) {
  const dist = join(root, 'dist');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  for (const d of SHIP_DIRS) {
    if (existsSync(join(root, d))) cpSync(join(root, d), join(dist, d), { recursive: true });
  }
  for (const f of SHIP_FILES) {
    if (existsSync(join(root, f))) cpSync(join(root, f), join(dist, f));
  }
  // Zero-config single-file projects keep their root pages/assets.
  if (!existsSync(join(root, 'pages'))) {
    for (const f of readdirSync(root)) {
      if (f === 'dist' || f === 'node_modules' || f.startsWith('.')) continue;
      const full = join(root, f);
      if (statSync(full).isFile() && /\.(html|css|js|json|png|jpg|svg|ico|webp)$/.test(f)
        && !SHIP_FILES.includes(f)) {
        cpSync(full, join(dist, f));
      }
    }
  }
  writeFileSync(join(dist, '__server.js'),
    "import { serve } from 'spark-ssr';\n" +
    'serve({ root: process.cwd(), port: Number(process.env.PORT) || 3000 });\n');
  console.log(`✓ assembled dist/`);
  if (compile) {
    const r = Bun.spawnSync(
      ['bun', 'build', '--compile', join(dist, '__server.js'), '--outfile', join(dist, 'app')],
      { cwd: root, stdout: 'inherit', stderr: 'inherit' },
    );
    if (r.exitCode !== 0) process.exit(r.exitCode);
    console.log('✓ compiled dist/app — run it from dist/ (reads pages/ next to it)');
  }
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { process.stdout.write(HELP); process.exit(0); }

const root = resolve(opts.root || process.cwd());
const port = opts.port ?? (Number(process.env.PORT) || 3000);

if (opts.cmd === 'build') {
  await build(root, opts.compile);
} else if (opts.cmd === 'start') {
  const dist = join(root, 'dist');
  await serve({ root: existsSync(join(dist, '__server.js')) ? dist : root, port });
} else {
  await serve({ root, port });
}
