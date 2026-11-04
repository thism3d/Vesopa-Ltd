"""Copy the kitchen screen's and the customer display's data code into Vesopa
Go, which runs as either (owner, 2026-11-03: "single app can be EPOS,
display, kitchen but only one at a time").

    python tool/sync_go_modes.py

Edit these in vesopa_epos_kitchen and vesopa_epos_display, then run this. The
board, the offline queue, the local link and the server fallback are the
Windows apps' own; Go writes only its own screens over them, and its own
session (vesopa_go/lib/kitchen/data/kitchen_session.dart, providers.dart),
which take the credential from Go's sign-in rather than a typed one.

Imports are rewritten to Go's places: the local link is Go's one copy
(lib/data/lan, the same file as the till's), the constants are Go's, and the
Windows-only machine fingerprint is a stub that answers null; Go's own
trusted_roots.dart has only the words for a failed connection.
"""
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
GO = REPO / "vesopa_go" / "lib"

KITCHEN = REPO / "vesopa_epos_kitchen" / "lib" / "data"
KITCHEN_FILES = [
    "ticket.dart",
    "ticket_board.dart",
    "live_link.dart",
    "dinein_inbox.dart",
    "dinein_orders.dart",
    "kitchen_stock.dart",
    "screen_profile.dart",
    "kitchen_branding.dart",
    "kitchen_api.dart",
]

DISPLAY = REPO / "vesopa_epos_display" / "lib" / "data"
DISPLAY_FILES = [
    "till_link.dart",
    "basket_feed.dart",
    "control.dart",
]

REWRITES = [
    ("import 'lan/lan_link.dart';", "import '../../data/lan/lan_link.dart';"),
    ("import 'lan/lan_service.dart';", "import '../../data/lan/lan_service.dart';"),
    ("import '../config/constants.dart';", "import 'kitchen_constants.dart';"),
]

HEADER = "// Copied from {src} by tool/sync_go_modes.py. Edit it there, then run that.\n"


def copy(src_dir: Path, names, dest: Path):
    dest.mkdir(parents=True, exist_ok=True)
    for name in names:
        text = (src_dir / name).read_bytes().decode("utf-8")
        nl = "\r\n" if "\r\n" in text else "\n"
        for a, b in REWRITES:
            text = text.replace(a.replace("\n", nl), b.replace("\n", nl))
        rel = (src_dir / name).relative_to(REPO).as_posix()
        text = HEADER.format(src=rel).replace("\n", nl) + text
        (dest / name).write_bytes(text.encode("utf-8"))
    print(f"{dest.relative_to(REPO).as_posix()}: {len(names)} files")


copy(KITCHEN, KITCHEN_FILES, GO / "kitchen" / "data")
copy(DISPLAY, DISPLAY_FILES, GO / "display" / "data")
