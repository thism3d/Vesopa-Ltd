"""Put Vesopa's Teya partner credentials on the back office (2026-10-19).

    python tool/install_teya_env.py

Reads the TEYA_* lines from .env.teya (gitignored), never prints a value,
backs up the back office .env and sets each line there (replacing an old one).
Sandbox credentials are TEYA_*; Teya's live ones, once issued after
certification, go in .env.teya as TEYA_LIVE_* and are installed the same way,
which is what makes "Live" selectable in the back office.

The next back office restart (tool/deploy_memberships.py --backoffice, which
restarts with --update-env) picks them up.
"""
import os
import pathlib
import re
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import deploy_pontardawe_app as app  # noqa: E402

NAME = re.compile(r"^TEYA_[A-Z_]+$")

# Runs on the server: merges the uploaded lines into .env, then deletes them.
MERGE = r'''
import sys
src, env = sys.argv[1], sys.argv[2]
new = {}
for line in open(src, encoding="utf-8").read().splitlines():
    if "=" in line:
        k, v = line.split("=", 1)
        new[k] = v
out, seen = [], set()
for line in open(env, encoding="utf-8").read().splitlines():
    k = line.split("=", 1)[0]
    if k in new:
        out.append(k + "=" + new[k]); seen.add(k)
    else:
        out.append(line)
for k, v in new.items():
    if k not in seen:
        out.append(k + "=" + v)
open(env, "w", encoding="utf-8").write("\n".join(out) + "\n")
print(len(new))
'''


def main():
    lines = {}
    for line in (ROOT / ".env.teya").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if NAME.match(k) and v and "\n" not in v:
            lines[k] = v
    for need in ("TEYA_DEVICE_CLIENT_ID", "TEYA_DEVICE_CLIENT_SECRET"):
        if need not in lines:
            raise SystemExit(f"{need} is missing from .env.teya")
    c = app.vesopa_ssh.connect()
    try:
        env = f"{app.BACKOFFICE}/.env"
        tmp = f"/tmp/.teya-{os.getpid()}"
        script = f"/tmp/.teya-merge-{os.getpid()}.py"
        s = c.open_sftp()
        with s.file(tmp, "w") as f:
            f.write("\n".join(f"{k}={v}" for k, v in lines.items()) + "\n")
        s.chmod(tmp, 0o600)
        with s.file(script, "w") as f:
            f.write(MERGE)
        s.close()
        stamp = time.strftime("%Y%m%d-%H%M%S")
        cmd = (f"cp -p {env} {env}.bak-{stamp} && python3 {script} {tmp} {env}; rc=$?; rm -f {tmp} {script}; "
               f"grep -c '^TEYA_' {env}; exit $rc")
        _, o, e = c.exec_command(cmd, timeout=60)
        out = o.read().decode().split()
        err = e.read().decode().strip()
        if err:
            print("server said:", err.splitlines()[-1][:200])
        print(f"Teya lines sent: {len(lines)} ({', '.join(sorted(lines))})")
        print(f"TEYA_ lines now in the back office .env: {out[-1] if out else '?'} (backup .env.bak-{stamp})")
    finally:
        c.close()


if __name__ == "__main__":
    main()
