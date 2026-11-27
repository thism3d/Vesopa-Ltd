"""A venue app to Google Play: the phone bundle, the Wear OS bundle, the listing (2026-10-12).

    python tool/play_upload.py PontardaweRFC                # bundles, listing, pictures
    python tool/play_upload.py PontardaweRFC --listing      # only the listing and pictures
    python tool/play_upload.py PontardaweRFC --track beta   # another track than play.json's
    python tool/play_upload.py PontardaweRFC --builds DIR   # bundles from DIR, not the Desktop
    python tool/play_upload.py PontardaweRFC --next-build   # print the next build number Play has not seen
    python tool/play_upload.py PontardaweRFC --only wear    # one part: phone, wear or listing; apps = phone and wear, no listing
    python tool/play_upload.py PontardaweRFC --halt alpha,wear:beta   # pause what is out on these tracks
    python tool/play_upload.py PontardaweRFC --track production --only phone --draft   # a draft to roll out by hand

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
        # Google's 503 "The service is currently unavailable" and 429 pass in
        # a moment (2026-11-19: one cost Go 1.2.70 its build number): try
        # again, up to four times, before giving up.
        for wait in (5, 15, 30, 60, None):
            try:
                with urllib.request.urlopen(req, timeout=600) as r:
                    raw = r.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and wait is not None:
                    print(f"   ({e.code} from Google Play; trying again in {wait}s)", file=sys.stderr)
                    time.sleep(wait)
                    continue
                raise_play(e)

    def edit(self):
        return self.call("POST", f"{API}/{self.package}/edits", {})["id"]

    def commit(self, edit):
        """Commit the edit; True when Google took it for review, False when
        it is saved but waits for "Send for review" in Play Console."""
        try:
            self.call("POST", f"{API}/{self.package}/edits/{edit}:commit")
            return True
        except PlayError as e:
            # Some changes (a listing on an app under review) must be sent
            # for review from the Play Console's Publishing overview.
            if "changesNotSentForReview" not in str(e):
                raise
            self.call("POST", f"{API}/{self.package}/edits/{edit}:commit?changesNotSentForReview=true")
            print("   committed but NOT sent for review: Play Console > Publishing overview > Send for review")
            return False

    def reviews(self, tracks):
        """Google's own state of each release (owner, 2026-11-27: the watch
        app "not getting on review"): draft, in review, approved but not
        published, published, rejected. The edits API says only
        "completed", which also covers a release Google never got."""
        out = {}
        for t in tracks:
            try:
                r = self.call("GET", f"{API}/{self.package}/tracks/{urllib.parse.quote(t, safe='')}/releases")
            except Exception as e:  # noqa: BLE001 - a readout; never stops the run
                out[t] = [f"review state unknown ({str(e)[:70]})"]
                continue
            out[t] = [f"{x.get('releaseName', '?')}: {x.get('releaseLifecycleState', '?')}"
                      + (f" (codes {', '.join(str(c) for a in x.get('activeArtifacts', []) for c in ([a.get('versionCode')] if a.get('versionCode') else []))})" if x.get('activeArtifacts') else "")
                      for x in r.get("releases", [])] or ["no releases"]
        return out


def raise_play(e):
    """A Play API refusal as a PlayError with Google's own message."""
    detail = e.read().decode(errors="replace")
    try:
        detail = json.loads(detail)["error"]["message"]
    except (ValueError, KeyError, TypeError):
        pass
    raise PlayError(f"{e.code}: {detail}") from None


class PlayError(Exception):
    pass


# Set once Play has said the app is still a draft (never published): every
# release after that is a draft, which is all such an app may hold.
DRAFT_ONLY = [False]


