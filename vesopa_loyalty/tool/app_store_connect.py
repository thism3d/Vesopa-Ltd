"""
A venue's iPhone app in App Store Connect, through Apple's API.

    python vesopa_loyalty/tool/app_store_connect.py status   PontardaweRFC
    python vesopa_loyalty/tool/app_store_connect.py prepare  PontardaweRFC
    python vesopa_loyalty/tool/app_store_connect.py store    PontardaweRFC
    python vesopa_loyalty/tool/app_store_connect.py testflight PontardaweRFC <build>

Run by .github/workflows/ios-venue-app.yml, which has the key; it can be run
anywhere else with the same three variables set:

    ASC_KEY_ID      the key's ID
    ASC_ISSUER_ID   the Issuer ID
    ASC_KEY_P8      the AuthKey_XXXXXXXXXX.p8 file's contents (or ASC_KEY_PATH)

prepare     registers the App IDs (the app and its Watch app) with Push
            Notifications on, finds the app's record, and prints the next free
            build number for venue.json's version (as `build=N`, for the
            workflow). Apple's API cannot create the app record itself: when
            there is none it says exactly what to type in App Store Connect
            and stops.

store       fills the App Store listing from <venue>/store/app_store.json and
            the pictures in <venue>/store/screenshots/: name, subtitle,
            description, keywords, URLs, category, age rating, price (free),
            availability, copyright, review contact and notes, and replaces
            the screenshots. Reviewer sign-in comes from ASC_REVIEW_USER and
            ASC_REVIEW_PASSWORD when they are set. Nothing is submitted.

testflight  waits for the uploaded build to finish processing, gives it its
            "What to Test", fills TestFlight's own test information, puts it
            in the internal group (every App Store Connect user on the team,
            added as testers) and attaches it to the App Store version.

Everything is safe to run again: what is already right is left alone.

Two things Apple's API does not do at all, and which are listed at the end of
every `store` run until done by hand: the App Privacy answers, and creating
the app record.

Needs PyJWT with its crypto extra (`pip install "pyjwt[crypto]"`).
"""

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import jwt

API = "https://api.appstoreconnect.apple.com"

# Apple's names for the screenshot sizes this uploads. The folder names are
# ours; the sizes are the ones each display type takes.
SCREENSHOT_SETS = {
    "iphone-6.9": ("APP_IPHONE_67", {(1290, 2796), (1320, 2868)}),
    "ipad-13": ("APP_IPAD_PRO_3GEN_129", {(2048, 2732), (2064, 2752)}),
}

# Left for the end of the run: what still needs a person in App Store Connect.
TODO = []


def note(msg):
    print(msg, flush=True)


def todo(msg):
    TODO.append(msg)
    print(f"! {msg}", flush=True)


class AppleError(Exception):
    def __init__(self, status, body):
        self.status = status
        self.body = body
        try:
            self.errors = json.loads(body).get("errors", [])
        except ValueError:
            self.errors = []
        super().__init__(f"{status}: {body[:1500]}")

    def detail(self):
        return "; ".join(f"{e.get('title', '')} {e.get('detail', '')}".strip() for e in self.errors) or self.body[:500]


class Client:
    def __init__(self):
        key_id = os.environ.get("ASC_KEY_ID", "").strip()
        issuer = os.environ.get("ASC_ISSUER_ID", "").strip()
        p8 = os.environ.get("ASC_KEY_P8", "")
        if not p8 and os.environ.get("ASC_KEY_PATH"):
            p8 = Path(os.environ["ASC_KEY_PATH"]).read_text()
        if not (key_id and issuer and p8.strip()):
            raise SystemExit("ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 (or ASC_KEY_PATH) are needed.")
        self.key_id, self.issuer, self.p8 = key_id, issuer, p8.strip() + "\n"
        self._token, self._made = None, 0

    def token(self):
        # Apple allows twenty minutes; a fresh one every ten.
        if not self._token or time.time() - self._made > 600:
            now = int(time.time())
            self._token = jwt.encode(
                {"iss": self.issuer, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"},
                self.p8,
                algorithm="ES256",
                headers={"kid": self.key_id, "typ": "JWT"},
            )
            self._made = now
        return self._token

    def call(self, method, path, body=None, query=None):
        url = path if path.startswith("http") else API + path
        if query:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query)
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(5):
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("Authorization", f"Bearer {self.token()}")
            if data is not None:
                req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=120) as res:
                    raw = res.read().decode()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                raw = e.read().decode(errors="replace")
                if e.code in (429, 500, 502, 503, 504) and attempt < 4:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise AppleError(e.code, raw) from None
            except urllib.error.URLError:
                if attempt < 4:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise

    def get(self, path, **query):
        return self.call("GET", path, query=query or None)

    def all(self, path, **query):
        """Every page of a list."""
        out = []
        page = self.get(path, **query)
        while True:
            out.extend(page.get("data", []))
            nxt = page.get("links", {}).get("next")
            if not nxt:
                return out
            page = self.call("GET", nxt)

    def post(self, path, body):
        return self.call("POST", path, body)

    def patch(self, path, body):
        return self.call("PATCH", path, body)

    def delete(self, path, body=None):
        return self.call("DELETE", path, body)



