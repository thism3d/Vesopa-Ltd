"""Release EPOS 1.16.38, Kitchen 1.7.23 and Display 1.7.10 (2026-11-03).

    python tool/release_hardware_2026_11_03.py                  # build, signed installers, Store
    python tool/release_hardware_2026_11_03.py --to msix     # stop before the Store, to test
    python tool/release_hardware_2026_11_03.py --from store

Settings > Network and hardware: the PC's adapters, Wi-Fi hotspot and who is
on it, file and printer sharing, Bluetooth, USB and serial devices, restarts;
admin changes through the Vesopa network helper service (windows/nethelper).

Order: build, then the installers (which sign every exe and DLL in the build,
the helper included), then the Store package from that same signed build
(msix --build-windows false), so the helper Windows asks about carries
Vesopa's signature in both. Nothing is pinned: a venue moves only when the
owner says.
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
    ("vesopa-epos", "vesopa_epos", "1.16.38.0", "vesopa_epos/build/store/vesopa-epos-store.msix", "notes-1.16.38.0-epos.txt"),
    ("vesopa-kitchen", "vesopa_epos_kitchen", "1.7.23.0", "vesopa_epos_kitchen/build/store/vesopa-kitchen-store.msix", "notes-1.7.23.0-kitchen.txt"),
    ("vesopa-display", "vesopa_epos_display", "1.7.10.0", "vesopa_epos_display/build/store/vesopa-display-store.msix", "notes-1.7.10.0-display.txt"),
]
# The same as each pubspec's windows_build_args: obfuscated, symbols kept here.
BUILD_ARGS = ["build", "windows", "--release", "--obfuscate", "--split-debug-info=build/symbols"]
STEPS = ["build", "installers", "msix", "store"]

# The Store's "What's new", LF only (see the 1.16.3 script).
NOTES = {
    "notes-1.16.38.0-epos.txt": "Version 1.16.38.0 - Network and hardware\n\n"
        "Settings > Network and hardware shows this PC's network adapters, Wi-Fi, Bluetooth, USB and serial devices, with warnings and restarts.\n"
        "Share this till's network as a Wi-Fi hotspot so Go phones and screens join it when the venue Wi-Fi fails, and see who is on it.\n"
        "Turn file and printer sharing and network discovery on or off, and make the venue network Private.\n",
    "notes-1.7.23.0-kitchen.txt": "Version 1.7.23.0 - Network and hardware\n\n"
        "Settings > Network and hardware shows this PC's network, Wi-Fi hotspot, Bluetooth and USB devices, with warnings and restarts.\n",
    "notes-1.7.10.0-display.txt": "Version 1.7.10.0 - Network and hardware\n\n"
        "Settings > Network and hardware shows this PC's network, Wi-Fi hotspot, Bluetooth and USB devices, with warnings and restarts.\n",
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
    if "--to" in sys.argv:
        todo = [t for t in todo if STEPS.index(t) <= STEPS.index(sys.argv[sys.argv.index("--to") + 1])]
    if "--no-installers" in sys.argv:
        todo = [t for t in todo if t != "installers"]

    if "build" in todo:
        current = "build"
        flutter = tool("flutter")
        for _key, folder, version, _msix, _notes in APPS:
            run([flutter, "pub", "get"], ROOT / folder, step=f"{folder}: pub get")
            run([flutter, *BUILD_ARGS], ROOT / folder, step=f"{folder}: build {version}")

    if "installers" in todo:
        current = "installers"
        run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
             "& .\\tool\\build-installers.ps1 -Publish -SkipFlutter -Apps till,kitchen,display"
             " -Notes 'Network and hardware: hotspot, adapters, sharing, Bluetooth, USB'"],
            step="EXE installers to admin.vesopa.com/downloads")

    if "msix" in todo:
        current = "msix"
        dart = tool("dart")
        for _key, folder, version, msix, _notes in APPS:
            images = ROOT / folder / "build" / "windows" / "x64" / "runner" / "Release" / "Images"
            if images.exists():
                subprocess.run(["attrib", "-R", str(images), "/S", "/D"], shell=False)
                shutil.rmtree(images, ignore_errors=True)
            run([dart, "run", "msix:create", "--store", "--build-windows", "false"], ROOT / folder, step=f"{folder}: msix {version}")
            check_msix(msix, version)

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
