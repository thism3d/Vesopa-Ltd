"""Deploy Vesopa Gift's code to the live box (gift.vesopaepos.com).

    python vesopa_gift/scripts/deploy.py            # show what it would do
    python vesopa_gift/scripts/deploy.py --apply    # do it

Code only: src, views, public, schema, the package files and
scripts/venue-access.js (the owner's switches, for a shell). It never sends a
.env (the live one holds the secrets and is not in git) or anything under
uploads/ (venues' own designs and event pictures live only on the server).

Then, on the server: npm ci when the lock file changed, the schema applied
twice (it must survive that, like every Vesopa schema), a backup of the gift
database first, pm2 restart, and a health check through nginx.

The first-time setup -- the Hestia domain, certificate, database, .env files
and the pm2 process -- is described in vesopa_gift/DEPLOY.md.
"""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
REPO = os.path.dirname(APP)
sys.path.insert(0, os.path.join(REPO, ".claude", "skills", "vesopa-ops", "scripts"))
import vesopa_ssh  # noqa: E402

REMOTE = "/home/vesopa/web/gift.vesopaepos.com/private/nodeapp"
PARTS = ["src", "views", "public", "schema"]
EXCLUDES = set(vesopa_ssh.DEFAULT_EXCLUDES) | {"uploads"}


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    apply = "--apply" in sys.argv
    client = vesopa_ssh.connect()
    try:
        status = vesopa_ssh.run(client, f"test -f {REMOTE}/.env && test -d {REMOTE}/node_modules")
        if status != 0:
            raise SystemExit(f"{REMOTE} is not set up (no .env or node_modules) -- see DEPLOY.md")
        _, out, _ = client.exec_command(f"sha256sum {REMOTE}/package-lock.json 2>/dev/null | cut -d' ' -f1")
        lock_changed = out.read().decode().strip() != sha(os.path.join(APP, "package-lock.json"))
        print(f"would upload {', '.join(PARTS)} and the package files to {REMOTE}")
        print(f"package-lock.json {'changed: npm ci will run' if lock_changed else 'unchanged'}")
        if not apply:
            print("dry run -- nothing changed. Re-run with --apply.")
            return

        stamp = "$(date +%Y%m%d_%H%M%S)"
        backup = (
            f"cd {REMOTE} && mkdir -p backup && set -a && . ./.env && set +a && "
            f"mysqldump --single-transaction -h127.0.0.1 -u\"$DB_USER\" -p\"$DB_PASSWORD\" \"$DB_NAME\" "
            f"> backup/pre_deploy_{stamp}.sql && ls -1t backup | head -1"
        )
        if vesopa_ssh.run(client, backup) != 0:
            raise SystemExit("the database backup failed -- nothing deployed")

        for part in PARTS:
            vesopa_ssh.put(client, os.path.join(APP, part), f"{REMOTE}/{part}", EXCLUDES)
        sftp = client.open_sftp()
        try:
            for name in ("package.json", "package-lock.json"):
                sftp.put(os.path.join(APP, name), f"{REMOTE}/{name}")
            # The one script meant for the server: the owner's switches from a shell.
            try:
                sftp.stat(f"{REMOTE}/scripts")
            except IOError:
                sftp.mkdir(f"{REMOTE}/scripts")
            sftp.put(os.path.join(HERE, "venue-access.js"), f"{REMOTE}/scripts/venue-access.js")
        finally:
            sftp.close()

        steps = [f"cd {REMOTE}"]
        if lock_changed:
            steps.append("npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2")
        steps += [
            "chown -R vesopa:vesopa .",
            "set -a && . ./.env && set +a",
            "for i in 1 2; do mysql -h127.0.0.1 -u\"$DB_USER\" -p\"$DB_PASSWORD\" \"$DB_NAME\" < schema/schema.sql || exit 1; done",
            "echo schema applied twice",
            "pm2 restart vesopa_gift >/dev/null && echo restarted",
            "sleep 4",
            "curl -fsS https://gift.vesopaepos.com/health && echo",
        ]
        if vesopa_ssh.run(client, " && ".join(steps)) != 0:
            raise SystemExit("deploy step failed -- check `pm2 logs vesopa_gift`")
    finally:
        client.close()


if __name__ == "__main__":
    main()
