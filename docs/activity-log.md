# Activity log

What every till, kitchen screen, kiosk, loyalty app and back-office user pressed
or changed, kept on the server so a fault can be traced without ringing the
venue. Added 2026-09-27.

## What is recorded

| Where it comes from | What | Where it goes |
|---|---|---|
| Vesopa EPOS (till) | every tap (the label of the button), screens opened, staff sign-on and sign-off, app start, resume and pause, uncaught errors | back office Activity Log, and `%LOCALAPPDATA%\Vesopa\epos\logs` on the till |
| Kitchen screen | the same | back office, and `%LOCALAPPDATA%\Vesopa\kitchen\logs` |
| Express kiosk | the same | back office, and `%LOCALAPPDATA%\Vesopa\express\logs` |
| Loyalty app (and white-label apps such as Metric, with `app: 'metric'`) | the same, against the signed-in customer | back office (filter by customer number), and a local file off the web |
| Customer display | the same | local file only, `%LOCALAPPDATA%\Vesopa\display\logs`. The display has no network capability by design, so nothing is sent |
| Back office (browser) | pages opened and buttons pressed | back office Activity Log |
| vesopa_server (backoffice.vesopaepos.com) | every request that changes something (POST, PUT, PATCH, DELETE) with its body after redaction, status and time taken, and every request that fails with a 5xx, with the error message | `epos_activity_log` table, and `logs/activity/*.jsonl` beside the app |
| vesopa_web, vesopa_auth, vesopa_hosting, vesopa_gift | every form posted and every failure | `logs/activity/*.jsonl` beside each app |

## What is never recorded

Passwords, PINs, tokens, session ids, card numbers, CVVs, expiry dates, bank
details, one-time codes, OAuth codes and voucher codes. Keys with those names are
replaced with `[redacted]`, a number that passes the card-number check is shown
as `[card ••••1234]`, and a JWT anywhere in text is removed. A tap on a key
labelled with only a digit or two (a PIN pad) is recorded as `number key`, and
what is typed into a text field is never recorded. The rules live in one place:
`shared/activity-log/activity_log.js` and its Dart twin, with tests.

## Where to look

**Back office → Programming → Activity Log** (`/activity-log`). Filter by app,
device, what happened (taps, screens, changes, sign-ins, errors), person,
customer number, free text and dates; tick "Only problems" for errors and
failed requests. "Download CSV" exports up to 20,000 rows for a support ticket.
A venue sees only its own rows. The Vesopa admin account sees every venue and
gets a venue picker. Back-office roles need the new "Activity Log" permission
(Programming group); users with no role see it as before.

**On the server**, each Node app writes `logs/activity/activity-YYYY-MM-DD.jsonl`
in its app folder (for example
`/home/vesopa/web/backoffice.vesopaepos.com/private/nodeapp/logs/activity`).
One JSON object per line:

```bash
# Everything one venue did today
jq -c 'select(.office=="venue@example.com")' logs/activity/activity-$(date +%F).jsonl
# Every failure
jq -c 'select(.action=="error" or .status>=500)' logs/activity/*.jsonl
```

## Keeping it small

* Database rows: 90 days, deleted in batches by the server every 24 hours.
* Server files: a new file each day and a new part after 50 MB, deleted after 30 days.
* App files: deleted after 14 days.
* Apps batch their events every 20 seconds (at most 200 per request, 3,000 per
  minute per device) and keep at most 1,000 unsent while offline.
* A till's ten-minute device heartbeat is not logged (its connects are already
  in the Devices log).

## For new apps and services

* Node: `tool/sync-activity-log.sh` copies the logger into a service as
  `src/activity_log.js`. Use `createActivityLog({ service, dir, pool? })`, then
  `app.use(log.middleware({ identify }))` and `log.startMaintenance()`. Add
  `--exclude 'logs'` to the service's rsync so a deploy never deletes the logs.
* Flutter: the script copies `lib/data/activity_log.dart`. In `main()` call
  `ActivityLog.instance..configure(app: 'metric', appVersion: '...', apiBase: ...)..installErrorHandlers()`;
  in `MaterialApp` add `navigatorObservers: [ActivityLog.instance.observer]` and
  `builder: (context, child) => ActivityLog.instance.wrap(child!)`; set
  `ActivityLog.instance.token` to a function returning the app's bearer token.
  Events go to `POST /activity/v1/events`; the venue always comes from the token.
* Add the service or app to the lists in `tool/sync-activity-log.sh`; the test
  in `shared/activity-log/test` fails if a copy drifts.

## Deploying

`vesopa_server`: deploy with `--schema` so `schema/schema_activity_log.sql`
creates `epos_activity_log` (back the database up first). Until the table
exists the server keeps working and writes to the files only. The other
services need a normal deploy and no migration.
