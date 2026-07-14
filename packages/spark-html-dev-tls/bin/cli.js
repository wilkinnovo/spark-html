#!/usr/bin/env bun
/**
 * spark-html-dev-tls — front your dev server with local HTTPS for device testing.
 *
 *   spark-html-dev-tls                    # auto-detect + wrap the dev server
 *   spark-html-dev-tls --port 3000        # HTTPS port (default 3000)
 *   spark-html-dev-tls --cert c --key k   # bring your own cert (e.g. mkcert)
 *   spark-html-dev-tls -- bun spark-ssr   # explicit dev command after `--`
 */
import { secure } from '../src/index.js';

const HELP = `spark-html-dev-tls — local HTTPS for spark-html dev servers (device testing)

Usage:
  spark-html-dev-tls [--port <n>] [--target-port <n>] [--cert <f> --key <f>] [-- <dev cmd…>]

Keep your normal \`dev\` script (plain HTTP). Add a \`secure\` script that wraps it:
  "scripts": { "dev": "bun spark-ssr", "secure": "bun spark-html-dev-tls" }

Options:
  --port         HTTPS port to serve (default 3000)
  --target-port  private HTTP port for the wrapped dev server (default port+1)
  --cert, --key  use your own certificate instead of a generated self-signed one
  --root         project directory (default cwd)
  --             everything after is the dev command to wrap (skips auto-detect)
`;

const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { opts.cmd = argv.slice(i + 1); break; }
  else if (a === '-h' || a === '--help') { process.stdout.write(HELP); process.exit(0); }
  else if (a === '--port') opts.port = Number(argv[++i]);
  else if (a === '--target-port') opts.targetPort = Number(argv[++i]);
  else if (a === '--cert') opts.cert = argv[++i];
  else if (a === '--key') opts.key = argv[++i];
  else if (a === '--root') opts.root = argv[++i];
  else { console.error(`Unknown option: ${a}`); process.exit(2); }
}

try {
  await secure(opts);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
