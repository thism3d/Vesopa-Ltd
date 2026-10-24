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

signing     makes this run's distribution certificate and App Store profiles
            (app and Watch app) into a folder, with ExportOptions.plist;
            sign-project then sets the venue's project to sign with them.
            See "signing" below for why not Xcode's automatic signing.

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
            added as testers), adds it to every external group (open testers)
            and sends it to Beta App Review for them, and attaches it to the
            App Store version.

Everything is safe to run again: what is already right is left alone.

Two things Apple's API does not do at all, and which are listed at the end of
every `store` run until done by hand: the App Privacy answers, and creating
the app record.

Needs PyJWT with its crypto extra (`pip install "pyjwt[crypto]"`).
"""

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


API = "https://api.appstoreconnect.apple.com"

# Apple's names for the screenshot sizes this uploads. The folder names are
# ours; the sizes are the ones each display type takes.
SCREENSHOT_SETS = {
    "iphone-6.9": ("APP_IPHONE_67", {(1290, 2796), (1320, 2868)}),  # also APP_IPHONE_67's
    "ipad-13": ("APP_IPAD_PRO_3GEN_129", {(2048, 2732), (2064, 2752)}),
    # The Apple Watch app's own (tool/make_watch_screenshots.py): the listing
    # shows them under Apple Watch.
    "watch-ultra": ("APP_WATCH_ULTRA", {(410, 502), (422, 514)}),
    "watch-series-10": ("APP_WATCH_SERIES_10", {(416, 496)}),
    # iPhone Duo (2026): its own slot in App Store Connect, which takes the
    # closed or the open display's size. Apple's published API names no case
    # for it yet, so the name is found at upload time (duo_display_type).
    "iphone-duo": (None, {(1398, 2034), (2034, 1398), (2007, 2853), (2853, 2007)}),
}

# Names App Store Connect may know the iPhone Duo slot by, tried in turn when
# no set of that kind exists yet; Apple's refusal lists the names it takes.
DUO_GUESSES = ("APP_IPHONE_DUO", "APP_IPHONE_DUO_OUTER", "APP_IPHONE_DUO_INNER", "APP_IPHONE_FOLD")

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
        parts = []
        for e in self.errors:
            parts.append(f"{e.get('title', '')} {e.get('detail', '')}".strip())
            # Apple's "please check associated errors": the real reasons (a
            # missing screenshot, an unanswered question) are in meta, keyed
            # by the resource they belong to.
            for where, errs in ((e.get("meta") or {}).get("associatedErrors") or {}).items():
                for a in errs or []:
                    parts.append(f"  [{where.rsplit('/', 1)[-1]}] {a.get('code', '')}: {a.get('detail') or a.get('title', '')}")
        return "\n".join(parts) or self.body[:500]


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
            import jwt  # here, so sign-project runs without it

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
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                # A read that times out is a TimeoutError, not a URLError.
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


def ensure_capability(c, bundle, capability, settings=None):
    have = c.all(f"/v1/bundleIds/{bundle['id']}/bundleIdCapabilities")
    if any(x["attributes"].get("capabilityType") == capability for x in have):
        note(f"  {bundle['attributes']['identifier']}: {capability} already on")
        return
    try:
        c.post("/v1/bundleIdCapabilities", {"data": {
            "type": "bundleIdCapabilities",
            "attributes": {"capabilityType": capability, **({"settings": settings} if settings else {})},
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
    # Sign in with Apple and passkeys on the device (ios/Runner/AuthBridge.swift;
    # make_venue_app.py writes the matching entitlements).
    ensure_capability(c, phone, "APPLE_ID_AUTH", [{
        "key": "APPLE_ID_AUTH_APP_CONSENT", "options": [{"key": "PRIMARY_APP_CONSENT"}]}])
    ensure_capability(c, phone, "ASSOCIATED_DOMAINS")
    # Apple Wallet: the member's card as a pass (ios/Runner/WalletBridge.swift;
    # make_venue_app.py writes the pass-type-identifiers entitlement). The
    # profile made in `signing` then carries the team's pass types.
    ensure_capability(c, phone, "WALLET")

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


# ---- signing ------------------------------------------------------------------
#
# WHY NOT XCODE'S AUTOMATIC SIGNING. On a build machine Xcode's automatic
# signing archives with a development profile, and Apple will not make one for
# a team with no registered iPhone ("Your team has no devices"). App Store
# profiles need no devices, so they are made here instead: a distribution
# certificate from a key made on the runner (it never leaves it), and a
# profile for the app and one for its Watch app. Each is named after the run's
# certificate, so the next run revokes it: the team's certificate limit never
# fills. Revoking does not touch what is already uploaded -- Apple re-signs
# everything it distributes.

CI_PREFIX = "Vesopa CI"


def cmd_signing(venue_name, out_dir):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    import base64
    import plistlib

    _, v, _ = load_venue(venue_name)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    c = Client()

    # What earlier runs left: their profiles name their certificates.
    old_certs = set()
    for p in c.all("/v1/profiles", **{"filter[profileType]": "IOS_APP_STORE", "limit": "200"}):
        name = p["attributes"].get("name", "")
        if name.startswith(CI_PREFIX):
            m = re.search(r"cert ([A-Z0-9]+)$", name)
            if m:
                old_certs.add(m.group(1))
            try:
                c.delete(f"/v1/profiles/{p['id']}")
            except AppleError as e:
                note(f"  old profile {name}: {e.detail()}")
    for cid in old_certs:
        try:
            c.delete(f"/v1/certificates/{cid}")
            note(f"  revoked the previous run's certificate {cid}")
        except AppleError as e:
            note(f"  previous certificate {cid}: {e.detail()}")

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, CI_PREFIX)]))
        .sign(key, hashes.SHA256())
    )
    try:
        cert = c.post("/v1/certificates", {"data": {"type": "certificates", "attributes": {
            "certificateType": "DISTRIBUTION",
            "csrContent": csr.public_bytes(serialization.Encoding.PEM).decode(),
        }}})["data"]
    except AppleError as e:
        raise SystemExit(
            f"Apple would not make a distribution certificate: {e.detail()}\n"
            "If the team is at its limit, revoke an unused one in Certificates, Identifiers & Profiles."
        )
    note(f"  distribution certificate {cert['id']}")
    (out / "dist.key.pem").write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (out / "dist.cer").write_bytes(base64.b64decode(cert["attributes"]["certificateContent"]))

    profiles = {}
    for identifier in (v["app_id"], f"{v['app_id']}.watchkitapp"):
        bundles = [b for b in c.all("/v1/bundleIds", **{"filter[identifier]": identifier})
                   if b["attributes"]["identifier"] == identifier]
        if not bundles:
            raise SystemExit(f"No App ID {identifier}: run `prepare` first.")
        name = f"{CI_PREFIX} {identifier} cert {cert['id']}"
        prof = c.post("/v1/profiles", {"data": {
            "type": "profiles",
            "attributes": {"name": name, "profileType": "IOS_APP_STORE"},
            "relationships": {
                "bundleId": {"data": {"type": "bundleIds", "id": bundles[0]["id"]}},
                "certificates": {"data": [{"type": "certificates", "id": cert["id"]}]},
            },
        }})["data"]
        content = base64.b64decode(prof["attributes"]["profileContent"])
        uuid = prof["attributes"]["uuid"]
        (out / f"{uuid}.mobileprovision").write_bytes(content)
        profiles[identifier] = name
        note(f"  App Store profile for {identifier}")

    with open(out / "ExportOptions.plist", "wb") as f:
        plistlib.dump({
            "method": "app-store-connect",
            "destination": "upload",
            "teamID": v.get("apple_team", ""),
            "signingStyle": "manual",
            "signingCertificate": "Apple Distribution",
            "provisioningProfiles": profiles,
            "uploadSymbols": True,
            "manageAppVersionAndBuildNumber": False,
        }, f)
    (out / "profiles.json").write_text(json.dumps(profiles, indent=2))


def cmd_sign_project(venue_name, profiles_json):
    """Manual signing in the venue's project, target by target: the app and
    the Watch app each with its own App Store profile."""
    venue_dir, v, _ = load_venue(venue_name)
    profiles = json.loads(Path(profiles_json).read_text())
    pbx = venue_dir / "build" / "app" / "ios" / "Runner.xcodeproj" / "project.pbxproj"
    text = pbx.read_text(encoding="utf-8")
    out, changed = [], 0
    # Each build configuration is a `buildSettings = { ... };` block; the ones
    # for the app and the Watch app are told apart by their bundle id.
    for block in re.split(r"(buildSettings = \{.*?\n\t\t\t\};)", text, flags=re.S):
        m = re.search(r"PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);", block) if block.startswith("buildSettings") else None
        ident = m.group(1).strip('"') if m else None
        if ident in profiles:
            block = re.sub(r"\n\t\t\t\tCODE_SIGN_STYLE = [^;]+;", "", block)
            block = re.sub(r"\n\t\t\t\t\"?CODE_SIGN_IDENTITY(\[[^\]]*\])?\"? = [^;]+;", "", block)
            block = re.sub(r"\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = [^;]+;", "", block)
            block = block.replace("buildSettings = {", (
                "buildSettings = {\n"
                "\t\t\t\tCODE_SIGN_STYLE = Manual;\n"
                "\t\t\t\tCODE_SIGN_IDENTITY = \"Apple Distribution\";\n"
                f"\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = \"{profiles[ident]}\";"
            ), 1)
            changed += 1
        out.append(block)
    if not changed:
        raise SystemExit(f"{pbx}: no build settings for {', '.join(profiles)}")
    pbx.write_text("".join(out), encoding="utf-8")
    note(f"  manual signing on {changed} build configurations")



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


def review_account(r):
    """The reviewers' sign-in: the venue's own throwaway review member
    (store/app_store.json review.demo_user and demo_password, made with
    tool/make_review_member.py), else the environment's ASC_REVIEW_* secrets.
    Only ever a test account made for Apple's reviewers, never a real member's."""
    if r.get("demo_user") and r.get("demo_password"):
        return r["demo_user"], r["demo_password"]
    return os.environ.get("ASC_REVIEW_USER", ""), os.environ.get("ASC_REVIEW_PASSWORD", "")


def set_review_details(c, version, store):
    r = store.get("review", {})
    attrs = {
        "contactFirstName": r.get("contact_first_name"),
        "contactLastName": r.get("contact_last_name"),
        "contactEmail": r.get("contact_email"),
        "contactPhone": os.environ.get("ASC_REVIEW_PHONE") or r.get("contact_phone"),
        "notes": r.get("notes"),
    }
    user, password = review_account(r)
    if user and password:
        attrs.update(demoAccountRequired=True, demoAccountName=user, demoAccountPassword=password)
    else:
        todo("App Review sign-in: the app is members-only. Add a member account for Apple's reviewer "
             "(back office > Customers, with a password set), and give it as ASC_REVIEW_USER and "
             "ASC_REVIEW_PASSWORD in the App Store Connect API environment, or under App Review Information.")
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


def duo_display_type(c, version_loc, sets):
    """The iPhone Duo slot's display type, and its set, made if need be.

    An existing set says it (one the owner made by hand counts too). Failing
    that each guess is tried; a refusal that names the allowed values is
    searched for one with DUO or FOLD in it. (None, None) when App Store
    Connect's API does not take Duo screenshots yet."""
    for name, s in sets.items():
        if "DUO" in name or "FOLD" in name:
            return name, s
    import re
    guesses, tried = list(DUO_GUESSES), set()
    while guesses:
        name = guesses.pop(0)
        if name in tried:
            continue
        tried.add(name)
        try:
            made = c.post("/v1/appScreenshotSets", {"data": {
                "type": "appScreenshotSets",
                "attributes": {"screenshotDisplayType": name},
                "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": version_loc["id"]}}},
            }})["data"]
            return name, made
        except AppleError as e:
            named = [n for n in re.findall(r"APP_[A-Z0-9_]+", e.body) if ("DUO" in n or "FOLD" in n) and n not in tried]
            guesses = named + guesses
    return None, None


