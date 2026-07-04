// One-time (idempotent) dev database setup — `bun run dev` runs it for you.
// Swap spark.json's db to postgres:// any time; no code changes needed.
import { Database } from 'bun:sqlite';

const db = new Database('./dev.db', { create: true });
db.run(`CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  done INTEGER DEFAULT 0
)`);
if (db.query('SELECT COUNT(*) AS n FROM todos').get().n === 0) {
  db.run("INSERT INTO todos (title) VALUES ('Try spark-ssr'), ('Edit pages/index.html'), ('Ship it')");
  console.log('⚡ seeded dev.db with a few todos');
}
db.close();