def patch_attributes(c, kind, rid, attrs, label):
    """PATCH what Apple will take, dropping any attribute it says it does not
    know (Apple adds and retires age rating questions, for one) rather than
    losing the rest of the update."""
    attrs = {k: v for k, v in attrs.items() if v is not None}
    for _ in range(len(attrs) + 1):
        if not attrs:
            return
        try:
            c.patch(f"/v1/{kind}/{rid}", {"data": {"type": kind, "id": rid, "attributes": attrs}})
            note(f"  {label}: done")
            return
        except AppleError as e:
            dropped = False
            for err in e.errors:
                ptr = (err.get("source") or {}).get("pointer", "")
                name = ptr.rsplit("/", 1)[-1] if "/attributes/" in ptr else ""
                if name in attrs:
                    note(f"  {label}: Apple refused {name} ({err.get('detail', '')}); left as it is")
                    attrs.pop(name)
                    dropped = True
            if not dropped:
                todo(f"{label}: {e.detail()}")
                return


def load_venue(name):
    repo = Path(__file__).resolve().parents[2]
    venue_dir = (repo / name).resolve()
    v = json.loads((venue_dir / "venue.json").read_text(encoding="utf-8"))
    store_file = venue_dir / "store" / "app_store.json"
    store = json.loads(store_file.read_text(encoding="utf-8")) if store_file.exists() else {}
    return venue_dir, v, store


def find_app(c, bundle_id):
    apps = c.get("/v1/apps", **{"filter[bundleId]": bundle_id}).get("data", [])
    return apps[0] if apps else None


# ---- status -------------------------------------------------------------------


def cmd_status(venue_name):
    """What App Store Connect has for the app, changing nothing."""
    _, v, _ = load_venue(venue_name)
    c = Client()
    app = find_app(c, v["app_id"])
    if not app:
        note(f"No app record for {v['app_id']}.")
        return
    a = app["attributes"]
    note(f"App: {a.get('name')}  Apple ID {app['id']}  bundle {a.get('bundleId')}  SKU {a.get('sku')}  "
         f"primary language {a.get('primaryLocale')}")

    def safe(label, fn):
        try:
            fn()
        except AppleError as e:
            note(f"  {label}: {e.detail()}")

    def infos():
        for info in c.all(f"/v1/apps/{app['id']}/appInfos"):
            ia = info["attributes"]
            note(f"  app info: state {ia.get('state') or ia.get('appStoreState')}, age rating {ia.get('appStoreAgeRating')}")
            for loc in c.all(f"/v1/appInfos/{info['id']}/appInfoLocalizations"):
                la = loc["attributes"]
                note(f"    {la['locale']}: name {la.get('name')!r}, subtitle {la.get('subtitle')!r}, privacy {la.get('privacyPolicyUrl')!r}")

    def versions():
        for ver in c.all(f"/v1/apps/{app['id']}/appStoreVersions"):
            va = ver["attributes"]
            note(f"  version {va['versionString']} ({va.get('platform')}): {va.get('appVersionState') or va.get('appStoreState')}")
            for loc in c.all(f"/v1/appStoreVersions/{ver['id']}/appStoreVersionLocalizations"):
                la = loc["attributes"]
                sets = c.all(f"/v1/appStoreVersionLocalizations/{loc['id']}/appScreenshotSets")
                note(f"    {la['locale']}: description {len(la.get('description') or '')} chars, "
                     f"keywords {la.get('keywords')!r}, support {la.get('supportUrl')!r}, "
                     f"screenshot sets {[s['attributes']['screenshotDisplayType'] for s in sets]}")

    def builds():
        found = c.all("/v1/builds", **{"filter[app]": app["id"], "limit": "50", "include": "preReleaseVersion"})
        if not found:
            note("  builds: none uploaded yet")
        for b in found[:10]:
            ba = b["attributes"]
            note(f"  build {ba.get('version')}: {ba.get('processingState')}, uploaded {ba.get('uploadedDate')}, expired {ba.get('expired')}")

    def groups():
        for g in c.all(f"/v1/apps/{app['id']}/betaGroups"):
            ga = g["attributes"]
            testers = c.all(f"/v1/betaGroups/{g['id']}/betaTesters")
            note(f"  TestFlight group {ga['name']!r}: internal {ga.get('isInternalGroup')}, "
                 f"every build {ga.get('hasAccessToAllBuilds')}, {len(testers)} testers")

    for label, fn in (("app info", infos), ("versions", versions), ("builds", builds), ("TestFlight", groups)):
        safe(label, fn)