# ---- The App Asset Library (App Store Connect, October 2026) ---------------
#
# Screenshots, the product page header and the search results picture, placed
# on the version from one library of the app's pictures. It replaces the
# screenshot sets (still used below when the library cannot be reached), and
# it is the only way to the iPhone Duo slot and the creative assets. Where a
# picture goes is read from Apple's reference data at run time, never kept
# here: Apple adds devices there without a new API version.

# What to place: folder (or file) under <venue>/store, its placement type, the
# category its pictures are uploaded as, and the display classes it is meant
# for, best first (None: every group whose sizes the picture fits).
LIBRARY_TARGETS = [
    ("screenshots/iphone-6.9", "APP_SCREENSHOT", "APP_SCREENSHOTS_AND_PREVIEWS",
     ["IPHONE_DYNAMIC_ISLAND_LARGE_DISPLAY", "IPHONE_DYNAMIC_ISLAND_MEDIUM_DISPLAY"]),
    ("screenshots/iphone-duo", "APP_SCREENSHOT", "APP_SCREENSHOTS_AND_PREVIEWS", ["IPHONE_DUO"]),
    ("screenshots/ipad-13", "APP_SCREENSHOT", "APP_SCREENSHOTS_AND_PREVIEWS", ["IPAD_13_DISPLAY", "IPAD_129_DISPLAY"]),
    ("screenshots/watch-ultra", "APP_SCREENSHOT", "APP_SCREENSHOTS_AND_PREVIEWS", ["WATCH_ULTRA"]),
    ("screenshots/watch-series-10", "APP_SCREENSHOT", "APP_SCREENSHOTS_AND_PREVIEWS", ["WATCH_SERIES_10"]),
    ("creative/header.png", "PRODUCT_PAGE_HEADER_ASSET", "CREATIVE_ASSETS", None),
    ("creative/search.png", "APP_STORE_SEARCH_RESULTS_ASSET", "CREATIVE_ASSETS", None),
]


