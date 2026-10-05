"""Set up Metric Group UK on Vesopa EPOS and invite Matt Hammond (2026-10-05).

    python tool/setup_metric_venue.py            # everything, then the email
    python tool/setup_metric_venue.py --no-mail  # everything but the email

Owner, 2026-10-05: "The venue name for Metric Group is Metric Group UK. Access
on the Matt account. Send invitation as well to Matt mail and cc to
info@vesopasoftware.com and info@vesopa.com ... grant the applications for
Metric Group".

Run from the repository root on the owner's PC (cloud sessions cannot reach
port 22). On the Cloud box it:

  1. back office: uploads src/mailer.js (now with cc), the venue setup tool
     and the invitation with its pictures
  2. back office: tool/setup-partner-venue.js makes the venue Metric Group UK
     on m.hammond@metricgroup.co.uk (sign-in by Continue with Vesopa, no
     password), allows Memberships and Vehicle access, and makes a free
     five-year EPOS plan for each of Metric's own plans
  3. Metric: writes each plan's EPOS id back, so the first sync matches them
     rather than adding copies; if Metric has no partner key yet, a new one
     goes straight from a mode-600 file into Metric's .env with
     EPOS_BASE_URL (never printed, the file deleted), then a restart, which
     syncs at boot
  4. Vesopa Auth: scripts/grant-venue-apps.js lets Matt's existing account
     into the back office, till, kitchen, display and kiosk applications
  5. sends the invitation (to Matt, cc info@vesopasoftware.com and
     info@vesopa.com), then checks

Every step is re-runnable; a second run changes nothing and, with --no-mail,
sends nothing.
"""
import os
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "MetricMembership", "server", "scripts"))
from deploy import connect  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

USER = "vesopasoftware"
WEB = f"/home/{USER}/web"
BACKOFFICE = f"{WEB}/backoffice.vesopaepos.com/private/nodeapp"
METRIC = f"{WEB}/metric.vesopa.com/private/nodeapp"
AUTH = f"{WEB}/auth.vesopa.com/private/nodeapp"

VENUE = "Metric Group UK"
EMAIL = "m.hammond@metricgroup.co.uk"
PERSON = "Matt Hammond"

UPLOADS = [
    ("vesopa_server/src/mailer.js", f"{BACKOFFICE}/src/mailer.js"),
    ("vesopa_server/tool/setup-partner-venue.js", f"{BACKOFFICE}/tool/setup-partner-venue.js"),
    ("vesopa_server/tool/invite/send-metric-invite.js", f"{BACKOFFICE}/tool/invite/send-metric-invite.js"),
    ("vesopa_server/tool/invite/metric-hero.gif", f"{BACKOFFICE}/tool/invite/metric-hero.gif"),
    ("vesopa_server/tool/invite/backoffice-memberships.png", f"{BACKOFFICE}/tool/invite/backoffice-memberships.png"),
    ("vesopa_server/tool/invite/metric-app.jpg", f"{BACKOFFICE}/tool/invite/metric-app.jpg"),
    ("vesopa_auth/scripts/grant-venue-apps.js", f"{AUTH}/scripts/grant-venue-apps.js"),
]


def sh(client, command, show=True):
    stdin, stdout, stderr = client.exec_command(command, timeout=600)
    stdin.close()
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    status = stdout.channel.recv_exit_status()
    if show and out.strip():
        print(out.rstrip())
    if err.strip():
        print(err.rstrip(), file=sys.stderr)
    return status, out


def must(client, command, show=True):
    status, out = sh(client, command, show)
    if status != 0:
        raise SystemExit(f"failed on the box (exit {status})")
    return out


def as_user(cmd):
    return f"su - {USER} -c \"{cmd}\""


