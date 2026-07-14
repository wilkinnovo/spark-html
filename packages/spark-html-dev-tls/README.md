# spark-html-dev-tls

Local **HTTPS for your spark-html dev server**, so you can test secure-context
browser APIs — **camera, microphone, geolocation, service workers** — from a
real phone on your LAN. These APIs only work over `https://` (or `localhost`),
so a plain `http://192.168.x.x:3000` dev URL can't use them. This wraps that
dev server with a self-signed TLS reverse proxy.

It's a **testing tool, and purely additive**: your normal `dev` script is left
exactly as it is (plain HTTP). You add a `secure` script that wraps it.

```json
{
  "scripts": {
    "dev": "bun spark-ssr",
    "secure": "bun spark-html-dev-tls"
  }
}
```

```bash
bun run dev      # unchanged — http://localhost:3000
bun run secure   # https://<your-lan-ip>:3000  → open this on your phone
```

`secure` auto-detects the project (a `spark.json` / `pages/` folder → spark-ssr;
a `spark.config.js` → spark-html-bun), spawns that same dev server on a private
port, and fronts it with HTTPS. It works the same for **SSR, client-only, and
prerender** apps — an HTTP→HTTPS proxy doesn't care what's behind it.

## What it handles

- **Plain requests** stream straight through.
- **Live reload / live data** (spark-ssr's `/__spark/reload` and `/__spark/live`
  Server-Sent Events) pass through as live streams.
- **Hot module reload** (spark-html-bun's `/__spark_hmr` WebSocket) is relayed.
- **Secure cookies** work — the proxy adds `x-forwarded-proto: https`, so the
  dev server marks session/flash cookies `Secure` correctly.

## Requirements & options

`openssl` (a system tool, already on macOS/Linux and via Git-Bash/WSL on
Windows) generates the certificate — no npm dependencies. The cert is cached in
`.spark/dev.{pem,key}` with a SAN covering `localhost`, `127.0.0.1`, and your
LAN IPs, and reused until it nears expiry.

```bash
spark-html-dev-tls --port 8443            # pick the HTTPS port
spark-html-dev-tls --cert c.pem --key k   # bring your own cert (e.g. mkcert, for no warning)
spark-html-dev-tls -- bun spark-ssr       # skip auto-detect; wrap an explicit command
```

Self-signed certificates show a one-time browser warning (accept it, or install
a [mkcert](https://github.com/FiloSottile/mkcert) cert and pass `--cert/--key`
for a trusted, warning-free experience). This is a **dev-only** tool; production
HTTPS is normally terminated by your host or a reverse proxy.
