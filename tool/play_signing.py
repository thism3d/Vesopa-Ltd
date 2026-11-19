"""The SHA-256 fingerprint of the key Google Play signs an app with.

    PLAY_SERVICE_ACCOUNT_JSON='{...}' python3 tool/play_signing.py com.vesopaepos.loughorrfc

Play re-signs every app it delivers with that app's own signing key, so a
website that lets the app open its links (assetlinks.json) must name that
key's fingerprint; another club's, or only the upload key's, verifies nothing
(Loughor RFC, 2026-11-19). Asks Play for the newest bundle it has and the
certificate of the APKs it made from it. Prints "package=AA:BB:..."; the
fingerprint is public (Play Console > App integrity shows it).
"""
import base64
import re
import sys

from play_upload import API, Play, PlayError, access_token, key_file


def colons(raw: str) -> str | None:
    """Play's hash as AA:BB:..., whether it came as hex or base64."""
    text = raw.strip().replace(":", "")
    if re.fullmatch(r"[0-9A-Fa-f]{64}", text):
        data = bytes.fromhex(text)
    else:
        try:
            data = base64.b64decode(text + "=" * (-len(text) % 4), altchars=b"-_")
        except ValueError:
            return None
    return ":".join(f"{b:02X}" for b in data) if len(data) == 32 else None


def signing_prints(package: str) -> list[str]:
    token, _ = access_token(key_file())
    play = Play(token, package)
    edit = play.edit()
    try:
        codes = sorted(int(b["versionCode"]) for b in play.call("GET", f"{API}/{package}/edits/{edit}/bundles").get("bundles", []))
    finally:
        play.call("DELETE", f"{API}/{package}/edits/{edit}")
    if not codes:
        return []
    got = play.call("GET", f"{API}/{package}/generatedApks/{codes[-1]}")
    prints = []
    for g in got.get("generatedApks", []):
        p = colons(str(g.get("certificateSha256Hash", "")))
        if p and p not in prints:
            prints.append(p)
    return prints


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    try:
        prints = signing_prints(sys.argv[1])
    except PlayError as e:
        raise SystemExit(f"! {e}")
    if not prints:
        raise SystemExit(f"! Play has no signed build of {sys.argv[1]} yet")
    print(f"{sys.argv[1]}={','.join(prints)}")


if __name__ == "__main__":
    main()