def release(play, edit, aab: pathlib.Path, track, name, notes, lang):
    print(f"   uploading {aab.name} ({aab.stat().st_size // 1_000_000} MB)")
    bundle = play.call("POST", f"{UPLOAD}/{play.package}/edits/{edit}/bundles?uploadType=media",
                       data=aab.read_bytes(), ctype="application/octet-stream")
    code = bundle["versionCode"]
    # --draft: the release waits in Play Console for the owner to roll it out
    # (owner, 2026-10-24: "I'll press the production release myself").
    rel = {"name": name, "versionCodes": [str(code)], "status": "draft" if ("--draft" in sys.argv or DRAFT_ONLY[0]) else "completed",
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
    words = {"language": lang, "title": p["title"], "shortDescription": p["short_description"],
             "fullDescription": p["full_description"]}
    if p.get("video"):  # the YouTube promo shown above the screenshots
        words["video"] = p["video"]
    play.call("PUT", f"{API}/{play.package}/edits/{edit}/listings/{lang}", words)
    print("   name, short and full description, contact details: done")
    for kind, sources in p["images"].items():
        files = []
        for s in sources:
            path = store / s
            files += sorted(f for f in path.iterdir() if f.suffix.lower() in (".png", ".jpg", ".jpeg")) if path.is_dir() else [path] if path.is_file() else []
        if not files:
            print(f"   {kind}: no pictures, left as it is")
            continue
        base = f"{API}/{play.package}/edits/{edit}/listings/{lang}/{kind}"
        try:
            play.call("DELETE", base)
            for f in files:
                play.call("POST", f"{UPLOAD}/{play.package}/edits/{edit}/listings/{lang}/{kind}?uploadType=media",
                          data=f.read_bytes(), ctype="image/png" if f.suffix.lower() == ".png" else "image/jpeg")
            print(f"   {kind}: {len(files)} uploaded")
        except PlayError as e:
            # Wear OS pictures need the Wear OS form factor switched on first.
            print(f"   ! {kind}: {e}")


WEAR_OFFSET = 1_000_000  # the watch bundle's versionCode is the build number plus this
TV_OFFSET = 2_000_000  # and the TV-only bundle's (go-android.yml)


def next_build(play, floor: int) -> int:
    """One more than any build number Play has seen, phone or watch: Play refuses
    a versionCode it already has, on any track, even a rejected one."""
    edit = play.edit()
    try:
        seen = [int(b["versionCode"]) for b in play.call("GET", f"{API}/{play.package}/edits/{edit}/bundles").get("bundles", [])]
    finally:
        play.call("DELETE", f"{API}/{play.package}/edits/{edit}")
    builds = [c % WEAR_OFFSET for c in seen]
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
    skip = {i + 1 for i, a in enumerate(sys.argv) if a in ("--track", "--builds", "--only", "--halt", "--promote")}
    args = [a for i, a in enumerate(sys.argv) if i and i not in skip and not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit(__doc__)
    venue_dir = (ROOT / args[0]).resolve()
    store = venue_dir / "store"
    p = json.loads((store / "play.json").read_text(encoding="utf-8"))
    # An app that keeps its testers' notes in store/what_to_test.json (Vesopa
    # Go, 2026-11-04) gets this release's from there, not play.json's old ones.
    wtt = store / "what_to_test.json"
    if wtt.is_file():
        notes = json.loads(wtt.read_text(encoding="utf-8"))
        text = notes.get("release_notes", "").strip()
        if text:
            p["release_notes"] = text[:500]
    v = json.loads((venue_dir / "venue.json").read_text(encoding="utf-8"))
    track = option("--track") or p.get("track", "internal")
    only = option("--only") or ("listing" if "--listing" in sys.argv else None)
    only_listing = only == "listing"

    keyfile = key_file()
    token, who = access_token(keyfile)
    play = Play(token, p["package"])
    if option("--halt"):
        sys.exit(halt(play, option("--halt").split(",")))
    # --status: every track and what is on it, read only (owner, 2026-11-19:
    # "I did not get the updates": which release is live, a draft, or halted).
    if "--status" in sys.argv:
        edit = play.edit()
        reach = {}
        try:
            tracks = play.call("GET", f"{API}/{play.package}/edits/{edit}/tracks").get("tracks", [])
            # Where each testing track is offered: a form factor's own track
            # (wear:beta) has its own countries, and with none it is published
            # nowhere (owner, 2026-11-20: Wear OS open testing "not published").
            for t in tracks:
                if not t.get("releases"):
                    continue
                try:
                    # A track's name may have spaces ("wear:Closed testing - Alpha").
                    a = play.call("GET", f"{API}/{play.package}/edits/{edit}/countryAvailability/{urllib.parse.quote(t['track'], safe=':')}")
                    n = len(a.get("countries", []))
                    reach[t["track"]] = f"{n} countries" + (" + rest of world" if a.get("restOfWorld") else "") if (n or a.get("restOfWorld")) else "NO COUNTRIES (published nowhere)"
                except Exception as e:  # noqa: BLE001 - a readout; never stops the run
                    reach[t["track"]] = f"countries unknown ({str(e)[:60]})"
        finally:
            play.call("DELETE", f"{API}/{play.package}/edits/{edit}")
        print(f"{p['title']} ({p['package']}): what each track holds")
        for t in sorted(tracks, key=lambda x: x["track"]):
            rels = t.get("releases", [])
            if not rels:
                continue
            for r in rels:
                frac = f" {round(100 * float(r['userFraction']))}% of users" if r.get("userFraction") else ""
                print(f"  {t['track']:<22} {r.get('name', '?'):<16} {r.get('status', '?'):<11}{frac}  codes {', '.join(r.get('versionCodes', []))}  [{reach.get(t['track'], '?')}]")
        print("  (completed = the edit holds it; Google's own state follows)")
        print("Google's review state of each release:")
        for t, lines in play.reviews([t["track"] for t in tracks if t.get("releases")]).items():
            for line in lines:
                print(f"  {t:<22} {line}")
        return
    if "--next-build" in sys.argv:
        print(next_build(play, int(v["build"])))
        return
    # --promote CODE --track beta: a bundle already in Play (e.g. on internal
    # testing) onto another track, with no upload and no build (owner,
    # 2026-11-04: "do not build again").
    if option("--promote"):
        code = option("--promote")
        edit = play.edit()
        # "latest:<track>": the newest version code on that track (owner,
        # 2026-11-27: the Wear OS open-testing build straight to production).
        if code.startswith("latest:"):
            src = code.split(":", 1)[1]
            t = play.call("GET", f"{API}/{play.package}/edits/{edit}/tracks/{src}")
            codes = [int(c) for r in t.get("releases", []) for c in r.get("versionCodes", [])]
            if not codes:
                sys.exit(f"   ! nothing on the {src} track")
            code = str(max(codes))
            print(f"   newest on {src}: version code {code}")
        seen = None
        for t in play.call("GET", f"{API}/{play.package}/edits/{edit}/tracks").get("tracks", []):
            for r in t.get("releases", []):
                if code in r.get("versionCodes", []):
                    seen = (t["track"], r)
        if not seen:
            sys.exit(f"   ! version code {code} is not on any track")
        source, r = seen
        # Moving a release onto the track that already holds it changes
        # nothing, so Google gets nothing to review (2026-11-27: 1000008
        # "from wear:production onto wear:production" made no submission).
        if source == track:
            play.call("DELETE", f"{API}/{play.package}/edits/{edit}")
            sys.exit(f"   ! version code {code} is already on {track}: nothing new to send for review. "
                     f"Build a new one onto it instead (mode full, part wear/phone, track {track}).")
        rel = {"name": r.get("name") or code, "versionCodes": [code], "status": "completed",
               "releaseNotes": r.get("releaseNotes") or [{"language": p["language"], "text": p["release_notes"]}]}
        # The track then holds only this release: an earlier one there (Play's
        # "superseded by another version", or a halted first release) is
        # replaced. Committing sends it to Google's review.
        play.call("PUT", f"{API}/{play.package}/edits/{edit}/tracks/{track}", {"track": track, "releases": [rel]})
        sent = play.commit(edit)
        print(f"   version code {code} ({rel['name']}) from {source} onto the {track} track" + (", sent for review" if sent else ""))
        return
    print(f"{p['title']} ({p['package']}) as {who}")

    failed = False
    if not only_listing:
        builds = pathlib.Path(option("--builds") or pathlib.Path.home() / "Desktop" / "Android-builds")
        stem = f"{venue_dir.name}-{v['version']}-{v['build']}"
        name = f"{v['version']} ({v['build']})"
        parts = [(builds / f"{stem}.aab", track, "Phone and tablet", "phone"),
                 (builds / f"{stem}-wear.aab", f"wear:{track}", "Wear OS", "wear"),
                 # Vesopa Go's TV-only bundle (go-android.yml), for Play's
                 # dedicated Android TV track; a venue app has none.
                 (builds / f"{stem}-tv.aab", f"tv:{track}", "Android TV", "tv")]
        for aab, t, label, part in parts:
            # --only apps: the phone and the watch bundles, without the listing.
            if only and only != part and only != "apps":
                continue
            # Only the bundles this app has: Go has no watch, a venue app no TV.
            if not aab.is_file() and (part == "tv" or (part == "wear" and not v.get("watch_app_id"))):
                continue
            print(f"{label}:")
            if not aab.is_file():
                print(f"   ! {aab} is missing: run {venue_dir.name}\\build-android.cmd first")
                failed = True
                continue
            if part in ("wear", "tv"):
                # Play gives a new Wear OS form factor internal, open (beta)
                # and production tracks but no closed one: a closed-testing
                # phone release puts its watch on Wear OS internal testing,
                # which is private too (Loughor RFC, 2026-11-19).
                try:
                    look = play.edit()
                    have = {x["track"] for x in play.call("GET", f"{API}/{play.package}/edits/{look}/tracks").get("tracks", [])}
                    play.call("DELETE", f"{API}/{play.package}/edits/{look}")
                    inner = f"{part}:internal"
                    if t not in have and inner in have and track not in ("beta", "production"):
                        print(f"   (no {t} track in Play: this goes on {inner}, {label} internal testing)")
                        t = inner
                except PlayError:
                    pass
            try:
                # Another run using Play at the same time (Club site reads the
                # signing key) ends this one's edit: "This edit has expired" or
                # "has been deleted" (Loughor RFC 1.0.0 (7), 2026-11-20). The
                # upload is started again, once, in a fresh edit.
                for attempt in (1, 2):
                    try:
                        edit = play.edit()
                        release(play, edit, aab, t, name, p["release_notes"], p["language"])
                        break
                    except PlayError as e:
                        gone = "edit has expired" in str(e).lower() or "edit has been deleted" in str(e).lower()
                        if attempt == 2 or not gone:
                            raise
                        print("   (Play ended the edit while uploading: starting it again)")
                try:
                    play.commit(edit)
                except PlayError as e:
                    # A draft app refuses a completed release at the commit, not
                    # at the track: start again with the release as a draft.
                    if "draft" not in str(e).lower() or DRAFT_ONLY[0]:
                        raise
                    DRAFT_ONLY[0] = True
                    edit = play.edit()
                    release(play, edit, aab, t, name, p["release_notes"], p["language"])
                    play.commit(edit)
                    print("   (the app is still a draft in Play, so the release is a draft: roll it out in Play Console)")
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

    if only in ("phone", "wear", "tv", "apps"):
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