# ---- prepare ------------------------------------------------------------------


def ensure_bundle_id(c, identifier, name):
    found = [b for b in c.all("/v1/bundleIds", **{"filter[identifier]": identifier}) if b["attributes"]["identifier"] == identifier]
    if found:
        note(f"  App ID {identifier}: already registered")
        return found[0]
    try:
        made = c.post("/v1/bundleIds", {"data": {"type": "bundleIds", "attributes": {
            "identifier": identifier, "name": name, "platform": "IOS"}}})
        note(f"  App ID {identifier}: registered")
        return made["data"]
    except AppleError as e:
        raise SystemExit(f"Could not register {identifier}: {e.detail()}")


def ensure_capability(c, bundle, capability):
    have = c.all(f"/v1/bundleIds/{bundle['id']}/bundleIdCapabilities")
    if any(x["attributes"].get("capabilityType") == capability for x in have):
        note(f"  {bundle['attributes']['identifier']}: {capability} already on")
        return
    try:
        c.post("/v1/bundleIdCapabilities", {"data": {
            "type": "bundleIdCapabilities",
            "attributes": {"capabilityType": capability},
            "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": bundle["id"]}}},
        }})
        note(f"  {bundle['attributes']['identifier']}: {capability} switched on")
    except AppleError as e:
        todo(f"Switch {capability} on for {bundle['attributes']['identifier']}: {e.detail()}")


def next_build(c, app_id, version, floor):
    """One more than the highest build already uploaded for this version, and
    never below venue.json's own number."""
    builds = c.all("/v1/builds", **{
        "filter[app]": app_id, "filter[preReleaseVersion.version]": version, "limit": "200"})
    used = [int(b["attributes"]["version"]) for b in builds if str(b["attributes"].get("version", "")).isdigit()]
    return max([floor - 1, *used]) + 1


def cmd_prepare(venue_name):
    venue_dir, v, _ = load_venue(venue_name)
    c = Client()
    app_id = v["app_id"]
    note(f"{v['name']} ({app_id})")
    phone = ensure_bundle_id(c, app_id, v["name"])
    ensure_bundle_id(c, f"{app_id}.watchkitapp", f"{v['name']} Watch")
    ensure_capability(c, phone, "PUSH_NOTIFICATIONS")

    app = find_app(c, app_id)
    out = os.environ.get("GITHUB_OUTPUT")
    if not app:
        msg = (
            f"There is no app record for {app_id} in App Store Connect yet, and Apple's API cannot make one. "
            f"Once, by hand: App Store Connect > Apps > + > New App: platform iOS, name \"{v['name']}\", "
            f"primary language English (U.K.), bundle ID {app_id} (now in the list), SKU {app_id}, "
            "user access Full Access. Then run this workflow again; everything else is filled in for you."
        )
        print(f"::error::{msg}" if out else msg)
        sys.exit(2)
    note(f"  app record: {app['attributes']['name']} (Apple ID {app['id']})")
    build = next_build(c, app["id"], v["version"], int(v["build"]))
    note(f"  build number: {build} for version {v['version']}")
    if out:
        with open(out, "a") as f:
            f.write(f"build={build}\napp={app['id']}\n")
    else:
        print(f"build={build}")


