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

async function prompt(question, fallback) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer || fallback;
  } finally {
    rl.close();
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

  // 3 ─ copy the template ──────────────────────────────────────────────
  mkdirSync(targetDir, { recursive: true });
  cpSync(templateDir, targetDir, { recursive: true });

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

  // 4 ─ stamp the project name into package.json ───────────────────────
  const pkgPath = join(targetDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.name = projectName;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // 5 ─ celebrate + print next steps ───────────────────────────────────
  const rel = relative(process.cwd(), targetDir) || '.';
  stdout.write(`\n${c.green('✔')} Scaffolded ${c.bold(projectName)} in ${c.cyan(rel)}\n\n`);
  stdout.write(`${c.bold('Next steps:')}\n`);
  if (rel !== '.') stdout.write(`  ${c.dim('1.')} cd ${rel}\n`);
  stdout.write(`  ${c.dim(rel !== '.' ? '2.' : '1.')} npm install\n`);
  stdout.write(`  ${c.dim(rel !== '.' ? '3.' : '2.')} npm run dev\n\n`);
  stdout.write(`${BOLT} Then open the dev server and edit ${c.cyan('public/components/welcome.html')}.\n\n`);
}

main().catch((err) => bail(err?.message || String(err)));
