#!/usr/bin/env node
/**
 * create-spark-html-app
 *
 *   npm create spark-html-app@latest my-app
 *   npx create-spark-html-app my-app
 *
 * Scaffolds a ready-to-run Vite + spark-html project with a live,
 * reactive "Welcome to Spark" screen. Zero runtime dependencies —
 * just Node built-ins, in keeping with Spark's no-build ethos.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, basename } from 'node:path';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const templateDir = resolve(here, '..', 'template');

// ── tiny ANSI palette (no chalk; one less thing to install) ───────────
const supportsColor = stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code) => (s) =>
  supportsColor ? `\x1b[${code}m${s}\x1b[0m` : String(s);
const c = {
  spark: paint('38;5;220'), // ⚡ gold
  accent: paint('38;5;141'), // spark purple
  dim: paint('2'),
  bold: paint('1'),
  green: paint('32'),
  red: paint('31'),
  cyan: paint('36'),
};

const BOLT = c.spark('⚡');

function bail(msg) {
  stdout.write(`\n${c.red('✘')} ${msg}\n\n`);
  exit(1);
}

// A valid, polite npm package name.
function sanitizeName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/^[._]+/, '')
    .replace(/[^a-z0-9-~]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isEmptyDir(dir) {
  if (!existsSync(dir)) return true;
  const entries = readdirSync(dir).filter((f) => f !== '.git');
  return entries.length === 0;
}

// Resolve the newest published version of a package from the npm registry,
// so a freshly scaffolded app always starts on the latest spark-html.
// Returns a caret range (e.g. "^0.13.2"), or null if the lookup fails
// (offline, registry down) — callers fall back to the template default.
async function latestRange(pkgName) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const registry = (process.env.npm_config_registry || 'https://registry.npmjs.org')
      .replace(/\/+$/, '');
    const res = await fetch(`${registry}/${pkgName}/latest`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const { version } = await res.json();
    return version ? `^${version}` : null;
  } catch {
    return null;
  }
}

async function prompt(question, fallback) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

// ── optional features ──────────────────────────────────────────────────
// The template ships with EVERYTHING wired; excluded features are stripped
// out of the copied files via `@spark:<name>` … `@spark:end` marker blocks
// (`@spark:!name` blocks are kept only when the feature is OFF).
const FEATURES = [
  { key: 'router', question: 'Include router (multi-page SPA)?', def: true, deps: ['spark-html-router'], files: ['public/components/about.html'] },
  { key: 'theme', question: 'Include theme (dark/light toggle)?', def: true, deps: ['spark-html-theme'], files: [] },
  { key: 'image', question: 'Include image optimization?', def: true, deps: ['spark-html-image'], files: ['public/components/demo-image.html', 'public/sample.jpg'] },
  { key: 'sri', question: 'Include SRI integrity checks?', def: true, deps: ['spark-html-sri'], files: [] },
  { key: 'pwa', question: 'Include PWA support (manifest + offline shell)?', def: false, deps: ['spark-html-manifest'], files: ['public/icon.png'] },
];

async function pickFeatures() {
  const flags = argv.slice(3);
  const on = {};
  for (const f of FEATURES) on[f.key] = f.def;
  if (flags.includes('--all')) for (const f of FEATURES) on[f.key] = true;
  if (flags.includes('--minimal')) for (const f of FEATURES) on[f.key] = false;
  for (const f of FEATURES) {
    if (flags.includes(`--${f.key}`)) on[f.key] = true;
    if (flags.includes(`--no-${f.key}`)) on[f.key] = false;
  }
  // Interactive only on a TTY, and only when no preset flag was given.
  const preset = flags.some((a) => /^--(yes|all|minimal|(no-)?(router|theme|image|sri|pwa))$/.test(a));
  if (stdin.isTTY && !preset) {
    for (const f of FEATURES) {
      const hint = f.def ? '(Y/n)' : '(y/N)';
      const a = (await prompt(`${c.accent('?')} ${f.question} ${c.dim(hint)} `, '')).toLowerCase();
      if (a) on[f.key] = /^y(es)?$/.test(a);
    }
  }
  return on;
}

// Remove `@spark:` marker blocks for excluded features (and the marker
// lines themselves for included ones) across every copied text file.
function stripMarkers(text, on) {
  const out = [];
  let skipDepth = 0;
  for (const line of text.split('\n')) {
    const open = line.match(/@spark:(!?)([a-z]+)\s*(-->)?\s*$/);
    if (open && open[2] !== 'end') {
      const keep = open[1] === '!' ? !on[open[2]] : !!on[open[2]];
      if (skipDepth || !keep) skipDepth++;
      continue; // marker lines never ship
    }
    if (/@spark:end/.test(line)) {
      if (skipDepth) skipDepth--;
      continue;
    }
    if (!skipDepth) out.push(line);
  }
  return out.join('\n');
}

function walkFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function applyFeatures(targetDir, on) {
  // 1 ─ strip marker blocks in every text file.
  for (const file of walkFiles(targetDir)) {
    if (!/\.(js|html|css)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (!text.includes('@spark:')) continue;
    writeFileSync(file, stripMarkers(text, on), 'utf8');
  }
  // 2 ─ delete files that belong to excluded features.
  for (const f of FEATURES) {
    if (on[f.key]) continue;
    for (const rel of f.files) rmSync(join(targetDir, rel), { force: true });
  }
}

async function main() {
  stdout.write(`\n${BOLT} ${c.bold('create-spark-html-app')}\n`);
  stdout.write(`${c.dim('   HTML that reacts — no compiler, no virtual DOM.')}\n\n`);

  // 1 ─ figure out the target directory ────────────────────────────────
  let targetArg = argv[2];
  if (!targetArg) {
    if (!stdin.isTTY) bail('Please pass a project name: create-spark-html-app <name>');
    targetArg = await prompt(
      `${c.accent('?')} Project name: ${c.dim('(my-spark-app)')} `,
      'my-spark-app',
    );
  }

  const targetDir = resolve(process.cwd(), targetArg);
  const projectName = sanitizeName(basename(targetDir)) || 'my-spark-app';

  // 2 ─ make sure we won't clobber anything ────────────────────────────
  if (!isEmptyDir(targetDir)) {
    if (!stdin.isTTY) bail(`Directory "${targetArg}" already exists and is not empty.`);
    const ok = await prompt(
      `${c.accent('?')} "${targetArg}" is not empty. Continue and overwrite files? ${c.dim('(y/N)')} `,
      'n',
    );
    if (!/^y(es)?$/i.test(ok)) bail('Aborted — nothing was written.');
  }

  // 3 ─ pick features, copy the template, strip what's excluded ────────
  const features = await pickFeatures();
  mkdirSync(targetDir, { recursive: true });
  cpSync(templateDir, targetDir, { recursive: true });
  applyFeatures(targetDir, features);

  // npm renames/strips dotfiles on publish, so the template ships them
  // with safe underscore prefixes. Restore the real names here.
  const dotfiles = [
    ['_gitignore', '.gitignore'],
    ['_npmrc', '.npmrc'],
  ];
  for (const [from, to] of dotfiles) {
    const src = join(targetDir, from);
    if (existsSync(src)) renameSync(src, join(targetDir, to));
  }

  // 4 ─ stamp the project name + pin the latest spark-html ─────────────
  const pkgPath = join(targetDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.name = projectName;
  // Drop dependencies that belong to excluded features.
  for (const f of FEATURES) {
    if (features[f.key]) continue;
    for (const dep of f.deps) {
      if (pkg.dependencies) delete pkg.dependencies[dep];
      if (pkg.devDependencies) delete pkg.devDependencies[dep];
    }
  }
  // PWA config carries the app's display name.
  if (features.pwa) {
    const vitePath = join(targetDir, 'vite.config.js');
    writeFileSync(vitePath, readFileSync(vitePath, 'utf8').replace("name: 'Spark App'", `name: '${projectName}'`), 'utf8');
  }
  // Always start on the newest published versions of the spark packages. If the
  // registry can't be reached (or a package isn't published yet), the template's
  // "latest" default still resolves on install.
  for (const group of ['dependencies', 'devDependencies']) {
    const deps = pkg[group];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (name !== 'spark-html' && !name.startsWith('spark-html-') && name !== 'spark-prerender') continue;
      const range = await latestRange(name);
      if (range) {
        deps[name] = range;
        stdout.write(`${c.dim(`   using ${name} ${range}`)}\n`);
      }
    }
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // 5 ─ celebrate + print next steps ───────────────────────────────────
  const rel = relative(process.cwd(), targetDir) || '.';
  const picked = FEATURES.filter((f) => features[f.key]).map((f) => f.key).join(', ') || 'core only';
  stdout.write(`\n${c.green('✔')} Scaffolded ${c.bold(projectName)} in ${c.cyan(rel)} ${c.dim(`(head, persist, prerender, devtools + ${picked})`)}\n\n`);
  stdout.write(`${c.bold('Next steps:')}\n`);
  if (rel !== '.') stdout.write(`  ${c.dim('1.')} cd ${rel}\n`);
  stdout.write(`  ${c.dim(rel !== '.' ? '2.' : '1.')} npm install\n`);
  stdout.write(`  ${c.dim(rel !== '.' ? '3.' : '2.')} npm run dev\n\n`);
  stdout.write(`${BOLT} Then open the dev server and edit ${c.cyan('public/components/hero.html')}.\n\n`);
}

main().catch((err) => bail(err?.message || String(err)));