# ---- store ----------------------------------------------------------------------


def editable_app_info(c, app_id):
    infos = c.all(f"/v1/apps/{app_id}/appInfos")
    live = {"READY_FOR_DISTRIBUTION", "READY_FOR_SALE", "REPLACED_WITH_NEW_INFO"}
    for info in infos:
        state = info["attributes"].get("state") or info["attributes"].get("appStoreState")
        if state not in live:
            return info
    return infos[0] if infos else None


def localization(c, parent_path, kind, parent_rel, parent_type, parent_id, locale):
    """The parent's localization for `locale`, or its only one, or a new one."""
    locs = c.all(parent_path)
    for loc in locs:
        if loc["attributes"]["locale"] == locale:
            return loc
    try:
        made = c.post(f"/v1/{kind}", {"data": {
            "type": kind,
            "attributes": {"locale": locale},
            "relationships": {parent_rel: {"data": {"type": parent_type, "id": parent_id}}},
        }})
        return made["data"]
    except AppleError as e:
        if locs:
            note(f"  {kind}: no {locale} ({e.detail()}); using {locs[0]['attributes']['locale']}")
            return locs[0]
        raise


def editable_version(c, app_id, version):
    versions = c.all(f"/v1/apps/{app_id}/appStoreVersions", **{"filter[platform]": "IOS"})
    editable = {"PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"}
    for ver in versions:
        a = ver["attributes"]
        state = a.get("appVersionState") or a.get("appStoreState")
        if state in editable:
            if a["versionString"] != version:
                patch_attributes(c, "appStoreVersions", ver["id"], {"versionString": version}, f"version {a['versionString']} -> {version}")
            return ver
    made = c.post("/v1/appStoreVersions", {"data": {
        "type": "appStoreVersions",
        "attributes": {"platform": "IOS", "versionString": version},
        "relationships": {"app": {"data": {"type": "apps", "id": app_id}}},
    }})
    note(f"  App Store version {version}: made")
    return made["data"]


def set_category(c, info, store):
    rel = {}
    for key, field in (("primaryCategory", "category"), ("secondaryCategory", "secondary_category")):
        if store.get(field):
            rel[key] = {"data": {"type": "appCategories", "id": store[field]}}
    if not rel:
        return
    try:
        c.patch(f"/v1/appInfos/{info['id']}", {"data": {"type": "appInfos", "id": info["id"], "relationships": rel}})
        note(f"  category: {store.get('category')} / {store.get('secondary_category') or '-'}")
    except AppleError as e:
        todo(f"Category: {e.detail()}")


def set_age_rating(c, info):
    try:
        decl = c.get(f"/v1/appInfos/{info['id']}/ageRatingDeclaration")["data"]
    except AppleError as e:
        todo(f"Age rating: {e.detail()}")
        return
    # A members' card, club news and a venue's offers: nothing on any of
    # Apple's lists. 4+.
    none = "NONE"
    attrs = {
        "alcoholTobaccoOrDrugUseOrReferences": none,
        "contests": none,
        "gamblingSimulated": none,
        "horrorOrFearThemes": none,
        "matureOrSuggestiveThemes": none,
        "medicalOrTreatmentInformation": none,
        "profanityOrCrudeHumor": none,
        "sexualContentGraphicAndNudity": none,
        "sexualContentOrNudity": none,
        "violenceCartoonOrFantasy": none,
        "violenceRealistic": none,
        "violenceRealisticProlongedGraphicOrSadistic": none,
        "gunsOrOtherWeapons": none,
        "gambling": False,
        "unrestrictedWebAccess": False,
        "lootBox": False,
        "messagingAndChat": False,
        "parentalControls": False,
        "ageAssurance": False,
        "userGeneratedContent": False,
        "advertising": False,
        "healthOrWellnessTopics": False,
        "kidsAgeBand": None,
    }
    patch_attributes(c, "ageRatingDeclarations", decl["id"], attrs, "age rating (4+)")


