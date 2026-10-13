"""Set the iOS workflow's FIREBASE_IOS_API_KEY secret and start "iOS - venue app".

    python tool/github_ios_release.py                 # secret, then run the workflow (full)
    python tool/github_ios_release.py --secret-only
    python tool/github_ios_release.py --run-only [--mode check|full|listing] [--venue PontardaweRFC]

Uses the GitHub sign-in git already has on this PC (Git Credential Manager,
`git credential fill`); nothing is printed. The secret goes into the
"App Store Connect API" environment the workflow uses, sealed with the
repository's public key as GitHub requires (PyNaCl). Its value is API_KEY from
<venue>/GoogleService-Info.plist (gitignored).
"""
import base64
import json
import pathlib
import plistlib
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OWNER, REPO = "thism3d", "Vesopa-Ltd"
ENVIRONMENT = "App Store Connect API"
WORKFLOW = "ios-venue-app.yml"


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def token():
    out = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                         capture_output=True, text=True, cwd=ROOT, timeout=60).stdout
    for line in out.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1]
    raise SystemExit("! git has no GitHub sign-in on this PC")


def api(tok, method, path, body=None):
    req = urllib.request.Request(f"https://api.github.com{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json",
                                          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "vesopa-release"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, {"message": e.read().decode(errors="replace")[:300]}


def set_secret(tok, venue):
    from nacl import encoding, public
    value = str(plistlib.loads((ROOT / venue / "GoogleService-Info.plist").read_bytes()).get("API_KEY", ""))
    if not value:
        raise SystemExit(f"! no API_KEY in {venue}/GoogleService-Info.plist")
    st, repo = api(tok, "GET", f"/repos/{OWNER}/{REPO}")
    if st != 200:
        raise SystemExit(f"! cannot read the repository ({st}): {repo.get('message')}")
    env = urllib.parse.quote(ENVIRONMENT)
    st, key = api(tok, "GET", f"/repositories/{repo['id']}/environments/{env}/secrets/public-key")
    if st != 200:
        raise SystemExit(f"! cannot read the environment's key ({st}): {key.get('message')}")
    sealed = public.SealedBox(public.PublicKey(key["key"].encode(), encoding.Base64Encoder())).encrypt(value.encode())
    st, out = api(tok, "PUT", f"/repositories/{repo['id']}/environments/{env}/secrets/FIREBASE_IOS_API_KEY",
                  {"encrypted_value": base64.b64encode(sealed).decode(), "key_id": key["key_id"]})
    if st not in (201, 204):
        raise SystemExit(f"! secret not saved ({st}): {out.get('message')}")
    print(f"FIREBASE_IOS_API_KEY saved in the '{ENVIRONMENT}' environment")


def run(tok, venue, mode):
    st, out = api(tok, "POST", f"/repos/{OWNER}/{REPO}/actions/workflows/{WORKFLOW}/dispatches",
                  {"ref": "main", "inputs": {"venue": venue, "mode": mode}})
    if st != 204:
        raise SystemExit(f"! workflow not started ({st}): {out.get('message')}")
    print(f"started 'iOS - venue app' for {venue} ({mode}): https://github.com/{OWNER}/{REPO}/actions/workflows/{WORKFLOW}")


def main():
    venue = arg("--venue", "PontardaweRFC")
    tok = token()
    if "--run-only" not in sys.argv:
        set_secret(tok, venue)
    if "--secret-only" not in sys.argv:
        run(tok, venue, arg("--mode", "full"))


if __name__ == "__main__":
    main()
