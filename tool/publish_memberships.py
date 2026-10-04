"""Finish the membership release (2026-10-05): Metric live, then the Store.

    python tool/publish_memberships.py

Run from the repository root on the owner's Windows folder, after
`git pull origin main`. It:

  1. deploys Metric Membership (tool/deploy_memberships.py --metric)
  2. stages and commits the four Store packages already built on this PC:
     EPOS 1.13.0.0, Display 1.6.15.0, Express 1.0.8.0, Loyalty 1.0.9.0.
     Staged with manual publish: nothing reaches a device until Publish now
     is pressed in Partner Center.

Stops at the first failure and says which step.
"""
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
STORE = ROOT / "ms-store-submission-client"
APPS = [
    ("vesopa-epos", "1.13.0.0", "vesopa_epos/build/store/vesopa-epos-store.msix", "notes-1.13.0.0-epos.txt"),
    ("vesopa-display", "1.6.15.0", "vesopa_epos_display/build/store/vesopa-display-store.msix", "notes-1.6.15.0-display.txt"),
    ("vesopa-express", "1.0.8.0", "vesopa_express/build/store/vesopa-express-store.msix", "notes-1.0.8.0-express.txt"),
    ("vesopa-loyalty", "1.0.9.0", "vesopa_loyalty/build/store/vesopa-loyalty-store.msix", "notes-1.0.9.0-loyalty.txt"),
]

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


def run(args, cwd, env=None, step=""):
    print(f"▶ {step}")
    r = subprocess.run(args, cwd=str(cwd), env={**os.environ, **(env or {})})
    if r.returncode:
        raise SystemExit(f"stopped: {step} failed")


def main():
    run([sys.executable, "tool/deploy_memberships.py", "--metric"], ROOT, step="Metric Membership deploy")
    for app, version, msix, notes in APPS:
        if not (ROOT / msix).exists():
            raise SystemExit(f"stopped: {msix} is not built")
        run(["node", "examples/stage.js", app, str(ROOT / msix), notes], STORE,
            env={"STAGE_VERSION": version}, step=f"stage {app} {version}")
        run(["node", "examples/commit.js", app], STORE, step=f"commit {app} {version}")
    print("✓ Metric is live and all four submissions are with Microsoft. Press Publish now in Partner Center once certified.")


if __name__ == "__main__":
    main()
