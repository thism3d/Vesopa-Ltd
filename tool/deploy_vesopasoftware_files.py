"""Ship named vesopasoftware/ files to vesopasoftware.com, safely.

    python tool/deploy_vesopasoftware_files.py site/index.html site/css/sections.css ...

Paths are relative to vesopasoftware/ (site/... for the page, server/... for
the Node app). In order:
  1. BACKUP the live app (no node_modules, uploads, logs or video frames) to
     /home/vesopasoftware/backups/vesopasoftware-<stamp>.tgz
  2. UPLOAD only the named files, owned by vesopasoftware
  3. RESTART only vesopasoftware.com when a server file changed
  4. CHECK the home page answers 200
Roll back: tar -xzf the backup -C the app folder, then restart by name.
"""
import os
import pathlib
import shutil
import sys
import tempfile
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "vesopasoftware"
for base in (ROOT, *ROOT.parents):
    if (base / ".env.claude").exists():
        for line in (base / ".env.claude").read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip().removeprefix("export ").strip(), v.strip().strip('"').strip("'"))
        break
if "VESOPA_SSH_HOST" not in os.environ and os.environ.get("VESOPA_SERVER_SSH"):
    os.environ["VESOPA_SSH_HOST"] = os.environ["VESOPA_SERVER_SSH"]
sys.path.insert(0, str(ROOT / "tool"))
import deploy_memberships as dm  # noqa: E402

APP = f"/home/{dm.USER}/web/vesopasoftware.com/private/nodeapp"


def main():
    files = [f.replace("\\", "/") for f in sys.argv[1:]]
    if not files:
        raise SystemExit(__doc__)
    for f in files:
        if ".env" in f or ".." in f or not (SRC / f).is_file():
            raise SystemExit(f"not a vesopasoftware file: {f}")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    print("▶ backup")
    dm.ssh("run", f"mkdir -p /home/{dm.USER}/backups && tar -czf /home/{dm.USER}/backups/vesopasoftware-{stamp}.tgz "
                  f"-C {APP} --exclude=./node_modules --exclude=./uploads --exclude='*.log' "
                  f"--exclude=./site/assets/video_frames . && echo backed up vesopasoftware-{stamp}.tgz")
    print("▶ upload", len(files), "files")
    stage = pathlib.Path(tempfile.mkdtemp(prefix="vs-"))
    try:
        for f in files:
            (stage / f).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SRC / f, stage / f)
        for top in sorted({f.split("/")[0] for f in files}):
            dm.ssh("put", str(stage / top), f"{APP}/{top}")
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    tops = " ".join(sorted({f.split("/")[0] for f in files}))
    dm.ssh("run", f"cd {APP} && chown -R {dm.USER}:{dm.USER} {tops}")
    if any(f.startswith("server/") for f in files):
        print("▶ restart vesopasoftware.com")
        dm.ssh("run", dm.PM2.format("restart vesopasoftware.com --update-env") + " | tail -1")
        time.sleep(4)
    with urllib.request.urlopen("https://vesopasoftware.com/?v=" + stamp, timeout=20) as r:
        print("home", r.status)


if __name__ == "__main__":
    main()
