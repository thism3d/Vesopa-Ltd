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
