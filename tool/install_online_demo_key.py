"""Put the online checkout's demo (Dojo sandbox) key on the back office.

    python tool/install_online_demo_key.py

Reads DOJO_ONLINE_DEMO_KEY from .env.dojo-demo (gitignored), never prints it,
refuses anything that is not a sandbox key, backs up the back office .env and
sets the line there. The next back office restart (tool/deploy_memberships.py
--backoffice, which restarts with --update-env) picks it up.
"""
import os
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import deploy_pontardawe_app as app  # noqa: E402


def main():
    key = ""
    for line in (ROOT / ".env.dojo-demo").read_text(encoding="utf-8").splitlines():
        if line.startswith("DOJO_ONLINE_DEMO_KEY="):
            key = line.split("=", 1)[1].strip()
    if not key.startswith("sk_sandbox_"):
        raise SystemExit("no sandbox key in .env.dojo-demo")
    c = app.vesopa_ssh.connect()
    try:
        env = f"{app.BACKOFFICE}/.env"
        tmp = f"/tmp/.dk-{os.getpid()}"
        s = c.open_sftp()
        with s.file(tmp, "w") as f:
            f.write(key)
        s.chmod(tmp, 0o600)
        s.close()
        stamp = time.strftime("%Y%m%d-%H%M%S")
        cmd = (f"cp -p {env} {env}.bak-{stamp} && k=$(cat {tmp}) && rm -f {tmp} && "
               f"(grep -q '^DOJO_ONLINE_DEMO_KEY=' {env} && sed -i \"s#^DOJO_ONLINE_DEMO_KEY=.*#DOJO_ONLINE_DEMO_KEY=$k#\" {env} "
               f"|| echo \"DOJO_ONLINE_DEMO_KEY=$k\" >> {env}) && grep -c '^DOJO_ONLINE_DEMO_KEY=sk_sandbox_' {env}")
        _, o, e = c.exec_command(cmd, timeout=60)
        out = o.read().decode().strip()
        print("set in the back office .env:", "yes" if out.endswith("1") else "NO", f"(backup .env.bak-{stamp})")
    finally:
        c.close()


if __name__ == "__main__":
    main()