class RefData:
    """Apple's catalogue of picture sizes and the groups that take them."""

    def __init__(self, c):
        rows = c.get("/v1/appAssetLibraryRefData").get("data") or []
        a = (rows[0] if rows else {}).get("attributes") or {}
        self.specs = {s["specId"]: s for s in a.get("imageSpecs") or []}
        self.groups = {g["placementProfileGroupId"]: g for g in a.get("placementProfileGroups") or []}
        self.types = {t["placementTypeId"]: t for t in a.get("placementTypes") or []}
        # What an App Store version allows: group -> most pictures, per type.
        self.limits = {}
        for f in a.get("features") or []:
            if f.get("featureId") != "APP_STORE_VERSIONS":
                continue
            for pol in f.get("placementPolicies") or []:
                for lim in pol.get("groupLimits") or []:
                    for gid in lim.get("groupIds") or []:
                        self.limits[(pol.get("placementType"), gid)] = lim.get("maxCount")

    def fits(self, spec_id, size):
        d = (self.specs.get(spec_id) or {}).get("dimensions") or {}
        w, h = size
        return d.get("minWidth", 0) <= w <= d.get("maxWidth", 0) and d.get("minHeight", 0) <= h <= d.get("maxHeight", 0)

    def groups_for(self, ptype, size, wanted):
        """The groups of [ptype] on an App Store version that take a picture of
        [size]: of the first wanted display class that has one, or all."""
        mappings = (self.types.get(ptype) or {}).get("specMappings") or []
        fit = []
        for m in mappings:
            gid = m.get("placementGroupId")
            platform = str((self.groups.get(gid) or {}).get("platform", ""))
            if any(x in platform for x in ("MAC", "TV", "VISION")):
                continue
            if self.limits and (ptype, gid) not in self.limits:
                continue
            if any(self.fits(sid, size) for sid in m.get("specs") or []):
                fit.append(gid)
        if wanted is None:
            return fit
        for cls in wanted:
            mine = [g for g in fit if (self.groups.get(g) or {}).get("displayClassId") == cls]
            if mine:
                return mine[:1]
        return []

    def describe(self, ptype):
        """For a run's log when nothing fits: what Apple does take."""
        out = []
        for m in (self.types.get(ptype) or {}).get("specMappings") or []:
            gid = m.get("placementGroupId")
            sizes = sorted({f"{d.get('minWidth')}x{d.get('minHeight')}" for d in
                            ((self.specs.get(sid) or {}).get("dimensions") or {} for sid in m.get("specs") or [])})
            out.append(f"{gid} ({(self.groups.get(gid) or {}).get('displayClassId')}: {', '.join(sizes[:6])})")
        return "; ".join(out[:30])


