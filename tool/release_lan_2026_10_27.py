"""Release EPOS 1.16.33, Kitchen 1.7.16 and Customer Display 1.7.6 (2026-10-27): the local link.

    python tool/release_lan_2026_10_27.py               # build, installers, Store
    python tool/release_lan_2026_10_27.py --from store  # pick up at a step

The venue's devices talk over its own network (docs/LOCAL_LINK_PLAN.md): one
main till, the others connected to it, another taking over if it goes; tables,
kitchen tickets, customer displays on other computers and, with the internet
down, points, gift cards and vouchers. Encrypted, this venue's devices only.
Also: show/hide on the till's password boxes, and every build obfuscated with
its symbols kept in build/symbols. Nothing is pinned by this script: a venue
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
    ("vesopa-epos", "vesopa_epos", "1.16.33.0", "vesopa_epos/build/store/vesopa-epos-store.msix", "notes-1.16.33.0-epos.txt"),
    ("vesopa-kitchen", "vesopa_epos_kitchen", "1.7.16.0", "vesopa_epos_kitchen/build/store/vesopa-kitchen-store.msix", "notes-1.7.16.0-kitchen.txt"),
    ("vesopa-display", "vesopa_epos_display", "1.7.6.0", "vesopa_epos_display/build/store/vesopa-display-store.msix", "notes-1.7.6.0-display.txt"),
]
# The same as each pubspec's windows_build_args: obfuscated, symbols kept here.
BUILD_ARGS = ["build", "windows", "--release", "--obfuscate", "--split-debug-info=build/symbols"]
STEPS = ["build", "installers", "store"]

# The Store's "What's new", LF only (see the 1.16.3 script).
NOTES = {
    "notes-1.16.33.0-epos.txt": "Version 1.16.33.0 - Tills talk on the venue network\n\n"
        "Tills share tables, send kitchen tickets and drive customer displays over the venue's own network, so they keep going when the internet is down. One till is the main one; another takes over if it goes off. Only this venue's devices can join, and the link is encrypted.\n"
        "With the internet down, points, gift cards and vouchers keep working through the main till and catch up with the cloud when it is back.\n"
        "Show or hide the password when signing in or out.\n",
    "notes-1.7.16.0-kitchen.txt": "Version 1.7.16.0 - Orders straight from the tills\n\n"
        "Kitchen screens get tickets from the tills over the venue's own network, in milliseconds and with the internet down, and see each other's bumps at once.\n",
    "notes-1.7.6.0-display.txt": "Version 1.7.6.0 - Follows the till on the venue network\n\n"
        "A customer display on another computer follows its till over the venue's own network as well as the internet.\n",
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
             " -Notes 'Local link between tills, kitchen screens and displays'"],
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
