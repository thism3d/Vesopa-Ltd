# Metric Membership — server

White-label membership for **Metric Group** (metricgroup.co.uk), a Vesopa
customer, at **https://metric.vesopa.com**. A driver signs in with Continue with
Vesopa, registers their car registrations, and Metric's ANPR cameras open the
barrier for those cars on the way in and out.

| Part | Where |
| --- | --- |
| Member app (web, Windows, Android, iPhone) | `vesopa_metric/` (Flutter, same shape as `vesopa_loyalty/`) |
| This server: API, camera webhook, staff console | `vesopa_metric_server/` (Node, Express, MySQL) |
| Continue with Vesopa client | `vesopa_auth/schema/schema_025_metric_client.sql` (slug `vesopa-metric`) |
| Brand | `public/brand/` and `src/brand.js`, from Metric's public website |

```
/                  member web app (Flutter build in web_app/)
/api/v1/...        member API (Bearer session)
/anpr/v1/gates/<key>/event       camera posts a plate read, gets {open}
/anpr/v1/gates/<key>/allowlist   controller pulls the plate list (JSON or ?format=csv)
/anpr/v1/gates/<key>/ping        installer's test
/admin             Metric staff console (Continue with Vesopa, METRIC_ADMIN_EMAILS)
/auth/callback     Vesopa Auth comes back here (web app and console)
/health
```

## How the barriers work

Researched 2026-09-27. Metric sells its own **AI-Gate**: barrier gates with
built-in ANPR cameras, run from its Mi-Office back office, which keeps a
**permit list** of plates, and whose Mi-Xchange API links it to other systems.
The cameras inside ANPR barrier packages in the UK are mostly Hikvision or
Dahua access-control ANPR units. Across all of them there are two standard ways
to let a registered car through, and this server does both:

1. **Allow-list on the camera** (gate mode `allowlist`). The camera holds the
   list and closes the barrier relay itself on a match, so it keeps working if
   the internet drops. This server keeps the list equal to the members' active
   cars: after every change (a few seconds later) and every 5 minutes. It only
   ever removes plates it added itself.
   - `hikvision`: ISAPI `licensePlateAuditData` (whiteList) / `DelLicensePlateAuditData`, digest auth
   - `dahua`: CGI `recordUpdater.cgi` on `TrafficRedList` with `OpenGate=true`
   - `generic` / `metric_aigate`: the full list POSTed to the controller's
     address as JSON, or pulled by it from `/allowlist`
2. **Decision by the server** (gate mode `decision`). The camera, or Metric's
   own back office, sends each read to `/event`. The server answers
   `{"open": true|false, "reason": ...}` (or `OPEN`/`DENY` with
   `?format=text`). For Hikvision and Dahua it also sends the barrier its open
   command. This covers what a camera cannot decide by itself: expiry dates,
   suspended members, and one membership working across several sites.

`both` does both. Plate reads are parsed from generic JSON, Hikvision
EventNotificationAlert (XML, JSON or multipart with pictures), Dahua JSON and
most other makes, because the parser searches the body for any plate-like key.
Close reads (0/O/D/Q, 1/I, 2/Z, 5/S, 8/B, 6/G) match when the lane allows it, and
only when exactly one car matches. Repeat reads of one car within 15 seconds
are answered once.

**Assumed:** Metric's AI-Gate back office can either call a webhook per read or
pull or push a plate list. Until Metric sends the Mi-Xchange API document,
`metric_aigate` behaves as `generic`. The Hikvision and Dahua endpoints follow
the vendors' published ANPR API guides, and the installer should check them on
the first unit, because firmware versions differ.

### What Metric needs to supply

- The make and model of the cameras and barriers at each site, and whether
  they will call us (decision) or hold the list (allow-list).
- For the allow-list or remote open: a way for this server to reach each
  camera (a public address, port forward or VPN) and a camera user with API
  rights.
- For AI-Gate / Mi-Office: the Mi-Xchange API document, or confirmation that
  their back office can call the `/event` webhook or pull `/allowlist`.
- The staff email addresses for the console (`METRIC_ADMIN_EMAILS`).
- Their site names and addresses, and the rules: how many cars per member, and
  whether new members are approved by hand (the default) or automatically.

## Logs

Every member action (sign-in, cars added or removed, details changed), every
tap and screen the app reports (`POST /api/v1/log`: names only, never what was
typed), every staff change, every plate read and every allow-list sync goes to:

- `logs/metric-activity-YYYY-MM-DD.jsonl` on the box: one JSON line each,
  kept `LOG_KEEP_DAYS` (90)
- the `activity_log` table, searchable in the console's **Activity log**
  and on each member's page

Keys that look like secrets are replaced with `[hidden]` before anything is
written.

## Run and test

```bash
npm install
npm test                 # MariaDB on 127.0.0.1 (root, no password) — makes metric_test
cp .env.example .env     # then fill it in
npm start
```

## Deploy

`python vesopa_metric_server/scripts/deploy.py` (check) then `--apply`, from a
machine that can SSH to the Cloud box. See the docstring and
`scripts/remote-install.sh`. The script is idempotent: the first run sets up the
DNS record, Hestia domain (NodeJS proxy), certificate, database, Auth client and
`.env`. Later runs only ship code. pm2 runs as `vesopasoftware` and the app is
named `metric.vesopa.com`.
