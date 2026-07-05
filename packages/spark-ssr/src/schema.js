/**
 * The template is the schema (§7). The framework already knows `todo.title`
 * is text (it's interpolated), `todo.done` is boolean (a checkbox bind), and
 * `user_id` means scoping — so nobody writes setup.js.
 *
 *   bun spark-ssr db        show inferred schema vs live DB (a diff)
 *   bun spark-ssr db push   create/alter tables to match the templates
 *
 * serve() also runs the safe half automatically at startup: CREATE missing
 * tables and apply idempotent seeds, so `bun spark-ssr` works on a fresh
 * clone. Columns are never dropped without --force.
 *
 * Column sources, weakest to strongest:
 *   id / created_at                       always
 *   {todo.title} interpolations           TEXT
 *   bind:checked="todo.done"              INTEGER (boolean)
 *   <input name=… type=…> in a form       type-mapped
 *   seed file rows                        keys + value types
 *   user_id                               auth configured + the page reads session
 */
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { singular } from './parse.js';

const INPUT_TYPE = {
  checkbox: 'INTEGER', number: 'REAL', range: 'REAL',
  date: 'TEXT', time: 'TEXT', 'datetime-local': 'TEXT',
};
const valueType = (v) =>
  typeof v === 'boolean' ? 'INTEGER'
  : typeof v === 'number' ? (Number.isInteger(v) ? 'INTEGER' : 'REAL')
  : 'TEXT';

const RESERVED = new Set(['id', 'user_id', 'created_at']);

/**
 * Infer every declared table's columns from the parsed pages.
 * pagesData: [{ blocks, analysis, plan, forms }]; config: loaded spark.json.
 * Returns { table: { columns: { name: TYPE }, seed: path|null } }.
 */
