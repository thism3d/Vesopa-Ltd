"""Deploy the Gemini 3.8 Flash TTS voice to cloud.vesopa.com.

    python tool/deploy_cloud_voice.py            # back up, deploy, restart, verify
    python tool/deploy_cloud_voice.py --check    # only show what it would do

The owner chose Gemini for the assistant's voice on 2026-10-03, with a warm,
friendly Bangladeshi Bangla (thread "Voice model cost"). This sends the two
files that change it, src/ai/voice.js and src/config.js, to the live panel on
the Cloud box (34.63.118.67).

.env wins over the default in config.js, so if the live .env pins AI_TTS_MODEL
to anything else, that one line is changed to gemini-3.8-flash-tts. Nothing
else in .env is touched, and the backup below includes it.

Steps: a tar.gz backup of the live app in /home/vesopasoftware/backups, upload
of the two files, chown, `pm2 restart cloud.vesopa.com` as vesopasoftware, then
a check on the server that the app's own voice module now speaks a Bangla line
with the new model (one short request, a fraction of a cent).

Credentials and SSH come from tool/deploy_websites_cookie_notice.py, which reads
VESOPA_SSH_PASSWORD from .env.claude-tools or .env.claude.

To roll back:  tar -xzf /home/vesopasoftware/backups/<file>.tgz -C <app dir>
then `pm2 restart cloud.vesopa.com` as vesopasoftware.
"""
import posixpath
import sys
import time

import deploy_websites_cookie_notice as base

DOMAIN = "cloud.vesopa.com"
FOLDER = "vesopa_hosting"
FILES = ["vesopa_hosting/src/ai/voice.js", "vesopa_hosting/src/config.js"]
MODEL = "gemini-3.8-flash-tts"
APP = f"/home/{base.USER}/web/{DOMAIN}/private/nodeapp"

# Run in the app's directory: the live module speaks one Bangla line.
PROBE = (
    "require('dotenv').config();"
    "const c=require('./src/config');const v=require('./src/ai/voice');"
    "console.log('model',c.AI.TTS_MODEL,'key',v.ENABLED?'set':'MISSING');"
    "if(!v.ENABLED)process.exit(2);"
    "v.synthesise('আপনার ডোমেইনটি এখন সক্রিয় আছে।','bn')"
    ".then(f=>console.log('spoke',((f.length-44)/48000).toFixed(1)+'s'))"
    ".catch(e=>{console.log('voice error',e.message);process.exit(3)})"
)


def main():
    check_only = "--check" in sys.argv
    client = base.vesopa_ssh.connect()
    try:
        status, _ = base.sh(client, f"test -d {APP}", quiet=True)
        if status != 0:
            print(f"! {APP} does not exist on the server")
            sys.exit(1)
        _, pin = base.sh(client, f"grep -E '^AI_TTS_MODEL=' {APP}/.env || true", quiet=True)
        pin = pin.strip()
        print(f"== {DOMAIN}: {len(FILES)} files")
        for f in FILES:
            print("   " + f)
        print(f"   .env AI_TTS_MODEL: {pin or '(not set, the default applies)'}")
        if check_only:
            return

        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = f"{base.BACKUPS}/{DOMAIN}-{stamp}.tgz"
        status, _ = base.sh(client, (
            f"mkdir -p {base.BACKUPS} && tar -czf {backup} -C {APP} "
            "--exclude=./node_modules --exclude=./uploads --exclude=./logs --exclude=./backup . "
            f"&& ls -lh {backup} | awk '{{print $5}}'"
        ))
        if status != 0:
            print("! backup failed; nothing was changed")
            sys.exit(1)
        print(f"   backup: {backup}")

        sftp = client.open_sftp()
        try:
            for f in FILES:
                sftp.put(str(base.ROOT / f), posixpath.join(APP, f[len(FOLDER) + 1:]))
            print(f"   uploaded {len(FILES)} file(s)")
        finally:
            sftp.close()

        if pin and pin != f"AI_TTS_MODEL={MODEL}":
            base.sh(client, f"sed -i 's/^AI_TTS_MODEL=.*/AI_TTS_MODEL={MODEL}/' {APP}/.env", quiet=True)
            print(f"   .env: {pin} -> AI_TTS_MODEL={MODEL}")

        base.sh(client, f"chown {base.USER}:{base.USER} {APP}/src/ai/voice.js {APP}/src/config.js {APP}/.env", quiet=True)
        status, _ = base.sh(client, base.PM2.format(f"restart {DOMAIN}") + " >/dev/null && echo restarted")
        if status != 0:
            print(f"! pm2 restart failed; roll back with: tar -xzf {backup} -C {APP}")
            sys.exit(1)
        time.sleep(4)

        probe = PROBE.replace("'", "'\\''")
        status, out = base.sh(client, f"su - {base.USER} -c \"cd {APP} && node -e '{probe}'\"")
        good = status == 0 and f"model {MODEL}" in out and "spoke" in out
    finally:
        client.close()
    print("\nOK  cloud.vesopa.com voice" if good else "\nFAIL cloud.vesopa.com voice")
    sys.exit(0 if good else 1)


if __name__ == "__main__":
    main()
