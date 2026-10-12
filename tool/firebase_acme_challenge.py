"""Answer one Firebase (Google) ACME challenge on auth.vesopa.com.

    python tool/firebase_acme_challenge.py <token>.<key-authorisation>
    python tool/firebase_acme_challenge.py --remove

Firebase checks a custom domain by fetching
http(s)://auth.vesopa.com/.well-known/acme-challenge/<token> and expecting
the exact text <token>.<key-authorisation>. The owner asked for it on
2026-10-12.

WHY AN NGINX INCLUDE AND NOT THE APP. Hestia already answers EVERY path under
/.well-known/acme-challenge/ on this box with one regex location that returns
"<token>.<Hestia's own account thumbprint>" — stateless ACME, which is how its
Let's Encrypt renewals pass. That answer would be wrong for Firebase's token.
An exact `location =` wins over any regex location in nginx, so this include
answers Firebase's one token and leaves Hestia's regex in charge of every
other one: Let's Encrypt renewal for auth.vesopa.com keeps working unchanged.
The script checks that too, with a made-up token, and takes the include out
again if anything is off.
"""
import pathlib
import re
import sys
import time
import urllib.request
import uuid

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))

import deploy_client_area_vesopa_connect as base  # noqa: E402

vesopa_ssh = base.vesopa_ssh
sh = base.sh

DOMAIN = "auth.vesopa.com"
CONF = f"/home/vesopasoftware/conf/web/{DOMAIN}"
NAMES = ["nginx.conf_0firebase_acme", "nginx.ssl.conf_0firebase_acme"]  # port 80 and 443
VALUE = re.compile(r"^([A-Za-z0-9_-]{20,})\.([A-Za-z0-9_-]{20,})$")


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "vesopa-acme-check"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace").strip()
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def reload(client, undo):
    st, out = sh(client, "nginx -t 2>&1 | tail -1", quiet=True)
    if "successful" not in out:
        sh(client, undo, quiet=True)
        raise SystemExit(f"! nginx refused it ({out.strip()}); taken out again, nginx not reloaded")
    sh(client, "systemctl reload nginx", quiet=True)


def main():
    args = sys.argv[1:]
    remove = "--remove" in args
    value = next((a.strip() for a in args if not a.startswith("--")), "")
    match = VALUE.match(value)
    if not remove and not match:
        raise SystemExit(__doc__)
    paths = " ".join(f"{CONF}/{n}" for n in NAMES)

    client = vesopa_ssh.connect()
    try:
        if remove:
            sh(client, f"rm -f {paths}", quiet=True)
            reload(client, "true")
            print("removed the Firebase ACME include")
            return

        token = match.group(1)
        body = "\n".join([
            "# Firebase custom-domain check (tool/firebase_acme_challenge.py).",
            "# Exact match, so Hestia's regex keeps answering every other token.",
            f"location = /.well-known/acme-challenge/{token} {{",
            "    default_type text/plain;",
            f"    return 200 '{value}';",
            "}",
            "",
        ])
        sftp = client.open_sftp()
        try:
            for name in NAMES:
                with sftp.open(f"{CONF}/{name}", "w") as f:
                    f.write(body)
        finally:
            sftp.close()
        reload(client, f"rm -f {paths}")
        time.sleep(2)
    finally:
        client.close()

    ok = True
    for scheme in ("http", "https"):
        st, got = get(f"{scheme}://{DOMAIN}/.well-known/acme-challenge/{token}")
        good = st == 200 and got == value
        ok &= good
        print(f"   {'ok ' if good else 'BAD'} {scheme}: {st} {got[:70]}")
    probe = uuid.uuid4().hex + "abcdefgh"
    st, got = get(f"https://{DOMAIN}/.well-known/acme-challenge/{probe}")
    hestia = st == 200 and got.startswith(probe + ".") and got != value
    ok &= hestia
    print(f"   {'ok ' if hestia else 'BAD'} any other token still gets Hestia's answer (Let's Encrypt renewal): {st}")
    if not ok:
        raise SystemExit("! not right; run with --remove to take the include out")


if __name__ == "__main__":
    main()
