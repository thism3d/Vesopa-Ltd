"""Give Matt Hammond a new Vesopa password and write it into his handover PDF.

    python tool/metric_handover_pdf.py

Run from the repository root on the owner's PC (the machine that deploys). It:

  1. makes a strong random password (never printed, never written to the repo);
  2. sets it on m.hammond@metricgroup.co.uk in the live Vesopa Auth through
     vesopa_auth/scripts/set-account-password.py, with the password passed in
     the child's environment only;
  3. fills the admin and staff password boxes in
     MetricMembership/handover/Metric-Membership-Handover-Pack.pdf and saves the
     result to the Desktop as Metric-Membership-Handover-Pack.pdf. The staff
     password comes from METRIC_TEST_PASSWORD (this machine's environment, or
     .env.claude / .env.claude-tools in this checkout). If it is not there, the
     staff box stays blank and fillable.

The PDF on the Desktop holds live passwords: attach it to the email to Matt,
then delete it. Running this again makes a new password and a new PDF.
"""

import os
import pathlib
import secrets
import string
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
EMAIL = "m.hammond@metricgroup.co.uk"
SOURCE = REPO / "MetricMembership" / "handover" / "Metric-Membership-Handover-Pack.pdf"
FILL = REPO / "tool" / "pdf-fill"


def make_password(length=16):
    # Letters and digits plus two symbols that no shell or form mangles: the
    # last one was set from a command line where "$(" was eaten.
    alphabet = string.ascii_letters + string.digits
    while True:
        core = [secrets.choice(alphabet) for _ in range(length - 2)]
        core.insert(secrets.randbelow(len(core)), secrets.choice("-_"))
        core.insert(secrets.randbelow(len(core)), secrets.choice("-_"))
        pw = "".join(core)
        if any(c.islower() for c in pw) and any(c.isupper() for c in pw) and any(c.isdigit() for c in pw):
            return pw


def from_env_files(name):
    if os.environ.get(name):
        return os.environ[name]
    for file in (".env.claude-tools", ".env.claude"):
        path = REPO / file
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def main():
    if not SOURCE.exists():
        raise SystemExit(f"missing {SOURCE}; git pull first")
    desktop = pathlib.Path.home() / "Desktop"
    if not desktop.exists():
        desktop = pathlib.Path.home()
    out = desktop / "Metric-Membership-Handover-Pack.pdf"

    node = "node.exe" if os.name == "nt" else "node"
    npm = "npm.cmd" if os.name == "nt" else "npm"
    if not (FILL / "node_modules" / "pdf-lib").exists():
        print("installing pdf-lib for the PDF step")
        subprocess.run([npm, "install", "--silent", "--no-audit", "--no-fund"], cwd=FILL, check=True)

    password = make_password()
    env = dict(os.environ, VESOPA_ACCOUNT_PASSWORD=password)
    print(f"1/2 setting a new password on {EMAIL}")
    subprocess.run(
        [sys.executable, str(REPO / "vesopa_auth" / "scripts" / "set-account-password.py"), EMAIL],
        cwd=REPO, env=env, stdin=subprocess.DEVNULL, check=True,
    )

    print("2/2 writing the passwords into the PDF")
    env = dict(os.environ, HANDOVER_ADMIN_PW=password, HANDOVER_STAFF_PW=from_env_files("METRIC_TEST_PASSWORD"))
    subprocess.run(
        [node, str(FILL / "fill.mjs"), str(SOURCE), str(out),
         "admin_password=HANDOVER_ADMIN_PW", "staff_password=HANDOVER_STAFF_PW"],
        env=env, check=True,
    )
    print(f"\ndone. {out}\nIt holds live passwords: attach it to the email to Matt, then delete it.")


if __name__ == "__main__":
    main()
