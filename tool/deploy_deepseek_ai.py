"""Deploy Vesopa AI on DeepSeek to vesopasoftware.com and cloud.vesopa.com.

    python tool/deploy_deepseek_ai.py            # back up, deploy, set keys, restart, verify
    python tool/deploy_deepseek_ai.py --check    # only show what it would do
    python tool/deploy_deepseek_ai.py --keep-ai-off   # leave AI_FEATURES=off on Cloud if it is set

Ships the commit "Vesopa AI on DeepSeek: website bar, Cloud assistant and
Studio" (the owner's model policy of 2026-10-03) and anything after it in the
same folders, to the Cloud box (34.63.118.67):

    vesopasoftware.com    vesopasoftware/   AI bar, saved chats, privacy page
    cloud.vesopa.com      vesopa_hosting/   assistant routing, sessions,
                                            devices, projects, Studio drafts

For each site, stopping that site at the first failure:
  1. a tar.gz of the live app (no node_modules, uploads or logs) in
     /home/vesopasoftware/backups/<domain>-<stamp>.tgz, .env included;
  2. the changed files only (from git), never .env;
  3. the keys written into the live .env, one line each, nothing else touched:
       vesopasoftware.com  DEEPSEEK_API_KEY = the "VesopaSoftware" key
       cloud.vesopa.com    DEEPSEEK_API_KEY = the "VesopaCloud" key
       both                GEMINI_API_KEY   (the backup), if not already set
     On Cloud, AI_FEATURES=off is removed (the owner asked on 2026-10-03 for
     the assistant and Studio to work again), unless --keep-ai-off;
  4. Cloud only: schema.sql, which is idempotent (new tables ai_devices,
     ai_sessions, ai_studio_drafts and the column ai_messages.session_id);
  5. chown, `pm2 restart <domain>` as vesopasoftware (never `restart all`);
  6. checks: the AI answers through the live app (one short question each,
     a fraction of a cent), the public status endpoints say enabled.

Key values are read from the environment or from .env.claude /
.env.claude-tools on this machine and are never printed. Names looked for:
DeepSeekAPIKey + DeepSeekAPIName, DeepSeekAPIKey2 + DeepSeekAPIName2 (the
name says which key is VesopaSoftware and which VesopaCloud), GEMINI_API_KEY.
SSH comes from tool/deploy_websites_cookie_notice.py (VESOPA_SSH_PASSWORD).

To roll a site back:  tar -xzf /home/vesopasoftware/backups/<file>.tgz -C <app dir>
then `pm2 restart <domain>` as vesopasoftware.
"""
import json
import os
import pathlib
import posixpath
import subprocess
import sys
import time
import urllib.request

import deploy_websites_cookie_notice as base

ROOT = base.ROOT
BASE_COMMIT = "c835839"  # main just before the DeepSeek commit
NODE = "PATH=/opt/nodejs/24/bin:$PATH"


def env_files():
    roots = [ROOT]
    try:
        common = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=ROOT,
                                capture_output=True, text=True, check=True).stdout.strip()
        roots.append((ROOT / common).resolve().parent)
    except Exception:  # noqa: BLE001
        pass
    for root in roots:
        for name in (".env.claude", ".env.claude-tools"):
            f = pathlib.Path(root) / name
            if f.is_file():
                yield f


def local_values():
    values = {}
    for f in env_files():
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[7:]
            key, sep, value = line.partition("=")
            if sep and key.strip() and key.strip() not in values:
                values[key.strip()] = value.strip().strip("'\"")
    for k, v in os.environ.items():
        if v:
            values[k] = v
    return values


def keys():
    v = local_values()
    pairs = [(v.get("DeepSeekAPIName", ""), v.get("DeepSeekAPIKey", "")),
             (v.get("DeepSeekAPIName2", ""), v.get("DeepSeekAPIKey2", ""))]
    software = cloud = ""
    for name, key in pairs:
        n = name.lower().replace(" ", "")
        if "cloud" in n:
            cloud = cloud or key
        elif "software" in n:
            software = software or key
    # Names missing: the first key is VesopaSoftware and the second VesopaCloud,
    # as they were set up.
    software = software or pairs[0][1]
    cloud = cloud or pairs[1][1] or software
    gemini = v.get("GEMINI_API_KEY", "")
    return {"software": software, "cloud": cloud, "gemini": gemini}


