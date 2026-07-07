/**
 * Sessions + flash — HMAC-signed, cookie-carried, stateless.
 *
 * A session is `base64url(JSON payload) + '.' + HMAC-SHA256(data, secret)`
 * in an HttpOnly spark_session cookie; a flash is the same signature scheme
 * over a bare string in a read-once spark_flash cookie. Verification uses
 * timingSafeEqual and any malformed/forged value reads as null — never an
 * exception on the request path.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function signSession(payload, secret) {
  const data = b64(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(data).digest('base64url');
  return data + '.' + mac;
}

export function readSession(cookieHeader, secret) {
  const jar = {};
  for (const part of String(cookieHeader || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1);
  }
  const raw = jar.spark_session;
  if (!raw) return null;
  const [data, mac] = raw.split('.');
  if (!data || !mac) return null;
  const expect = createHmac('sha256', secret).update(data).digest('base64url');
  try {
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch { return null; }
}

export const SESSION_COOKIE = (value, clear = false) =>
  `spark_session=${clear ? '' : value}; Path=/; HttpOnly; SameSite=Lax${clear ? '; Max-Age=0' : ''}`;

// One-shot flash messages: a signed, read-once cookie. Set on a form's success
// 303 (flash="…") and exposed as ambient {flash} on the very next page, then
// cleared — the "Saved!" / "Signed out" toast every app needs, no state store.
export function signFlash(msg, secret) {
  const data = b64(String(msg));
  return data + '.' + createHmac('sha256', secret).update(data).digest('base64url');
}

export function readFlash(cookieHeader, secret) {
  const raw = String(cookieHeader || '').split(/;\s*/)
    .map((p) => p.split('=')).find((kv) => kv[0].trim() === 'spark_flash');
  if (!raw || !raw[1]) return null;
  const [data, mac] = raw[1].split('.');
  if (!data || !mac) return null;
  const expect = createHmac('sha256', secret).update(data).digest('base64url');
  try {
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch { return null; }
}

export const FLASH_COOKIE = (value, clear = false) =>
  `spark_flash=${clear ? '' : value}; Path=/; SameSite=Lax${clear ? '; Max-Age=0' : ''}`;

// Roles in one column: an is_admin (or role) column on the auth table
// unlocks guard="session.is_admin" and unscoped reads for admins.
export const isAdmin = (s) => !!s && (s.is_admin === 1 || s.is_admin === true || s.role === 'admin');
