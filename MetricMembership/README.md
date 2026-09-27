# Metric Membership

Metric Group's white-label membership at https://metric.vesopa.com: drivers
register their cars and Metric's ANPR barriers open for them.

| Folder | What |
| --- | --- |
| `app/` | Member app, Flutter (web, Windows, Android, iPhone) |
| `server/` | API, camera webhook, staff console (`/admin`), Node |
| `DESIGN.md` | The design system both share: colours, type, spacing, components |

Deploy: `python MetricMembership/server/scripts/deploy.py` (check), then
`--apply`, from a machine that can reach the Cloud box. Details in
`server/README.md`.