SITES = [
    # (repo folder, domain, which DeepSeek key)
    ("vesopasoftware", "vesopasoftware.com", "software"),
    ("vesopa_hosting", "cloud.vesopa.com", "cloud"),
]

# Run in each app's directory: one short question through the app's own client.
PROBE = {
    "vesopasoftware.com": (
        "require('dotenv').config();"
        "const {createClient}=require('./server/lib/vesopa_ai.cjs');"
        "const c=createClient({app:'deploy-check',apiKey:process.env.DEEPSEEK_API_KEY,gemini:{apiKey:process.env.GEMINI_API_KEY}});"
        "c.chat({purpose:'site-chat',messages:[{role:'user',content:'Reply with the single word READY'}]})"
        ".then(r=>console.log('answer',r.provider,JSON.stringify(r.content.slice(0,40))))"
        ".catch(e=>{console.log('ai error',e.message);process.exit(3)})"
    ),
    "cloud.vesopa.com": (
        "require('dotenv').config();"
        "const llm=require('./src/ai/llm');"
        "console.log('deepseek',llm.client.deepseek?'set':'MISSING','backup',llm.client.backup?'set':'none','bedrock',llm.bedrockEnabled()?'set':'none');"
        "llm.client.chat({purpose:'cloud-guide',messages:[{role:'user',content:'Reply with the single word READY'}]})"
        ".then(r=>console.log('answer',r.provider,JSON.stringify(r.content.slice(0,40))))"
        ".catch(e=>{console.log('ai error',e.message);process.exit(3)})"
    ),
}


def set_env(client, app, wanted, drop):
    """Write KEY=value lines into the live .env; returns what changed, by key name only."""
    sftp = client.open_sftp()
    path = posixpath.join(app, ".env")
    try:
        try:
            with sftp.open(path, "r") as f:
                lines = f.read().decode("utf-8", "replace").splitlines()
        except IOError:
            lines = []
        changed = []
        out = []
        seen = set()
        for line in lines:
            key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
            if key in drop and line.strip() == f"{key}={drop[key]}":
                changed.append(f"removed {key}={drop[key]}")
                continue
            if key in wanted:
                seen.add(key)
                value, only_if_missing = wanted[key]
                current = line.split("=", 1)[1].strip()
                if only_if_missing and current:
                    out.append(line)
                    continue
                if current != value:
                    changed.append(f"set {key}")
                out.append(f"{key}={value}")
                continue
            out.append(line)
        added = [k for k in wanted if k not in seen and wanted[k][0]]
        if added:
            out.append("")
            out.append("# Vesopa AI on DeepSeek (tool/deploy_deepseek_ai.py, 2026-10-03)")
            for k in added:
                out.append(f"{k}={wanted[k][0]}")
                changed.append(f"added {k}")
        if changed:
            with sftp.open(path, "w") as f:
                f.write(("\n".join(out) + "\n").encode("utf-8"))
        return changed
    finally:
        sftp.close()