def set_price_free(c, app_id):
    try:
        c.get(f"/v1/apps/{app_id}/appPriceSchedule")
        sched = c.get(f"/v1/apps/{app_id}/appPriceSchedule/manualPrices")
        if sched.get("data"):
            note("  price: already set")
            return
    except AppleError:
        pass
    try:
        points = c.get(f"/v1/apps/{app_id}/appPricePoints", **{"filter[territory]": "GBR", "limit": "200"})["data"]
        free = next(p for p in points if float(p["attributes"].get("customerPrice") or 0) == 0)
        c.post("/v1/appPriceSchedules", {
            "data": {
                "type": "appPriceSchedules",
                "relationships": {
                    "app": {"data": {"type": "apps", "id": app_id}},
                    "baseTerritory": {"data": {"type": "territories", "id": "GBR"}},
                    "manualPrices": {"data": [{"type": "appPrices", "id": "${free}"}]},
                },
            },
            "included": [{
                "type": "appPrices",
                "id": "${free}",
                "attributes": {"startDate": None},
                "relationships": {"appPricePoint": {"data": {"type": "appPricePoints", "id": free["id"]}}},
            }],
        })
        note("  price: free")
    except (AppleError, StopIteration) as e:
        todo(f"Price (Free): {e.detail() if isinstance(e, AppleError) else 'no free price point found'}")


def set_availability(c, app_id):
    try:
        c.get(f"/v1/apps/{app_id}/appAvailabilityV2")
        note("  availability: already set")
        return
    except AppleError as e:
        if e.status != 404:
            todo(f"Availability: {e.detail()}")
            return
    try:
        territories = [t["id"] for t in c.all("/v1/territories", limit="200")]
        included = [{
            "type": "territoryAvailabilities",
            "id": f"${{{t}}}",
            "attributes": {"available": True},
            "relationships": {"territory": {"data": {"type": "territories", "id": t}}},
        } for t in territories]
        c.post("/v2/appAvailabilities", {
            "data": {
                "type": "appAvailabilities",
                "attributes": {"availableInNewTerritories": True},
                "relationships": {
                    "app": {"data": {"type": "apps", "id": app_id}},
                    "territoryAvailabilities": {"data": [{"type": "territoryAvailabilities", "id": i["id"]} for i in included]},
                },
            },
            "included": included,
        })
        note(f"  availability: {len(territories)} countries and regions")
    except AppleError as e:
        todo(f"Availability: {e.detail()}")


def set_review_details(c, version, store):
    r = store.get("review", {})
    attrs = {
        "contactFirstName": r.get("contact_first_name"),
        "contactLastName": r.get("contact_last_name"),
        "contactEmail": r.get("contact_email"),
        "contactPhone": os.environ.get("ASC_REVIEW_PHONE") or r.get("contact_phone"),
        "notes": r.get("notes"),
    }
    user, password = os.environ.get("ASC_REVIEW_USER", ""), os.environ.get("ASC_REVIEW_PASSWORD", "")
    if user and password:
        attrs.update(demoAccountRequired=True, demoAccountName=user, demoAccountPassword=password)
    else:
        todo("App Review sign-in: the app is members-only. Add a member account for Apple's reviewer "
             "(back office > Customers, with a password set), and give it as ASC_REVIEW_USER and "
             "ASC_REVIEW_PASSWORD in the production environment, or under App Review Information.")
    if not attrs["contactPhone"]:
        todo("App Review contact phone number: ASC_REVIEW_PHONE, or under App Review Information.")
    try:
        existing = c.get(f"/v1/appStoreVersions/{version['id']}/appStoreReviewDetail").get("data")
    except AppleError:
        existing = None
    attrs = {k: v for k, v in attrs.items() if v}
    if existing:
        patch_attributes(c, "appStoreReviewDetails", existing["id"], attrs, "App Review information")
        return
    try:
        c.post("/v1/appStoreReviewDetails", {"data": {
            "type": "appStoreReviewDetails",
            "attributes": attrs,
            "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": version["id"]}}},
        }})
        note("  App Review information: done")
    except AppleError as e:
        todo(f"App Review information: {e.detail()}")


