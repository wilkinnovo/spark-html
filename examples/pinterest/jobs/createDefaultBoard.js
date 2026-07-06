// Wired from pages/_layout.html: <spark-ssr job="createDefaultBoard"
// on="insert:users" /> — runs after every signup, with the new user row on
// req.row. Every account needs at least one board before it can save
// anything, so this gives new users a starting point with zero UI for it.
export default async function createDefaultBoard(req, db) {
  const user = req.row;
  if (!user) return;
  await db.query('INSERT INTO boards (user_id, name, description) VALUES (?, ?, ?)', [
    user.id,
    'My Pins',
    'Your first board — add more from any pin.',
  ]);
}
