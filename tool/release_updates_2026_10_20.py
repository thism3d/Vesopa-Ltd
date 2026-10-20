"""Release EPOS 1.16.22, Kitchen 1.7.13 and Customer Display 1.7.2 (2026-10-20): updates on admin's say-so.

    python tool/release_updates_2026_10_20.py               # build, installers, Store
    python tool/release_updates_2026_10_20.py --from store  # pick up at a step

On admin.vesopa.com Versions a venue's version can now be set to install now
or at a set time, with nobody pressing anything: a 30-second countdown like
Windows, unsent sales sent first, and the till opens on the bill it had.
Force installs even with a bill open. Ask on screen stays the default.
Nothing is pinned by this script: a venue moves only when the owner says.
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
STEPS = ["build", "installers", "store"]

# The Store's "What's new", LF only (see the 1.16.3 script).
NOTES = {
    "notes-1.7.2.0-display.txt": "Version 1.7.2.0 - Updates when Vesopa says\n\n"
        "When Vesopa updates your venue, the customer display installs it at the time set, after a 30 second countdown.\n",
    "notes-1.16.22.0-epos.txt": "Version 1.16.22.0 - Updates when Vesopa says\n\n"
        "When Vesopa updates your venue, the till installs it at the time set, after a 30 second countdown. Unsent sales are sent first and the till opens again on the bill it had.\n",
    "notes-1.7.13.0-kitchen.txt": "Version 1.7.13.0 - Updates when Vesopa says\n\n"
        "When Vesopa updates your venue, the kitchen screen installs it at the time set, after a 30 second countdown.\n",
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
             " -Notes 'Updates when Vesopa says'"],
            step="EXE installers to admin.vesopa.com/downloads")

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

    print("\n✓ Done. Installers are on admin.vesopa.com/downloads"
          " and the Store has the rest.")


if __name__ == "__main__":
    main()
