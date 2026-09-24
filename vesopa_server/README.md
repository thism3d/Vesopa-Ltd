# Vesopa EPOS — server

Node API + WebSocket push for the Vesopa till. Talks to the same
`vesopa_eposdb` MySQL database the existing PHP back office uses, so products
maintained in the back office are immediately sellable on the tills.

## Setup

```bash
npm install
cp .env.example .env      # then fill in DB_USER / DB_PASSWORD
mysql -u root -p vesopa_eposdb < schema.sql
npm start
```

`.env` is gitignored. Credentials are never hardcoded in source.

## Endpoints

| Method | Path                  | Purpose                                        |
| ------ | --------------------- | ---------------------------------------------- |
| GET    | `/health`             | Liveness check                                 |
| GET    | `/products`           | Catalogue pull; the till caches this locally   |
| POST   | `/orders`             | Submit a completed sale (idempotent)           |
| GET    | `/reports/end-of-day` | Takings for a date, split by tender            |
| WS     | `/ws`                 | Server→terminal push (kitchen, table status)   |
| POST   | `/api/webhooks/dojo/:env` | Dojo card events (`sandbox` \| `live`)     |

## Dojo webhooks

Dojo push payment-intent and terminal-session events here. This is not how a
sale completes — the till polls its own terminal session to a verdict, because
it needs the answer while the customer is still standing there. This is how the
back office learns what happened *after* the till stopped looking: a refund
raised in the Dojo portal, a reversal, a pre-authorisation captured the next
morning, or a sale whose result the till never saw because the tablet lost
Wi-Fi between "card presented" and "approved".

Subscribe in the Dojo developer portal, one subscription per environment:

```
https://backoffice.vesopaepos.com/api/webhooks/dojo/sandbox
https://backoffice.vesopaepos.com/api/webhooks/dojo/live
```

The environment is in the path because each subscription is issued its own
signing secret, and the handler has to know which secret to check *before* it
can trust anything in the payload. Put them in `.env` as
`DOJO_WEBHOOK_SECRET_SANDBOX` / `_LIVE`; leave one blank and that endpoint
fails closed with a 401 rather than accepting unverified events. The boot log
says which environments are configured.

Three properties that matter, in order of how badly they break:

- **Forgeries are rejected.** The URL is public and these events move money in
  the reporting. Every request is HMAC-SHA256 verified against the *raw* bytes
  — `JSON.stringify(req.body)` is a re-serialisation that agrees with what was
  sent only by luck, so `express.json`'s `verify` hook keeps the buffer.
  Dojo's digest is uppercase hex joined with hyphens (`sha256=4B-49-F8-…`);
  both that and plain hex verify.
- **Duplicates do nothing.** Delivery is at-least-once with up to 12 retries,
  so a repeat is routine. `dojo_webhook_events` has Dojo's own event id as its
  PRIMARY KEY and `INSERT IGNORE` is the whole de-duplication strategy.
- **It answers fast.** Anything that is not 2xx is a retry, so the handler
  verifies, writes, and returns. A genuine server-side failure returns 5xx *so
  that* Dojo retries; an event for a payment we have never seen is recorded as
  unmatched and acknowledged, because retrying will not make it match.

Events are tied to a sale through `epos_payments.reference`, which holds the
`paymentIntentId` the till used. Run `schema_dojo.sql` (or `deploy.sh
--schema`) to create the ledger table and the columns it reconciles into.

## Why sales go over HTTP, not the WebSocket

A till has to keep selling with no network. Sales are written to the
terminal's local SQLite first and queued in an outbox, then pushed over plain
HTTP — a request that can fail, be retried, and survive the app being killed
mid-flight. A dropped socket loses in-flight frames and an offline terminal has
no socket at all, so the socket is used only for what it is genuinely good at:
the server pushing to us.

`POST /orders` is idempotent on the order UUID minted by the till. A terminal
retrying after a dropped connection re-sends the same id and gets `409
duplicate` instead of booking the sale twice.
