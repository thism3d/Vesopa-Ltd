"""A venue app to Google Play: the phone bundle, the Wear OS bundle, the listing (2026-10-12).

    python tool/play_upload.py PontardaweRFC                # bundles, listing, pictures
    python tool/play_upload.py PontardaweRFC --listing      # only the listing and pictures
    python tool/play_upload.py PontardaweRFC --track beta   # another track than play.json's
    python tool/play_upload.py PontardaweRFC --builds DIR   # bundles from DIR, not the Desktop
    python tool/play_upload.py PontardaweRFC --next-build   # print the next build number Play has not seen
    python tool/play_upload.py PontardaweRFC --only wear    # one part: phone, wear or listing
    python tool/play_upload.py PontardaweRFC --halt alpha,wear:beta   # pause what is out on these tracks

Reads <venue>/store/play.json (package, words, track, release notes, which
pictures) and venue.json (version and build), and takes the bundles that
<venue>/build-android.ps1 left in Desktop\\Android-builds:
PontardaweRFC-<version>-<build>.aab, and -wear.aab for the watch, which goes on
the Wear OS track ("wear:<track>") of the same listing.

Through the Google Play Developer API, as a service account the Play Console
has been given release rights (Users and permissions > Invite, with "Release
to testing tracks" and "Manage store presence"). Its key file is
PLAY_SERVICE_ACCOUNT_JSON (a path, or the key file's contents themselves, as a
GitHub secret holds it), else Documents\\Vesopa-Keys\\play-service-account.json,
else the Firebase Admin SDK key beside it (the same Google project, so one
account can do both). Never in the repo. The Google Play Android Developer
API must be switched on in that Google Cloud project.

Each part is its own edit, so a watch the Play Console has not been told about
yet (Advanced settings > Form factors > Wear OS) does not stop the phone
release. Run on the owner's PC, like the other release tools.
"""
import base64
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications"
UPLOAD = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications"
SCOPE = "https://www.googleapis.com/auth/androidpublisher"
KEYS = pathlib.Path.home() / "Documents" / "Vesopa-Keys"


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def key_file() -> pathlib.Path:
    named = os.environ.get("PLAY_SERVICE_ACCOUNT_JSON", "").strip()
    if named.startswith("{"):
        # The key itself (a CI secret), not a path to it: to a private file.
        import tempfile
        fd, tmp = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(named)
        return pathlib.Path(tmp)
    for p in [named, KEYS / "play-service-account.json", KEYS / "firebase-adminsdk-vesopa.json"]:
        if p and pathlib.Path(p).is_file():
            return pathlib.Path(p)
    raise SystemExit(f"! no service account key: set PLAY_SERVICE_ACCOUNT_JSON or save it as {KEYS / 'play-service-account.json'}")


