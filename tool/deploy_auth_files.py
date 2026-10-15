"""Ship named vesopa_auth files to auth.vesopa.com, safely.

    python tool/deploy_auth_files.py src/routes/stepup.js views/second-factor.ejs ...

Paths are relative to vesopa_auth/. In order, stopping at the first failure:
  1. BACKUP the live app (no node_modules or logs) to /home/vesopasoftware/backups/.
  2. UPLOAD only the named files (never .env), chown to vesopasoftware.
  3. TEST: `npm test` on the server (every template compiles) BEFORE restarting.
  4. RESTART only auth.vesopa.com as vesopasoftware (never `restart all`).
  5. SMOKE: /health answers ok.
Roll back: tar -xzf /home/vesopasoftware/backups/<file>.tgz -C <app dir>, then
restart auth.vesopa.com as vesopasoftware.
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except AttributeError:
    pass

ROOT = pathlib.Path(__file__).resolve().parents[1]
AUTH = ROOT / "vesopa_auth"
APP = "/home/vesopasoftware/web/auth.vesopa.com/private/nodeapp"
PM2 = "su - vesopasoftware -c 'PM2_HOME=/home/vesopasoftware/.pm2 pm2 {}'"


def ssh(*args):
    env = {**os.environ, "MSYS_NO_PATHCONV": "1"}
    r = subprocess.run([sys.executable, str(ROOT / "tool" / "auth_ssh.py"), *args], cwd=str(ROOT),
                       text=True, encoding="utf-8", errors="replace", capture_output=True, env=env)
    if r.stdout.strip():
        print(r.stdout.rstrip()[-2500:])
    if r.returncode:
        print(r.stderr.rstrip()[-1500:], file=sys.stderr)
        raise SystemExit(f"failed: {' '.join(args[:1])}")
    return r.stdout


def main():
    files = [f.replace("\\", "/") for f in sys.argv[1:]]
    if not files:
        raise SystemExit(__doc__)
    for f in files:
        if f.startswith(".env") or ".." in f or not (AUTH / f).is_file():
            raise SystemExit(f"not a vesopa_auth file: {f}")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    print("▶ backup")
    ssh("run", f"mkdir -p /home/vesopasoftware/backups && tar --exclude=node_modules --exclude='*.log' "
               f"-czf /home/vesopasoftware/backups/auth-{stamp}.tgz -C {APP} . && echo backed up auth-{stamp}.tgz")
    print("▶ upload", ", ".join(files))
    stage = pathlib.Path(tempfile.mkdtemp(prefix="auth-"))
    try:
        for f in files:
            (stage / f).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(AUTH / f, stage / f)
        ssh("put", str(stage), APP)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    ssh("run", f"chown -R vesopasoftware:vesopasoftware {APP}/src {APP}/views {APP}/public")
    print("▶ test on the server")
    ssh("run", f"cd {APP} && su vesopasoftware -s /bin/bash -c 'set -o pipefail; NODE_ENV=test npm test 2>&1 | tail -6'")
    print("▶ restart auth.vesopa.com")
    ssh("run", PM2.format("restart auth.vesopa.com") + " | tail -2")
    time.sleep(4)
    with urllib.request.urlopen("https://auth.vesopa.com/health", timeout=20) as r:
        print("health", r.status, r.read(200).decode("utf-8", "replace"))


if __name__ == "__main__":
    main()
