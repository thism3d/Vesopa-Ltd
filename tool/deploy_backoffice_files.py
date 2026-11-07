"""Ship named vesopa_server files to the back office (backoffice.vesopaepos.com), safely.

    python tool/deploy_backoffice_files.py src/stripe.js src/stripe_client.js ...

Paths are relative to vesopa_server/. Only the files named go up, so work other
sessions left undeployed on main stays undeployed. In order, stopping at the
first failure:
  1. BACKUP src and public to /home/vesopasoftware/backups/backoffice-<stamp>.tgz
  2. UPLOAD the named files (never .env), owned by vesopasoftware
  3. CHECK each JavaScript file parses on the server (node --check)
  4. RESTART only backoffice.vesopaepos.com (never `restart all`)
  5. HEALTH: /health answers 200
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
SERVER = ROOT / "vesopa_server"

# A worktree has no gitignored files: the login is in the main checkout's .env.claude.
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

APP = dm.BACKOFFICE


def main():
    files = [f.replace("\\", "/") for f in sys.argv[1:]]
    if not files:
        raise SystemExit(__doc__)
    for f in files:
        if ".env" in f or ".." in f or not (SERVER / f).is_file():
            raise SystemExit(f"not a vesopa_server file: {f}")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    print("▶ backup")
    dm.ssh("run", f"mkdir -p /home/{dm.USER}/backups && tar -czf /home/{dm.USER}/backups/backoffice-{stamp}.tgz "
                  f"-C {APP} src public && echo backed up backoffice-{stamp}.tgz")
    print("▶ upload", ", ".join(files))
    stage = pathlib.Path(tempfile.mkdtemp(prefix="backoffice-"))
    try:
        for f in files:
            (stage / f).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SERVER / f, stage / f)
        for top in sorted({f.split("/")[0] for f in files}):
            dm.ssh("put", str(stage / top), f"{APP}/{top}")
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    dm.ssh("run", f"cd {APP} && chown -R {dm.USER}:{dm.USER} " + " ".join(sorted({f.split('/')[0] for f in files})))
    js = [f for f in files if f.endswith(".js")]
    if js:
        print("▶ check")
        dm.ssh("run", f"cd {APP} && " + " && ".join(f"node --check {f}" for f in js) + " && echo parsed")
    print("▶ restart backoffice.vesopaepos.com")
    dm.ssh("run", dm.PM2.format("restart backoffice.vesopaepos.com --update-env") + " | tail -2")
    time.sleep(5)
    with urllib.request.urlopen("https://backoffice.vesopaepos.com/health", timeout=20) as r:
        print("health", r.status)


if __name__ == "__main__":
    main()
