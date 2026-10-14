"""Put the Apple Wallet signing material on the back office box, and point the server at it.

    python tool/install_wallet_certs.py --check    # what the server can see, nothing changed
    python tool/install_wallet_certs.py            # install, fix the .env paths, restart, check

"That card could not be issued" (Pontardawe RFC's app, 2026-10-15). The box
moved to the Cloud server, where the back office runs as `vesopasoftware`, but
its .env still pointed APPLE_WALLET_DIR / APPLE_WALLET_CERT_DIR /
APPLE_WWDR_CERT at the old box's /home/vesopa/... folder, and the files were
never copied across. passes_and_oauth/README.md, "Moving to a new server".

Copies, from passes_and_oauth/ (never printed, never in git):
    Vesopa Software Ltd Pass Key.p12   -> <dir>/vesopa_wallet.p12   (the one that signs)
    loyalty, membership, giftcard, staffcard, promotion _pass.cer, wwdr.pem
into the back office's private/wallet (0700, files 0600, owned by the app's
user), sets the three paths in the .env (backed up first; the password line is
left as it is), restarts pm2 and asks the server whether it can now sign.
"""
import os
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))

import deploy_pontardawe_app as app  # noqa: E402  (loads .env.claude too)

SRC = ROOT / "passes_and_oauth"
FILES = {
    "Vesopa Software Ltd Pass Key.p12": "vesopa_wallet.p12",
    "loyalty_pass.cer": "loyalty_pass.cer",
    "membership_pass.cer": "membership_pass.cer",
    "giftcard_pass.cer": "giftcard_pass.cer",
    "staffcard_pass.cer": "staffcard_pass.cer",
    "promotion_pass.cer": "promotion_pass.cer",
    "wwdr.pem": "wwdr.pem",
}
WALLET = app.BACKOFFICE.replace("/private/nodeapp", "/private/wallet")

CHECK = r"""
require('dotenv').config();
const A = require('./src/wallet_apple');
const c = (A.loadConfig || A.readConfig || A.cachedConfig)(process.env);
console.log('configured:', !!c.configured);
for (const p of (c.problems || [])) console.log('  problem:', p);
"""


def run(client, cmd, timeout=120):
    _, out, err = client.exec_command(cmd, timeout=timeout)
    code = out.channel.recv_exit_status()
    return code, out.read().decode("utf-8", "replace"), err.read().decode("utf-8", "replace")


def check(client):
    name = f".walletcheck-{os.getpid()}.js"
    sftp = client.open_sftp()
    with sftp.file(f"{app.BACKOFFICE}/{name}", "w") as f:
        f.write(CHECK)
    sftp.close()
    code, out, err = run(client, f"cd {app.BACKOFFICE} && {app.NODE} node ./{name} 2>&1 | grep -v 'injected env'; rm -f ./{name}")
    print(out.strip() or err.strip())
    return "configured: true" in out


def main():
    missing = [n for n in FILES if not (SRC / n).exists()]
    if missing:
        raise SystemExit(f"missing in passes_and_oauth/: {', '.join(missing)}")
    client = app.vesopa_ssh.connect()
    try:
        print("before:")
        if check(client) and "--force" not in sys.argv:
            print("Apple Wallet is already configured; nothing to do.")
            return
        if "--check" in sys.argv:
            return
        user = app.USER
        run(client, f"mkdir -p {WALLET} && chown {user}:{user} {WALLET} && chmod 700 {WALLET}")
        sftp = client.open_sftp()
        for src, dst in FILES.items():
            tmp = f"{WALLET}/.{dst}.uploading"
            sftp.put(str(SRC / src), tmp)
            sftp.posix_rename(tmp, f"{WALLET}/{dst}")
        sftp.close()
        run(client, f"chown {user}:{user} {WALLET}/* && chmod 600 {WALLET}/*")
        print(f"copied {len(FILES)} files to {WALLET} (0600, {user})")
        env = f"{app.BACKOFFICE}/.env"
        stamp = time.strftime("%Y%m%d-%H%M%S")
        sets = {"APPLE_WALLET_DIR": WALLET, "APPLE_WALLET_CERT_DIR": WALLET, "APPLE_WWDR_CERT": f"{WALLET}/wwdr.pem"}
        cmd = [f"cp -p {env} {env}.bak-{stamp}"]
        for k, v in sets.items():
            cmd.append(f"(grep -q '^{k}=' {env} && sed -i 's#^{k}=.*#{k}={v}#' {env} || echo '{k}={v}' >> {env})")
        code, out, err = run(client, " && ".join(cmd))
        if code:
            raise SystemExit(f"! could not update the .env: {err[-300:]}")
        print(f".env paths set (backup {env}.bak-{stamp})")
        code, out, err = run(client, app.PM2.format("restart backoffice.vesopaepos.com --update-env") + " | tail -2")
        print(out.strip()[-300:])
        time.sleep(3)
        print("after:")
        if not check(client):
            raise SystemExit("! still not configured: see the problems above")
        print("✓ Apple Wallet can sign passes again")
    finally:
        client.close()


if __name__ == "__main__":
    main()
