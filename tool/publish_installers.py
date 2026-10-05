"""Put a Windows installer on admin.vesopa.com's Downloads (2026-10-05).

    python tool/publish_installers.py <app> <version> <installer.exe> [--signed] [--notes "..."]

Run from the repository root on the owner's PC; tool/build-installers.ps1
-Publish calls it for each installer it built. It copies the file to the
Cloud box (34.63.118.67) beside admin.vesopa.com and registers it with
vesopa_admin/scripts/add-release.js, which hashes it and adds it to
Downloads. Choosing it for venues is then done on admin.vesopa.com/versions.

app is one of: till, kitchen, display, express, loyalty.

Nothing a venue runs changes: a new version only reaches a device when
somebody chooses it under Versions AND update prompts are switched on.
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
USER = "vesopasoftware"
PRIVATE = f"/home/{USER}/web/admin.vesopa.com/private"
APP = f"{PRIVATE}/nodeapp"
APPS = ["till", "kitchen", "display", "express", "loyalty"]

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

# The server login, the same way deploy_memberships.py finds it.
sys.path.insert(0, str(ROOT / "tool"))
import deploy_memberships  # noqa: E402,F401  (loads .env.claude into the environment)


def ssh(*args):
    r = subprocess.run([sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), *args],
                       cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", capture_output=True)
    out = (r.stdout or "").rstrip()
    if out:
        print(out)
    if r.returncode != 0:
        print((r.stderr or "").rstrip(), file=sys.stderr)
        raise SystemExit(f"failed: {args[0]}")
    return out


def main():
    args = sys.argv[1:]
    signed = "--signed" in args
    if signed:
        args.remove("--signed")
    notes = None
    if "--notes" in args:
        i = args.index("--notes")
        notes = args[i + 1] if i + 1 < len(args) else None
        del args[i:i + 2]
    if len(args) != 3 or args[0] not in APPS:
        raise SystemExit(__doc__)
    app, version, exe = args
    exe = pathlib.Path(exe).resolve()
    if not exe.is_file() or exe.suffix.lower() != ".exe":
        raise SystemExit(f"{exe} is not an installer")

    stamp = time.strftime("%Y%m%d_%H%M%S")
    remote = f"{PRIVATE}/release-uploads/{stamp}-{app}"
    stage = pathlib.Path(tempfile.mkdtemp(prefix="installer-"))
    try:
        shutil.copy(exe, stage / exe.name)
        print(f"▶ {app} {version}: uploading {exe.name} ({exe.stat().st_size / 1048576:.1f} MB)")
        ssh("put", str(stage), remote)
    finally:
        shutil.rmtree(stage, ignore_errors=True)

    quote = lambda s: "'" + str(s).replace("'", "'\"'\"'") + "'"  # noqa: E731
    extra = (" --signed" if signed else "") + (f" --notes {quote(notes)}" if notes else "") + " --by pc"
    print(f"▶ {app} {version}: adding to Downloads")
    # As the app's user, so the file and its folder belong to the app; the
    # upload folder goes whether or not the add worked.
    inner = f"cd {APP} && node scripts/add-release.js {app} {version} {remote}/{exe.name}{extra}"
    ssh("run", f"chown -R {USER}:{USER} {remote} && su - {USER} -c {quote(inner)}; rc=$?; rm -rf {remote}; exit $rc")
    print(f"✓ {app} {version} is on https://admin.vesopa.com/downloads")


if __name__ == "__main__":
    main()