def library_image(c, library_id, path, category, label):
    """The library's copy of [path], uploaded once: a picture already there
    under the same name and contents is used again."""
    data = path.read_bytes()
    ref = f"{label} {path.stem} {hashlib.md5(data).hexdigest()[:12]}"
    for img in c.all(f"/v1/appAssetLibraries/{library_id}/images", **{"filter[referenceName]": ref}):
        if img["attributes"].get("state") not in ("FAILED", "AWAITING_UPLOAD"):
            return img["id"], False
    made = c.post("/v1/appAssetLibraryImages", {"data": {
        "type": "appAssetLibraryImages",
        "attributes": {"fileName": path.name, "fileSize": len(data), "category": category, "referenceName": ref},
        "relationships": {"assetLibrary": {"data": {"type": "appAssetLibraries", "id": library_id}}},
    }})["data"]
    for op in made["attributes"].get("uploadOperations") or []:
        part = data[op["offset"]: op["offset"] + op["length"]]
        req = urllib.request.Request(op["url"], data=part, method=op["method"])
        for h in op.get("requestHeaders", []):
            req.add_header(h["name"], h["value"])
        with urllib.request.urlopen(req, timeout=300):
            pass
    c.patch(f"/v1/appAssetLibraryImages/{made['id']}", {"data": {
        "type": "appAssetLibraryImages", "id": made["id"], "attributes": {"uploaded": True}}})
    return made["id"], True


