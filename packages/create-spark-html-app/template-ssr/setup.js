// One-time (idempotent) dev database setup — `bun run dev` runs it for you.
// Swap spark.json's db to postgres:// any time; no code changes needed.
import { Database } from 'bun:sqlite';

const db = new Database('./dev.db', { create: true });

db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  bio TEXT DEFAULT ''
)`);

db.run(`CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT DEFAULT '',
  body TEXT DEFAULT '',
  published INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (date('now'))
)`);

db.run(`CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  done INTEGER DEFAULT 0
)`);

if (db.query('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  // The author account — sign in at /admin to manage the blog.
  const hash = await Bun.password.hash('spark');
  db.run('INSERT INTO users (email, password, name, bio) VALUES (?, ?, ?, ?)', [
    'me@spark-html.com',
    hash,
    'Ada Spark',
    'I write HTML that reacts. No compiler, no virtual DOM, no build step — just the platform, with a spark.',
  ]);

  const posts = [
    ['hello-spark', 'Hello, Spark',
      'Why this blog runs on HTML that infers its own backend.',
      'This site is a handful of .html files and one SQLite database.\n\nEach page declares the data it needs in a <spark-ssr> block, and the server infers the rest: routes from filenames, APIs from SQL, auth from a user_id column.\n\nView source on any page — what you see is what I wrote.',
      1, '2026-06-21'],
    ['html-that-reacts', 'HTML that reacts',
      'Templates, loops and conditionals — in plain HTML attributes.',
      'A <template each="post in posts"> renders a list. A <template if> branches. {curly} braces interpolate.\n\nOn the server they render to static HTML; in the browser the same syntax comes alive as components. One mental model, both sides of the wire.',
      1, '2026-06-27'],
    ['zero-config-ssr', 'Zero-config SSR',
      'Filesystem routing, sessions, uploads and CRUD — from the template.',
      'pages/blog/[slug].html serves /blog/:slug, and :slug binds straight into the page query.\n\nDeclare <spark-ssr table="todos"> and the REST endpoints exist. Add a user_id column and they are scoped to the signed-in user. Delete the file and it all goes away.',
      1, '2026-07-02'],
    ['drafts-are-private', 'Drafts are private',
      'This post is unpublished — only the signed-in author sees it.',
      'The page query keeps drafts out of anonymous requests:\n\nWHERE slug = :slug AND (published = 1 OR :session.id IS NOT NULL)\n\nSign in at /admin and this post appears on the homepage preview and here. Publish it from the admin panel when it is ready.',
      0, '2026-07-04'],
  ];
  for (const [slug, title, excerpt, body, published, at] of posts) {
    db.run(
      'INSERT INTO posts (user_id, slug, title, excerpt, body, published, created_at) VALUES (1, ?, ?, ?, ?, ?, ?)',
      [slug, title, excerpt, body, published, at],
    );
  }

  db.run(`INSERT INTO todos (user_id, title, done) VALUES
    (1, 'Finish the drafts post', 1),
    (1, 'Write about companion packages', 0),
    (1, 'Reply to reader mail', 0)`);

  console.log('⚡ seeded dev.db — sign in at /admin with me@spark-html.com / spark');
}

db.close();
