"""Send a Teya email from muzahid@vesopa.com (2026-10-19).

    python tool/send_teya_mail.py --store            # upload and show what it would send
    python tool/send_teya_mail.py --store --send     # test company and store request, partnersupport@teya.com, cc Meirion

Uploads vesopa_server/tool/invite/teya to the back office and runs
send-teya-mail.js there, through Auth's SMTP settings like the Dojo emails.
"""
import pathlib
import shlex
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from deploy_memberships import BACKOFFICE, USER, ssh  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "vesopa_server" / "tool" / "invite" / "teya"


def main():
    flags = " ".join(shlex.quote(a) for a in sys.argv[1:])
    print("▶ upload")
    ssh("run", f"mkdir -p {BACKOFFICE}/tool/invite")
    ssh("put", str(SRC), f"{BACKOFFICE}/tool/invite/teya")
    print("▶ send" if "--send" in sys.argv else "▶ dry run")
    ssh("run", f"cd {BACKOFFICE} && chown -R {USER}:{USER} tool/invite/teya && "
               f"su {USER} -s /bin/bash -c {shlex.quote(f'node tool/invite/teya/send-teya-mail.js {flags}')}")


if __name__ == "__main__":
    main()
