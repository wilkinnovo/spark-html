// A MODULE source: `post = ./lib/post.js` in blog/[slug].html calls this with
// the request. It reads a single markdown file by slug and returns one row
// (front matter → fields, the rest → body), or null when there's no such file
// — which the page turns into a real 404. No database required.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export default function post(req) {
  const slug = String(req.params.slug || '').replace(/[^a-z0-9-]/gi, '');
  const file = join(import.meta.dir, '..', 'content', `${slug}.md`);
  if (!slug || !existsSync(file)) return null;

  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const data = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (kv) data[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
    }
  }
  return { slug, ...data, body: m ? raw.slice(m[0].length).trim() : raw.trim() };
}
