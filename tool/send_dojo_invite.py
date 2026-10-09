"""Send the Dojo kick-off invitation from muzahid@vesopa.com (2026-10-08).

    python tool/send_dojo_invite.py                  # upload and show what it would send
    python tool/send_dojo_invite.py --send           # send to Dojo, cc Meirion
    python tool/send_dojo_invite.py --send --only info@vesopa.com   # one test copy
    python tool/send_dojo_invite.py --confirmed --send   # follow-up: 1:30pm accepted, Meet link
    python tool/send_dojo_invite.py --reminder2 --send   # 9 Oct midday: reminder, new Meet link
    python tool/send_dojo_invite.py --correction --send  # 9 Oct: 1:30pm not 8:30am, new Meet link
    python tool/send_dojo_invite.py --reminder --send    # 9 Oct morning: reminder for today 1:30pm

Owner, 2026-10-08: "You send by yourself like you sent to metric group". It
uploads vesopa_server/tool/invite/dojo to the back office on the Cloud box and
runs send-dojo-invite.js there, which goes out through Auth's SMTP settings
like the Metric invitation did. Changes nothing else on the server.
"""
import pathlib
import shlex
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from deploy_memberships import BACKOFFICE, USER, ssh  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "vesopa_server" / "tool" / "invite" / "dojo"


def main():
    flags = " ".join(shlex.quote(a) for a in sys.argv[1:])
    print("▶ upload")
    ssh("run", f"mkdir -p {BACKOFFICE}/tool/invite")
    ssh("put", str(SRC), f"{BACKOFFICE}/tool/invite/dojo")
    print("▶ send" if "--send" in sys.argv else "▶ dry run")
    ssh("run", f"cd {BACKOFFICE} && chown -R {USER}:{USER} tool/invite/dojo && "
               f"su {USER} -s /bin/bash -c {shlex.quote(f'node tool/invite/dojo/send-dojo-invite.js {flags}')}")


if __name__ == "__main__":
    main()
