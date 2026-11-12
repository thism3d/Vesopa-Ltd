"""Send EPOS 1.16.52 to the Microsoft Store (2026-11-12): Z/X cash drawer lines always shown.

    python tool/release_store_2026_11_12.py msix     # make and check the packages
    python tool/release_store_2026_11_12.py store    # send them

Made from the signed builds in the short-path clone (C:\\Users\\azureuser\\gtmp\\vb):
the display's video plugin passes Windows' path limit in a worktree. Sent from
the main checkout, which holds the Store's credentials.
"""
import os
import pathlib
import re
import shutil
import subprocess
import sys
import zipfile

BUILD = pathlib.Path(r"C:\Users\azureuser\gtmp\vb")
STORE = pathlib.Path(r"C:\Users\azureuser\develop\Vesopa-Ltd\ms-store-submission-client")
APPS = [
    ("vesopa-epos", "vesopa_epos", "1.16.52.0", "vesopa-epos-store.msix",
     "Version 1.16.52.0 - Clearer X and Z reports\n\n"
     "The cash drawer section of the X and Z reports always shows the float, paid in, paid out, "
     "cashback given and the cash expected in the drawer, at 0.00 too, on screen and on paper.\n"),
]

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


def tool(name):
    found = shutil.which(name) or shutil.which(f"{name}.bat") or shutil.which(f"{name}.cmd")
    if not found:
        raise SystemExit(f"{name} is not on PATH")
    return found


def package(folder, msix):
    return BUILD / folder / "build" / "store" / msix


def check(folder, version, msix):
    """Stop if the package is missing or still the previous version."""
    path = package(folder, msix)
    if not path.exists():
        raise SystemExit(f"{path} was not made")
    with zipfile.ZipFile(path) as z:
        if z.testzip() is not None:
            raise SystemExit(f"{path} is damaged")
        manifest = z.read("AppxManifest.xml").decode("utf-8", "replace")
    found = re.search(r'<Identity[^>]*\sVersion="([^"]+)"', manifest)
    if not found or found.group(1) != version:
        raise SystemExit(f"{path} is version {found.group(1) if found else '?'}, not {version}")
    print(f"{folder}: {version} ok, {path.stat().st_size // 1048576} MB", flush=True)


def make():
    dart = tool("dart")
    for _key, folder, version, msix, _notes in APPS:
        images = BUILD / folder / "build" / "windows" / "x64" / "runner" / "Release" / "Images"
        if images.exists():
            subprocess.run(["attrib", "-R", str(images), "/S", "/D"], shell=False)
            shutil.rmtree(images, ignore_errors=True)
        r = subprocess.run([dart, "run", "msix:create", "--store", "--build-windows", "false"],
                           cwd=BUILD / folder, stdin=subprocess.DEVNULL)
        if r.returncode:
            print(f"{folder}: msix:create answered {r.returncode}, checking what it left", flush=True)
        check(folder, version, msix)


def send():
    node = tool("node")
    for _key, folder, version, msix, _notes in APPS:
        check(folder, version, msix)
    refused = []
    for key, folder, version, msix, notes in APPS:
        name = f"notes-{version}-{key}.txt"
        (STORE / name).write_bytes(notes.encode("utf-8"))
        env = {**os.environ, "STAGE_VERSION": version, "PUBLISH_MODE": "Immediate"}
        for args in (["examples/cancel-pending.js", key],
                     ["examples/stage.js", key, str(package(folder, msix)), name],
                     ["examples/commit.js", key]):
            print(f"\n{key}: {args[0]}", flush=True)
            if subprocess.run([node, *args], cwd=STORE, env=env, stdin=subprocess.DEVNULL).returncode:
                refused.append(key)
                break
    print(f"\nNot sent: {', '.join(refused)}" if refused else "\nSent to the Store.", flush=True)
    if refused:
        raise SystemExit(1)


if __name__ == "__main__":
    # A name after the step limits it to that app: store vesopa-epos.
    if len(sys.argv) > 2:
        APPS[:] = [a for a in APPS if a[0] == sys.argv[2]]
    {"msix": make, "store": send}[sys.argv[1]]()
