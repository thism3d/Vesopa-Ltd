"""Run commands on, and copy files to, cloud.vesopa.com's application.

    python tool/cloud_ssh.py run "ls @app"
    python tool/cloud_ssh.py put vesopa_hosting/src "@app/src"
    python tool/cloud_ssh.py get "@app/.env" local.env
    python tool/cloud_ssh.py pm2 "restart cloud.vesopa.com"

Same box, same user and same transport as tool/auth_ssh.py — auth.vesopa.com and
cloud.vesopa.com are two Node apps under one Hestia account — so this reuses
that helper and changes only the application directory and the pm2 name.
`@app` is the hosting panel's directory here, never the auth server's.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import auth_ssh  # noqa: E402

auth_ssh.DOMAIN = "cloud.vesopa.com"
auth_ssh.REMOTE_APP = f"/home/{auth_ssh.APP_USER}/web/{auth_ssh.DOMAIN}/private/nodeapp"

if __name__ == "__main__":
    auth_ssh.main()
