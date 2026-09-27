"""Make somebody at Metric Group the administrator of Metric Membership.

    python vesopa_metric_server/scripts/setup-admin.py m.hammond@metricgroup.co.uk "Matt Hammond"

Run from the repository root on the machine that deploys (see deploy.py), after
deploy.py --apply. On the Cloud box it:

  1. copies vesopa_auth/scripts/make-org-admin.js and set-password.js into the
     live Vesopa Auth, and runs make-org-admin.js: the account (address
     verified), the "Metric Group" organisation owned by them with the
     vesopa-metric application moved into it, and admin on the application.
     Not Vesopa staff, and not a member (the owner: "except customer").
  2. sets their password, if one is given: METRIC_ADMIN_PASSWORD in this
     machine's environment, or typed at the prompt. It goes to the box as a
     mode-600 file that set-password.js reads and this script deletes, never
     on a command line, and is never printed.
  3. adds the address to METRIC_ADMIN_EMAILS in metric.vesopa.com's .env, so
     /admin (the staff console) lets them in, and restarts the app.

Idempotent: running it again changes nothing but the password.
"""

import getpass
import os
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from deploy import REPO, connect, vesopa_ssh  # noqa: E402

W = "/home/vesopasoftware/web"
AUTH = f"{W}/auth.vesopa.com/private/nodeapp"
METRIC = f"{W}/metric.vesopa.com/private/nodeapp"
USER = "vesopasoftware"


def run(client, cmd):
    if vesopa_ssh.run(client, cmd) != 0:
        raise SystemExit(f"failed on the box: {cmd.split('&&')[-1].strip()[:80]}")


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    email, name = sys.argv[1].strip().lower(), sys.argv[2].strip()
    if "'" in email + name or '"' in email + name:
        raise SystemExit("no quotes in the email or name, please")
    password = os.environ.get("METRIC_ADMIN_PASSWORD")
    if password is None and sys.stdin.isatty():
        password = getpass.getpass(f"Password for {email} (Enter for none): ")

    client = connect()
    sftp = client.open_sftp()
    try:
        for script in ("make-org-admin.js", "set-password.js"):
            sftp.put(os.path.join(REPO, "vesopa_auth", "scripts", script), f"{AUTH}/scripts/{script}")
        run(client, f"chown {USER}:{USER} {AUTH}/scripts/make-org-admin.js {AUTH}/scripts/set-password.js")

        print(f"Vesopa Auth: {email} as Metric Group's administrator")
        run(client, f"su - {USER} -c \"cd {AUTH} && node scripts/make-org-admin.js '{email}' '{name}' metric-group 'Metric Group' vesopa-metric\"")

        if password:
            secret = f"{AUTH}/.pw-{secrets.token_hex(8)}"
            with sftp.open(secret, "w") as f:
                f.chmod(0o600)
                f.write(password)
            try:
                run(client, f"chown {USER}:{USER} {secret} && su - {USER} -c \"cd {AUTH} && VESOPA_SET_PASSWORD_FILE={secret} node scripts/set-password.js '{email}'\"")
            finally:
                vesopa_ssh.run(client, f"rm -f {secret}")
        else:
            print("no password given: they sign in with an emailed code")

        print("metric.vesopa.com: staff console access")
        run(client, (
            f"cd {METRIC} && cur=$(grep '^METRIC_ADMIN_EMAILS=' .env | cut -d= -f2-) && "
            f"case \",$cur,\" in *,{email},*) echo '  already listed';; "
            f"*) sed -i \"s/^METRIC_ADMIN_EMAILS=.*/METRIC_ADMIN_EMAILS=${{cur:+$cur,}}{email}/\" .env && echo '  added';; esac && "
            f"grep '^METRIC_ADMIN_EMAILS=' .env && su - {USER} -c 'pm2 restart metric.vesopa.com --update-env >/dev/null' && echo '  restarted'"
        ))
        client_id = ""
        try:
            with sftp.open(f"{METRIC}/.env") as f:
                for line in f.read().decode().splitlines():
                    if line.startswith("VESOPA_METRIC_CLIENT_ID="):
                        client_id = line.split("=", 1)[1]
        except IOError:
            pass
        print(f"\ndone. {email} manages the sign-in at https://auth.vesopa.com/developers"
              f" (client {client_id or 'see .env'}) and the members at https://metric.vesopa.com/admin")
    finally:
        sftp.close()
        client.close()


if __name__ == "__main__":
    main()
