"""Give auth.vesopa.com its own mail login: no-reply@vesopa.com on mail.vesopa.com.

    $env:NOREPLY_PW = "<password>"; python tool/setup_noreply_mail.py

Asked for by the owner on 2026-10-12. On the Cloud box it:

  1. creates no-reply@vesopa.com under whichever Hestia user holds the
     vesopa.com mail domain, or resets its password if it already exists
  2. proves the login on mail.vesopa.com:587 (STARTTLS) BEFORE changing anything
  3. backs up auth's .env, then sets SMTP_HOST, SMTP_PORT, SMTP_SECURE,
     SMTP_USER, SMTP_PASSWORD and MAIL_FROM
  4. restarts auth.vesopa.com by name and checks /health and the app's own
     mail settings

The password comes from $NOREPLY_PW (or a prompt) and is never written to the
repo, a log or the screen.

vesopa.com's primary MX is Microsoft 365, so mail TO no-reply@vesopa.com from
outside still goes there; this mailbox exists only so the box can authenticate
the sender.
"""
import getpass
import os
import pathlib
import shlex
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

ROOT = pathlib.Path(__file__).resolve().parents[1]
SSH = ROOT / "tool" / "auth_ssh.py"
STAGE = "/root/.noreply_mail"


def ssh(*args):
    result = subprocess.run([sys.executable, str(SSH), *args], cwd=str(ROOT), text=True, capture_output=True)
    if result.stdout:
        print(result.stdout.rstrip())
    if result.returncode != 0:
        print(result.stderr.rstrip(), file=sys.stderr)
    return result.returncode


def main():
    password = os.environ.get("NOREPLY_PW") or getpass.getpass("no-reply@vesopa.com password: ")
    if not password:
        raise SystemExit("no password given")
    ssh("put", str(ROOT / "tool" / "noreply_mail"), STAGE)
    code = ssh(
        "run",
        f"NOREPLY_PW={shlex.quote(password)} bash {STAGE}/remote.sh; rc=$?; rm -rf {STAGE}; exit $rc",
    )
    raise SystemExit(code)


if __name__ == "__main__":
    main()