def place_group(c, loc_id, ptype, group, image_ids):
    """Make the group show exactly [image_ids], in that order. Placements
    cannot be changed, so a different set means new ones."""
    # include=image: without it Apple leaves the placement's image link out,
    # every group looked changed, and each run re-made them all.
    have = c.all(f"/v1/appStoreVersionLocalizations/{loc_id}/placements", **{
        "filter[placementType]": ptype, "filter[placementGroup]": group, "sort": "placementGroupPosition",
        "include": "image"})
    shown = [((p.get("relationships") or {}).get("image") or {}).get("data", {}) or {} for p in have]
    if [x.get("id") for x in shown] == image_ids:
        return False
    for p in have:
        c.delete(f"/v1/appAssetLibraryPlacements/{p['id']}")
    made = []
    for image_id in image_ids:
        made.append(c.post("/v1/appAssetLibraryPlacements", {"data": {
            "type": "appAssetLibraryPlacements",
            "attributes": {"placementType": ptype, "placementGroup": group},
            "relationships": {
                "image": {"data": {"type": "appAssetLibraryImages", "id": image_id}},
                "appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": loc_id}},
            },
        }})["data"]["id"])
    if len(made) > 1:
        c.post("/v1/appAssetLibraryPlacementOrderingRequests", {"data": {
            "type": "appAssetLibraryPlacementOrderingRequests",
            "attributes": {"placementGroup": group},
            "relationships": {
                "orderedPlacements": {"data": [{"type": "appAssetLibraryPlacements", "id": i} for i in made]},
                "appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": loc_id}},
            },
        }})
    return True


def set_library_pictures(c, app, version_loc, venue_dir):
    """Every picture in LIBRARY_TARGETS onto the version, from the library.
    Answers the screenshot folders it placed, so the old screenshot sets are
    used only for the rest; None when the library cannot be reached at all."""
    try:
        library_id = c.get(f"/v1/apps/{app['id']}/assetLibrary")["data"]["id"]
        ref = RefData(c)
    except (AppleError, KeyError, TypeError, IndexError) as e:
        note(f"  App Asset Library: not reachable ({e.detail() if isinstance(e, AppleError) else e}); screenshot sets instead")
        return None
    root = venue_dir / "store"
    placed, fresh = set(), []
    for target, ptype, category, wanted in LIBRARY_TARGETS:
        where = root / target
        files = [where] if where.suffix == ".png" else sorted(where.glob("*.png")) if where.exists() else []
        files = [f for f in files if f.exists()]
        if not files:
            continue
        label = target.split("/")[-1].removesuffix(".png")
        try:
            sizes = {png_size(f) for f in files}
            if len(sizes) != 1:
                todo(f"{target}: pictures of different sizes ({sizes}), not placed")
                continue
            groups = ref.groups_for(ptype, sizes.pop(), wanted)
            if not groups:
                todo(f"{target}: App Store Connect has no {ptype} slot for {png_size(files[0])}; it takes {ref.describe(ptype)}")
                continue
            ids = []
            for f in files:
                image_id, new = library_image(c, library_id, f, category, label)
                ids.append(image_id)
                if new:
                    fresh.append((image_id, f"{target}/{f.name}" if len(files) > 1 else target))
            for group in groups:
                most = ref.limits.get((ptype, group)) or len(ids)
                changed = place_group(c, version_loc["id"], ptype, group, ids[:most])
                note(f"  {target}: {'placed' if changed else 'already placed'} in {group} ({min(len(ids), most)})")
            placed.add(target.removeprefix("screenshots/"))
        except AppleError as e:
            todo(f"{target}: {e.detail()}")
    # Apple processes uploads after the fact; say so if one is refused.
    deadline = time.time() + 300
    while fresh and time.time() < deadline:
        waiting = []
        for image_id, name in fresh:
            a = c.get(f"/v1/appAssetLibraryImages/{image_id}")["data"]["attributes"]
            if a.get("state") == "FAILED":
                todo(f"{name}: Apple could not use it: {a.get('stateDetails')}")
            elif a.get("state") in ("AWAITING_UPLOAD", "UPLOAD_COMPLETE"):
                waiting.append((image_id, name))
        fresh = waiting
        if fresh:
            time.sleep(10)
    if fresh:
        note(f"  App Asset Library: {len(fresh)} still processing at Apple; they show once done")
    return placed


