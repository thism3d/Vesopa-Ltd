"""Files Vesopa Go shares with the till, copied as they are.

    python vesopa_go/tool/sync_go_shared.py         # copy the till's version into Go
    python vesopa_go/tool/sync_go_shared.py --check # exit 1 if Go's copy has drifted

Edit these in the till (vesopa_epos), then run this. The till is the
specification for Go (docs/GO_PARITY_PLAN.md): one file, not two that drift.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SHARED = [
    "lib/data/till_permissions.dart",
]

drift = []
for rel in SHARED:
    till = (REPO / "vesopa_epos" / rel).read_bytes()
    go = REPO / "vesopa_go" / rel
    if not go.exists() or go.read_bytes() != till:
        drift.append(rel)
        if "--check" not in sys.argv:
            go.write_bytes(till)
for rel in drift:
    print(("drifted: " if "--check" in sys.argv else "copied: ") + rel)
sys.exit(1 if drift and "--check" in sys.argv else 0)
