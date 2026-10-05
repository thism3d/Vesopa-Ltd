"""Send the back office's mail from vesopa.com (2026-10-05).

    python tool/backoffice_mail_sender.py

Owner's choice on 2026-10-05: "Switch to vesopa.com". The outgoing relay
(SMTP2GO) refuses every message whose From is @vesopaepos.com ("550 From header
sender domain not verified"), so sign-in codes, receipts and reminders from
support@ / menu@vesopaepos.com never reached anyone outside. vesopa.com is
verified there, which is why auth.vesopa.com's codes (no-reply@vesopa.com) get
through. This makes the back office send the same way. It:

  1. uploads src/mailer.js (answers go to MAIL_REPLY_TO) and tool/mail-test.js
  2. backs up .env, then sets MAIL_FROM=no-reply@vesopa.com and
     MAIL_REPLY_TO=info@vesopasoftware.com (and MENU_MAIL_FROM likewise when
     the menu@ mailbox is configured); the mailbox login is left as it is
  3. restarts the back office
  4. sends a test to info@vesopa.com (which goes out through the relay) and
     shows the mail log's verdict: "250" means accepted

Re-runnable. To undo: restore the .env.bak-mailfrom-* copy it prints, restart.
No mailbox is created anywhere.
"""
import pathlib
import shutil
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from deploy_memberships import BACKOFFICE, PM2, USER, ssh  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
SENDER = "no-reply@vesopa.com"
REPLY_TO = "info@vesopasoftware.com"
TEST_TO = "info@vesopa.com"


def setting(key, value, only_if=None):
    line = f"{key}={value}"
    cmd = f"(grep -q '^{key}=' .env && sed -i 's|^{key}=.*|{line}|' .env || echo '{line}' >> .env)"
    return f"(grep -qE '^{only_if}=.+' .env && {cmd} || true)" if only_if else cmd


def main():
    print("▶ upload")
    stage = pathlib.Path(tempfile.mkdtemp(prefix="mailfrom-"))
    try:
        (stage / "src").mkdir()
        (stage / "tool").mkdir()
        shutil.copy(ROOT / "vesopa_server" / "src" / "mailer.js", stage / "src" / "mailer.js")
        shutil.copy(ROOT / "vesopa_server" / "tool" / "mail-test.js", stage / "tool" / "mail-test.js")
        for part in ["src", "tool"]:
            ssh("put", str(stage / part), f"{BACKOFFICE}/{part}")
    finally:
        shutil.rmtree(stage, ignore_errors=True)

    print("▶ .env: sender")
    ssh("run",
        f"cd {BACKOFFICE} && b=.env.bak-mailfrom-$(date +%Y%m%d%H%M%S) && cp -p .env $b && echo \"  backup $b\" && "
        f"{setting('MAIL_FROM', SENDER)} && {setting('MAIL_REPLY_TO', REPLY_TO)} && "
        f"{setting('MENU_MAIL_FROM', SENDER, only_if='MENU_SMTP_USER')} && "
        f"chown {USER}:{USER} .env src/mailer.js tool/mail-test.js && "
        "grep -E '^(MAIL_FROM|MAIL_REPLY_TO|MENU_MAIL_FROM)=' .env | sed 's/^/  /'")

    print("▶ restart")
    ssh("run", PM2.format("restart backoffice.vesopaepos.com --update-env") + " | tail -2")

    print(f"▶ test to {TEST_TO}")
    ssh("run",
        f"cd {BACKOFFICE} && su - {USER} -c 'cd {BACKOFFICE} && node tool/mail-test.js {TEST_TO}'; "
        f"grep -qE '^MENU_SMTP_USER=.+' .env && su - {USER} -c 'cd {BACKOFFICE} && node tool/mail-test.js {TEST_TO} menu'; "
        "sleep 8; log=$(ls /var/log/exim4/mainlog /var/log/exim/main.log 2>/dev/null | head -1); "
        f"echo \"  mail log ($log):\"; tail -n 300 \"$log\" | grep -E '{SENDER}|{TEST_TO}' | tail -6 | sed 's/^/  /'",
        check=False)
    print("\ndone. A line with '=> info@vesopa.com' and '250' means the relay accepted it; "
          "'**' with '550' means it was refused.")


if __name__ == "__main__":
    main()
