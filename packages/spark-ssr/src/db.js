/**
 * One tiny adapter per driver, no ORM. SQL arrives with `?` placeholders and
 * an ordered values array (the `:param` → `?` rewrite is quote-aware and
 * happens in parse.js). Bun ships both drivers — nothing to install.
 *
 *   sqlite://./dev.db   sqlite::memory:        → bun:sqlite
 *   postgres://…        postgresql://…         → Bun.SQL
 */

// Statements that produce rows (SELECT/WITH, or anything RETURNING) go
// through .all(); the rest through .run() so we still get change counts.
const yieldsRows = (sql) => /^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql);

// sqlite binds primitives only — flatten anything else.
const bindable = (v) =>
  v === undefined ? null
  : v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint' ? v
  : typeof v === 'boolean' ? (v ? 1 : 0)
  : JSON.stringify(v);

export async function connect(url, root) {
  if (!url) return null;

  if (url.startsWith('sqlite:')) {
    const { Database } = await import('bun:sqlite');
    const { isAbsolute, join } = await import('node:path');
    let path = url.slice('sqlite:'.length).replace(/^\/\//, '');
    if (path === '' || path === ':memory:') path = ':memory:';
    // A relative file lives in the PROJECT, not wherever the process started.
    else if (root && !isAbsolute(path)) path = join(root, path);
    const db = new Database(path, { create: true });
    return {
      kind: 'sqlite',
      async query(sql, values = []) {
        const vals = values.map(bindable);
        if (yieldsRows(sql)) return db.query(sql).all(...vals);
        const r = db.run(sql, vals);
        return Object.assign([], { changes: r.changes, lastInsertRowid: r.lastInsertRowid });
      },
      async columns(table) {
        if (!/^\w+$/.test(table)) return [];
        try {
          return db.query(`PRAGMA table_info(${table})`).all()
            .map((c) => ({ name: c.name, type: String(c.type || '').toUpperCase() }));
        } catch { return []; }
      },
      close() { db.close(); },
      raw: db,
    };
  }

  if (/^postgres(ql)?:/.test(url)) {
    const sql = new Bun.SQL(url);
    const positional = (q) => { let i = 0; return q.replace(/\?/g, () => `$${++i}`); };
    return {
      kind: 'postgres',
      async query(q, values = []) {
        return await sql.unsafe(positional(q), values.map(bindable));
      },
      async columns(table) {
        try {
          const rows = await sql.unsafe(
            'SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = $1',
            [table],
          );
          return rows.map((r) => ({ name: r.name, type: String(r.type || '').toUpperCase() }));
        } catch { return []; }
      },
      close() { return sql.close(); },
      raw: sql,
    };
  }

  throw new Error(`spark-ssr: unsupported db url "${url}" (sqlite:// or postgres:// expected)`);
}