def set_screenshots(c, version_loc, venue_dir, skip=()):
    root = venue_dir / "store" / "screenshots"
    sets = {s["attributes"]["screenshotDisplayType"]: s for s in c.all(f"/v1/appStoreVersionLocalizations/{version_loc['id']}/appScreenshotSets")}
    for folder, (display, sizes) in SCREENSHOT_SETS.items():
        if folder in skip:
            continue
        files = sorted((root / folder).glob("*.png")) if (root / folder).exists() else []
        if not files:
            continue
        bad = [f.name for f in files if png_size(f) not in sizes]
        if bad:
            todo(f"Screenshots {folder}: wrong size, not uploaded: {', '.join(bad)}")
            continue
        try:
            if display is None:
                display, shot_set = duo_display_type(c, version_loc, sets)
                if not display:
                    todo(f"Screenshots {folder}: App Store Connect's API takes no iPhone Duo screenshots yet; "
                         f"drag {root / folder} into the iPhone Duo slot by hand once (later runs then keep it up to date)")
                    continue
                note(f"  screenshots {folder}: App Store Connect calls it {display}")
            shot_set = sets.get(display) or (shot_set if folder == "iphone-duo" else None)
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


def set_beta_review_details(c, app, store):
    """TestFlight's own review contact and sign-in, for the app. Kept the same as
    the App Store's, so the listing and TestFlight runs both refresh it."""
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
        user, password = review_account(r)
        if user and password:
            attrs.update(demoAccountRequired=True, demoAccountName=user, demoAccountPassword=password)
        patch_attributes(c, "betaAppReviewDetails", detail["id"], {k: val for k, val in attrs.items() if val},
                         "TestFlight review contact")
    except AppleError as e:
        todo(f"TestFlight review contact: {e.detail()}")


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
    # What's New: Apple refuses it on an app's first version, so only sent
    # when store/app_store.json has one (owner, 2026-10-24: release notes).
    if store.get("whats_new"):
        try:
            patch_attributes(c, "appStoreVersionLocalizations", vloc["id"], {"whatsNew": store["whats_new"]}, "what's new")
        except Exception as e:  # noqa: BLE001
            print(f"   ! what's new not set: {e}")
    set_review_details(c, version, store)
    set_beta_review_details(c, app, store)
    placed = set_library_pictures(c, app, vloc, venue_dir)
    set_screenshots(c, vloc, venue_dir, skip=placed or ())

    todo("App Privacy (App Store Connect > the app > App Privacy): Apple's API cannot answer it. "
         f"The answers are in {venue_name}/store/listing.md under \"App Privacy\".")
    summary()


# ---- submit for App Review --------------------------------------------------------


def latest_valid_build(c, app_id, version, number=None):
    """The build to submit: the one the testflight step uploaded, by number,
    else the newest VALID build on this version string."""
    builds = c.all("/v1/builds", **{
        "filter[app]": app_id,
        "filter[preReleaseVersion.version]": version,
        "sort": "-uploadedDate", "limit": "20",
    })
    for b in builds:
        if number is not None and str(b["attributes"].get("version")) != str(number):
            continue
        if b["attributes"].get("processingState") == "VALID":
            return b
    return builds[0] if builds else None


def attach_build(c, version_id, build_id):
    """Make sure the App Store version carries the build Apple will review."""
    try:
        cur = c.get(f"/v1/appStoreVersions/{version_id}/build").get("data")
        if cur and cur["id"] == build_id:
            note("  build already attached")
            return
    except AppleError:
        pass
    c.patch(f"/v1/appStoreVersions/{version_id}/relationships/build",
            {"data": {"type": "builds", "id": build_id}})
    note("  build attached to the version")


