import { decorate } from './format.js';

// Dashboard list: the signed-in user's own documents, newest first.
export default async function (req, db) {
  if (!req.session) return [];
  const rows = await db.query('SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC', [req.session.id]);
  return rows.map(decorate);
}
