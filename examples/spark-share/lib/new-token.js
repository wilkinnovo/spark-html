// A fresh share token for the upload form's hidden field — computed as a
// module data source so it's already in the server-rendered HTML (a plain,
// no-JS multipart upload still gets a real unique link on first paint).
export default async function () {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}