def privacy_published(c, app_id):
    """Whether App Privacy has been filled in and published for the app.
    Apple will not take a version for review until it is. True / False, or
    None when it cannot be read (then the submission attempt speaks instead)."""
    for path in (f"/v1/apps/{app_id}/appDataUsagesPublishState",
                 f"/v1/apps/{app_id}/appDataUsagePublishState"):
        try:
            data = c.get(path).get("data") or {}
            return bool(data.get("attributes", {}).get("published"))
        except AppleError:
            continue
    return None


def open_review_submission(c, app_id):
    """An in-progress review submission for this app on iOS, or None.

    READY_FOR_REVIEW is one we created but have not submitted yet, so it can be
    reused. Anything further along (WAITING_FOR_REVIEW, IN_REVIEW, ...) means it
    is already with Apple and must not be touched."""
    subs = c.all("/v1/reviewSubmissions", **{
        "filter[app]": app_id, "filter[platform]": "IOS"})
    live = None
    for sub in subs:
        state = sub["attributes"].get("state")
        if state == "READY_FOR_REVIEW":
            live = sub
        elif state in ("WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES", "CANCELING"):
            return ("busy", sub)
    return ("ready", live) if live else ("none", None)


def cmd_withdraw(venue_name):
    """Take the version that is with Apple out of review ("Remove from review"),
    so a newer build can replace it (owner, 2026-10-24: 1.3.1 was waiting for
    review and 1.3.2 could not be made). The version goes back to
    DEVELOPER_REJECTED, which `prepare`/`store` then rename to venue.json's
    version and fill again. Nothing is deleted."""
    venue_dir, v, store = load_venue(venue_name)
    c = Client()
    app = find_app(c, v["app_id"])
    if not app:
        raise SystemExit(f"No app record for {v['app_id']}.")
    state, sub = open_review_submission(c, app["id"])
    if state != "busy":
        note("  nothing is with Apple for review: nothing to withdraw")
        return
    now = sub["attributes"].get("state")
    if now != "CANCELING":
        c.patch(f"/v1/reviewSubmissions/{sub['id']}",
                {"data": {"type": "reviewSubmissions", "id": sub["id"], "attributes": {"canceled": True}}})
        note(f"  review submission ({now}): withdrawn")
    for _ in range(40):
        got = c.get(f"/v1/reviewSubmissions/{sub['id']}")["data"]["attributes"].get("state")
        if got not in ("CANCELING", "WAITING_FOR_REVIEW", "IN_REVIEW"):
            note(f"  review submission now {got}")
            return
        time.sleep(15)
    note("  Apple is still cancelling the submission; run again in a few minutes")