def access_token(path: pathlib.Path) -> tuple[str, str]:
    """A Google access token for the service account, signed here (RS256)."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    sa = json.loads(path.read_text(encoding="utf-8"))
    now = int(time.time())
    head = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claim = b64(json.dumps({"iss": sa["client_email"], "scope": SCOPE, "aud": sa["token_uri"],
                            "iat": now, "exp": now + 3600}).encode())
    key = serialization.load_pem_private_key(sa["private_key"].encode(), password=None)
    sig = key.sign(f"{head}.{claim}".encode(), padding.PKCS1v15(), hashes.SHA256())
    body = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                   "assertion": f"{head}.{claim}.{b64(sig)}"}).encode()
    with urllib.request.urlopen(urllib.request.Request(sa["token_uri"], data=body), timeout=30) as r:
        return json.loads(r.read())["access_token"], sa["client_email"]


class Play:
    def __init__(self, token, package):
        self.token, self.package = token, package

    def call(self, method, url, body=None, *, data=None, ctype="application/json"):
        if body is not None:
            data = json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Authorization": f"Bearer {self.token}", "Content-Type": ctype})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            try:
                detail = json.loads(detail)["error"]["message"]
            except (ValueError, KeyError, TypeError):
                pass
            raise PlayError(f"{e.code}: {detail}") from None

    def edit(self):
        return self.call("POST", f"{API}/{self.package}/edits", {})["id"]

    def commit(self, edit):
        try:
            self.call("POST", f"{API}/{self.package}/edits/{edit}:commit")
        except PlayError as e:
            # Some changes (a listing on an app under review) must be sent
            # for review from the Play Console's Publishing overview.
            if "changesNotSentForReview" not in str(e):
                raise
            self.call("POST", f"{API}/{self.package}/edits/{edit}:commit?changesNotSentForReview=true")
            print("   committed; send the changes for review in Play Console > Publishing overview")


class PlayError(Exception):
    pass


def release(play, edit, aab: pathlib.Path, track, name, notes, lang):
    print(f"   uploading {aab.name} ({aab.stat().st_size // 1_000_000} MB)")
    bundle = play.call("POST", f"{UPLOAD}/{play.package}/edits/{edit}/bundles?uploadType=media",
                       data=aab.read_bytes(), ctype="application/octet-stream")
    code = bundle["versionCode"]
    rel = {"name": name, "versionCodes": [str(code)], "status": "completed",
           "releaseNotes": [{"language": lang, "text": notes}]}
    try:
        play.call("PUT", f"{API}/{play.package}/edits/{edit}/tracks/{track}", {"track": track, "releases": [rel]})
    except PlayError as e:
        # An app that has never been published can only hold draft releases.
        if "draft" not in str(e).lower():
            raise
        rel["status"] = "draft"
        play.call("PUT", f"{API}/{play.package}/edits/{edit}/tracks/{track}", {"track": track, "releases": [rel]})
        print("   (the app is still a draft in Play, so the release is a draft: roll it out in Play Console)")
    print(f"   version code {code} on the {track} track")


def listing(play, edit, store: pathlib.Path, p):
    lang = p["language"]
    play.call("PUT", f"{API}/{play.package}/edits/{edit}/details",
              {"defaultLanguage": lang, "contactEmail": p["contact_email"], "contactWebsite": p["contact_website"]})
    play.call("PUT", f"{API}/{play.package}/edits/{edit}/listings/{lang}",
              {"language": lang, "title": p["title"], "shortDescription": p["short_description"],
               "fullDescription": p["full_description"]})
    print("   name, short and full description, contact details: done")
    for kind, sources in p["images"].items():
        files = []
        for s in sources:
            path = store / s
            files += sorted(path.glob("*.png")) if path.is_dir() else [path] if path.is_file() else []
        if not files:
            print(f"   {kind}: no pictures, left as it is")
            continue
        base = f"{API}/{play.package}/edits/{edit}/listings/{lang}/{kind}"
        try:
            play.call("DELETE", base)
            for f in files:
                play.call("POST", f"{UPLOAD}/{play.package}/edits/{edit}/listings/{lang}/{kind}?uploadType=media",
                          data=f.read_bytes(), ctype="image/png")
            print(f"   {kind}: {len(files)} uploaded")
        except PlayError as e:
            # Wear OS pictures need the Wear OS form factor switched on first.
            print(f"   ! {kind}: {e}")


WEAR_OFFSET = 1_000_000  # the watch bundle's versionCode is the build number plus this


def next_build(play, floor: int) -> int:
    """One more than any build number Play has seen, phone or watch: Play refuses
    a versionCode it already has, on any track, even a rejected one."""
    edit = play.edit()
    try:
        seen = [int(b["versionCode"]) for b in play.call("GET", f"{API}/{play.package}/edits/{edit}/bundles").get("bundles", [])]
    finally:
        play.call("DELETE", f"{API}/{play.package}/edits/{edit}")
    builds = [c - WEAR_OFFSET if c >= WEAR_OFFSET else c for c in seen]
    return max([floor - 1, *builds]) + 1


def halt(play, tracks) -> int:
    """Pause what is out on each track: testers stop being offered it. Play
    keeps the release, and a newer one on the track replaces it."""
    failed = 0
    for track in [t.strip() for t in tracks if t.strip()]:
        edit = play.edit()
        try:
            t = play.call("GET", f"{API}/{play.package}/edits/{edit}/tracks/{track}")
            releases = t.get("releases", [])
            live = [r for r in releases if r.get("status") in ("completed", "inProgress")]
            if not live:
                print(f"{track}: nothing out to pause ({', '.join(r.get('status', '?') for r in releases) or 'empty'})")
                play.call("DELETE", f"{API}/{play.package}/edits/{edit}")
                continue
            for r in live:
                r["status"] = "halted"
            play.call("PUT", f"{API}/{play.package}/edits/{edit}/tracks/{track}", {"track": track, "releases": releases})
            play.commit(edit)
            print(f"{track}: paused {', '.join(r.get('name', '') + ' ' + str(r.get('versionCodes')) for r in live)}")
        except PlayError as e:
            failed = 1
            print(f"{track}: ! {e}")
    return failed


def option(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None


def main():
    # Words after --track and --builds are their values, not the venue.
    skip = {i + 1 for i, a in enumerate(sys.argv) if a in ("--track", "--builds", "--only", "--halt")}
    args = [a for i, a in enumerate(sys.argv) if i and i not in skip and not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit(__doc__)
    venue_dir = (ROOT / args[0]).resolve()
    store = venue_dir / "store"
    p = json.loads((store / "play.json").read_text(encoding="utf-8"))
    v = json.loads((venue_dir / "venue.json").read_text(encoding="utf-8"))
    track = option("--track") or p.get("track", "internal")
    only = option("--only") or ("listing" if "--listing" in sys.argv else None)
    only_listing = only == "listing"

    keyfile = key_file()
    token, who = access_token(keyfile)
    play = Play(token, p["package"])
    if option("--halt"):
        sys.exit(halt(play, option("--halt").split(",")))
    if "--next-build" in sys.argv:
        print(next_build(play, int(v["build"])))
        return
    print(f"{p['title']} ({p['package']}) as {who}")

    failed = False
    if not only_listing:
        builds = pathlib.Path(option("--builds") or pathlib.Path.home() / "Desktop" / "Android-builds")
        stem = f"{venue_dir.name}-{v['version']}-{v['build']}"
        name = f"{v['version']} ({v['build']})"
        parts = [(builds / f"{stem}.aab", track, "Phone and tablet", "phone"),
                 (builds / f"{stem}-wear.aab", f"wear:{track}", "Wear OS", "wear")]
        for aab, t, label, part in parts:
            if only and only != part:
                continue
            print(f"{label}:")
            if not aab.is_file():
                print(f"   ! {aab} is missing: run {venue_dir.name}\\build-android.cmd first")
                failed = True
                continue
            try:
                edit = play.edit()
                release(play, edit, aab, t, name, p["release_notes"], p["language"])
                play.commit(edit)
            except PlayError as e:
                failed = True
                print(f"   ! {e}")
                if "Track not found" in str(e):
                    # Say which tracks Play does have, so the right name can be given.
                    try:
                        look = play.edit()
                        names = sorted(x["track"] for x in play.call("GET", f"{API}/{play.package}/edits/{look}/tracks").get("tracks", []))
                        play.call("DELETE", f"{API}/{play.package}/edits/{look}")
                        print(f"     Tracks Play has for this app: {', '.join(names)}")
                    except PlayError as e2:
                        print(f"     (could not list the tracks: {e2})")
                if label == "Wear OS":
                    print("     A Wear OS testing track is made in Play Console > Test and release > Testing >"
                          " Closed testing > Create track, form factor Wear OS; or give --track one Play has.")

    if only in ("phone", "wear"):
        sys.exit(1 if failed else 0)
    print("Store listing:")
    try:
        edit = play.edit()
        listing(play, edit, store, p)
        play.commit(edit)
    except PlayError as e:
        failed = True
        print(f"   ! {e}")

    print("\nThe rest of Play Console's questions (app access, data safety, content rating) are"
          f" answered in {venue_dir.name}\\store\\play_console.md; Google's API cannot fill those in.")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
