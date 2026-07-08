import { decorate } from './format.js';

// Homepage discovery strip — the newest public uploads across every user.
export default async function (req, db) {
  const rows = await db.query(
    `SELECT d.*, u.name AS owner_name, u.avatar AS owner_avatar, u.id AS owner_id
     FROM documents d JOIN users u ON u.id = d.user_id
     WHERE d.visibility = 'public' ORDER BY d.created_at DESC LIMIT 6`,
  );
  return rows.map(decorate);
}
