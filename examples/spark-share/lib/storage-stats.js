import { humanSize } from './format.js';

// Dashboard header: file count + total bytes used, pre-formatted.
export default async function (req, db) {
  if (!req.session) return { count: 0, totalLabel: '0 B' };
  const rows = await db.query(
    'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total FROM documents WHERE user_id = ?',
    [req.session.id],
  );
  const row = rows[0] || { count: 0, total: 0 };
  return { count: row.count, totalLabel: humanSize(row.total) };
}
