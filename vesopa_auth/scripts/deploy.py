"""Deploy auth.vesopa.com from this Windows machine.

    python vesopa_auth/scripts/deploy.py           code, schema, restart, verify
    python vesopa_auth/scripts/deploy.py --no-schema
    python vesopa_auth/scripts/deploy.py --restart-only

WHY PYTHON AND NOT A SHELL SCRIPT

The sibling apps ship a `deploy.sh` each, and neither runs on this machine:
they need rsync and an interactive ssh password, and Git Bash rewrites every
POSIX-looking argument on its way to a native Windows program. This drives the
same paramiko helper everything else here uses.

WHAT IT WILL NOT DO

  * It never uploads `.env`. The live secrets are only on the server, and a sync
    in the wrong direction would replace them with whatever is in the working
    copy — which for a fresh clone is nothing at all.
  * It never calls `v-add-nodejs-app`, which regenerates `.env` as a two-line
    stub.
  * It restarts `auth.vesopa.com` BY NAME. `pm2 restart all` on this box also
    restarts cloud.vesopa.com and vesopasoftware.com, and pm2 will not ask
    whether you meant it.
"""

import pathlib
import subprocess
import sys

# The Windows console defaults to cp1252, which cannot encode the marks used
# below — and the failure is a traceback in the middle of a deploy rather than a
# mangled character.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

ROOT = pathlib.Path(__file__).resolve().parents[2]
APP = ROOT / "vesopa_auth"
SSH = ROOT / "tool" / "auth_ssh.py"

# `plan/` is working material for people, not for the server. `content/` is
# uploaded because the policy pages are rendered from it.
EXCLUDES = ["plan", "node_modules", ".env"]


def ssh(*args):
    result = subprocess.run(
        [sys.executable, str(SSH), *args], cwd=str(ROOT), text=True, capture_output=True
    )
    if result.stdout:
        print(result.stdout.rstrip())
    if result.returncode != 0:
        print(result.stderr.rstrip(), file=sys.stderr)
        raise SystemExit(f"failed: auth_ssh {' '.join(args[:2])}")
    return result.stdout


def main():
    flags = set(sys.argv[1:])
    restart_only = "--restart-only" in flags

    if not restart_only:
        print("▶ uploading application")
        ssh("put", str(APP), "@app", "--exclude", *EXCLUDES)

        print("▶ installing dependencies")
        ssh("run", "cd @app && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3")

        # Everything under the domain must belong to the Hestia user: pm2 runs
        # as `vesopasoftware`, and a root-owned .env at mode 600 is a file the
        # application cannot read, which presents as a missing secret at boot.
        print("▶ ownership")
        ssh(
            "run",
            "chown -R vesopasoftware:vesopasoftware "
            "/home/vesopasoftware/web/auth.vesopa.com/private && chmod 600 @app/.env",
        )

        if "--no-schema" not in flags:
            print("▶ applying schema")
            ssh(
                "run",
                "cd @app/schema && for f in schema.sql $(ls schema_*.sql 2>/dev/null | sort); "
                'do mysql vesopasoftware_authdb < "$f" && echo "  ok $f" || echo "  FAILED $f"; done',
            )

    if not restart_only and "--skip-checks" not in flags:
        """
        Compile every template BEFORE restarting — and on the server.

        A template that only renders on a rare path (the account-linking
        interrupt, say) is not exercised by the smoke tests, so a syntax error
        in one ships happily and waits for a real person to find it. That has
        happened once: an EJS tag written inside an EJS comment, discovered by
        somebody signing in with Google.

        Run on the SERVER rather than here, for two reasons. This machine has no
        node_modules — dependencies are installed on the far end — so a local
        check fails for want of `ejs` and refuses every deploy. And the server
        is where it matters: the same Node, the same files, after the upload.

        The order is the point. The files are already there, but the running
        process still has the old ones in memory, so a failure here leaves the
        previous version serving rather than a broken one.
        """
        print("▶ checking templates on the server")
        result = subprocess.run(
            [sys.executable, str(SSH), "run",
             "cd @app && node --test test/views.test.js 2>&1 | tail -25"],
            cwd=str(ROOT), text=True, capture_output=True,
        )
        if "fail 0" not in result.stdout:
            print(result.stdout[-3000:])
            raise SystemExit(
                "REFUSING TO RESTART: a template does not compile.\n"
                "The previous version is still serving. Fix the template and deploy again."
            )
        print("  ✓ every template compiles")

    print("▶ restarting")
    ssh(
        "run",
        "su - vesopasoftware -c 'PM2_HOME=/home/vesopasoftware/.pm2 "
        "pm2 restart auth.vesopa.com --update-env' | tail -3",
    )

    print("▶ verifying")
    # Against the public URL, not 127.0.0.1: that also proves nginx, the proxy
    # template and the certificate, which is where a deploy actually breaks.
    ssh(
        "run",
        "sleep 2; curl -sS -o /dev/null -w 'health %{http_code}\\n' https://auth.vesopa.com/health; "
        "curl -sS -o /dev/null -w 'login  %{http_code}\\n' https://auth.vesopa.com/login; "
        "echo '--- recent errors ---'; tail -5 @app/logs/error.log",
    )


if __name__ == "__main__":
    main()
