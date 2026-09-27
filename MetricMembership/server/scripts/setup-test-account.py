"""The Microsoft Store testers' login for Metric Membership.

    python MetricMembership/server/scripts/setup-test-account.py [email] ["name"]

The account defaults to staff@metricgroup.co.uk, "Alex Carter" (the owner,
2026-09-27: "Create an account staff@metricgroup.co.uk ... Name 'Alex'").

Run from the repository root on the machine that deploys (see deploy.py), with
METRIC_TEST_PASSWORD in this machine's environment (or typed at the prompt).
On the Cloud box it:

  1. copies create-person.js, set-password.js and subject-for.js into the live
     Vesopa Auth, and makes the account a Vesopa
     account with its address verified on the owner's word;
  2. sets its password. It goes to the box as a mode-600 file that
     set-password.js reads and this script deletes, never on a command line,
     and is never printed;
  3. makes it an approved Metric member with three cars and a week of visits
     (seed-test-member.js), ready before its first sign-in;
  4. adds it to METRIC_ADMIN_EMAILS in metric.vesopa.com's .env, so it opens
     the staff console at /admin too, and restarts the app.

Idempotent, and sends no email: running it again changes nothing but the
password.
"""

import getpass
import os
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from deploy import REPO, connect, vesopa_ssh  # noqa: E402

EMAIL = "staff@metricgroup.co.uk"
NAME = "Alex Carter"
W = "/home/vesopasoftware/web"
AUTH = f"{W}/auth.vesopa.com/private/nodeapp"
METRIC = f"{W}/metric.vesopa.com/private/nodeapp"
USER = "vesopasoftware"


def run(client, cmd):
    if vesopa_ssh.run(client, cmd) != 0:
        raise SystemExit(f"failed on the box: {cmd.split('&&')[-1].strip()[:80]}")


def output(client, cmd):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=120)
    stdin.close()
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    if stdout.channel.recv_exit_status() != 0:
        raise SystemExit(f"failed on the box: {err or out}")
    return out


def main():
    global EMAIL, NAME
    if len(sys.argv) > 1:
        EMAIL = sys.argv[1].strip().lower()
    if len(sys.argv) > 2:
        NAME = sys.argv[2].strip()
    if "'" in EMAIL + NAME or '"' in EMAIL + NAME or "@" not in EMAIL:
        raise SystemExit("an email address and a name without quotes, please")
    password = os.environ.get("METRIC_TEST_PASSWORD")
    if password is None and sys.stdin.isatty():
        password = getpass.getpass(f"Password for {EMAIL}: ")
    if not password or len(password) < 10:
        raise SystemExit("set METRIC_TEST_PASSWORD (10 characters or more) first")

    client = connect()
    sftp = client.open_sftp()
    try:
        scripts = ("create-person.js", "set-password.js", "subject-for.js")
        for script in scripts:
            sftp.put(os.path.join(REPO, "vesopa_auth", "scripts", script), f"{AUTH}/scripts/{script}")
        run(client, f"mkdir -p {METRIC}/scripts")
        sftp.put(os.path.join(HERE, "seed-test-member.js"), f"{METRIC}/scripts/seed-test-member.js")
        owned = " ".join([f"{AUTH}/scripts/{s}" for s in scripts] + [f"{METRIC}/scripts"])
        run(client, f"chown -R {USER}:{USER} {owned}")

        print(f"Vesopa Auth: {EMAIL}")
        run(client, f"su - {USER} -c \"cd {AUTH} && node scripts/create-person.js '{EMAIL}' '{NAME}'\"")

        secret = f"{AUTH}/.pw-{secrets.token_hex(8)}"
        with sftp.open(secret, "w") as f:
            f.chmod(0o600)
            f.write(password)
        try:
            run(client, f"chown {USER}:{USER} {secret} && su - {USER} -c \"cd {AUTH} && VESOPA_SET_PASSWORD_FILE={secret} node scripts/set-password.js '{EMAIL}'\"")
        finally:
            vesopa_ssh.run(client, f"rm -f {secret}")

        sub = output(client, f"su - {USER} -c \"cd {AUTH} && node scripts/subject-for.js '{EMAIL}' vesopa-metric\"")
        if not sub or "'" in sub or " " in sub:
            raise SystemExit("Vesopa Auth did not give a subject for the account")

        print("metric.vesopa.com: approved member with cars and visits")
        run(client, f"su - {USER} -c \"cd {METRIC} && node scripts/seed-test-member.js '{sub}' '{EMAIL}' '{NAME}'\"")

        print("metric.vesopa.com: staff console access")
        run(client, (
            f"cd {METRIC} && (grep -q '^METRIC_ADMIN_EMAILS=' .env || echo 'METRIC_ADMIN_EMAILS=' >> .env) && "
            f"cur=$(grep '^METRIC_ADMIN_EMAILS=' .env | cut -d= -f2-) && "
            f"case \",$cur,\" in *,{EMAIL},*) echo '  already listed';; "
            f"*) sed -i \"s/^METRIC_ADMIN_EMAILS=.*/METRIC_ADMIN_EMAILS=${{cur:+$cur,}}{EMAIL}/\" .env && echo '  added';; esac && "
            f"su - {USER} -c 'pm2 restart metric.vesopa.com --update-env >/dev/null' && echo '  restarted'"
        ))
        print(f"\ndone. The Store testers sign in at https://metric.vesopa.com (and /admin) as {EMAIL}"
              " with the password you set.")
    finally:
        sftp.close()
        client.close()


if __name__ == "__main__":
    main()
