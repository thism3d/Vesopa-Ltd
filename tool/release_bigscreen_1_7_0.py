"""Release Customer Display 1.7.0, EPOS 1.16.16 and Kitchen 1.7.11 (2026-10-17).

    python tool/release_bigscreen_1_7_0.py               # build, Store, installers
    python tool/release_bigscreen_1_7_0.py --from store  # pick up at a step

The customer display on a pub's big screen: TV sizes, touch off, tiles (all
off by default), set from the till; sign in with the till's email and
password; a display on another computer through the back office; a local
WebSocket on the same PC. The EPOS opens once per Windows account and has a
customer display button on its top bar. The kitchen screen signs in with an
email and password, no venue field.
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
    ("vesopa-display", "vesopa_epos_display", "1.7.0.0", "vesopa_epos_display/build/store/vesopa-display-store.msix", "notes-1.7.0.0-display.txt"),
    ("vesopa-epos", "vesopa_epos", "1.16.16.0", "vesopa_epos/build/store/vesopa-epos-store.msix", "notes-1.16.16.0-epos.txt"),
    ("vesopa-kitchen", "vesopa_epos_kitchen", "1.7.11.0", "vesopa_epos_kitchen/build/store/vesopa-kitchen-store.msix", "notes-1.7.11.0-kitchen.txt"),
]
STEPS = ["build", "store", "installers"]

# The Store's "What's new", LF only (see the 1.16.3 script).
NOTES = {
    "notes-1.7.0.0-display.txt": "Version 1.7.0.0 - Made for big screens\n\n"
        "Choose the TV size (32 to 100 inch) so the bill reads from across the room, turn touch off for a screen nobody can reach, "
        "and add tiles: clock, date, welcome, today's special, QR code, cards accepted and the running total. All off unless you turn "
        "them on, set from the till or from the display. Sign in with your till email and password. A display can now run on a "
        "different computer from the till, and on the same computer it updates instantly.\n",
    "notes-1.16.16.0-epos.txt": "Version 1.16.16.0 - Customer display controls\n\n"
        "A customer display button on the top bar opens its settings: TV size, touch, tiles and everything else. Connect a customer "
        "display on another computer with its code. Opening Vesopa EPOS a second time now brings the open window to the front.\n",
    "notes-1.7.11.0-kitchen.txt": "Version 1.7.11.0 - Simpler sign in\n\n"
        "Sign the kitchen screen in with your email and password, the same as the till. No venue to type.\n",
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
            # A read-only Images folder left by an earlier build makes
            # msix:create crash before it writes the package.
            images = ROOT / folder / "build" / "windows" / "x64" / "runner" / "Release" / "Images"
            if images.exists():
                subprocess.run(["attrib", "-R", str(images), "/S", "/D"], shell=False)
                shutil.rmtree(images, ignore_errors=True)
            run([dart, "run", "msix:create", "--store"], ROOT / folder, step=f"{folder}: msix {version}")
            check_msix(msix, version)

    if "store" in todo:
        current = "store"
        node = tool("node")
        for _key, _folder, version, msix, _notes in APPS:
            check_msix(msix, version)
        for name, text in NOTES.items():
            (STORE / name).write_bytes(text.encode("utf-8"))
        # One app's Store refusal (an earlier submission still in progress)
        # must not hold back the others or the installers.
        refused = []
        for key, _folder, version, msix, notes in APPS:
            try:
                # "If any update in certification, cancel and update with the
                # latest versions" (the owner, 2026-10-09).
                run([node, "examples/cancel-pending.js", key], STORE, step=f"Store: cancel what {key} has in progress")
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
        # -Command, not -File: -File hands "till,kitchen" over as one string,
        # which the installer script's list of apps refuses.
        run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
             "& .\\tool\\build-installers.ps1 -Publish -Apps display,till,kitchen"
             " -Notes 'Customer display for big screens, EPOS display controls, kitchen email sign-in'"],
            step="EXE installers to admin.vesopa.com/downloads")

    print("\n✓ Done. The Store submission is with Microsoft"
          " and publish themselves once certified, and the installers are on"
          " admin.vesopa.com/downloads.")


if __name__ == "__main__":
    main()
