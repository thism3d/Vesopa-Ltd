"""go.vesopa.com/.well-known/assetlinks.json: Android's proof that Vesopa Go
may open go.vesopa.com/link (a screen's QR) itself rather than in the browser
(owner, 2026-11-18: "I want to use deeplink to the app scanned from iPhone,
iPad and Android").

    python vesopa_go/tool/assetlinks.py --upload SHA256 [--version-code N]

Android checks the app's signing certificate against this file. Two can sign
Vesopa Go: the upload key (the APK on go.vesopa.com/install) and Google Play's
app-signing key (everything installed from Play), read from Play's API for a
build Play has made. Both are listed. Run by go-android.yml after the upload.
"""
import base64
import json
import os
import pathlib
import re
import sys
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "tool"))
import go_site  # noqa: E402

PACKAGE = "com.vesopa.go"


def colons(value):
    """A SHA-256 as Android wants it: 32 hex pairs with colons."""
    v = value.strip()
    if re.fullmatch(r"([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}", v):
        return v.upper()
    if re.fullmatch(r"[0-9A-Fa-f]{64}", v):
        raw = bytes.fromhex(v)
    else:
        raw = base64.b64decode(v + "=" * (-len(v) % 4), altchars=b"-_" if "-" in v or "_" in v else None)
    if len(raw) != 32:
        raise ValueError(f"not a SHA-256: {value[:12]}…")
    return ":".join(f"{b:02X}" for b in raw)


def play_signing(version_code):
    """Play's app-signing certificate, from the APKs Play generated for a build."""
    try:
        import play_upload  # noqa: E402  (tool/play_upload.py: the service account)
        token, _ = play_upload.access_token(play_upload.key_file())
        url = f"{play_upload.API}/{PACKAGE}/generatedApks/{version_code}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        found = []
        for group in data.get("generatedApks", []):
            sha = group.get("certificateSha256Hash")
            if sha:
                found.append(colons(sha))
        return found
    except Exception as e:  # noqa: BLE001 - the upload key alone still serves the install page
        print(f"  Play's app-signing certificate not read: {e}")
        return []


def main():
    args = sys.argv[1:]
    upload = args[args.index("--upload") + 1] if "--upload" in args else os.environ.get("UPLOAD_SHA256", "")
    code = args[args.index("--version-code") + 1] if "--version-code" in args else ""
    prints = []
    if upload:
        prints.append(colons(upload))
    if code:
        prints += play_signing(code)
    prints = sorted(set(prints))
    if not prints:
        raise SystemExit("! no certificate fingerprints: nothing to publish")
    body = json.dumps([{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {"namespace": "android_app", "package_name": PACKAGE, "sha256_cert_fingerprints": prints},
    }], indent=2).encode()
    user, folder = go_site.where()
    target = f"{folder}/.well-known"
    go_site.sh(f"mkdir -p {target} && cat > {target}/assetlinks.json && chown -R {user}:{user} {target} "
               f"&& chmod 755 {target} && chmod 644 {target}/assetlinks.json", data=body)
    print(f"  {len(prints)} certificate(s) in https://{go_site.DOMAIN}/.well-known/assetlinks.json:",
          go_site.status(f"https://{go_site.DOMAIN}/.well-known/assetlinks.json"))


if __name__ == "__main__":
    main()
