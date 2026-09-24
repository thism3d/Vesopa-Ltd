# Serving the dine-in pages from vesopaepos.com

The address printed on a table card is `vesopaepos.com/t/<code>` — the apex
domain, not `backoffice.`. The card gets laminated and stood on a table, so the
address on it has to be the one a venue would actually put in front of a
customer, and it has to keep working.

The apex domain is the marketing site (`vesopa_web`, `127.0.0.1:5065`). The
dine-in pages are in the back office (`127.0.0.1:5060`). These two files are the
nginx that routes four paths — and only four — across.

| File | Goes to | Does |
| --- | --- | --- |
| `nginx.ssl.conf_dinein` | `/home/vesopa/conf/web/vesopaepos.com/` | Proxies `/t/`, `/m/`, `/o/` and `/api/public/dinein/` to :5060 |
| `nginx.conf_dinein` | the same directory | Redirects those four to HTTPS |

Then `nginx -t && systemctl reload nginx`.

## Why they are in that directory and not in nodejs-app.conf

Because the HestiaCP Node plugin **regenerates `nodejs-app.conf` from a
template** every time the Node app is reconfigured in the panel — see
`quickinstall-app/NodeJs/NodeJsSetup.php`, which writes a temp file over it.
Rules kept there would vanish on somebody clicking Save, and every printed QR
code in the venue would stop working with nothing on screen to explain it.

`nginx.conf_*` / `nginx.ssl.conf_*` is HestiaCP's own per-domain custom slot and
survives a rebuild. The four NodeJS nginx templates did not include it — every
other HestiaCP template does — so that one glob line was added to each of
`NodeJS.tpl`, `NodeJS.stpl`, `NodeJSForceSSL.tpl` and `NodeJSForceSSL.stpl` in
`/usr/local/hestia/data/templates/web/nginx/`, with `.bak-` copies beside them.
It is a glob, so it matches nothing for the domains that have no custom file.

**A HestiaCP upgrade may replace those templates.** If the dine-in pages ever
start 404ing on the apex, check that the vhost still has the
`conf/web/<domain>/nginx.ssl.conf_*` include:

```bash
grep include /etc/nginx/conf.d/domains/vesopaepos.com.ssl.conf
```

and if it has gone, re-add the line to the templates and run
`v-rebuild-web-domain vesopa vesopaepos.com yes`.

## What is deliberately not proxied

`/api/public/dinein/` is the entire API those pages call, and it is the one part
of the back office designed to be reached with no credential — possession of the
table's printed id is the whole of it. Proxying `/api/` wholesale would put the
signed-in back office on the public domain.

Verified sealed: `/api/products`, `/api/dinein/venue`, `/api/login`,
`/till/dinein/orders` and `/dashboard` all 404 on the apex.

## The other half

`PUBLIC_BASE_URL=https://vesopaepos.com` in the back office `.env`. Without it
every link is built from the request's own host, so a card generated in the back
office would be printed with `backoffice.` on it.