def main():
    mail = "--no-mail" not in sys.argv
    client = connect()
    sftp = client.open_sftp()
    tag = secrets.token_hex(6)
    plans_file = f"/home/{USER}/.metric-plans-{tag}.json"
    key_file = f"/home/{USER}/.metric-key-{tag}"
    try:
        print("▶ upload")
        must(client, f"mkdir -p {BACKOFFICE}/tool/invite")
        for local, remote in UPLOADS:
            sftp.put(os.path.join(REPO, *local.split("/")), remote)
        must(client, f"chown -R {USER}:{USER} {BACKOFFICE}/src/mailer.js {BACKOFFICE}/tool {AUTH}/scripts/grant-venue-apps.js")

        print("▶ Metric's plans")
        mdb = f"$(grep -E '^DB_NAME=' {METRIC}/.env | cut -d= -f2)"
        must(client,
             f"mariadb {mdb} -N -B -e \"SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('id', id, 'name', name, "
             f"'description', description, 'max_vehicles', max_vehicles, 'is_default', is_default, "
             f"'active', active, 'epos_plan_id', epos_plan_id)), '[]') FROM plans\" > {plans_file} && "
             f"chown {USER}:{USER} {plans_file} && echo \"  $(grep -o '\"name\"' {plans_file} | wc -l) plan(s)\"")
        _, has_key = sh(client, f"grep -qE '^EPOS_PARTNER_KEY=.+' {METRIC}/.env && echo yes || echo no", show=False)
        new_key = has_key.strip() != "yes"

        print(f"▶ back office: {VENUE}")
        key_args = f" --new-key --key-out {key_file}" if new_key else ""
        out = must(client, as_user(
            f"cd {BACKOFFICE} && node tool/setup-partner-venue.js --name '{VENUE}' --email {EMAIL} "
            f"--person '{PERSON}' --modules memberships,vehicle_access --plans {plans_file}{key_args}"), show=False)
        import json
        result = json.loads([line for line in out.splitlines() if line.startswith("{")][-1])
        office = result["office"]
        print(f"  office {office['id']}: {office['name']} ({office['key']})")
        for m in result["modules"]:
            print(f"  module {m['module']}: allowed {m['allowed']}, on {m['enabled']}")
        for a in result["actions"]:
            print(f"  {a}")

        print("▶ Metric: plan ids and the EPOS link")
        for metric_id, epos_id in result["plans"].items():
            must(client, f"mariadb {mdb} -e \"UPDATE plans SET epos_plan_id = '{int(epos_id)}' "
                         f"WHERE id = {int(metric_id)} AND (epos_plan_id IS NULL OR epos_plan_id <> '{int(epos_id)}')\"")
        print(f"  {len(result['plans'])} plan(s) mapped")
        if result.get("key_written"):
            must(client,
                 f"cd {METRIC} && sed -i '/^EPOS_BASE_URL=/d;/^EPOS_PARTNER_KEY=/d' .env && "
                 f"{{ echo 'EPOS_BASE_URL=https://backoffice.vesopaepos.com'; printf 'EPOS_PARTNER_KEY=%s\\n' \"$(cat {key_file})\"; }} >> .env && "
                 f"rm -f {key_file} && echo '  partner key written to .env (not shown)'")
        else:
            print("  Metric already had a partner key; left as it is")
        must(client, as_user(f"PM2_HOME=/home/{USER}/.pm2 pm2 restart metric.vesopa.com --update-env") + " | tail -2")

        print("▶ Vesopa Auth: Matt's applications")
        must(client, as_user(f"cd {AUTH} && node scripts/grant-venue-apps.js {EMAIL}") + " 2>&1 | grep -v '^⚠'")

        print("▶ checks (after Metric's first sync)")
        sh(client,
           "sleep 20; "
           "curl -sS -o /dev/null -w '  metric health        %{http_code}\\n' https://metric.vesopa.com/health; "
           f"mariadb {mdb} -N -e \"SELECT CONCAT('  metric plans linked  ', SUM(epos_plan_id IS NOT NULL), ' of ', COUNT(*)) FROM plans; "
           f"SELECT CONCAT('  metric members linked ', SUM(epos_member_id IS NOT NULL), ' of ', COUNT(*)) FROM members WHERE status <> 'closed'\"; "
           f"grep -iE 'epos' {WEB}/../.pm2/logs/metric.vesopa.com-error.log 2>/dev/null | tail -3 || true")

        if mail:
            print("▶ invitation")
            must(client, as_user(f"cd {BACKOFFICE} && node tool/invite/send-metric-invite.js --send"))
        else:
            print("▶ invitation not sent (--no-mail)")
        print("\ndone.")
    finally:
        sh(client, f"rm -f {plans_file} {key_file}", show=False)
        sftp.close()
        client.close()


if __name__ == "__main__":
    main()
