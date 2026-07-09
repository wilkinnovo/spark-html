/**
 * Scaffold a create-spark-html-app template inside the monorepo (so local
 * packages are resolved via Bun workspaces), build it, and start a preview
 * server on the given port.  Keeps running until killed.
 *
 * Usage:
 *   bun scripts/serve-template-for-e2e.mjs <template-name> [port]
 *
 * template-name  one of: basic, ssr, ssr-nodb, prerender
 * port           default 5100
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function $async(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: 'inherit', ...opts });
    c.on('exit', (code) => code === 0 ? resolve() : reject(new Error(cmd + ' exited ' + code)));
    c.on('error', reject);
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TPL_DIRS = {
  basic:    join(ROOT, 'packages/create-spark-html-app/template'),
  ssr:      join(ROOT, 'packages/create-spark-html-app/template-ssr'),
  'ssr-nodb': join(ROOT, 'packages/create-spark-html-app/template-ssr-nodb'),
  prerender: join(ROOT, 'packages/create-spark-html-app/template-prerender'),
};

const TPL = process.argv[2];
const PORT = Number(process.argv[3]) || 5100;

if (!TPL || !TPL_DIRS[TPL]) {
  console.error('Usage: bun scripts/serve-template-for-e2e.mjs <template-name> [port]');
  console.error('template-name: ' + Object.keys(TPL_DIRS).join(', '));
  process.exit(1);
}

const src = TPL_DIRS[TPL];
if (!existsSync(src)) { console.error('Template dir not found: ' + src); process.exit(1); }

// 1. Copy to a temp dir inside the monorepo so workspace resolution works.
const tmp = mkdtempSync(join(ROOT, '/tmp-e2e-tpl-'));
cpSync(src, tmp, { recursive: true });

// 2. Rename _gitignore → .gitignore.
if (existsSync(join(tmp, '_gitignore'))) {
  cpSync(join(tmp, '_gitignore'), join(tmp, '.gitignore'));
  rmSync(join(tmp, '_gitignore'));
}

// 3. Rewrite spark-* dependency versions to file: paths at the workspace
//    sources. NOT '*': the tmp dir is not a workspace MEMBER, so bun
//    resolves '*' from the REGISTRY — the e2e looked like it exercised the
//    tree while actually exercising the published packages (found
//    2026-07-09; serve-relocation-fixture.mjs had the same gap).
const pkgPath = join(tmp, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
for (const depKey of ['dependencies', 'devDependencies']) {
  if (pkg[depKey]) {
    for (const key of Object.keys(pkg[depKey])) {
      if (!key.startsWith('spark-')) continue;
      const dir = join(ROOT, 'packages', key === 'spark-html' ? 'spark' : key);
      if (existsSync(dir)) pkg[depKey][key] = 'file:' + dir;
    }
  }
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`[template-e2e] Scaffolded ${TPL} at ${tmp}`);

// 4. Install dependencies.
await $async('bun', ['install', '--no-save'], { cwd: tmp });

// 5. Build (prerender template has its own build pipeline; SSR templates
//    serve directly; basic template uses the dev server instead of build \u2014
//    see the note by its preview/dev branch below).
if (TPL === 'prerender') {
  console.log('[template-e2e] Building\u2026');
  await $async('bun', ['run', 'build'], { cwd: tmp });
} else if (TPL === 'ssr' || TPL === 'ssr-nodb') {
  if (!existsSync(join(tmp, 'spark.json'))) {
    writeFileSync(join(tmp, 'spark.json'), JSON.stringify({ db: 'sqlite::memory:' }, null, 2) + '\n');
  } else if (TPL === 'ssr') {
    // The template's shipped spark.json deliberately has no auth.secret —
    // dev mode auto-generates an ephemeral one, and requiring a real secret
    // is a deploy-time step (see the template's own README "Deploy"
    // section), not a fresh-scaffold one. `spark-ssr start` runs in
    // production mode (watch:false) and fails hard without a secret by
    // design (M3.3) — set one here the same way a real deploy would.
    const sparkJsonPath = join(tmp, 'spark.json');
    const sparkJson = JSON.parse(readFileSync(sparkJsonPath, 'utf8'));
    sparkJson.auth.secret = 'ENV.SESSION_SECRET';
    writeFileSync(sparkJsonPath, JSON.stringify(sparkJson, null, 2) + '\n');
  }
}

// 6. Start server.  Server runs in the foreground; when the test kills this
//    script (SIGTERM), the server dies too.
console.log(`[template-e2e] Starting server on :${PORT}\u2026`);
let serverArgs;
if (TPL === 'ssr' || TPL === 'ssr-nodb') {
  serverArgs = ['x', 'spark-ssr', 'start', '--port', String(PORT)];
} else if (TPL === 'basic') {
  // Use the dev server (import-map based), not build+preview. `bun install`
  // here resolves spark-html-bun/spark-html from the registry/cache, NOT
  // this monorepo's local workspace source — so build+preview can only ever
  // smoke-test whatever's currently published, never an in-flight fix (the
  // CSS/JS asset-mapping bug fixed in this same rc is covered instead by
  // packages/spark-html-bun/test/bun.js, which imports the local source
  // directly). Dev mode sidesteps the build step entirely and stays green
  // regardless of what's on the registry.
  serverArgs = ['x', 'spark', 'dev', '--port', String(PORT)];
} else {
  // prerender — use preview after build.
  serverArgs = ['x', 'spark', 'preview', '--port', String(PORT), '--strict-port'];
}

// The ssr (blog) template configures auth, and `spark-ssr start` runs in
// production mode (watch:false) — it fails hard without a stable secret
// (by design, see M3.3). Real deploys set this in the environment; do the
// same here so the smoke test exercises the documented golden path.
const serverEnv = { ...process.env };
if (TPL === 'ssr') serverEnv.SESSION_SECRET = 'e2e-test-secret-not-for-production';

const server = spawn('bun', serverArgs, {
  cwd: tmp,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: serverEnv,
});

// Clean shutdown: kill the server, clean up the temp dir.
function shutdown() {
  server.kill('SIGTERM');
  // Give the server a moment to exit before removing the temp dir.
  setTimeout(() => rmSync(tmp, { recursive: true, force: true }), 500);
}
server.on('exit', (code) => {
  console.log(`[template-e2e] Server exited (code ${code})`);
});

// Forward termination signals to the server child.
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('SIGINT', () => { shutdown(); process.exit(0); });

// Keep this process alive until killed.
await new Promise(() => {});