def deploy(client, folder, domain, which, k, check_only):
    app = f"/home/{base.USER}/web/{domain}/private/nodeapp"
    files = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=AM", f"{BASE_COMMIT}..HEAD", "--", folder],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.split()
    files = [f for f in files if not posixpath.basename(f).startswith(".env") and "/node_modules/" not in f and "/test/" not in f]
    print(f"\n== {domain}  ({len(files)} files from {folder}/)")
    status, _ = base.sh(client, f"test -d {app}", quiet=True)
    if status != 0:
        print(f"   ! {app} does not exist on the server; skipped")
        return False
    _, flags = base.sh(client, f"grep -E '^(AI_FEATURES|DEEPSEEK_API_KEY|GEMINI_API_KEY|AI_API_KEY|AI_TTS_API_KEY)=' {app}/.env | sed -E 's/=(.).*/=\\1…/' || true", quiet=True)
    print("   live .env (values hidden): " + (", ".join(flags.split()) or "none of the AI keys"))
    if check_only:
        for f in files:
            print("   " + f)
        return True

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"{base.BACKUPS}/{domain}-{stamp}.tgz"
    status, _ = base.sh(client, (
        f"mkdir -p {base.BACKUPS} && tar -czf {backup} -C {app} "
        "--exclude=./node_modules --exclude=./uploads --exclude=./logs --exclude=./backup "
        "--exclude=./site/assets/video_frames . && ls -lh " + backup + " | awk '{print $5}'"
    ))
    if status != 0:
        print("   ! backup failed; this site was NOT changed")
        return False
    print(f"   backup: {backup}")

    sftp = client.open_sftp()
    try:
        for f in files:
            dest = posixpath.join(app, f[len(folder) + 1:])
            base.vesopa_ssh._mkdirs(sftp, posixpath.dirname(dest))
            sftp.put(str(ROOT / f), dest)
        print(f"   uploaded {len(files)} files")
    finally:
        sftp.close()

    wanted = {"DEEPSEEK_API_KEY": (k[which], False)}
    if k["gemini"]:
        wanted["GEMINI_API_KEY"] = (k["gemini"], True)
    drop = {}
    if domain == "cloud.vesopa.com" and "--keep-ai-off" not in sys.argv:
        drop["AI_FEATURES"] = "off"
    for c in set_env(client, app, wanted, drop) or ["no .env change needed"]:
        print(f"   .env: {c}")

    if domain == "cloud.vesopa.com":
        status, _ = base.sh(client, (
            f"cd {app} && DBU=$(grep -E '^DB_USER=' .env | cut -d= -f2-) "
            "&& DBP=$(grep -E '^DB_PASSWORD=' .env | cut -d= -f2-) "
            "&& DBN=$(grep -E '^DB_NAME=' .env | cut -d= -f2-) "
            "&& mysql -u\"$DBU\" -p\"$DBP\" \"$DBN\" < schema.sql && echo schema applied"
        ))
        if status != 0:
            print(f"   ! schema.sql failed; roll back with: tar -xzf {backup} -C {app}")
            return False

    base.sh(client, f"mkdir -p {app}/logs && chown -R {base.USER}:{base.USER} {app}", quiet=True)
    status, _ = base.sh(client, base.PM2.format(f"restart {domain}") + " >/dev/null && echo restarted")
    if status != 0:
        print(f"   ! pm2 restart failed; roll back with: tar -xzf {backup} -C {app}")
        return False
    time.sleep(5)

    probe = PROBE[domain].replace("'", "'\\''")
    status, out = base.sh(client, f"su - {base.USER} -c \"cd {app} && {NODE} node -e '{probe}'\"")
    good = status == 0 and "answer" in out

    url = f"https://{domain}/api/ai/status" if domain == "vesopasoftware.com" else f"https://{domain}/ai/session"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 vesopa-deploy-check", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read().decode("utf-8", "replace"))
        enabled = body.get("enabled") is True
    except Exception as e:  # noqa: BLE001
        enabled, body = False, str(e)
    print(f"   {'ok ' if enabled else 'BAD'} {url} enabled={enabled}")
    return good and enabled


def main():
    check_only = "--check" in sys.argv
    k = keys()
    print("keys found: " + ", ".join(f"{n}={'yes' if k[n] else 'NO'}" for n in ("software", "cloud", "gemini")))
    if not k["software"] or not k["cloud"]:
        print("! DeepSeek keys not found in the environment or .env.claude; nothing was changed")
        sys.exit(1)
    client = base.vesopa_ssh.connect()
    results = {}
    try:
        for folder, domain, which in SITES:
            results[domain] = deploy(client, folder, domain, which, k, check_only)
    finally:
        client.close()
    print()
    for domain, ok in results.items():
        print(f"{'OK  ' if ok else 'FAIL'} {domain}")
    sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    main()
