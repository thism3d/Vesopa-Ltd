"""Send the 30-day free trial mail to every waiting demo request (2026-10-18).

    python tool/send_trial_invites.py                                  # list who would get it
    python tool/send_trial_invites.py --send --only info@vesopa.com    # one test copy
    python tool/send_trial_invites.py --send                           # everyone, one email each
    python tool/send_trial_invites.py --approve [--send]               # 19 Oct: back office logins (TryVeposa), 30-day trial, login mail

Owner, 2026-10-18: "Send trial to these 30 people from muzahid@vesopa.com,
send every email separately ... being Vesopa Developer". Uploads
vesopa_server/tool/invite/trial to the back office on the Cloud box and runs
send-trial.js there, which goes out through Auth's SMTP settings like the Dojo
invitations. Reads demo_request only; changes nothing else on the server.
"""
import pathlib
import shlex
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from deploy_memberships import BACKOFFICE, USER, ssh  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "vesopa_server" / "tool" / "invite" / "trial"


def main():
    args = [a for a in sys.argv[1:] if a != "--approve"]
    script = "approve-trial.js" if "--approve" in sys.argv else "send-trial.js"
    flags = " ".join(shlex.quote(a) for a in args)
    print("▶ upload")
    ssh("run", f"mkdir -p {BACKOFFICE}/tool/invite")
    ssh("put", str(SRC), f"{BACKOFFICE}/tool/invite/trial")
    print("▶ send" if "--send" in sys.argv else "▶ dry run")
    ssh("run", f"cd {BACKOFFICE} && chown -R {USER}:{USER} tool/invite/trial && "
               f"su {USER} -s /bin/bash -c {shlex.quote(f'node tool/invite/trial/{script} {flags}')}")


if __name__ == "__main__":
    main()