def upload_screenshot(c, set_id, path):
    data = path.read_bytes()
    made = c.post("/v1/appScreenshots", {"data": {
        "type": "appScreenshots",
        "attributes": {"fileName": path.name, "fileSize": len(data)},
        "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": set_id}}},
    }})["data"]
    for op in made["attributes"]["uploadOperations"]:
        part = data[op["offset"]: op["offset"] + op["length"]]
        req = urllib.request.Request(op["url"], data=part, method=op["method"])
        for h in op.get("requestHeaders", []):
            req.add_header(h["name"], h["value"])
        with urllib.request.urlopen(req, timeout=300):
            pass
    c.patch(f"/v1/appScreenshots/{made['id']}", {"data": {
        "type": "appScreenshots", "id": made["id"],
        "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()},
    }})


def png_size(path):
    import struct
    with path.open("rb") as f:
        head = f.read(24)
    return struct.unpack(">II", head[16:24])


def set_screenshots(c, version_loc, venue_dir):
    root = venue_dir / "store" / "screenshots"
    sets = {s["attributes"]["screenshotDisplayType"]: s for s in c.all(f"/v1/appStoreVersionLocalizations/{version_loc['id']}/appScreenshotSets")}
    for folder, (display, sizes) in SCREENSHOT_SETS.items():
        files = sorted((root / folder).glob("*.png")) if (root / folder).exists() else []
        if not files:
            continue
        bad = [f.name for f in files if png_size(f) not in sizes]
        if bad:
            todo(f"Screenshots {folder}: wrong size, not uploaded: {', '.join(bad)}")
            continue
        try:
            shot_set = sets.get(display)
            if not shot_set:
                shot_set = c.post("/v1/appScreenshotSets", {"data": {
                    "type": "appScreenshotSets",
                    "attributes": {"screenshotDisplayType": display},
                    "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": version_loc["id"]}}},
                }})["data"]
            # Same pictures as last time: leave them.
            have = c.all(f"/v1/appScreenshotSets/{shot_set['id']}/appScreenshots")
            want = [hashlib.md5(f.read_bytes()).hexdigest() for f in files]
            if [h["attributes"].get("sourceFileChecksum") for h in have] == want:
                note(f"  screenshots {folder}: already up to date")
                continue
            for h in have:
                c.delete(f"/v1/appScreenshots/{h['id']}")
            for f in files:
                upload_screenshot(c, shot_set["id"], f)
            note(f"  screenshots {folder}: {len(files)} uploaded")
        except AppleError as e:
            todo(f"Screenshots {folder}: {e.detail()}")


def cmd_store(venue_name):
    venue_dir, v, store = load_venue(venue_name)
    if not store:
        raise SystemExit(f"{venue_dir / 'store' / 'app_store.json'} is missing.")
    c = Client()
    app = find_app(c, v["app_id"])
    if not app:
        raise SystemExit(f"No app record for {v['app_id']}: run `prepare` first.")
    locale = store.get("locale", "en-GB")
    note(f"{v['name']}: App Store listing ({locale})")

    info = editable_app_info(c, app["id"])
    if info:
        loc = localization(c, f"/v1/appInfos/{info['id']}/appInfoLocalizations", "appInfoLocalizations",
                           "appInfo", "appInfos", info["id"], locale)
        patch_attributes(c, "appInfoLocalizations", loc["id"], {
            "name": store.get("name"),
            "subtitle": store.get("subtitle"),
            "privacyPolicyUrl": store.get("privacy_url"),
        }, "name, subtitle, privacy policy")
        set_category(c, info, store)
        set_age_rating(c, info)
    else:
        todo("App information: none found to edit")

    try:
        patch_attributes(c, "apps", app["id"], {"contentRightsDeclaration": "DOES_NOT_USE_THIRD_PARTY_CONTENT"}, "content rights")
    except AppleError as e:
        todo(f"Content rights: {e.detail()}")
    set_price_free(c, app["id"])
    set_availability(c, app["id"])

    version = editable_version(c, app["id"], v["version"])
    patch_attributes(c, "appStoreVersions", version["id"], {
        "copyright": store.get("copyright"),
        "releaseType": "MANUAL",
    }, "copyright, release by hand")
    vloc = localization(c, f"/v1/appStoreVersions/{version['id']}/appStoreVersionLocalizations",
                        "appStoreVersionLocalizations", "appStoreVersion", "appStoreVersions", version["id"], locale)
    patch_attributes(c, "appStoreVersionLocalizations", vloc["id"], {
        "description": store.get("description"),
        "keywords": store.get("keywords"),
        "promotionalText": store.get("promotional_text"),
        "supportUrl": store.get("support_url"),
        "marketingUrl": store.get("marketing_url"),
    }, "description, keywords, promotional text, URLs")
    set_review_details(c, version, store)
    set_screenshots(c, vloc, venue_dir)

    todo("App Privacy (App Store Connect > the app > App Privacy): Apple's API cannot answer it. "
         f"The answers are in {venue_name}/store/listing.md under \"App Privacy\".")
    summary()


