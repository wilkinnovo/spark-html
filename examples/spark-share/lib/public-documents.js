import { decorate } from './format.js';

// A profile's public grid — only that owner's `visibility = 'public'` files.
export default async function (req, db) {
  const id = req.params.id;
  const rows = await db.query(
    "SELECT * FROM documents WHERE user_id = ? AND visibility = 'public' ORDER BY created_at DESC",
    [id],
  );
  return rows.map(decorate);
}
