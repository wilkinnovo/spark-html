// A background job (jobs/<name>.js). The admin page wires it with
// <spark-ssr job="notify-author" on="insert:posts" /> — so it runs after
// every INSERT into posts, with the new row on req.row. Same shape as a data
// source: (req, db). req.mail is the sender from spark.json.
export default async function notifyAuthor(req, db) {
  const post = req.row;
  if (!post || !post.published) return; // drafts don't page anyone

  const [author] = await db.query('SELECT name, email FROM users WHERE id = ?', [post.user_id]);
  await req.mail({
    to: author?.email ?? 'me@spark-html.com',
    subject: `Published: ${post.title}`,
    text: `Hi ${author?.name ?? 'there'},\n\nYour post "${post.title}" is now live at /blog/${post.slug}.`,
  });
}
