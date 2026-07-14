/**
 * A cached self-signed certificate for local HTTPS. The cert's SAN covers
 * `localhost`, `127.0.0.1`, and every LAN IPv4 on this machine, so a phone
 * opening `https://<lan-ip>:<port>` validates the host (after accepting the
 * self-signed warning once). openssl is a system tool — present on macOS and
 * Linux, and via Git-Bash / WSL on Windows — so this stays dependency-free.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';

/** Every non-internal IPv4 address on this host (the phone-reachable ones). */
export function lanIPs() {
  const ips = new Set();
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.add(ni.address);
    }
  }
  return [...ips];
}

/**
 * Ensure a dev cert exists in `dir`, reusing one under ~10 months old.
 * Returns { cert, key, reused }. Throws (naming the fix) if openssl is absent.
 */
export async function ensureCert({ dir, ips = lanIPs() } = {}) {
  mkdirSync(dir, { recursive: true });
  const cert = join(dir, 'dev.pem');
  const key = join(dir, 'dev.key');

  if (existsSync(cert) && existsSync(key)) {
    const ageDays = (Date.now() - statSync(cert).mtimeMs) / 86_400_000;
    if (ageDays < 300) return { cert, key, reused: true };
  }

  const san = 'subjectAltName=DNS:localhost,IP:127.0.0.1'
    + ips.map((ip) => ',IP:' + ip).join('');
  const r = Bun.spawnSync([
    'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '365',
    '-subj', '/CN=localhost', '-addext', san,
  ]);
  if (!r.success) {
    throw new Error(
      '[spark-html-dev-tls] could not generate a TLS certificate with openssl.\n'
      + '  Install openssl and retry, or bring your own: --cert <file> --key <file>.\n'
      + (r.stderr ? r.stderr.toString() : ''),
    );
  }
  return { cert, key, reused: false };
}
