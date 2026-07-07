/**
 * Request plumbing: the req wrapper handed to every handler/script, body +
 * upload parsing, `:token` param injection, runSql (rewritten params + the
 * source-cache TTL path), the app-relative fetch(), and CORS headers.
 *
 * makeRequest(app) closes over the serve() context bag. app.uploadWebp is
 * assigned after the family-deps scan (before the server starts) and
 * app.ctx.port after Bun.serve binds — both read at call time.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { rewriteParams, sqlTables } from './parse.js';

const dig = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

export function makeRequest(app) {
  const { config, db, uploadsDir, sourceCache, ctx } = app;

  function wrapReq(request, url, params, session, server) {
    const headers = {};
    for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
    let bodyMemo = null;
    const req = {
      raw: request,
      method: request.method,
      url: url.href,
      path: url.pathname,
      params,
      query: Object.fromEntries(url.searchParams),
      headers,
      session,
      ip: server?.requestIP?.(request)?.address || headers['x-forwarded-for'] || '',
      json: () => request.json(),
      text: () => request.text(),
      formData: () => request.formData(),
      body() {
        if (!bodyMemo) bodyMemo = parseBody(request);
        return bodyMemo;
      },
    };
    return req;
  }

  async function parseBody(request) {
    const ct = request.headers.get('content-type') || '';
    try {
      if (ct.includes('application/json')) {
        const fields = await request.json();
        return { fields: fields && typeof fields === 'object' ? fields : {}, file: null };
      }
      if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
        const fd = await request.formData();
        const fields = {};
        let file = null;
        for (const [k, v] of fd.entries()) {
          if (v && typeof v === 'object' && typeof v.arrayBuffer === 'function') {
            const ext = ((v.name || '').match(/\.\w+$/) || [''])[0];
            const name = randomUUID() + ext;
            mkdirSync(uploadsDir, { recursive: true });
            await Bun.write(join(uploadsDir, name), v);
            file = { url: '/uploads/' + name, original: '/uploads/' + name, name: v.name || name, size: v.size, type: v.type };
            if (app.uploadWebp && /\.(png|jpe?g)$/i.test(name)) {
              try {
                const sharp = (await import('sharp')).default;
                const webpName = name.replace(/\.\w+$/, '.webp');
                await sharp(join(uploadsDir, name)).webp({ quality: 82 }).toFile(join(uploadsDir, webpName));
                file.url = '/uploads/' + webpName;
              } catch { /* sharp unavailable — original serves fine */ }
            }
            fields[k] = file.url;
          } else {
            fields[k] = v;
          }
        }
        return { fields, file };
      }
    } catch { /* malformed body → empty */ }
    return { fields: {}, file: null };
  }

  // ── param injection: resolve one :token from the request ──
  async function resolveToken(tok, req) {
    if (tok.startsWith('body.')) return dig((await req.body()).fields, tok.slice(5)) ?? null;
    if (tok.startsWith('session.')) return dig(req.session || {}, tok.slice(8)) ?? null;
    if (tok.startsWith('header.')) return req.headers[tok.slice(7).toLowerCase()] ?? null;
    if (tok.startsWith('file.')) return dig((await req.body()).file || {}, tok.slice(5)) ?? null;
    if (req.params[tok] !== undefined) return req.params[tok];
    if (req.query[tok] !== undefined) return req.query[tok];
    return null;
  }

  async function runSql(sqlText, req, ttl = 0) {
    const { sql, tokens } = rewriteParams(sqlText);
    const values = [];
    for (const t of tokens) values.push(await resolveToken(t, req));
    if (!ttl) return db.query(sql, values);
    const key = 'q|' + sql + '|' + JSON.stringify(values);
    const hit = sourceCache.get(key);
    if (hit) return hit.value;
    const rows = await db.query(sql, values);
    sourceCache.set(key, rows, ttl, sqlTables(sqlText));
    return rows;
  }

  // App-relative fetch: '/api/x' resolves against this server; plain-object
  // bodies become JSON; the caller's cookie rides along so scoping holds.
  function makeAppFetch(req) {
    return (input, init = {}) => {
      let url = String(input);
      if (url.startsWith('/')) url = `http://localhost:${ctx.port}${url}`;
      init = { ...init };
      const b = init.body;
      const isPlainObject = b && typeof b === 'object'
        && !(b instanceof FormData) && !(b instanceof URLSearchParams)
        && !(b instanceof ArrayBuffer) && typeof b.arrayBuffer !== 'function'
        && typeof b.getReader !== 'function';
      if (isPlainObject) {
        init.body = JSON.stringify(b);
        init.headers = { 'content-type': 'application/json', ...(init.headers || {}) };
      }
      if (req && req.headers.cookie) init.headers = { cookie: req.headers.cookie, ...(init.headers || {}) };
      return fetch(url, init);
    };
  }

  // ── CORS ──
  function corsHeaders(origin) {
    if (!config.cors) return null;
    const allowed = config.cors === true ? '*'
      : Array.isArray(config.cors) && origin && config.cors.includes(origin) ? origin : null;
    if (!allowed) return null;
    return {
      'access-control-allow-origin': allowed,
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      ...(allowed !== '*' ? { vary: 'origin' } : {}),
    };
  }

  return { wrapReq, parseBody, resolveToken, runSql, makeAppFetch, corsHeaders };
}
