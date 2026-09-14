# Vesopa Gift on the live box

How gift.vesopaepos.com is set up, how to change it, and what bit on the way.
No secret is written here; every value lives in the server's `.env` files and,
on the development machine, in `.env.claude-tools` (`VESOPA_GIFT_*`).

## Where it runs

| | |
| --- | --- |
| Server | the EPOS box, `hosting.onzep.uk` (3.72.113.21), beside the back office |
| Hestia | user `vesopa`, web domain `gift.vesopaepos.com` on 172.31.33.219, no aliases |
| DNS | `gift A 3.72.113.21` in the `vesopaepos.com` zone, served by this box (ns1/ns2.onzep.uk) |
| Certificate | Let's Encrypt through Hestia, HTTPS forced |
| nginx | proxy template `NodeJSForceSSL`; the domain's own include, written by hand: `/home/vesopa/hestiacp_nodejs_config/web/gift.vesopaepos.com/nodejs-app.conf` (and `-fallback.conf`) → `127.0.0.1:5070` |
| App | `/home/vesopa/web/gift.vesopaepos.com/private/nodeapp` (src, views, public, schema, node_modules, `.env`, `uploads/`, `backup/`) |
| Process | pm2 (root's), name `vesopa_gift`, `src/server.js`, max memory 300 MB; logs in `/root/.pm2/logs/vesopa-gift-*.log` |
| Database | `vesopa_giftdb`, user `vesopa_giftdb`, made through Hestia (`v-add-database vesopa giftdb giftdb …`) |

**Never create a Hestia "Node quickapp" for this domain** (`v-add-nodejs-app`):
it rewrites the app's `.env` with a two-line stub. The include above is written
by hand for the same reason as `menu.vesopaepos.com`'s.

## The three things it is connected to

* **The back office** on `127.0.0.1:5060`, through `/api/integrations/gift`
  (`vesopa_server/src/gift_integration.js`). Both `.env` files hold the same
  `GIFT_SERVICE_KEY`; without it the API answers 503, with a wrong one 401.
* **Vesopa Auth**, for the console: the application "Vesopa Gift" (slug
  `vesopa-gift`, id 36), self-registration off, roles `owner`, `support`,
  `venue` (`vesopa_auth/schema/schema_017_gift_client.sql`). Its secret was
  minted with `vesopa_auth/scripts/mint-client-secret.js` into
  `/root/vesopa-gift-client.secret` on the Auth box. The owner
  (info@vesopasoftware.com) is `owner` there and admin of the app in the
  developer portal, which is where the console's People link goes.
* **Mail**: the menu's customer mailbox (`menu@vesopaepos.com`), the same
  settings the back office uses for `MENU_SMTP_*`. Mail goes out in the venue's
  name with Reply-To the venue's own address.

## .env (names only)

`NODE_ENV PORT BASE_URL EPOS_API GIFT_SERVICE_KEY DB_HOST DB_PORT DB_NAME DB_USER
DB_PASSWORD VESOPA_AUTH_ISSUER VESOPA_AUTH_CLIENT_ID VESOPA_AUTH_CLIENT_SECRET
SESSION_SECRET SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASSWORD MAIL_FROM
BACKOFFICE_ORIGIN GIFT_TEST_OFFICES` — see `.env.example`. Optional:
`BRAND_ORIGINS` (extra hosts a venue's logo may come from; default
menu.vesopaepos.com), `GIFT_SCHEDULER=off`, `GIFT_SWEEP_MS`.

## Changing it

```bash
python vesopa_gift/scripts/deploy.py            # what it would do
python vesopa_gift/scripts/deploy.py --apply    # back up the gift database, send the code, schema twice, restart, health
```

It sends code only — never `.env`, never `uploads/`. A change to
`vesopa_server/src/gift_integration.js` is a back-office deploy, done like any
other (back up, upload, `pm2 restart vesopa_backoffice`).

Then check it on the real thing:

```bash
python vesopa_gift/scripts/verify-live.py
```

Test venue only; pays with Dojo's sandbox card after checking the checkout is a
sandbox one; declines Dojo's optional cookies; mails manager@vesopa.co.uk;
removes everything it made and proves it with SQL.

## The owner's switches, from a shell

For when nobody can reach the console. On the server, in the app directory:

```bash
node scripts/venue-access.js list
node scripts/venue-access.js enable 9
node scripts/venue-access.js staff 9 manager@vesopa.co.uk
node scripts/venue-access.js disable 9
```

Audited as "operator (server)".

## What bit

* **Port 5060 is a "bad port" to `fetch()`** (it is SIP's), so every call to the
  back office failed on the live box — while the tests, on random ports,
  passed. `src/epos.js` uses `node:http`; `test/epos-port.test.js` answers on
  5060 to keep it that way.
* **Branding comes from two hosts.** The EPOS hands out logos on
  `menu.vesopaepos.com` as well as the back office's own name; the CSP names
  both.
* **Dojo's `cardName` is the cardholder's name.** The scheme is `cardType`.
* **Dojo's checkout covers the Pay button with a cookie notice** whose optional
  cookies are switched on by default; the live check switches them off.

## Undoing it

`pm2 stop vesopa_gift` takes the shop and console down; `v-suspend-web-domain
vesopa gift.vesopaepos.com` stops nginx serving it. Every card sold is an
ordinary gift card in the EPOS and keeps working at the till either way. Database
backups: `backup/` in the app directory (one per deploy) and
`backup/pre_gift_live_*.sql` in the back office's.
