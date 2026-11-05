"""Put admin.vesopa.com's code live, and nothing else.

    python tool/deploy_admin_files.py

Backs up what is there on the box, uploads src, views and public, checks the
code, restarts by name and asks /healthz. Leaves .env, node_modules and the
database alone. deploy_memberships.py --admin is the full install, with DNS,
certificates and keys; this is for a code change.
"""
import pathlib
import shutil
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import update_venue_versions as venue  # noqa: E402  (its ssh helper and paths)


def main():
    stamp = time.strftime("%Y%m%d-%H%M%S")
    stage = pathlib.Path(tempfile.mkdtemp(prefix="admin-"))
    for part in ("src", "views", "public"):
        shutil.copytree(ROOT / "vesopa_admin" / part, stage / part)
    venue.ssh("put", str(stage), "/tmp/.adminstage")
    venue.ssh(
        "run",
        f"set -e; cd {venue.ADMIN}; mkdir -p /home/{venue.USER}/backups/admin; "
        f"tar czf /home/{venue.USER}/backups/admin/admin-{stamp}.tgz src views public; "
        f"cp -r /tmp/.adminstage/. {venue.ADMIN}/; rm -rf /tmp/.adminstage; "
        f"chown -R {venue.USER}:{venue.USER} src views public; "
        f"node --check src/routes.js; node --check src/server.js; "
        f"sudo -u {venue.USER} pm2 restart admin.vesopa.com --update-env | tail -1; "
        f"sleep 4; curl -s -o /dev/null -w 'admin health %{{http_code}}\\n' https://admin.vesopa.com/healthz",
    )
    print(f"backup: /home/{venue.USER}/backups/admin/admin-{stamp}.tgz")


if __name__ == "__main__":
    main()
