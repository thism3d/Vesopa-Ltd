"""Release Dojo's second UAT round (2026-10-12): back office, Store, installers.

    python tool/release_dojo_1_16_3.py              # everything, in order
    python tool/release_dojo_1_16_3.py --from build # pick up at a step

Run from the repository root on the owner's Windows PC, after
`git pull origin main`. EPOS 1.16.3.0 carries 1.16.2.0's refund and receipt
fixes too (1.16.2.0 never went to the Store).

  deploy      python tool/deploy_memberships.py --backoffice: the Bill
              Report's Failed card payments tab
  build       flutter build windows + msix:create --store for EPOS 1.16.3.0
              and Display 1.6.22.0
  store       stage and commit it to the Microsoft Store, publishing
              automatically once certified (owner chose this 2026-10-08)
  installers  tool/build-installers.ps1 -Publish: the till's EXE installer, on
              admin.vesopa.com/downloads, ready to choose under Versions
"""
import os
import pathlib
import shutil
import re
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
STORE = ROOT / "ms-store-submission-client"
APPS = [
    # store key, folder, version, msix, notes
    ("vesopa-epos", "vesopa_epos", "1.16.3.0", "vesopa_epos/build/store/vesopa-epos-store.msix", "notes-1.16.3.0-epos.txt"),
    ("vesopa-display", "vesopa_epos_display", "1.6.22.0",
     "vesopa_epos_display/build/store/vesopa-display-store.msix", "notes-1.6.22.0-display.txt"),
]

# The Store's "What's new" text. Written here because ms-store-submission-
# client/notes-*.txt is git-ignored, so a notes file made in the cloud never
# reaches this PC (the 1.16.2 run stopped on exactly that).
NOTES = {
    "notes-1.16.3.0-epos.txt": """Version 1.16.3.0 - Card payments, signatures and refunds

Signatures: the till keeps following the card machine while a signature is checked. If no answer is given in 80 seconds the machine accepts it and the till shows the real result. A signature rejected after that still shows the payment as taken, so it is never lost.

Not confirmed results: the till keeps checking with Dojo by itself and records the payment the moment Dojo confirm it. Check status, Record as paid and Try again are always there.

Refunds on the card machine now work like payments: signature check, cancel, Check refund status, Record as refunded and Try again.

Receipts has a Failed card payments tab listing declined, cancelled and unconfirmed card payments with Dojo's reference and the reason.

Also: refunds cannot repeat, receipts show Paid, Card or Refunded, and receipt PDFs open on the computer. Member cards and app QR codes without the card prefix find the member. Exit application closes the till straight away. The till reaches the back office on computers missing the newer security certificates.
""",
    "notes-1.6.22.0-display.txt": """Version 1.6.22.0 - Card refunds on the customer screen

The customer screen now shows card refunds as well as card payments: what the card machine is asking for, then whether the refund went through.
""",
}
STEPS = ["deploy", "build", "store", "installers"]

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


def check_msix(msix, version):
    """Stop if the package is missing or still the previous version.

    msix:create has crashed on a read-only runner\\Release\\Images folder and
    left the last release's package in place, which would otherwise go to the
    Store as if it were this one.
    """
    path = ROOT / msix
    if not path.exists():
        raise SystemExit(f"✗ {msix} was not made")
    with zipfile.ZipFile(path) as z:
        manifest = z.read("AppxManifest.xml").decode("utf-8", "replace")
    found = re.search(r'<Identity[^>]*\sVersion="([^"]+)"', manifest)
    if not found or found.group(1) != version:
        raise SystemExit(f"✗ {msix} is version {found.group(1) if found else '?'}, not {version}."
                         " Delete it and run again with --from build")
    print(f"  {msix}: {version} ✓", flush=True)


def main():
    global current
    start = STEPS[0]
    if "--from" in sys.argv:
        start = sys.argv[sys.argv.index("--from") + 1]
        if start not in STEPS:
            raise SystemExit(f"--from takes one of {', '.join(STEPS)}")
    todo = STEPS[STEPS.index(start):]
    refused = []

    if "deploy" in todo:
        current = "deploy"
        run([sys.executable, "tool/deploy_memberships.py", "--backoffice"], step="back office deploy")

    if "build" in todo:
        current = "build"
        flutter, dart = tool("flutter"), tool("dart")
        for _key, folder, version, msix, _notes in APPS:
            run([flutter, "pub", "get"], ROOT / folder, step=f"{folder}: pub get")
            run([flutter, "build", "windows", "--release"], ROOT / folder, step=f"{folder}: build {version}")
            run([dart, "run", "msix:create", "--store"], ROOT / folder, step=f"{folder}: msix {version}")
            check_msix(msix, version)

    if "store" in todo:
        # Again here, so `--from store` never sends an old package either.
        for _key, _folder, version, msix, _notes in APPS:
            check_msix(msix, version)

        current = "store"
        node = tool("node")
        for name, text in NOTES.items():
            # LF only: Windows text mode writes CRLF, and the notes checker
            # then misses the blank line after the title.
            (STORE / name).write_bytes(text.encode("utf-8"))
        # One app's Store refusal (an earlier submission still in progress)
        # must not hold back the others or the installers.
        for key, _folder, version, msix, notes in APPS:
            try:
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
        # -Command, not -File: -File hands "till,display" over as one string,
        # which the installer script's list of apps refuses.
        run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
             "& .\\tool\\build-installers.ps1 -Publish -Apps till,display"
             " -Notes 'Dojo UAT 2: signature after 80 s, late rejection, refunds like payments, auto status check, failed card payments tab'"],
            step="EXE installers to admin.vesopa.com/downloads")

    if refused:
        print(f"\n✗ Not finished: {', '.join(refused)} did not go to the Store. Fix it, then run again with"
              " --from store. The back office and installers are done.")
    else:
        print("\n✓ Done. The back office is live, EPOS 1.16.3.0 and Display 1.6.22.0 are with Microsoft and publish"
              " themselves once certified, and the installers are on admin.vesopa.com/downloads.")


if __name__ == "__main__":
    main()
