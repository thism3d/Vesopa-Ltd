"""Release EPOS 1.16.36, Kitchen 1.7.21 and Display 1.7.8 (2026-11-02).

    python tool/release_devices_2026_11_02.py                  # build, signed installers, Store
    python tool/release_devices_2026_11_02.py --no-installers  # build and Store only
    python tool/release_devices_2026_11_02.py --from installers

Connected devices for Vesopa support: every device on the local link, the ones
heard only over the internet, and the till's printers and card machine, with
test connection, test speed, identify and a full check; make main till,
restart and disconnect. Behind the day's support code on the till, and for
Vesopa support in the back office. Includes 1.16.35 / 1.7.20 / 1.7.7 (staff
drink slips, network setup). Installers are signed. Nothing is pinned: a venue
moves only when the owner says.
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
    ("vesopa-epos", "vesopa_epos", "1.16.36.0", "vesopa_epos/build/store/vesopa-epos-store.msix", "notes-1.16.36.0-epos.txt"),
    ("vesopa-kitchen", "vesopa_epos_kitchen", "1.7.21.0", "vesopa_epos_kitchen/build/store/vesopa-kitchen-store.msix", "notes-1.7.21.0-kitchen.txt"),
    ("vesopa-display", "vesopa_epos_display", "1.7.8.0", "vesopa_epos_display/build/store/vesopa-display-store.msix", "notes-1.7.8.0-display.txt"),
]
# The same as each pubspec's windows_build_args: obfuscated, symbols kept here.
BUILD_ARGS = ["build", "windows", "--release", "--obfuscate", "--split-debug-info=build/symbols"]
STEPS = ["build", "installers", "store"]

# The Store's "What's new", LF only (see the 1.16.3 script).
NOTES = {
    "notes-1.16.36.0-epos.txt": "Version 1.16.36.0 - Connected devices\n\n"
        "Vesopa support can see every till, kitchen screen and customer display on the venue network, and the printers and card machine, and test each one, from this till or the back office.\n"
        "Products marked Staff item print a slip with a barcode and code when sold; scan it or type it to redeem the drink, once. Works with the internet down.\n"
        "Settings > Local network shows this till's address and ports, and takes addresses for networks where devices do not find each other.\n",
    "notes-1.7.21.0-kitchen.txt": "Version 1.7.21.0 - Easier support\n\n"
        "Vesopa support can test this screen's connection and show a banner on it to find it.\n"
        "Orders being cooked stay on the board when the internet comes back, and everything marked done offline reaches the cloud.\n",
    "notes-1.7.8.0-display.txt": "Version 1.7.8.0 - Easier support\n\n"
        "Vesopa support can test this display's connection and show a banner on it to find it.\n"
        "Reaches the main till directly on networks that block discovery, and remembers it through a power cut.\n",
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
    if "--no-installers" in sys.argv:
        todo = [t for t in todo if t != "installers"]

    if "build" in todo:
        current = "build"
        flutter, dart = tool("flutter"), tool("dart")
        for _key, folder, version, msix, _notes in APPS:
            run([flutter, "pub", "get"], ROOT / folder, step=f"{folder}: pub get")
            run([flutter, *BUILD_ARGS], ROOT / folder, step=f"{folder}: build {version}")
            images = ROOT / folder / "build" / "windows" / "x64" / "runner" / "Release" / "Images"
            if images.exists():
                subprocess.run(["attrib", "-R", str(images), "/S", "/D"], shell=False)
                shutil.rmtree(images, ignore_errors=True)
            run([dart, "run", "msix:create", "--store"], ROOT / folder, step=f"{folder}: msix {version}")
            check_msix(msix, version)

    if "installers" in todo:
        current = "installers"
        run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
             "& .\\tool\\build-installers.ps1 -Publish -Apps till,kitchen,display"
             " -Notes 'Connected devices, staff drink slips, network setup'"],
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
