# vesopaepos.com

The public Vesopa EPOS website, its enquiry forms and its staff admin panel.
Node + Express + EJS, replacing the PHP site that used to live in
`/Applications/MAMP/htdocs/vesopaepos`.

Runs on **port 5065**. The back office (`backoffice.vesopaepos.com`) is a
separate app — [`vesopa_server`](../vesopa_server) — on port 5060. Both talk to
the same `vesopa_eposdb` database, which is how a demo request approved here
becomes a working back-office login.

## Setup

```bash
npm install
cp .env.example .env      # then fill in DB, SESSION_SECRET, SMTP, PayPal
mysql -u root -p vesopa_eposdb < schema.sql
npm start
```

`.env` is gitignored. Nothing in `src/` contains a credential — the PHP site
hardcoded the database password, the SMTP password and the PayPal secrets in
files that were readable from the web root.

## Layout

```
src/
  server.js        express app, static files, error pages
  config.js        pricing plans, contact details, brand colours
  db.js            mysql pool + transaction helper
  mailer.js        nodemailer transport
  paypal.js        PayPal REST client
  payments.js      recording completed payments
  admin-auth.js    admin sessions (HMAC cookie) and password checking
  routes/
    pages.js         public pages, robots.txt, sitemap.xml, legacy redirects
    forms.js         the four enquiry forms
    checkout-api.js  PayPal endpoints the checkout page calls
    admin.js         /admin
  emails/          HTML mail templates
views/             EJS — the PHP markup, unchanged
public/            CSS, JS, images, fonts, favicons
schema.sql         the tables this site owns
```

## Routes

| Method | Path                    | Purpose                                  |
| ------ | ----------------------- | ---------------------------------------- |
| GET    | `/health`               | Liveness check                           |
| GET    | `/`, `/pricing`, `/about`, `/help`, `/download`, `/training`, `/career`, `/privacy`, `/terms`, `/refund` | Content pages |
| GET    | `/checkout?period=1\|12\|24` | Subscription checkout               |
| GET    | `/payment-status?ref=`  | Receipt after a completed payment        |
| POST   | `/request-demo`, `/contact`, `/job-enquiry`, `/book-training` | Enquiry forms |
| POST   | `/api/paypal/*`         | Plan creation, order creation, capture   |
| GET    | `/admin`                | Staff panel                              |

The PHP `.php` URLs 301 to their replacements, so old links and indexed pages
keep working.

## Design

The markup is the PHP site's markup. The rendered DOM — every tag, every class,
in order — is identical on all ten content pages; the stylesheet and images were
copied across untouched. What changed is underneath: asset URLs are
root-absolute instead of relative, the copyright year is computed, and the
duplicated pricing-card block that had drifted apart between `index.php` and
`pricing.php` is one partial.

Branding is the 2025 logo: green-and-black wordmark, green square app icon,
regenerated PWA icons and favicon, and `theme_color` moved from the old purple
to `#a5c715`. The email templates moved to the same green.

**The stylesheet is still on the old purple accent** (`#8a3393` and friends), as
is the hero video `public/assets/logo/file.mp4`. That was left alone
deliberately — recolouring the site is a visual change, not a port. It is a
small job when wanted: six purple-family values in `main0.1.0.css`, plus a new
hero video.

## What the port fixed

Behaviour that was broken or unsafe in the PHP, not stylistic preference:

- **Checkout never completed.** Every `INSERT` in `paypal_subscription_init.php`
  and `paypal_checkout_validate.php` was commented out, and both files gated
  their success response on a row id those inserts would have produced. A
  customer who paid saw the button spin and nothing else; no record was kept.
  Payments are now captured server-side, recorded, and confirmed on a receipt
  page.
- **Admin login was injectable.** The query interpolated the username and
  password into SQL, so `" OR "1"="1` logged in as the first admin. Passwords
  were stored in plaintext, and the session was a role cookie encrypted with a
  key committed to the repo. Now: parameterised queries, bcrypt, one HMAC-signed
  cookie keyed from `.env`. Rows carried over with plaintext passwords are
  re-hashed in place on first successful login — nobody needs to reset anything.
- **Subadmins could manage admins.** The UI hid the panel; the endpoints were
  open to anyone who knew the URL.
- **Customer passwords were printed on screen** in the approved-accounts list.
- **Stored XSS** — the admin panel echoed enquiry text into the page unescaped.
- **Training bookings stored `0000-00-00`.** `datetime-local` was fed straight
  into MySQL. (Careful: it is a wall-clock value with no timezone, so it must
  not be round-tripped through UTC either.)
- **Database errors were printed to visitors**, along with the support phone
  number, on any connection failure.
- **No 404 page**, no rate limiting on the forms, no `robots.txt` covering
  `/admin`, and a sitemap hardcoded to the wrong domain.
- **The service worker cached nothing** but intercepted every request, and would
  have served the old logo to returning visitors after the rebrand.

Not carried over: `app_server/` and `apis/` (the old till/mobile API, pointed at
a dead `u345429484_*` database and superseded by `vesopa_server`), and the
`<stripe-buy-button>` markup in `checkout.php`, which was assigned to a variable
that was never echoed.

## Deploy

```bash
./deploy.sh                 # rsync + npm install + pm2 restart
./deploy.sh --schema        # also apply schema.sql (guarded, re-runnable)
./deploy.sh --restart-only
./deploy.sh --logs
./deploy.sh --help
```

There is no build step. `.env`, `node_modules` and `public/downloads` are
excluded from the sync so live secrets and the uploaded installer survive.

The database flags (`--db-push`, `--db-pull`) move **only the tables this site
owns** — enquiries, accounts, payments. The till and back-office tables in the
same database belong to `vesopa_server` and are never touched.
