"""Read-only look at a venue app on Google Play.

    python tool/play_check.py com.vesopaepos.pontardawerfc

Prints the store listing's icon (what play.google.com shows), the tracks and
their version codes, and the certificate Google Play signs the app with (Play
App Signing), read from a Play-generated APK. That certificate's SHA-1 and
SHA-256 are what Google Sign-In (an Android OAuth client) and passkeys
(assetlinks.json) need: phones that install from Play run the app signed with
it, not with the upload key. Opens an edit and never commits it.
"""
import hashlib
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))

import play_upload as pu  # noqa: E402


def colon(h):
    return ":".join(h[i:i + 2] for i in range(0, len(h), 2)).upper()


def main():
    package = sys.argv[1] if len(sys.argv) > 1 else "com.vesopaepos.pontardawerfc"
    token, who = pu.access_token(pu.key_file())
    play = pu.Play(token, package)
    edit = play.edit()
    base = f"{pu.API}/{package}/edits/{edit}"
    print(f"== {package} (as {who})")
    details = play.call("GET", f"{base}/details")
    lang = details.get("defaultLanguage", "en-GB")
    icons = play.call("GET", f"{base}/listings/{lang}/icon").get("images", [])
    for i in icons:
        print(f"   listing icon: {i.get('url')} sha256={i.get('sha256')}")
    if not icons:
        print("   listing icon: none")
    codes = set()
    for t in play.call("GET", f"{base}/tracks").get("tracks", []):
        for r in t.get("releases", []):
            print(f"   track {t['track']}: {r.get('status')} {r.get('versionCodes')}")
            codes.update(int(c) for c in r.get("versionCodes", []))
    play.call("DELETE", base)
    if not codes:
        return
    code = max(codes)
    apks = play.call("GET", f"{pu.API}/{package}/generatedApks/{code}").get("generatedApks", [])
    for group in apks:
        print(f"   signing key for generated APKs: {group.get('certificateSha256Hash')}")
        target = None
        if group.get("generatedUniversalApk"):
            target = group["generatedUniversalApk"]["downloadId"]
        elif group.get("generatedSplitApks"):
            target = group["generatedSplitApks"][0]["downloadId"]
        if not target:
            continue
        req = urllib.request.Request(
            f"{pu.API}/{package}/generatedApks/{code}/downloads/{target}:download?alt=media",
            headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=600) as r:
            data = r.read()
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            name = next((n for n in z.namelist() if n.startswith("META-INF/") and n.endswith((".RSA", ".EC", ".DSA"))), None)
            with tempfile.TemporaryDirectory() as tmp:
                apk = pathlib.Path(tmp) / "play.apk"
                apk.write_bytes(data)
                out = subprocess.run(["keytool", "-printcert", "-jarfile", str(apk)],
                                     capture_output=True, text=True).stdout
                for line in out.splitlines():
                    if "SHA1:" in line or "SHA256:" in line or "Owner:" in line:
                        print("   play signing " + line.strip())
            if name is None:
                print("   (APK has only a v2/v3 signature; keytool output above)")
        break


if __name__ == "__main__":
    main()