export function inferSchema(pagesData, config, root) {
  const tables = {};
  const ensure = (name) => (tables[name] ||= { columns: {}, seed: null });
  const setCol = (t, col, type, force = false) => {
    if (RESERVED.has(col)) return;
    if (!/^[a-zA-Z_]\w*$/.test(col)) return;
    if (force || !t.columns[col]) t.columns[col] = type;
  };

  const authTable = config.auth && config.auth.table;

  for (const pd of pagesData) {
    // Which template vars map to which table on this page.
    const varTable = {};
    for (const p of pd.plan || []) {
      if (p.source.kind === 'table') varTable[p.var] = p.source.table;
    }
    const usesSession = pd.analysis && (pd.analysis.needs.has('session')
      || (pd.blocks || []).some((b) => b.guard));

    for (const b of pd.blocks || []) {
      if (!b.table) continue;
      const t = ensure(b.table);
      if (b.seed && !t.seed) t.seed = b.seed;
      if (config.auth && b.table !== authTable && usesSession) t.scoped = true;

      // {var.field} interpolations for vars fed by this table → TEXT.
      const a = pd.analysis;
      if (a) {
        const roots = [
          ...Object.entries(varTable).filter(([, tb]) => tb === b.table).map(([v]) => v),
        ];
        // Loop vars over those roots read fields too: each="todo in todos".
        for (const [lv, src] of a.loopSources || []) {
          if (roots.includes(src)) roots.push(lv);
        }
        for (const r of roots) {
          for (const f of a.memberFields.get(r) || []) setCol(t, f, 'TEXT');
        }
        // bind kinds are stronger: a checkbox bind is a boolean column.
        for (const rb of a.rowBinds || []) {
          if (roots.includes(rb.loopVar)) {
            setCol(t, rb.field, rb.kind === 'checked' ? 'INTEGER' : 'TEXT', rb.kind === 'checked');
          }
        }
      }
    }

  }

  // Relations (§): each="c in post.comments" declares a child table `comments`
  // with a `post_id` foreign key. The loop var's read fields ({c.body}) type
  // its columns — nested data with no JOIN written by hand.
  for (const pd of pagesData) {
    for (const r of (pd.analysis && pd.analysis.relations) || []) {
      const t = ensure(r.rel);
      const fk = singular(r.parent) + '_id';
      if (!t.columns[fk]) t.columns[fk] = 'INTEGER';
      for (const f of (pd.analysis.memberFields.get(r.loopVar) || [])) setCol(t, f, 'TEXT');
    }
  }

  // The auth table always exists once auth is configured: its identity
  // column and a password.
  if (authTable) {
    const t = ensure(authTable);
    setCol(t, config.auth.identity || 'email', 'TEXT');
    setCol(t, 'password', 'TEXT');
    delete t.scoped; // never scope the auth table to itself
  }

  // Forms posting to /api/<table>: the inputs name and type the columns —
  // but only for tables a block declared. A form to /api/logout (or any
  // custom endpoint) is not a table declaration. Second pass, so a form on
  // one page reaches a table declared on another.
  for (const pd of pagesData) {
    for (const form of pd.forms || []) {
      if (!form.table || !tables[form.table]) continue;
      const t = tables[form.table];
      for (const [name, rules] of Object.entries(form.fields)) {
        setCol(t, name, INPUT_TYPE[rules.type] || 'TEXT', rules.type in INPUT_TYPE);
      }
    }
  }

  // Seed rows are the strongest signal: real keys, real value types.
  for (const [name, t] of Object.entries(tables)) {
    if (!t.seed) continue;
    try {
      const file = resolve(root, t.seed.replace(/^\.\//, ''));
      if (!file.startsWith(root) || !existsSync(file)) continue;
      const rows = JSON.parse(readFileSync(file, 'utf8'));
      for (const row of Array.isArray(rows) ? rows.slice(0, 1) : []) {
        for (const [k, v] of Object.entries(row)) setCol(t, k, valueType(v), true);
      }
      if (Array.isArray(rows) && rows.some((r) => 'user_id' in r)) t.scoped = true;
    } catch { /* unreadable seed — diff will say so */ }
  }

  return tables;
}

const q = (name) => name; // identifiers come from templates the author wrote

function createSql(table, spec, kind, withScope) {
  const cols = [
    kind === 'postgres'
      ? 'id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY'
      : 'id INTEGER PRIMARY KEY AUTOINCREMENT',
  ];
  if (withScope) cols.push('user_id INTEGER');
  for (const [name, type] of Object.entries(spec.columns)) {
    cols.push(`${q(name)} ${type === 'REAL' && kind === 'postgres' ? 'DOUBLE PRECISION' : type}`);
  }
  cols.push('created_at TEXT DEFAULT CURRENT_TIMESTAMP');
  return `CREATE TABLE ${q(table)} (\n  ${cols.join(',\n  ')}\n)`;
}

// SQLite type affinity buckets — the coarse grain a retype actually matters
// at. INTEGER vs TEXT is a real change; "INT" vs "INTEGER" is not. Unknown /
// empty live types read as TEXT affinity (SQLite's own default).
function affinity(type) {
  const s = String(type || '').toUpperCase();
  if (/INT/.test(s)) return 'INTEGER';
  if (/REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(s)) return 'REAL';
  return 'TEXT';
}

// Reserved columns are framework-owned — never diffed as a retype.
const NEVER_RETYPE = new Set(['id', 'user_id', 'created_at']);

/**
 * Diff the inferred schema against the live database (Tier 3.7).
 * Additive changes (create, add) apply freely. Destructive ones — a column
 * the templates no longer name (`extra`) or one whose implied type changed
 * (`retype`) — are reported but need `db push --force`.
 * Returns [{ table, create?, add:[{name,type}], retype:[{name,from,to}], extra:[name] }].
 */
export async function diffSchema(db, schema) {
  const out = [];
  for (const [table, spec] of Object.entries(schema)) {
    const live = await db.columns(table);
    const withScope = !!spec.scoped;
    if (!live.length) {
      out.push({ table, create: createSql(table, spec, db.kind, withScope), add: [], retype: [], extra: [] });
      continue;
    }
    const liveTypes = new Map(live.map((c) => [c.name, c.type]));
    const liveNames = new Set(liveTypes.keys());
    const want = { ...(withScope ? { user_id: 'INTEGER' } : {}), ...spec.columns, created_at: 'TEXT' };
    const add = Object.entries(want)
      .filter(([n]) => !liveNames.has(n))
      .map(([name, type]) => ({ name, type }));
    const retype = Object.entries(want)
      .filter(([n]) => liveNames.has(n) && !NEVER_RETYPE.has(n)
        && affinity(liveTypes.get(n)) !== affinity(want[n]))
      .map(([name, to]) => ({ name, from: liveTypes.get(name) || '(none)', to }));
    const wantNames = new Set(['id', ...Object.keys(want)]);
    const extra = [...liveNames].filter((n) => !wantNames.has(n));
    if (add.length || retype.length || extra.length) out.push({ table, add, retype, extra });
  }
  return out;
}

// Destructive retype on SQLite: no ALTER COLUMN TYPE, so rebuild the table
// from the inferred spec and copy the surviving columns' data across (SQLite
// casts on INSERT … SELECT). This is a full reconcile — extras drop too, which
// is exactly what --force means. Ids and created_at carry over verbatim.
async function rebuildTable(db, table, spec) {
  const withScope = !!spec.scoped;
  const newCols = ['id', ...(withScope ? ['user_id'] : []), ...Object.keys(spec.columns), 'created_at'];
  const liveNames = new Set((await db.columns(table)).map((c) => c.name));
  const copy = newCols.filter((n) => liveNames.has(n));
  const tmp = `${table}__spark_rebuild`;
  await db.query(`ALTER TABLE ${q(table)} RENAME TO ${q(tmp)}`);
  await db.query(createSql(table, spec, db.kind, withScope));
  if (copy.length) {
    const cols = copy.map(q).join(', ');
    await db.query(`INSERT INTO ${q(table)} (${cols}) SELECT ${cols} FROM ${q(tmp)}`);
  }
  await db.query(`DROP TABLE ${q(tmp)}`);
}

/**
 * Apply the diff: CREATE missing tables, ADD missing columns. Extra columns
 * are only dropped with force (and never id/user_id).
 */
export async function pushSchema(db, schema, { force = false, createOnly = false, log = () => {} } = {}) {
  const diff = await diffSchema(db, schema);
  for (const d of diff) {
    if (d.create) {
      await db.query(d.create);
      log(`created table ${d.table}`);
      continue;
    }
    if (createOnly) continue;
    const retype = d.retype || [];
    // A forced retype on SQLite rebuilds the whole table (adds + retypes +
    // drops in one reconcile), so the piecemeal ALTERs below are skipped.
    if (force && retype.length && db.kind !== 'postgres') {
      await rebuildTable(db, d.table, schema[d.table]);
      for (const col of retype) log(`${d.table}: changed ${col.name} ${col.from} → ${col.to}`);
      for (const col of d.extra) if (col !== 'id' && col !== 'user_id') log(`${d.table}: dropped ${col}`);
      continue;
    }
    for (const col of d.add) {
      await db.query(`ALTER TABLE ${q(d.table)} ADD COLUMN ${q(col.name)} ${col.type}`);
      log(`${d.table}: added ${col.name} ${col.type}`);
    }
    for (const col of retype) {
      if (!force) { log(`${d.table}: column ${col.name} is ${col.from} but the templates imply ${col.to} (kept — use --force to change)`); continue; }
      // Postgres can retype in place with an explicit cast.
      await db.query(`ALTER TABLE ${q(d.table)} ALTER COLUMN ${q(col.name)} TYPE ${col.to} USING ${q(col.name)}::${col.to.toLowerCase()}`);
      log(`${d.table}: changed ${col.name} ${col.from} → ${col.to}`);
    }
    for (const col of d.extra) {
      if (!force) { log(`${d.table}: column ${col} is not in the templates (kept — use --force to drop)`); continue; }
      if (col === 'id' || col === 'user_id') continue;
      await db.query(`ALTER TABLE ${q(d.table)} DROP COLUMN ${q(col)}`);
      log(`${d.table}: dropped ${col}`);
    }
  }
  return diff;
}

/**
 * Seed declared tables from their seed="…" files — once, idempotently: only
 * when the table is empty. Auth-table passwords hash unless already hashed.
 */
export async function seedTables(db, schema, config, root, log = () => {}) {
  const authTable = config.auth && config.auth.table;
  for (const [table, spec] of Object.entries(schema)) {
    if (!spec.seed) continue;
    const file = resolve(root, spec.seed.replace(/^\.\//, ''));
    if (!file.startsWith(root) || !existsSync(file)) continue;
    let rows;
    try { rows = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    if (!Array.isArray(rows) || !rows.length) continue;
    const count = await db.query(`SELECT COUNT(*) AS n FROM ${q(table)}`);
    if (Number(count[0]?.n ?? count[0]?.count ?? 0) > 0) continue;
    for (const row of rows) {
      const data = { ...row };
      if (table === authTable && typeof data.password === 'string' && !data.password.startsWith('$')) {
        data.password = await Bun.password.hash(data.password);
      }
      const keys = Object.keys(data);
      await db.query(
        `INSERT INTO ${q(table)} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
        keys.map((k) => data[k]),
      );
    }
    log(`seeded ${table} (${rows.length} rows) from ${spec.seed}`);
  }
}
