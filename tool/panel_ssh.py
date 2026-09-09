"""Run commands on, and copy files to, the hosting panel at cloud.vesopa.com.

    python tool/panel_ssh.py run "pm2 status"
    python tool/panel_ssh.py put src "@app/src"
    python tool/panel_ssh.py pm2 "restart cloud.vesopa.com"

The panel shares a MACHINE with auth.vesopa.com (34.63.118.67) and shares
nothing else — its own directory, its own database, its own pm2 process. So it
needs its own `@app`, and a literal remote path cannot be typed on this machine:
Git Bash rewrites anything POSIX-looking on its way to a native Windows program,
so `/home/vesopasoftware/...` arrives as `C:/Program Files/Git/home/...` and
every transfer fails with "No such file".

pm2 here is per Hestia user, so every pm2 command goes through
`su - vesopasoftware`. As root it starts a SECOND daemon and the two copies
fight over the port.
"""
import pathlib
import sys

sys.path.insert(
    0,
    str(pathlib.Path(__file__).resolve().parents[1] / ".claude" / "skills" / "vesopa-ops" / "scripts"),
)

import vesopa_ssh  # noqa: E402

HOST = "root@34.63.118.67"
APP_USER = "vesopasoftware"
DOMAIN = "cloud.vesopa.com"
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
        sys.argv = ["panel_ssh.py", "run", PM2.format(" ".join(args[1:]))]
        args = sys.argv[1:]

    # `get` upstream does not expand `@app`, though `put` and `run` do.
    if args and args[0] == "get" and len(args) >= 2 and args[1].startswith("@app"):
        sys.argv[2] = REMOTE_APP + args[1][len("@app"):]

    if not args:
        raise SystemExit(__doc__)
    vesopa_ssh.main()


if __name__ == "__main__":
    main()
