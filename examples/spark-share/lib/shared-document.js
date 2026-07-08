import { decorate } from './format.js';

// The public share-link screen — resolves by the unique token alone.
// Visibility never gates this: "private" only means "not listed" elsewhere,
// the link itself is the access control, same as Dropbox share links.
export default async function (req, db) {
  const rows = await db.query(
    `SELECT d.*, u.name AS owner_name, u.avatar AS owner_avatar, u.id AS owner_id
     FROM documents d JOIN users u ON u.id = d.user_id
     WHERE d.share_token = ? LIMIT 1`,
    [req.params.token],
  );
  return rows[0] ? decorate(rows[0]) : null;
}