def cmd_submit(venue_name, release=None, build_number=None):
    """Create (or reuse) the App Review submission, attach the build and the
    version, set how it releases, and submit it to Apple."""
    venue_dir, v, store = load_venue(venue_name)
    c = Client()
    app = find_app(c, v["app_id"])
    if not app:
        raise SystemExit(f"No app record for {v['app_id']}: run `prepare`/`store` first.")

    # Honour the release choice on the version before it goes in.
    want = (release or store.get("release_type") or "manual").lower()
    release_type = {"auto": "AFTER_APPROVAL", "automatic": "AFTER_APPROVAL",
                    "manual": "MANUAL"}.get(want, "MANUAL")

    version = editable_version(c, app["id"], v["version"])
    patch_attributes(c, "appStoreVersions", version["id"],
                     {"releaseType": release_type},
                     f"release {'automatically after approval' if release_type == 'AFTER_APPROVAL' else 'by hand'}")

    build = latest_valid_build(c, app["id"], v["version"], build_number)
    if not build:
        raise SystemExit(f"No processed build for {v['version']} yet. Run the TestFlight step first.")
    attach_build(c, version["id"], build["id"])

    # App Privacy is the one gate Apple's API cannot pass: a version with it
    # unpublished is refused with a bare "not in valid state". Say so plainly.
    if privacy_published(c, app["id"]) is False:
        todo("App Privacy is not published, so Apple will not take the app for review. "
             "App Store Connect > the app > App Privacy > Get Started (or Edit): answer the data "
             f"questions as set out in {venue_name}/store/listing.md (every item \"App Functionality\", "
             "no tracking), then press Publish. After that, run this `publish` step again.")
        summary()
        raise SystemExit("Publish App Privacy by hand first (see above), then run `publish` again.")

    state, sub = open_review_submission(c, app["id"])
    if state == "busy":
        note(f"{v['name']}: already with Apple for review "
             f"(state {sub['attributes'].get('state')}). Nothing to do.")
        summary()
        return
    if state == "none":
        sub = c.post("/v1/reviewSubmissions", {"data": {
            "type": "reviewSubmissions",
            "attributes": {"platform": "IOS"},
            "relationships": {"app": {"data": {"type": "apps", "id": app["id"]}}},
        }})["data"]
        note("  review submission: created")
    else:
        note("  review submission: reusing the one prepared earlier")

    # The version must be an item on the submission. Add it if it is not.
    items = c.all(f"/v1/reviewSubmissions/{sub['id']}/items")
    has_version = any(
        (it.get("relationships", {}).get("appStoreVersion", {}).get("data") or {}).get("id") == version["id"]
        for it in items)
    if not has_version:
        try:
            c.post("/v1/reviewSubmissionItems", {"data": {
                "type": "reviewSubmissionItems",
                "relationships": {
                    "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": sub["id"]}},
                    "appStoreVersion": {"data": {"type": "appStoreVersions", "id": version["id"]}},
                },
            }})
            note("  version added to the submission")
        except AppleError as e:
            # Apple lists exactly what is still missing (a screenshot size, the
            # build, App Privacy): surface it rather than a bare 409.
            todo(f"Could not add the version: {e.detail()}")
            summary()
            raise SystemExit("Fix the above in App Store Connect, then run `submit` again.")

    try:
        c.patch(f"/v1/reviewSubmissions/{sub['id']}",
                {"data": {"type": "reviewSubmissions", "id": sub["id"],
                          "attributes": {"submitted": True}}})
    except AppleError as e:
        todo(f"Apple would not accept the submission: {e.detail()}")
        summary()
        raise SystemExit("Fix the above in App Store Connect, then run `submit` again.")

    note(f"{v['name']} {v['version']} submitted for App Review "
         f"({'auto-release' if release_type == 'AFTER_APPROVAL' else 'release by hand'}).")
    note("  Apple review usually takes a day or two; watch App Store Connect.")
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

    set_beta_review_details(c, app, store)

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

    # External groups (open testers, public link): every build goes to each,
    # then to Beta App Review, which Apple needs before outside testers get it.
    try:
        external = [g for g in c.all(f"/v1/apps/{app['id']}/betaGroups")
                    if not g["attributes"].get("isInternalGroup")]
    except AppleError as e:
        external = []
        todo(f"TestFlight external groups: {e.detail()}")
    for g in external:
        try:
            c.post(f"/v1/betaGroups/{g['id']}/relationships/builds",
                   {"data": [{"type": "builds", "id": build["id"]}]})
            note(f"  build added to \"{g['attributes']['name']}\" (external)")
        except AppleError as e:
            todo(f"Add the build to {g['attributes']['name']}: {e.detail()}")
    if external:
        try:
            c.post("/v1/betaAppReviewSubmissions", {"data": {
                "type": "betaAppReviewSubmissions",
                "relationships": {"build": {"data": {"type": "builds", "id": build["id"]}}},
            }})
            note("  build sent to Beta App Review for the external testers")
        except AppleError as e:
            if e.status == 409:
                note(f"  Beta App Review: {e.detail()}")
            else:
                todo(f"Send the build to Beta App Review: {e.detail()}")

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
    if len(sys.argv) < 3 or sys.argv[1] not in ("status", "prepare", "signing", "sign-project", "store", "testflight", "submit", "withdraw"):
        raise SystemExit(__doc__)
    cmd, venue = sys.argv[1], sys.argv[2]
    if cmd == "status":
        cmd_status(venue)
    elif cmd == "signing":
        cmd_signing(venue, sys.argv[3])
    elif cmd == "sign-project":
        cmd_sign_project(venue, sys.argv[3])
    elif cmd == "prepare":
        cmd_prepare(venue)
    elif cmd == "store":
        cmd_store(venue)
    elif cmd == "withdraw":
        cmd_withdraw(venue)
    elif cmd == "submit":
        # submit <venue> [manual|auto] [build_number]
        release = next((a for a in sys.argv[3:] if a in ("manual", "auto", "automatic")), None)
        num = next((int(a) for a in sys.argv[3:] if a.isdigit()), None)
        cmd_submit(venue, release=release, build_number=num)
    else:
        if len(sys.argv) < 4:
            raise SystemExit("testflight needs the build number")
        cmd_testflight(venue, int(sys.argv[3]))


if __name__ == "__main__":
    main()
