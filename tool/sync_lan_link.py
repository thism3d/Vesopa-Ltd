"""Copy the venue's local link library from the till into the kitchen and display apps.

    python tool/sync_lan_link.py          # copy
    python tool/sync_lan_link.py --check  # fail if a copy differs (for CI or a release)

lib/data/lan/lan_link.dart and lan_service.dart are written once, in the till
(vesopa_epos), and used unchanged by the kitchen screen and the customer
display (2026-10-27, docs/LOCAL_LINK_PLAN.md). Three apps, one protocol.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "vesopa_epos" / "lib" / "data" / "lan"
FILES = ["lan_link.dart", "lan_service.dart"]
# Vesopa Go too (2026-10-27): tables and bills from the tills over the venue's
# own network, the main till's address from the back office (iOS blocks UDP).
APPS = ["vesopa_epos_kitchen", "vesopa_epos_display", "vesopa_go"]


def main():
    check = "--check" in sys.argv
    differs = []
    for app in APPS:
        dest = ROOT / app / "lib" / "data" / "lan"
        dest.mkdir(parents=True, exist_ok=True)
        for name in FILES:
            src = (SOURCE / name).read_bytes()
            target = dest / name
            if target.exists() and target.read_bytes() == src:
                continue
            if check:
                differs.append(f"{app}/lib/data/lan/{name}")
            else:
                target.write_bytes(src)
                print(f"  copied {name} -> {app}")
    if differs:
        raise SystemExit("✗ out of step: " + ", ".join(differs) + " (run tool/sync_lan_link.py)")
    print("✓ local link library in step")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    main()
