/**
 * Declarative side effects (Tier 3.8): mail() and background jobs.
 *
 * mail(msg) is ambient in page/api/middleware <script>s and jobs — sender is
 * a module, a webhook, or the dev logger, so it always resolves. A job is a
 * module (jobs/<name>.js) run on a schedule (every="1d") or after a matching
 * write (on="insert:orders"). fireEvent() is the single "a write went
 * through table X" fan-out: live/cache broadcast + hooked jobs.
 *
 * makeJobs(app) closes over the serve() context bag; app.broadcast and
 * app.makeAppFetch are late-bound (wired in serve() after the SSE channel
 * and request plumbing exist) and read at call time.
 */
import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sqlTables } from './parse.js';

export function makeJobs(app) {
  const { root, config, db, quiet, live } = app;

  // ── declarative mail ──
  // A msg is { to, subject, text, html, from } (or a bare string → text). The
  // sender is a module ("mail":"./lib/mail.js", default export (msg, ctx)), a
  // webhook ("mail":{ url, from, headers } → POST JSON), or a dev logger — so
  // mail() always resolves, wired or not (the zero-config default is "it logs").
  let mailSender = null;
  async function loadMailSender() {
    const m = config.mail;
    if (typeof m === 'string' && /\.(m?js|ts)$/i.test(m)) {
      const file = resolve(root, m.replace(/^\.\//, ''));
      if (!file.startsWith(root) || !existsSync(file)) return null;
      try {
        const mod = await import(pathToFileURL(file).href);
        return typeof mod.default === 'function' ? mod.default : null;
      } catch (e) { if (!quiet) console.warn(`[spark-ssr] "mail" module ${m} — ${e.message}`); return null; }
    }
    if (m && typeof m === 'object' && m.url) {
      return async (msg) => {
        const res = await fetch(m.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(m.headers || {}) },
          body: JSON.stringify({ from: m.from, ...msg }),
        });
        if (!res.ok) throw new Error(`mail webhook ${res.status}`);
        return { ok: true };
      };
    }
    return null;
  }
  const mail = async (msg = {}) => {
    const message = typeof msg === 'string' ? { text: msg } : (msg || {});
    if (mailSender) return mailSender(message, { db });
    if (!quiet) console.log(`[spark-ssr] mail (no sender configured) → to=${message.to ?? '?'} subject=${message.subject ?? ''}`);
    return { ok: false, logged: true };
  };
  const initMail = async () => { mailSender = await loadMailSender(); };

  // ── declarative jobs ──
  // <spark-ssr job="digest" every="1d" /> schedules jobs/digest.js; job="onX"
  // on="insert:orders" runs it after every matching write. The job body is a
  // module the same shape as a data source — (req, db) — where `req` carries
  // the trigger (req.event, req.row) plus req.mail / req.fetch.
  const jobTimers = [];
  const jobs = new Set();          // job names whose schedule/hook is wired
  const eventHooks = new Map();    // "insert:orders" | "*:orders" → Set(jobName)
  function parseEvery(s) {
    const em = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
    if (!em) return 0;
    const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[(em[2] || 's').toLowerCase()];
    return Math.round(Number(em[1]) * mult);
  }
  function jobFile(name) {
    for (const rel of [`jobs/${name}.js`, `lib/jobs/${name}.js`]) {
      const f = resolve(root, rel);
      if (f.startsWith(root) && existsSync(f)) return f;
    }
    return null;
  }
  async function runJob(name, event, row) {
    const file = jobFile(name);
    if (!file) { if (!quiet) console.warn(`[spark-ssr] job "${name}" has no module (jobs/${name}.js)`); return; }
    try {
      const bust = live ? '?v=' + statSync(file).mtimeMs : '';
      const mod = await import(pathToFileURL(file).href + bust);
      if (typeof mod.default !== 'function') return;
      const req = {
        job: name, event, row: row || null,
        params: {}, query: {}, headers: {}, session: null,
        mail, fetch: app.makeAppFetch(null),
      };
      await mod.default(req, db);
    } catch (e) { if (!quiet) console.warn(`[spark-ssr] job "${name}" threw: ${e.message}`); }
  }
  function registerJob(b) {
    if (!b.job || jobs.has(b.job)) return;
    jobs.add(b.job);
    if (b.on) {
      const key = b.on.includes(':') ? b.on.toLowerCase() : '*:' + b.on.toLowerCase();
      (eventHooks.get(key) || eventHooks.set(key, new Set()).get(key)).add(b.job);
    }
    if (b.every) {
      const ms = parseEvery(b.every);
      if (ms) {
        const t = setInterval(() => { runJob(b.job, 'schedule', null); }, ms);
        t.unref?.();
        jobTimers.push(t);
      } else if (!quiet) {
        console.warn(`[spark-ssr] job "${b.job}" has an unparseable every="${b.every}"`);
      }
    }
  }
  // A write went through a table: refresh live/cache AND fire any job hooked to
  // that event. `app.broadcast` stays the pure live-channel primitive underneath.
  function fireEvent(event, table, row) {
    app.broadcast(table);
    const t = String(table).toLowerCase();
    for (const key of [event + ':' + t, '*:' + t]) {
      const set = eventHooks.get(key);
      if (set) for (const name of set) runJob(name, event + ':' + table, row);
    }
  }
  // insert/update/delete for a write statement; null for a read. Leading
  // comments are stripped first (a "-- note\nINSERT" is still an insert),
  // and a CTE-led statement (WITH … INSERT/UPDATE/DELETE) is classified by
  // the write keyword inside it — CTE writes are real writes.
  const writeEvent = (sql) => {
    const s = String(sql).replace(/^(?:\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/))+/, '');
    if (/^\s*insert/i.test(s)) return 'insert';
    if (/^\s*update/i.test(s)) return 'update';
    if (/^\s*delete/i.test(s)) return 'delete';
    if (/^\s*with\b/i.test(s)) {
      const m = /\b(insert|update|delete)\b/i.exec(s);
      return m ? m[1].toLowerCase() : null;
    }
    return /^\s*select\b/i.test(s) ? null : 'write';
  };
  const broadcastSql = (sql) => {
    const event = writeEvent(sql) || 'write';
    for (const t of sqlTables(sql)) fireEvent(event, t, null);
  };

  // Wrap the raw `db` handed to a custom api/ endpoint so its hand-written
  // writes still fan out to `live` tabs + cache invalidation + job hooks —
  // the same automation the generated /api/<table> CRUD route gets, which is
  // otherwise the ONLY path that pings /__spark/live (the San-App audit's #18). Reads
  // pass straight through. Broadcasts are COALESCED per request and flushed
  // once the handler returns: an N-row write loop pings each touched table
  // exactly once, never N back-to-back refresh storms across open tabs.
  const liveDb = (rawDb) => {
    const touched = new Map(); // table -> last write event, deduped per request
    return {
      ...rawDb,
      async query(sql, values) {
        const r = await rawDb.query(sql, values);
        const event = writeEvent(sql);
        if (event) for (const t of sqlTables(sql)) touched.set(t, event);
        return r;
      },
      flushLive() {
        for (const [t, event] of touched) fireEvent(event, t, null);
        touched.clear();
      },
    };
  };

  return { mail, initMail, registerJob, runJob, fireEvent, broadcastSql, liveDb, jobTimers };
}
