"""Release EPOS 1.16.22, Kitchen 1.7.13 and Customer Display 1.7.2 (2026-10-20): automatic updates overnight.

    python tool/release_autoupdate_2026_10_20.py               # build, installers, pin, Store
    python tool/release_autoupdate_2026_10_20.py --from pin    # pick up at a step

The owner: "Every night Nicky updates the software of Pontardawe RFC, like that
do the updates automatically." With these versions, a version set for the
venue (admin.vesopa.com Versions) is installed by the app itself overnight
(02:00-06:00 on its own clock), a till only when no bill is open; in the day
it still asks. Installers go first and the automatic-update venues are pinned
straight after (tool/pin_auto_update_venues.py), then the Store.
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
    ("vesopa-display", "vesopa_epos_display", "1.7.2.0", "vesopa_epos_display/build/store/vesopa-display-store.msix", "notes-1.7.2.0-display.txt"),
    ("vesopa-epos", "vesopa_epos", "1.16.22.0", "vesopa_epos/build/store/vesopa-epos-store.msix", "notes-1.16.22.0-epos.txt"),
    ("vesopa-kitchen", "vesopa_epos_kitchen", "1.7.13.0", "vesopa_epos_kitchen/build/store/vesopa-kitchen-store.msix", "notes-1.7.13.0-kitchen.txt"),
]
STEPS = ["build", "installers", "pin", "store"]

# The Store's "What's new", LF only (see the 1.16.3 script).
NOTES = {
    "notes-1.7.2.0-display.txt": "Version 1.7.2.0 - Automatic updates overnight\n\n"
        "When Vesopa sets a new version for your venue, the customer display installs it by itself overnight. Nothing to press.\n",
    "notes-1.16.22.0-epos.txt": "Version 1.16.22.0 - Automatic updates overnight\n\n"
        "When Vesopa sets a new version for your venue, the till installs it by itself overnight when no bill is open. In the day it still asks first.\n",
    "notes-1.7.13.0-kitchen.txt": "Version 1.7.13.0 - Automatic updates overnight\n\n"
        "When Vesopa sets a new version for your venue, the kitchen screen installs it by itself overnight. In the day it still asks first.\n",
}


def check_msix(msix, version):
    """Stop if the package is missing or still the previous version (see memory: msix:create can crash)."""
    import re
    import zipfile
    path = ROOT / msix
    if not path.exists():
        raise SystemExit(f"✗ {msix} was not made")
    with zipfile.ZipFile(path) as z:
        manifest = z.read("AppxManifest.xml").decode("utf-8", "replace")
    found = re.search(r'<Identity[^>]*\sVersion="([^"]+)"', manifest)
    if not found or found.group(1) != version:
        raise SystemExit(f"✗ {msix} is version {found.group(1) if found else '?'}, not {version}. Run --from build again")
    print(f"  {msix}: {version} ✓", flush=True)


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

    if "build" in todo:
        current = "build"
        flutter, dart = tool("flutter"), tool("dart")
        for _key, folder, version, msix, _notes in APPS:
            run([flutter, "pub", "get"], ROOT / folder, step=f"{folder}: pub get")
            run([flutter, "build", "windows", "--release"], ROOT / folder, step=f"{folder}: build {version}")
            images = ROOT / folder / "build" / "windows" / "x64" / "runner" / "Release" / "Images"
            if images.exists():
                subprocess.run(["attrib", "-R", str(images), "/S", "/D"], shell=False)
                shutil.rmtree(images, ignore_errors=True)
            run([dart, "run", "msix:create", "--store"], ROOT / folder, step=f"{folder}: msix {version}")
            check_msix(msix, version)

    if "installers" in todo:
        current = "installers"
        run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
             "& .\\tool\\build-installers.ps1 -Publish -Apps display,till,kitchen"
             " -Notes 'Automatic updates overnight'"],
            step="EXE installers to admin.vesopa.com/downloads")

    if "pin" in todo:
        current = "pin"
        run([sys.executable, str(ROOT / "tool" / "pin_auto_update_venues.py")], step="Pin the automatic-update venues")

    if "store" in todo:
        current = "store"
        node = tool("node")
        for _key, _folder, version, msix, _notes in APPS:
            check_msix(msix, version)
        for name, text in NOTES.items():
            (STORE / name).write_bytes(text.encode("utf-8"))
        refused = []
        for key, _folder, version, msix, notes in APPS:
            try:
                run([node, "examples/cancel-pending.js", key], STORE, step=f"Store: cancel what {key} has in progress")
                run([node, "examples/stage.js", key, str(ROOT / msix), notes], STORE,
                    env={"STAGE_VERSION": version, "PUBLISH_MODE": "Immediate"}, step=f"Store: stage {key} {version}")
                run([node, "examples/commit.js", key], STORE, step=f"Store: commit {key} {version}")
            except SystemExit as e:
                print(e, flush=True)
                refused.append(key)
        if refused:
            print(f"\n✗ Not sent to the Store: {', '.join(refused)}. The others went.", flush=True)

    print("\n✓ Done. Installers are on admin.vesopa.com/downloads, the automatic-update venues are pinned to them,"
          " and the Store has the rest.")


if __name__ == "__main__":
    main()
