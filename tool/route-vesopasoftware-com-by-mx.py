"""Send mail made on the Cloud box for @vesopasoftware.com to Google, by MX.

    python tool/route-vesopasoftware-com-by-mx.py

Owner's choice on 2026-10-05: "Yes, route to Google". Same fault, same fix as
tool/route-vesopa-com-by-mx.py (vesopa.com, 2026-10-01). vesopasoftware.com's
mailboxes are on Google Workspace (MX 1 smtp.google.com); the Cloud box is only
its backup MX (10 mail.vesopa.com), but HestiaCP also lists it as a local mail
domain. So everything the box itself sent to info@vesopasoftware.com (the
Metric invitation copy, Auth's admin notices, back office replies) went into
the box's own local mailbox and never reached Gmail.

On the box it widens the existing vesopa_com_by_mx router to cover both
domains: mail MADE here for either goes out through the outgoing relay, which
delivers by MX. Mail arriving from outside as backup MX, and every mailbox, are
untouched. It backs up the template, regenerates, checks that
info@vesopasoftware.com now takes that router, restarts Exim, and puts the
backup back if any check fails. Needs vesopa_com_by_mx in place already.
Idempotent.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "MetricMembership", "server", "scripts"))
from deploy import connect, vesopa_ssh  # noqa: E402

REMOTE = r'''
set -e
C=/etc/exim4/exim4.conf.template
if ! grep -q "^vesopa_com_by_mx:" "$C"; then
  echo "vesopa_com_by_mx is not there: run tool/route-vesopa-com-by-mx.py first"
  exit 1
fi
if awk '/^vesopa_com_by_mx:/{f=1} f&&/domains =/{print; exit}' "$C" | grep -q vesopasoftware.com; then
  echo "vesopasoftware.com already routed by MX"
else
  B="$C.bak_pre_vesopasoftware_mx_$(date +%Y%m%d_%H%M%S)"
  cp -p "$C" "$B"
  echo "backed up to $B"
  python3 - "$C" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
i = s.index("vesopa_com_by_mx:")
j = s.index("domains = vesopa.com\n", i)
s = s[:j] + "domains = vesopa.com : vesopasoftware.com\n" + s[j + len("domains = vesopa.com\n"):]
s = s.replace("# vesopa.com mail lives on Microsoft 365 (MX 1)",
              "# vesopasoftware.com (Google Workspace, MX 1) added 2026-10-05 by\n"
              "# tool/route-vesopasoftware-com-by-mx.py.\n"
              "# vesopa.com mail lives on Microsoft 365 (MX 1)", 1)
open(p, "w").write(s)
PY
  update-exim4.conf
  if ! exim -bV >/dev/null 2>&1 \
     || ! exim -bt -f no-reply@vesopa.com info@vesopasoftware.com 2>&1 | grep -q "router = vesopa_com_by_mx" \
     || ! exim -bt -f no-reply@vesopa.com info@vesopa.com 2>&1 | grep -q "router = vesopa_com_by_mx"; then
    cp -p "$B" "$C"
    update-exim4.conf
    echo "CHECK FAILED: the backup is back in place and nothing changed"
    exit 1
  fi
  systemctl restart exim4
  echo "exim restarted"
fi
for a in info@vesopasoftware.com info@vesopa.com; do
  echo "route for $a from this box:"
  exim -bt -f no-reply@vesopa.com $a 2>&1 | grep -E "router|transport|host" | head -3
done
'''


def main():
    client = connect()
    try:
        status = vesopa_ssh.run(client, REMOTE)
        if status != 0:
            raise SystemExit("failed on the box: read the output above")
        print("\ndone. Mail made on the Cloud box for @vesopasoftware.com now goes to Google.")
    finally:
        client.close()


if __name__ == "__main__":
    main()