# ---- testflight -------------------------------------------------------------------


def wait_for_build(c, app_id, version, number, minutes=45):
    note(f"  waiting for build {version} ({number}) to finish processing")
    deadline = time.time() + minutes * 60
    while time.time() < deadline:
        builds = c.get("/v1/builds", **{
            "filter[app]": app_id, "filter[version]": str(number),
            "filter[preReleaseVersion.version]": version, "limit": "5"}).get("data", [])
        if builds:
            state = builds[0]["attributes"].get("processingState")
            if state == "VALID":
                note("  processed")
                return builds[0]
            if state in ("FAILED", "INVALID"):
                raise SystemExit(f"Apple could not process build {number}: {state}. See the email Apple sent.")
        time.sleep(30)
    raise SystemExit(f"Build {number} was still processing after {minutes} minutes; run `testflight` again later.")


def cmd_testflight(venue_name, number):
    venue_dir, v, store = load_venue(venue_name)
    c = Client()
    app = find_app(c, v["app_id"])
    if not app:
        raise SystemExit(f"No app record for {v['app_id']}.")
    tf = store.get("testflight", {})
    locale = store.get("locale", "en-GB")
    build = wait_for_build(c, app["id"], v["version"], number)

    # Export compliance: Info.plist already says no non-exempt encryption,
    # which Apple reads; this is only for a build where it did not.
    if build["attributes"].get("usesNonExemptEncryption") is None:
        patch_attributes(c, "builds", build["id"], {"usesNonExemptEncryption": False}, "export compliance")

    if tf.get("what_to_test"):
        try:
            locs = c.all(f"/v1/builds/{build['id']}/betaBuildLocalizations")
            if locs:
                patch_attributes(c, "betaBuildLocalizations", locs[0]["id"], {"whatsNew": tf["what_to_test"]}, "What to Test")
            else:
                c.post("/v1/betaBuildLocalizations", {"data": {
                    "type": "betaBuildLocalizations",
                    "attributes": {"locale": locale, "whatsNew": tf["what_to_test"]},
                    "relationships": {"build": {"data": {"type": "builds", "id": build["id"]}}},
                }})
                note("  What to Test: done")
        except AppleError as e:
            todo(f"What to Test: {e.detail()}")

    # TestFlight's own test information, for the app.
    try:
        locs = c.all(f"/v1/apps/{app['id']}/betaAppLocalizations")
        attrs = {
            "description": tf.get("description"),
            "feedbackEmail": tf.get("feedback_email"),
            "marketingUrl": store.get("marketing_url"),
            "privacyPolicyUrl": store.get("privacy_url"),
        }
        attrs = {k: val for k, val in attrs.items() if val}
        mine = next((x for x in locs if x["attributes"]["locale"] == locale), locs[0] if locs else None)
        if mine:
            patch_attributes(c, "betaAppLocalizations", mine["id"], attrs, "TestFlight test information")
        else:
            c.post("/v1/betaAppLocalizations", {"data": {
                "type": "betaAppLocalizations", "attributes": {"locale": locale, **attrs},
                "relationships": {"app": {"data": {"type": "apps", "id": app["id"]}}},
            }})
            note("  TestFlight test information: done")
    except AppleError as e:
        todo(f"TestFlight test information: {e.detail()}")

    r = store.get("review", {})
    try:
        detail = c.get(f"/v1/apps/{app['id']}/betaAppReviewDetail")["data"]
        attrs = {
            "contactFirstName": r.get("contact_first_name"),
            "contactLastName": r.get("contact_last_name"),
            "contactEmail": r.get("contact_email"),
            "contactPhone": os.environ.get("ASC_REVIEW_PHONE") or r.get("contact_phone"),
            "notes": r.get("notes"),
        }
        user, password = os.environ.get("ASC_REVIEW_USER", ""), os.environ.get("ASC_REVIEW_PASSWORD", "")
        if user and password:
            attrs.update(demoAccountRequired=True, demoAccountName=user, demoAccountPassword=password)
        patch_attributes(c, "betaAppReviewDetails", detail["id"], {k: val for k, val in attrs.items() if val},
                         "TestFlight review contact")
    except AppleError as e:
        todo(f"TestFlight review contact: {e.detail()}")

    group = internal_group(c, app["id"], tf.get("internal_group", "Vesopa team"))
    if group:
        add_team_as_testers(c, app["id"], group)
        if not group["attributes"].get("hasAccessToAllBuilds"):
            try:
                c.post(f"/v1/betaGroups/{group['id']}/relationships/builds",
                       {"data": [{"type": "builds", "id": build["id"]}]})
                note(f"  build added to \"{group['attributes']['name']}\"")
            except AppleError as e:
                todo(f"Add the build to {group['attributes']['name']}: {e.detail()}")
        else:
            note(f"  \"{group['attributes']['name']}\" gets every build")

    # The build the App Store version will go out with, when it is submitted.
    try:
        version = editable_version(c, app["id"], v["version"])
        c.patch(f"/v1/appStoreVersions/{version['id']}/relationships/build",
                {"data": {"type": "builds", "id": build["id"]}})
        note(f"  build {number} attached to App Store version {v['version']}")
    except AppleError as e:
        todo(f"Attach the build to the App Store version: {e.detail()}")
    summary()


