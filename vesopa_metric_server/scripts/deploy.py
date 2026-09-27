"""Deploy Metric Membership to metric.vesopa.com (the Cloud box).

    python vesopa_metric_server/scripts/deploy.py            --check: what exists, what it would do
    python vesopa_metric_server/scripts/deploy.py --apply    set up if needed, then ship

Run from the repository root on a machine that can SSH to the Cloud box (the
owner's Windows folder; cloud sessions cannot reach port 22). It:

  1. builds the member web app (flutter build web in vesopa_metric)
  2. bundles the server (no node_modules, no .env), the web build and the
     Vesopa Auth client schema (vesopa_auth/schema/schema_025_metric_client.sql)
  3. uploads the bundle to /root/metric-deploy/<stamp> and runs
     scripts/remote-install.sh there, which is idempotent: DNS record, Hestia
     web domain with the NodeJS proxy, certificate, database, the Auth client,
     .env on first run only, npm ci, schema twice, pm2 by name, health check

Which box: VESOPA_SERVER_IP (the Cloud box, 34.63.118.67) with root and
VESOPA_SSH_PASSWORD, from .env.claude-tools or the environment. NOT
VESOPA_SSH_HOST, which on some machines still names the old EPOS box.

Staff who may open /admin: METRIC_ADMIN_EMAILS=a@x,b@y on the command line's
environment is written into .env on the FIRST deploy only; afterwards edit the
.env on the box.
"""

import os
import posixpath
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
REPO = os.path.dirname(SERVER)
APP = os.path.join(REPO, "vesopa_metric")
sys.path.insert(0, os.path.join(REPO, ".claude", "skills", "vesopa-ops", "scripts"))
import paramiko  # noqa: E402
import vesopa_ssh  # noqa: E402


def connect():
    s = vesopa_ssh.settings()
    host = s.get("VESOPA_SERVER_IP") or os.environ.get("VESOPA_SERVER_IP")
    password = s.get("VESOPA_SSH_PASSWORD") or os.environ.get("VESOPA_SSH_PASSWORD")
    if not host or not password:
        raise SystemExit("VESOPA_SERVER_IP and VESOPA_SSH_PASSWORD are needed (.env.claude-tools)")
    print(f"connecting to root@{host}")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=host, username="root", password=password, timeout=30, look_for_keys=False, allow_agent=False)
    return c


def build_web():
    flutter = shutil.which("flutter") or shutil.which("flutter.bat")
    if not flutter:
        raise SystemExit("flutter is not on PATH")
    print("building the web app")
    subprocess.run([flutter, "pub", "get"], cwd=APP, check=True)
    subprocess.run([flutter, "build", "web", "--release", "--no-web-resources-cdn"], cwd=APP, check=True)
    return os.path.join(APP, "build", "web")


def bundle(web):
    tmp = tempfile.mkdtemp(prefix="metric-bundle-")
    ignore = shutil.ignore_patterns("node_modules", ".env", "logs", "backup", "web_app", "test")
    shutil.copytree(SERVER, os.path.join(tmp, "server"), ignore=ignore)
    shutil.copytree(web, os.path.join(tmp, "web_app"))
    shutil.copy(os.path.join(REPO, "vesopa_auth", "schema", "schema_025_metric_client.sql"), tmp)
    shutil.copy(os.path.join(HERE, "remote-install.sh"), tmp)
    # LF endings, whatever the checkout did: bash on the box reports
    # "$'\r': command not found" otherwise.
    path = os.path.join(tmp, "remote-install.sh")
    with open(path, "rb") as f:
        data = f.read().replace(b"\r\n", b"\n")
    with open(path, "wb") as f:
        f.write(data)
    return tmp


def main():
    apply = "--apply" in sys.argv
    web = os.path.join(APP, "build", "web")
    if apply or not os.path.isfile(os.path.join(web, "index.html")):
        web = build_web()
    local = bundle(web)
    remote = f"/root/metric-deploy/{time.strftime('%Y%m%d_%H%M%S')}"
    client = connect()
    try:
        vesopa_ssh.put(client, local, remote, set())
        admins = os.environ.get("METRIC_ADMIN_EMAILS", "")
        env = f"METRIC_ADMIN_EMAILS='{admins}' " if admins else ""
        cmd = f"cd {remote} && {env}bash remote-install.sh {'' if apply else '--check'}"
        status = vesopa_ssh.run(client, cmd)
        if status != 0:
            raise SystemExit("remote-install.sh failed -- read the output above")
        if not apply:
            print("check only: nothing changed. Re-run with --apply.")
    finally:
        client.close()
        shutil.rmtree(local, ignore_errors=True)


if __name__ == "__main__":
    main()
