"""Set the password on an existing Vesopa Auth account, from the owner's PC.

    python vesopa_auth/scripts/set-account-password.py you@example.com

Run from the repository root on the machine that deploys (see
MetricMembership/server/scripts/deploy.py), with VESOPA_ACCOUNT_PASSWORD in
this machine's environment, or typed at the prompt. On the Cloud box it:

  1. copies scripts/set-password.js into the live Vesopa Auth;
  2. writes the password to a mode-600 file there, runs set-password.js with
     VESOPA_SET_PASSWORD_FILE pointing at it, and deletes the file. The
     password never appears on a command line and is never printed;
  3. marks the address verified on the owner's word (verified_via = 'owner')
     if it is not verified yet, so the account can sign in with the password
     straight away.

set-password.js refuses any address not on its ALLOWED list. That list is the
safety of this script: add an address there, deliberately, before using this.
Sends no email.
"""

import getpass
import os
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "MetricMembership", "server", "scripts"))
from deploy import connect, vesopa_ssh  # noqa: E402

AUTH = "/home/vesopasoftware/web/auth.vesopa.com/private/nodeapp"
USER = "vesopasoftware"

VERIFY = r"""
const db = require('../src/db');
(async () => {
  const email = process.argv[2];
  const r = await db.execute(
    "UPDATE user_identities SET verified_at = NOW(), verified_via = 'owner' " +
    "WHERE type = 'email' AND identifier_norm = ? AND revoked_at IS NULL AND verified_at IS NULL",
    [email]);
  console.log(r.affectedRows ? '  address marked verified' : '  address already verified');
  await db.close();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
"""


def run(client, cmd):
    if vesopa_ssh.run(client, cmd) != 0:
        raise SystemExit("failed on the box")


def main():
    if len(sys.argv) < 2 or "@" not in sys.argv[1]:
        raise SystemExit(__doc__)
    email = sys.argv[1].strip().lower()
    if "'" in email or '"' in email or " " in email:
        raise SystemExit("an email address without quotes or spaces, please")
    password = os.environ.get("VESOPA_ACCOUNT_PASSWORD")
    if password is None and sys.stdin.isatty():
        password = getpass.getpass(f"Password for {email}: ")
    if not password or len(password) < 10:
        raise SystemExit("set VESOPA_ACCOUNT_PASSWORD (10 characters or more) first")

    client = connect()
    sftp = client.open_sftp()
    try:
        sftp.put(os.path.join(REPO, "vesopa_auth", "scripts", "set-password.js"), f"{AUTH}/scripts/set-password.js")
        verify = f"{AUTH}/scripts/.verify-{secrets.token_hex(6)}.js"
        with sftp.open(verify, "w") as f:
            f.write(VERIFY)
        run(client, f"chown {USER}:{USER} {AUTH}/scripts/set-password.js {verify}")

        print(f"Vesopa Auth: password for {email}")
        secret = f"{AUTH}/.pw-{secrets.token_hex(8)}"
        with sftp.open(secret, "w") as f:
            f.chmod(0o600)
            f.write(password)
        try:
            run(client, f"chown {USER}:{USER} {secret} && su - {USER} -c \"cd {AUTH} && "
                        f"VESOPA_SET_PASSWORD_FILE={secret} node scripts/set-password.js '{email}'\"")
        finally:
            vesopa_ssh.run(client, f"rm -f {secret}")

        try:
            run(client, f"su - {USER} -c \"cd {AUTH} && node {verify} '{email}'\"")
        finally:
            vesopa_ssh.run(client, f"rm -f {verify}")
        print(f"\ndone. {email} can sign in at https://auth.vesopa.com with that password.")
    finally:
        sftp.close()
        client.close()


if __name__ == "__main__":
    main()
