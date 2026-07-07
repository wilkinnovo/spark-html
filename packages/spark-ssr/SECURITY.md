# spark-ssr security posture (v1)

spark-ssr ships auth, sessions, a SQL layer, uploads, and file serving — it is
a security product with a framework attached. This file is the audited posture
as of the M3.3 pass. Every item below is pinned by a test in
`test/security.js` that fails when the protection is removed; "verified by
reading the code" is not verification here.

## Sessions & cookies

- **Signed, stateless sessions.** A session is `base64url(payload).HMAC-SHA256`
  in an `HttpOnly; SameSite=Lax` cookie (`src/session.js`). Verification is
  `timingSafeEqual`; any malformed/forged value reads as `null`, never an
  exception on the request path.
- **`Secure` on HTTPS.** Session and flash cookies gain the `Secure` attribute
  when the request reached us over HTTPS — directly, or via a TLS-terminating
  reverse proxy that sets **`X-Forwarded-Proto: https`**. That is the one
  forwarded header we trust for this; terminate TLS at a proxy you control and
  strip/normalize it at the edge so a client can't spoof it. `req.secure`
  exposes the same signal to handlers.
- **Production requires an explicit secret.** A production server
  (`watch:false`, i.e. `spark-ssr start` / a compiled `dist/`) with `auth`
  configured but **no `auth.secret`** refuses to start — an ephemeral random
  key silently invalidates every session on restart and can't be shared across
  instances. Set `"auth": { …, "secret": "ENV.SESSION_SECRET" }`. Dev keeps an
  ephemeral key for zero-config convenience.

## CSRF

- **Documented stance: `SameSite=Lax`.** Modern browsers do not attach a
  `SameSite=Lax` cookie to cross-site **POST/PUT/PATCH/DELETE** (only to
  top-level GET navigations), which covers the classic form-CSRF vector for the
  mutating requests that matter. spark-ssr therefore ships **no CSRF token** by
  default. If your threat model includes pre-`SameSite` browsers or you want
  defense in depth, add a token check in `middleware.html`. This is a
  deliberate decision, not an omission.

## Redirects & headers

- **No open redirect / header injection.** Every user-supplied redirect target
  (`_redirect` on no-JS forms, `?next` on the built-in auth screens) passes
  through `localPath()` (`src/request.js`): it must be an absolute path that is
  not protocol-relative (`//host`, `/\host`), not an absolute URL, and free of
  control characters (so a `\r\n` can't inject a second header). Anything else
  falls back to a known-good local path.

## SQL

- **All values are parameterized.** `:token` params (`?id`, `:session.id`,
  `:body.*`, `:header.*`) become bound `?` placeholders (`rewriteParams`);
  values never reach SQL as text.
- **Identifiers are allowlisted, not interpolated from input.** Table and
  column names come from schema inference / the parsed template (word chars
  only). The one input-driven identifier — `?sort=col:dir` on list pages — is
  matched against the table's real columns before it can reach `ORDER BY`; an
  unknown/injecting value is ignored, not executed.
- **`?q` search** binds `LIKE ?` over an allowlisted subset of the block's
  `search="…"` columns.

## File serving

- **No traversal.** A `..` anywhere in the decoded path is refused (404), and
  every resolved candidate must stay under the project root (`abs.startsWith(root)`).
- **public/ is the asset root.** The root fallback (co-located assets like
  `pages/x.css`, `/img/*`) never serves project internals: dotfiles, config
  (`spark.json`), lockfiles, databases, seed data, or the **server-only source
  trees** `node_modules/`, `jobs/`, `lib/`, `api/`, `dist/` (`SERVER_DIRS` in
  `src/static.js`) — those hold code and API keys and are reachable to the
  runtime, never to the browser. Keep anything secret out of `public/`.

## Uploads & request size

- **Body ceiling.** Any single request body (uploads + JSON) is capped at
  `maxBodyMb` (default 10 MB), enforced at the socket by Bun — an over-limit
  request gets `413` before it is buffered. Uploaded files are written under
  `uploads/` with a `randomUUID()` name and a word-char-only extension (no
  caller-controlled path).

## Rate limiting

- **Built-in login is limited.** Because spark-ssr ships the login endpoint, it
  ships a naive in-memory per-IP sliding-window limiter (10 attempts / 60 s →
  `429`, `src/crud.js`). It blunts credential stuffing without a dependency; an
  app behind a real WAF/proxy limiter loses nothing. Custom `auth.plugin` login
  endpoints own their own limiting.

## Response cache

- **Anonymous-only.** The full-page cache stores only anonymous GETs whose
  output is a pure function of (path, query): no per-request server `<script>`,
  no module sources, no SQL reading `:header`/`:body`. A request carrying any
  `spark_` cookie bypasses the cache entirely, and a response that sets a cookie
  is never stored — so one visitor's page can't be served to another. Pinned by
  the cache-poisoning test.

## Known / accepted

- **`SameSite=Lax` (no token)** — see CSRF above; documented, not a gap.
- **Response cache is blind to out-of-band DB writes until TTL** — inherent to a
  TTL cache; writes *through the server* invalidate by table.
- **Trusted proxy header** — `X-Forwarded-Proto` (Secure) and
  `X-Forwarded-For` (`req.ip`, rate-limit key) are trusted; front the app with a
  proxy that sets them authoritatively.
