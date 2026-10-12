"""Make info@pontardawerfc.com send, receive and forward (2026-10-12).

    python tool/pontardawe_mail_fix.py --check     what it would change
    $env:MAIL_PW = '<the mailbox password>'
    python tool/pontardawe_mail_fix.py             fix, save SMTP settings, test

Run from the repository root on the owner's PC (needs .env.claude-tools).
  1. PontardaweRFC/website/scripts/mail-forward.sh with club.json
     email_forwards_to: the mailbox keeps its copy, a copy goes on to that
     address through the relay, and a refused per-domain relay login is removed;
  2. with $MAIL_PW: SMTP_HOST/PORT/SECURE/USER/PASS/FROM in pontardawerfc.com's
     own .env on the box (only those keys; the value is never printed);
  3. one test message from outside to info@ (handed to Exim on the box), then
     the Exim log lines for it: the mailbox delivery and the forwarded copy.
"""
import json
import os
import pathlib
import shlex
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "MetricMembership" / "server" / "scripts"))
from deploy import connect, vesopa_ssh  # noqa: E402

SITE = ROOT / "PontardaweRFC" / "website"
APP_ENV = "/home/vesopasoftware/web/pontardawerfc.com/private/nodeapp/.env"
ADDRESS = "info@pontardawerfc.com"

SET_ENV = r'''
set -eu
F=__ENV__
[ -f "$F" ] || { echo "  ✗ no $F"; exit 1; }
cp -p "$F" "$F.bak_pre_smtp_$(date +%Y%m%d_%H%M%S)"
setkey() { python3 - "$F" "$1" "$2" <<'PY'
import sys
path, key, value = sys.argv[1:]
lines = [l for l in open(path).read().splitlines() if not l.startswith(key + "=")]
lines.append(f"{key}={value}")
open(path, "w").write("\n".join(lines) + "\n")
PY
}
setkey SMTP_HOST mail.pontardawerfc.com
setkey SMTP_PORT 587
setkey SMTP_SECURE false
setkey SMTP_USER __ADDR__
setkey SMTP_PASS "$MAIL_PW"
setkey SMTP_FROM "Pontardawe RFC <__ADDR__>"
chmod 600 "$F"
echo "  ✓ SMTP settings saved in $F: $(grep -c '^SMTP_' "$F") SMTP_ keys (password not shown)"
'''

TEST = r'''
ID="fwdtest-$(date +%s)"
printf 'From: Forward test <forward-test@vesopasoftware.com>\nTo: __ADDR__\nSubject: pontardawerfc.com inbox and forward test %s\nMessage-ID: <%s@vesopasoftware.com>\n\nSent to __ADDR__ to check it lands in the mailbox and is forwarded.\n' "$ID" "$ID" \
  | exim -f forward-test@vesopasoftware.com __ADDR__
echo "  ✓ test message handed to Exim: $ID"
sleep 12
QID=$(grep -F "id=$ID@" /var/log/exim4/mainlog | tail -1 | awk '{print $3}')
echo "  Exim log for $QID:"
[ -n "$QID" ] && grep -F "$QID" /var/log/exim4/mainlog | sed 's/^/    /'
'''


def run(client, script, env=""):
    return vesopa_ssh.run(client, f"{env}bash -c " + shlex.quote(script))


def main():
    check = "--check" in sys.argv
    password = os.environ.get("MAIL_PW", "")
    if not check and not password:
        raise SystemExit("set $env:MAIL_PW to the mailbox password first (or use --check)")
    club = json.loads((SITE / "content" / "club.json").read_text(encoding="utf-8"))
    to = club["email_forwards_to"]
    forward = (SITE / "scripts" / "mail-forward.sh").read_text(encoding="utf-8").replace("\r\n", "\n")
    client = connect()
    try:
        print(f"▶ {ADDRESS}: mailbox, relay login and forward to {to}")
        script = f"cat > /root/mail-forward.sh <<'SH'\n{forward}\nSH\nbash /root/mail-forward.sh {'--check ' if check else ''}{shlex.quote(to)}"
        if run(client, script) != 0:
            raise SystemExit("mail-forward.sh failed: nothing else was changed")
        if check:
            print("check only: nothing changed.")
            return
        print("▶ SMTP settings in the site's .env")
        run(client, SET_ENV.replace("__ENV__", APP_ENV).replace("__ADDR__", ADDRESS),
            env=f"MAIL_PW={shlex.quote(password)} ")
        print("▶ test: a message from outside to the mailbox")
        run(client, TEST.replace("__ADDR__", ADDRESS))
        time.sleep(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
