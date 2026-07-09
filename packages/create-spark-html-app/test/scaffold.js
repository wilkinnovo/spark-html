// Regression for post-v1-bugs.md #1: when the registry lookup fails (offline,
// registry down), the scaffolder must stamp "^<major of the CLI>" instead of
// leaving the "latest" dist-tag placeholder forever.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'index.js');
const cliVersion = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
const cliMajor = cliVersion.split('.')[0];

const workdir = mkdtempSync(join(tmpdir(), 'spark-scaffold-'));
let failed = false;

try {
  const target = 'app';
  const res = spawnSync(process.execPath, [bin, target, '--client', '--minimal'], {
    cwd: workdir,
    env: {
      ...process.env,
      // Dead port: the registry lookup must fail fast (not hang), triggering the fallback.
      npm_config_registry: 'http://127.0.0.1:1',
    },
    encoding: 'utf8',
    timeout: 20000,
  });

  if (res.status !== 0) {
    console.error(res.stdout, res.stderr);
    throw new Error(`scaffold exited ${res.status}`);
  }

  const pkg = JSON.parse(readFileSync(join(workdir, target, 'package.json'), 'utf8'));
  const range = pkg.dependencies?.['spark-html'];
  const expected = `^${cliMajor}.0.0`;

  if (range !== expected) {
    throw new Error(`expected spark-html pinned to ${expected}, got ${range}`);
  }
  if (range === 'latest') {
    throw new Error('regression: "latest" placeholder survived a failed registry lookup');
  }

  console.log('ok - scaffold.js: offline fallback pins ^<cli major>, never "latest"');
} catch (err) {
  failed = true;
  console.error('not ok - scaffold.js:', err.message);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

if (failed) process.exit(1);
