"""Release refunds and receipts (2026-10-12): back office, Store, installers.

    python tool/release_refunds_1_16_2.py              # everything, in order
    python tool/release_refunds_1_16_2.py --from build # pick up at a step

Run from the repository root on the owner's Windows PC, after
`git pull origin main`. EPOS 1.16.2.0 carries 1.16.1.0's member cards too.

  deploy      python tool/deploy_memberships.py --backoffice: receipt status,
              the receipt PDF file and schema_refund_lines.sql
  build       flutter build windows + msix:create --store for EPOS 1.16.2.0
  store       stage and commit it to the Microsoft Store, publishing
              automatically once certified (owner chose this 2026-10-08)
  installers  tool/build-installers.ps1 -Publish: the till's EXE installer, on
              admin.vesopa.com/downloads, ready to choose under Versions
"""
import os
import pathlib
import shutil
import re
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
STORE = ROOT / "ms-store-submission-client"
APPS = [
    # store key, folder, version, msix, notes
    ("vesopa-epos", "vesopa_epos", "1.16.2.0", "vesopa_epos/build/store/vesopa-epos-store.msix", "notes-1.16.2.0-epos.txt"),
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


def check_msix(msix, version):
    """Stop if the package is missing or still the previous version.

    msix:create has crashed on a read-only runner\\Release\\Images folder and
    left the last release's package in place, which would otherwise go to the
    Store as if it were this one.
    """
    path = ROOT / msix
    if not path.exists():
        raise SystemExit(f"✗ {msix} was not made")
    with zipfile.ZipFile(path) as z:
        manifest = z.read("AppxManifest.xml").decode("utf-8", "replace")
    found = re.search(r'<Identity[^>]*\sVersion="([^"]+)"', manifest)
    if not found or found.group(1) != version:
        raise SystemExit(f"✗ {msix} is version {found.group(1) if found else '?'}, not {version}."
                         " Delete it and run again with --from build")
    print(f"  {msix}: {version} ✓", flush=True)


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

    if "build" in todo:
        current = "build"
        flutter, dart = tool("flutter"), tool("dart")
        for _key, folder, version, msix, _notes in APPS:
            run([flutter, "pub", "get"], ROOT / folder, step=f"{folder}: pub get")
            run([flutter, "build", "windows", "--release"], ROOT / folder, step=f"{folder}: build {version}")
            run([dart, "run", "msix:create", "--store"], ROOT / folder, step=f"{folder}: msix {version}")
            check_msix(msix, version)

    if "store" in todo:
        # Again here, so `--from store` never sends an old package either.
        for _key, _folder, version, msix, _notes in APPS:
            check_msix(msix, version)

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
        # -Command, not -File: -File hands "till,display" over as one string,
        # which the installer script's list of apps refuses.
        run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
             "& .\\tool\\build-installers.ps1 -Publish -Apps till"
             " -Notes 'Refunds cannot repeat; receipts show Paid, Card or Refunded; refund result screen; keyed card Cancel'"],
            step="EXE installers to admin.vesopa.com/downloads")

    print("\n✓ Done. The back office is live, EPOS 1.16.2.0 is with Microsoft and publishes itself once certified,"
          " and its installer is on admin.vesopa.com/downloads.")


if __name__ == "__main__":
    main()
