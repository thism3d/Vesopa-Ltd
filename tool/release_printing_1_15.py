"""Release the printing fixes (2026-10-08): back office, admin, Store, installers.

    python tool/release_printing_1_15.py            # everything, in order
    python tool/release_printing_1_15.py --from store   # pick up at a step

Run from the repository root on the owner's Windows PC, after
`git pull origin main`. Steps, stopping at the first failure:

  deploy      back office (schema_print_options.sql, app_updates store_ok,
              the tick box fix, Paper and cutting) and admin.vesopa.com
              (Store versions), via tool/deploy_memberships.py
  build       flutter build windows + msix:create --store for the five apps:
              EPOS 1.15.0.0, Kitchen 1.7.4.0, Display 1.6.18.0,
              Express 1.0.11.0, Loyalty 1.0.11.0
  store       stage and commit each to the Microsoft Store, publishing
              automatically once certified (owner chose this 2026-10-08)
  installers  tool/build-installers.ps1 -Publish: the EXE installers, on
              admin.vesopa.com/downloads, ready to choose under Versions
"""
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
STORE = ROOT / "ms-store-submission-client"
APPS = [
    # store key, folder, version, msix, notes
    ("vesopa-epos", "vesopa_epos", "1.15.0.0", "vesopa_epos/build/store/vesopa-epos-store.msix", "notes-1.15.0.0-epos.txt"),
    ("vesopa-kitchen", "vesopa_epos_kitchen", "1.7.4.0",
     "vesopa_epos_kitchen/build/store/vesopa-kitchen-store.msix", "notes-1.7.4.0-kitchen.txt"),
    ("vesopa-express", "vesopa_express", "1.0.11.0",
     "vesopa_express/build/store/vesopa-express-store.msix", "notes-1.0.11.0-express.txt"),
    ("vesopa-loyalty", "vesopa_loyalty", "1.0.11.0",
     "vesopa_loyalty/build/store/vesopa-loyalty-store.msix", "notes-1.0.11.0-loyalty.txt"),
    ("vesopa-display", "vesopa_epos_display", "1.6.18.0",
     "vesopa_epos_display/build/store/vesopa-display-store.msix", "notes-1.6.18.0-display.txt"),
]
STEPS = ["deploy", "build", "store", "installers"]

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


def run(args, cwd=ROOT, env=None, step=""):
    print(f"\n▶ {step}", flush=True)
    r = subprocess.run(args, cwd=str(cwd), env={**os.environ, **(env or {})}, shell=False)
    if r.returncode:
        raise SystemExit(f"✗ stopped: {step} failed. Fix it, then run again with --from {current}")


def tool(name):
    found = shutil.which(name) or shutil.which(f"{name}.bat") or shutil.which(f"{name}.cmd")
    if not found:
        raise SystemExit(f"✗ {name} is not on PATH")
    return found


current = STEPS[0]


def main():
    global current
    start = STEPS[0]
    if "--from" in sys.argv:
        start = sys.argv[sys.argv.index("--from") + 1]
        if start not in STEPS:
            raise SystemExit(f"--from takes one of {', '.join(STEPS)}")
    todo = STEPS[STEPS.index(start):]

    if "deploy" in todo:
        current = "deploy"
        run([sys.executable, "tool/deploy_memberships.py", "--backoffice"], step="back office deploy")
        run([sys.executable, "tool/deploy_memberships.py", "--admin"], step="admin.vesopa.com deploy")

    if "build" in todo:
        current = "build"
        flutter, dart = tool("flutter"), tool("dart")
        for _key, folder, version, msix, _notes in APPS:
            run([flutter, "pub", "get"], ROOT / folder, step=f"{folder}: pub get")
            run([flutter, "build", "windows", "--release"], ROOT / folder, step=f"{folder}: build {version}")
            run([dart, "run", "msix:create", "--store"], ROOT / folder, step=f"{folder}: msix {version}")
            if not (ROOT / msix).exists():
                raise SystemExit(f"✗ {msix} was not made")

    if "store" in todo:
        current = "store"
        node = tool("node")
        # One app's Store refusal (an earlier submission still in progress)
        # must not hold back the others or the installers.
        refused = []
        for key, _folder, version, msix, notes in APPS:
            try:
                run([node, "examples/stage.js", key, str(ROOT / msix), notes], STORE,
                    env={"STAGE_VERSION": version, "PUBLISH_MODE": "Immediate"}, step=f"Store: stage {key} {version}")
                run([node, "examples/commit.js", key], STORE, step=f"Store: commit {key} {version}")
            except SystemExit as e:
                print(e, flush=True)
                refused.append(key)
        if refused:
            print(f"\n✗ Not sent to the Store: {', '.join(refused)}. The others went.", flush=True)

    if "installers" in todo:
        current = "installers"
        run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tool\\build-installers.ps1",
             "-Publish",
             "-Notes", "Printing that finishes every slip, print modes, Store copies follow Versions"],
            step="EXE installers to admin.vesopa.com/downloads")

    print("\n✓ Done. Back office and admin are live, the five Store submissions are with Microsoft"
          " and publish themselves once certified, and the installers are on"
          " admin.vesopa.com/downloads.")


if __name__ == "__main__":
    main()