def internal_group(c, app_id, name):
    groups = c.all(f"/v1/apps/{app_id}/betaGroups")
    for g in groups:
        if g["attributes"].get("isInternalGroup"):
            return g
    try:
        made = c.post("/v1/betaGroups", {"data": {
            "type": "betaGroups",
            "attributes": {"name": name, "isInternalGroup": True, "hasAccessToAllBuilds": True},
            "relationships": {"app": {"data": {"type": "apps", "id": app_id}}},
        }})["data"]
        note(f"  TestFlight group \"{name}\": made (internal, every build)")
        return made
    except AppleError as e:
        todo(f"TestFlight internal group: {e.detail()}")
        return None


def add_team_as_testers(c, app_id, group):
    """Every App Store Connect user on the team, as an internal tester."""
    try:
        users = c.all("/v1/users", limit="200")
    except AppleError as e:
        todo(f"Internal testers: could not list the team ({e.detail()})")
        return
    present = {t["attributes"].get("email", "").lower() for t in c.all(f"/v1/betaGroups/{group['id']}/betaTesters")}
    added = 0
    for u in users:
        a = u["attributes"]
        email = (a.get("username") or a.get("email") or "").lower()
        if not email or email in present:
            continue
        try:
            c.post("/v1/betaTesters", {"data": {
                "type": "betaTesters",
                "attributes": {"email": email, "firstName": a.get("firstName", ""), "lastName": a.get("lastName", "")},
                "relationships": {"betaGroups": {"data": [{"type": "betaGroups", "id": group["id"]}]}},
            }})
            added += 1
        except AppleError as e:
            note(f"  tester {email}: {e.detail()}")
    note(f"  internal testers: {added} added, {len(present)} already there")


def summary():
    if TODO:
        print("\nStill to do in App Store Connect:")
        for t in TODO:
            print(f"  - {t}")
        out = os.environ.get("GITHUB_STEP_SUMMARY")
        if out:
            with open(out, "a") as f:
                f.write("### Still to do in App Store Connect\n\n" + "".join(f"- {t}\n" for t in TODO) + "\n")
    else:
        print("\nNothing left to do by hand.")


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("status", "prepare", "store", "testflight"):
        raise SystemExit(__doc__)
    cmd, venue = sys.argv[1], sys.argv[2]
    if cmd == "status":
        cmd_status(venue)
    elif cmd == "prepare":
        cmd_prepare(venue)
    elif cmd == "store":
        cmd_store(venue)
    else:
        if len(sys.argv) < 4:
            raise SystemExit("testflight needs the build number")
        cmd_testflight(venue, int(sys.argv[3]))


if __name__ == "__main__":
    main()
