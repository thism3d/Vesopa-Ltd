"""Run commands on, and copy files to, the box that serves auth.vesopa.com.

    python tool/auth_ssh.py run "pm2 status"
    python tool/auth_ssh.py put src "@app/src" [--exclude node_modules]
    python tool/auth_ssh.py get "@app/.env" local.env

WHY THIS EXISTS SEPARATELY

`.claude/skills/vesopa-ops/scripts/vesopa_ssh.py` is deliberately hardwired to
`.env.claude-tools`, and that file names the EPOS back-office box
(root@3.72.113.21). The file beats the environment there on purpose — sourcing
the env file in Git Bash mangles POSIX-looking values — so `VESOPA_SSH_HOST=…`
in front of the command is silently ignored and you end up on the wrong server
with a shell that answers cheerfully.

auth.vesopa.com resolves to 34.63.118.67, the Hestia box that also serves
cloud.vesopa.com. Everything else about the transport is identical, so this
imports that script and replaces only the two settings.

Two things about this server that bite (see also vesopa_hosting/deploy-cloud.sh):

  * pm2 is PER HESTIA USER. The app runs as `vesopasoftware`, so pm2 commands
    must go through `su - vesopasoftware -c 'PM2_HOME=… pm2 …'`. As root you
    start a second daemon and the two copies fight over the port. The `pm2`
    action below does this for you.
  * `v-add-nodejs-app` regenerates .env with a two-line stub. Never let a deploy
    call it, and never sync .env upward.
"""
import os
import pathlib
import sys

sys.path.insert(
    0,
    str(pathlib.Path(__file__).resolve().parents[1] / ".claude" / "skills" / "vesopa-ops" / "scripts"),
)

import vesopa_ssh  # noqa: E402

HOST = "root@34.63.118.67"
APP_USER = "vesopasoftware"
DOMAIN = "auth.vesopa.com"
REMOTE_APP = f"/home/{APP_USER}/web/{DOMAIN}/private/nodeapp"
PM2 = f"su - {APP_USER} -c 'PM2_HOME=/home/{APP_USER}/.pm2 pm2 {{}}'"

_original_settings = vesopa_ssh.settings


def settings():
    values = _original_settings()
    values["VESOPA_SSH_HOST"] = HOST
    values["VESOPA_REMOTE_APP"] = REMOTE_APP
    return values


vesopa_ssh.settings = settings


def main():
    args = sys.argv[1:]
    if args and args[0] == "pm2":
        # `pm2 restart auth.vesopa.com` as the Hestia user, not as root.
        sys.argv = ["auth_ssh.py", "run", PM2.format(" ".join(args[1:]))]
        args = sys.argv[1:]

    # `get` in the upstream helper does NOT expand `@app`, though `put` and
    # `run` both do — so `get @app/.env` asks the server for a file literally
    # called "@app/.env" and fails with "No such file", which reads like the
    # file is missing rather than the path never having been resolved.
    #
    # Expanding it here keeps `@app` meaning the same thing in all three, which
    # matters more than it sounds: a literal remote path typed on this machine
    # is rewritten by Git Bash on its way to Python, so `@app` is the only form
    # that reliably survives the trip.
    if args and args[0] == "get" and len(args) >= 2 and args[1].startswith("@app"):
        sys.argv[2] = REMOTE_APP + args[1][len("@app"):]

    if not args:
        raise SystemExit(__doc__)
    vesopa_ssh.main()


if __name__ == "__main__":
    main()
