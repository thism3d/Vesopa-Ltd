"""Copy Settings > Network and hardware from the till to the kitchen and
display apps: the Dart page and service, the runner's Windows code and the
network helper service. Edit them in vesopa_epos, then run this.

    python tool/sync_hardware.py

The three runners are the same files, so they are copied whole; each app's
top-level windows/CMakeLists.txt gets the helper's add_subdirectory once.
"""
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TILL = REPO / "vesopa_epos"
APPS = ["vesopa_epos_kitchen", "vesopa_epos_display"]
FILES = [
    "lib/data/hardware.dart",
    "lib/ui/hardware_page.dart",
    "windows/runner/hardware.cpp",
    "windows/runner/hardware.h",
    "windows/runner/flutter_window.cpp",
    "windows/runner/CMakeLists.txt",
    "windows/nethelper/nethelper.cpp",
    "windows/nethelper/CMakeLists.txt",
]
HOOK = '# The network helper service, installed next to the runner (nethelper/).\nadd_subdirectory("nethelper")\n\n'
ANCHOR = 'set(INSTALL_BUNDLE_DATA_DIR "${CMAKE_INSTALL_PREFIX}/data")'

for app in APPS:
    dest = REPO / app
    for f in FILES:
        (dest / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(TILL / f, dest / f)
    cm = dest / "windows" / "CMakeLists.txt"
    text = cm.read_bytes().decode("utf-8")
    if 'add_subdirectory("nethelper")' not in text:
        nl = "\r\n" if "\r\n" in text else "\n"
        text = text.replace(ANCHOR, HOOK.replace("\n", nl) + ANCHOR, 1)
        cm.write_bytes(text.encode("utf-8"))
    print(f"{app}: {len(FILES)} files")
