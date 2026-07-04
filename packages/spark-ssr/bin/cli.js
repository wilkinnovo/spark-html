#!/usr/bin/env bun
/**
 * spark-ssr CLI
 *
 *   bun spark-ssr                serve the current directory (default)
 *   bun spark-ssr --port 3000    pick a port
 *   bun spark-ssr db             show the inferred schema vs the live DB
 *   bun spark-ssr db push        create/alter tables to match the templates
 *   bun spark-ssr build          assemble dist/ (+ compiled binary)
 *   bun spark-ssr start          serve dist/ if built, else the project
 *
 * Options:
 *   --port <n>      Port (default 3000, or PORT env).
 *   --root <dir>    Project root (default cwd).
 *   --no-compile    build: skip the single-binary compile, copy only.
 *   --docker        build: also emit a Dockerfile next to the binary.
 *   --force         db push: drop columns the templates no longer name.
 *   -h, --help      Show this help.
 */
import { join, resolve } from 'node:path';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { serve, loadConfig, projectSchema } from '../src/index.js';
import { diffSchema, pushSchema, seedTables } from '../src/schema.js';

function parseArgs(argv) {
  const opts = { cmd: 'serve', compile: true, force: false, docker: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--no-compile') opts.compile = false;
    else if (a === '--docker') opts.docker = true;
    else if (a === '--force') opts.force = true;
    else if (a === 'build' || a === 'start' || a === 'serve' || a === 'db') opts.cmd = a;
    else if (a === 'push' && opts.cmd === 'db') opts.push = true;
    else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(2); }
  }
  return opts;
}

const HELP = `spark-ssr — zero-config SSR for spark-html on Bun

Usage:
  bun spark-ssr [serve] [--port <n>] [--root <dir>]
  bun spark-ssr db [push] [--force]
  bun spark-ssr build [--no-compile] [--docker]
  bun spark-ssr start
`;

// The project files a deployment needs — pages, components, api, seeds,
// content, modules, public, error pages, middleware, config.
// node_modules/dist/uploads stay behind. public/ is FLATTENED into dist
// root: assets keep the same URLs they had in dev (/style.css, /img/…), and
// post-build passes (spark-html-image) resolve root-absolute <img> paths
// against dist directly.
const SHIP_DIRS = ['pages', 'components', 'api', 'seed', 'content', 'lib'];
const SHIP_FILES = ['404.html', '500.html', 'middleware.html', 'spark.json', 'package.json'];

async function build(root, { compile, docker }) {
  const dist = join(root, 'dist');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  for (const d of SHIP_DIRS) {
    if (existsSync(join(root, d))) cpSync(join(root, d), join(dist, d), { recursive: true });
  }
  if (existsSync(join(root, 'public'))) {
    for (const f of readdirSync(join(root, 'public'))) {
      cpSync(join(root, 'public', f), join(dist, f), { recursive: true });
    }
  }
  for (const f of SHIP_FILES) {
    if (existsSync(join(root, f))) cpSync(join(root, f), join(dist, f));
  }
  // Zero-config single-file projects keep their root pages/assets.
  if (!existsSync(join(root, 'pages'))) {
    for (const f of readdirSync(root)) {
      if (f === 'dist' || f === 'node_modules' || f.startsWith('.')) continue;
      const full = join(root, f);
      if (statSync(full).isFile() && /\.(html|css|js|json|png|jpg|svg|ico|webp|md)$/.test(f)
        && !SHIP_FILES.includes(f)) {
        cpSync(full, join(dist, f));
      }
    }
  }
  writeFileSync(join(dist, '__server.js'),
    "import { serve } from 'spark-ssr';\n" +
    'serve({ root: process.cwd(), port: Number(process.env.PORT) || 3000, watch: false });\n');
  console.log(`✓ assembled dist/`);
  // spark-html-image, when the app depends on it: the same pass a
  // spark-html-bun pipeline runs — webp variants + srcset for every local
  // <img> in the assembled pages and components. Options: spark.json "images".
  try {
    const image = (await import('spark-html-image')).default;
    await image(loadConfig(root).images || {}).run({ outDir: dist });
    console.log('✓ images optimized (spark-html-image)');
  } catch { /* not installed — plain assets ship as-is */ }
  if (compile) {
    const r = Bun.spawnSync(
      ['bun', 'build', '--compile', join(dist, '__server.js'), '--outfile', join(dist, 'app')],
      { cwd: root, stdout: 'inherit', stderr: 'inherit' },
    );
    if (r.exitCode !== 0) process.exit(r.exitCode);
    console.log('✓ compiled dist/app — run it from dist/ (reads pages/ next to it)');
  }
  if (docker) {
    // The deploy story: copy, run. The compiled binary needs only libc.
    writeFileSync(join(dist, 'Dockerfile'), compile
      ? 'FROM debian:stable-slim\nCOPY . /app\nWORKDIR /app\nEXPOSE 3000\nCMD ["/app/app"]\n'
      : 'FROM oven/bun:1\nCOPY . /app\nWORKDIR /app\nRUN bun install --production\nEXPOSE 3000\nCMD ["bun", "__server.js"]\n');
    console.log('✓ wrote dist/Dockerfile');
  }
}

// The template is the schema (§7): show the diff, or make it so.
async function dbCmd(root, { push, force }) {
  const { db, config, schema } = await projectSchema(root);
  if (!db) {
    console.error('No "db" configured in spark.json.');
    process.exit(1);
  }
  const names = Object.keys(schema);
  if (!names.length) {
    console.log('No tables declared — add <spark-ssr table="…"> to a page.');
    await db.close();
    return;
  }
  if (push) {
    await pushSchema(db, schema, { force, log: (m) => console.log(`✓ ${m}`) });
    await seedTables(db, schema, config, root, (m) => console.log(`✓ ${m}`));
    console.log('✓ database matches the templates');
  } else {
    const diff = await diffSchema(db, schema);
    for (const t of names) {
      const spec = schema[t];
      const cols = ['id', ...(spec.scoped ? ['user_id'] : []), ...Object.keys(spec.columns), 'created_at'];
      console.log(`${t}: ${cols.join(', ')}${spec.seed ? `  (seed: ${spec.seed})` : ''}`);
    }
    if (!diff.length) {
      console.log('\n✓ live database already matches');
    } else {
      console.log('');
      for (const d of diff) {
        if (d.create) console.log(`will create ${d.table}`);
        for (const c of d.add) console.log(`will add ${d.table}.${c.name} ${c.type}`);
        for (const c of d.extra) console.log(`extra column ${d.table}.${c} (kept; --force drops)`);
      }
      console.log('\nrun `bun spark-ssr db push` to apply');
    }
  }
  await db.close();
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { process.stdout.write(HELP); process.exit(0); }

const root = resolve(opts.root || process.cwd());
const port = opts.port ?? (Number(process.env.PORT) || 3000);

if (opts.cmd === 'build') {
  await build(root, opts);
} else if (opts.cmd === 'db') {
  await dbCmd(root, opts);
} else if (opts.cmd === 'start') {
  const dist = join(root, 'dist');
  await serve({ root: existsSync(join(dist, '__server.js')) ? dist : root, port, watch: false });
} else {
  await serve({ root, port });
}
