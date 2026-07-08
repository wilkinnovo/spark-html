// The mail sender (spark.json "mail": "./lib/mail.js"). Every mail() call in
// the app — from a page/api <script>, middleware, or a job — arrives here as
// { to, subject, text, html }. This default just logs, so the app runs with
// zero setup; swap the body for your provider (Resend, Postmark, SMTP, …) and
// nothing else changes.
export default async function send({ to, subject, text }) {
  console.log(`✉️  [mail] → ${to}\n    ${subject}\n    ${(text || '').split('\n').join('\n    ')}`);
  // e.g. with Resend:
  //   await fetch('https://api.resend.com/emails', {
  //     method: 'POST',
  //     headers: { authorization: `Bearer ${process.env.RESEND_KEY}`, 'content-type': 'application/json' },
  //     body: JSON.stringify({ from: 'blog@you.dev', to, subject, text }),
  //   });
  return { ok: true };
}
