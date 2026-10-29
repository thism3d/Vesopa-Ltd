"""
Vesopa Go on TestFlight: the Vesopa team (internal testing) and the "Closed
testing" group (external, with a public link to share).

    python vesopa_go/tool/testflight.py prepare
    python vesopa_go/tool/testflight.py signing <out_dir>
    python vesopa_go/tool/testflight.py sign-project <profiles.json>
    python vesopa_go/tool/testflight.py testflight <build>

Run by .github/workflows/go-ios.yml with the App Store Connect key (ASC_KEY_ID,
ASC_ISSUER_ID, ASC_KEY_P8 or ASC_KEY_PATH), the same key as ios-venue-app.yml.
The Apple calls are vesopa_loyalty/tool/app_store_connect.py's own, imported
rather than copied where they fit.

prepare     registers the App ID com.vesopa.go with NFC tag reading (staff cards),
            finds the app record (Apple ID 6827395109) and prints the next free
            build number (`build=N`), and whether Apple has granted Tap to Pay
            on iPhone to the App ID (`taptopay=true|false`): signing with that
            entitlement fails until Apple has.
signing     this run's distribution certificate and App Store profile, named
            "Vesopa CI ..." like the venue runs' so each run clears the last.
testflight  waits for the build, fills TestFlight's test information and the
            review contact, gives it to the team, puts it in "Closed testing"
            (made with a public link the first time) and sends it to Beta App
            Review, which Apple needs before anyone outside the team can
            install it. Prints the public link.

Safe to run again: what is already right is left alone.
"""

import base64
import json
import os
import plistlib
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "vesopa_loyalty" / "tool"))
import app_store_connect as asc  # noqa: E402

APP_ID = "com.vesopa.go"
NAME = "Vesopa Go"
TEAM = "G238FR2ZC9"
LOCALE = "en-GB"
PUBLIC_GROUP = "Closed testing"
PBX = REPO / "vesopa_go" / "ios" / "Runner.xcodeproj" / "project.pbxproj"

STORE = {
    "review": {
        "contact_first_name": "Vesopa",
        "contact_last_name": "Support",
        "contact_email": "info@vesopasoftware.com",
        # The owner's number for Apple's reviewers (2026-10-27).
        "contact_phone": "+447848494341",
        "notes": "Vesopa Go is the phone app for venues that use Vesopa EPOS: orders at the table and "
                 "the counter, sent to the kitchen, paid by card or cash. A venue signs in with its Vesopa "
                 "account. To review it, tap Continue with Vesopa and sign in with the account in Sign-in "
                 "information: The Vesopa Kitchen, Vesopa's own test venue on Dojo's sandbox (no real money "
                 "moves), then sign on with the staff PIN given there.",
    },
}
DESCRIPTION = ("Vesopa Go: take orders and payments anywhere in a Vesopa EPOS venue, at the counter or "
               "the table. Seat a table, send the order to the kitchen, split and pay the bill by card or "
               "cash, and see the day's sales. Sign in with the venue's Vesopa account.")
WHAT_TO_TEST = ("Vesopa Go 1.2.7 (the till's payment page): the till on iPad (screens, permissions, customers, memberships, tickets). Sign in with the venue's Vesopa account "
                "(The Vesopa Kitchen for testers). Open Tables (the floor plan), seat one, order (tap an item twice: it stacks; long-press for a "
                "note), send it, take the payment, print or email the receipt, then check Reports.")
FEEDBACK = "info@vesopasoftware.com"
PRIVACY = "https://go.vesopa.com/privacy/"
MARKETING = "https://go.vesopa.com/"


def version():
    m = re.search(r"^version:\s*([0-9.]+)", (REPO / "vesopa_go" / "pubspec.yaml").read_text(), re.M)
    return m.group(1)


def output(**values):
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.writelines(f"{k}={v}\n" for k, v in values.items())
    for k, v in values.items():
        print(f"{k}={v}")


def cmd_prepare():
    c = asc.Client()
    asc.note(f"{NAME} ({APP_ID})")
    bundle = asc.ensure_bundle_id(c, APP_ID, NAME)
    asc.ensure_capability(c, bundle, "NFC_TAG_READING")
    caps = {x["attributes"].get("capabilityType") or "" for x in c.all(f"/v1/bundleIds/{bundle['id']}/bundleIdCapabilities")}
    taptopay = any("PROXIMITY" in x or "TAP_TO_PAY" in x for x in caps)
    asc.note(f"  Tap to Pay on iPhone: {'granted' if taptopay else 'not granted to this App ID yet (built without it)'}")
    app = asc.find_app(c, APP_ID)
    if not app:
        msg = (f"There is no app record for {APP_ID} in App Store Connect yet, and Apple's API cannot make one. "
               f"Once, by hand: App Store Connect > Apps > + > New App: platform iOS, name \"{NAME}\", "
               f"primary language English (U.K.), bundle ID {APP_ID} (now in the list), SKU {APP_ID}, "
               "user access Full Access. Then run this workflow again; everything else is done for you.")
        print(f"::error::{msg}" if os.environ.get("GITHUB_OUTPUT") else msg)
        sys.exit(2)
    asc.note(f"  app record: {app['attributes']['name']} (Apple ID {app['id']})")
    build = asc.next_build(c, app["id"], version(), 1)
    asc.note(f"  build number: {build} for version {version()}")
    output(build=build, version=version(), app=app["id"], taptopay=str(taptopay).lower(),
           nfc=str("NFC_TAG_READING" in caps).lower())


def cmd_signing(out_dir):
    """The venue runs' signing (app_store_connect.py cmd_signing), for one App ID."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    c = asc.Client()

    old = set()
    for p in c.all("/v1/profiles", **{"filter[profileType]": "IOS_APP_STORE", "limit": "200"}):
        name = p["attributes"].get("name", "")
        if name.startswith(asc.CI_PREFIX):
            m = re.search(r"cert ([A-Z0-9]+)$", name)
            if m:
                old.add(m.group(1))
            try:
                c.delete(f"/v1/profiles/{p['id']}")
            except asc.AppleError as e:
                asc.note(f"  old profile {name}: {e.detail()}")
    for cid in old:
        try:
            c.delete(f"/v1/certificates/{cid}")
            asc.note(f"  revoked the previous run's certificate {cid}")
        except asc.AppleError as e:
            asc.note(f"  previous certificate {cid}: {e.detail()}")

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    csr = (x509.CertificateSigningRequestBuilder()
           .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, asc.CI_PREFIX)]))
           .sign(key, hashes.SHA256()))
    try:
        cert = c.post("/v1/certificates", {"data": {"type": "certificates", "attributes": {
            "certificateType": "DISTRIBUTION", "csrContent": csr.public_bytes(serialization.Encoding.PEM).decode()}}})["data"]
    except asc.AppleError as e:
        raise SystemExit(f"Apple would not make a distribution certificate: {e.detail()}")
    asc.note(f"  distribution certificate {cert['id']}")
    (out / "dist.key.pem").write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (out / "dist.cer").write_bytes(base64.b64decode(cert["attributes"]["certificateContent"]))

    bundles = [b for b in c.all("/v1/bundleIds", **{"filter[identifier]": APP_ID}) if b["attributes"]["identifier"] == APP_ID]
    if not bundles:
        raise SystemExit(f"No App ID {APP_ID}: run `prepare` first.")
    name = f"{asc.CI_PREFIX} {APP_ID} cert {cert['id']}"
    prof = c.post("/v1/profiles", {"data": {
        "type": "profiles",
        "attributes": {"name": name, "profileType": "IOS_APP_STORE"},
        "relationships": {
            "bundleId": {"data": {"type": "bundleIds", "id": bundles[0]["id"]}},
            "certificates": {"data": [{"type": "certificates", "id": cert["id"]}]},
        },
    }})["data"]
    (out / f"{prof['attributes']['uuid']}.mobileprovision").write_bytes(base64.b64decode(prof["attributes"]["profileContent"]))
    asc.note(f"  App Store profile for {APP_ID}")
    profiles = {APP_ID: name}
    with open(out / "ExportOptions.plist", "wb") as f:
        plistlib.dump({
            "method": "app-store-connect", "destination": "upload", "teamID": TEAM,
            "signingStyle": "manual", "signingCertificate": "Apple Distribution",
            "provisioningProfiles": profiles, "uploadSymbols": True, "manageAppVersionAndBuildNumber": False,
        }, f)
    (out / "profiles.json").write_text(json.dumps(profiles, indent=2))


def cmd_sign_project(profiles_json):
    """Manual signing with this run's profile on the app's build configurations."""
    profiles = json.loads(Path(profiles_json).read_text())
    text = PBX.read_text(encoding="utf-8")
    out, changed = [], 0
    for block in re.split(r"(buildSettings = \{.*?\n\t\t\t\};)", text, flags=re.S):
        m = re.search(r"PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);", block) if block.startswith("buildSettings") else None
        ident = m.group(1).strip('"') if m else None
        if ident in profiles:
            for setting in ("CODE_SIGN_STYLE", "DEVELOPMENT_TEAM", "PROVISIONING_PROFILE_SPECIFIER"):
                block = re.sub(rf"\n\t\t\t\t{setting} = [^;]+;", "", block)
            block = re.sub(r"\n\t\t\t\t\"?CODE_SIGN_IDENTITY(\[[^\]]*\])?\"? = [^;]+;", "", block)
            block = block.replace("buildSettings = {", (
                "buildSettings = {\n"
                "\t\t\t\tCODE_SIGN_STYLE = Manual;\n"
                "\t\t\t\tCODE_SIGN_IDENTITY = \"Apple Distribution\";\n"
                f"\t\t\t\tDEVELOPMENT_TEAM = {TEAM};\n"
                f"\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = \"{profiles[ident]}\";"), 1)
            changed += 1
        out.append(block)
    if not changed:
        raise SystemExit(f"{PBX}: no build settings for {', '.join(profiles)}")
    PBX.write_text("".join(out), encoding="utf-8")
    asc.note(f"  manual signing on {changed} build configurations")


def public_group(c, app_id):
    """The external group with the public link, made the first time."""
    for g in c.all(f"/v1/apps/{app_id}/betaGroups"):
        if not g["attributes"].get("isInternalGroup") and g["attributes"].get("name") == PUBLIC_GROUP:
            if not g["attributes"].get("publicLinkEnabled"):
                asc.patch_attributes(c, "betaGroups", g["id"], {"publicLinkEnabled": True}, "public link")
                g = c.get(f"/v1/betaGroups/{g['id']}")["data"]
            return g
    made = c.post("/v1/betaGroups", {"data": {
        "type": "betaGroups",
        "attributes": {"name": PUBLIC_GROUP, "isInternalGroup": False, "publicLinkEnabled": True,
                       "publicLinkLimitEnabled": False, "feedbackEnabled": True},
        "relationships": {"app": {"data": {"type": "apps", "id": app_id}}},
    }})["data"]
    asc.note(f"  TestFlight group \"{PUBLIC_GROUP}\": made, with a public link")
    return made


def cmd_testflight(number):
    c = asc.Client()
    app = asc.find_app(c, APP_ID)
    if not app:
        raise SystemExit(f"No app record for {APP_ID}.")
    build = asc.wait_for_build(c, app["id"], version(), number)
    if build["attributes"].get("usesNonExemptEncryption") is None:
        asc.patch_attributes(c, "builds", build["id"], {"usesNonExemptEncryption": False}, "export compliance")

    try:
        locs = c.all(f"/v1/builds/{build['id']}/betaBuildLocalizations")
        if locs:
            asc.patch_attributes(c, "betaBuildLocalizations", locs[0]["id"], {"whatsNew": WHAT_TO_TEST}, "What to Test")
        else:
            c.post("/v1/betaBuildLocalizations", {"data": {
                "type": "betaBuildLocalizations", "attributes": {"locale": LOCALE, "whatsNew": WHAT_TO_TEST},
                "relationships": {"build": {"data": {"type": "builds", "id": build["id"]}}}}})
    except asc.AppleError as e:
        asc.todo(f"What to Test: {e.detail()}")

    attrs = {"description": DESCRIPTION, "feedbackEmail": FEEDBACK, "marketingUrl": MARKETING, "privacyPolicyUrl": PRIVACY}
    try:
        locs = c.all(f"/v1/apps/{app['id']}/betaAppLocalizations")
        mine = next((x for x in locs if x["attributes"]["locale"] == LOCALE), locs[0] if locs else None)
        if mine:
            asc.patch_attributes(c, "betaAppLocalizations", mine["id"], attrs, "TestFlight test information")
        else:
            c.post("/v1/betaAppLocalizations", {"data": {
                "type": "betaAppLocalizations", "attributes": {"locale": LOCALE, **attrs},
                "relationships": {"app": {"data": {"type": "apps", "id": app["id"]}}}}})
            asc.note("  TestFlight test information: done")
    except asc.AppleError as e:
        asc.todo(f"TestFlight test information: {e.detail()}")
    asc.set_beta_review_details(c, app, STORE)

    team = asc.internal_group(c, app["id"], "Vesopa team")
    if team:
        asc.add_team_as_testers(c, app["id"], team)

    link = None
    try:
        group = public_group(c, app["id"])
        c.post(f"/v1/betaGroups/{group['id']}/relationships/builds", {"data": [{"type": "builds", "id": build["id"]}]})
        asc.note(f"  build added to \"{PUBLIC_GROUP}\"")
        link = group["attributes"].get("publicLink")
    except asc.AppleError as e:
        asc.todo(f"The \"{PUBLIC_GROUP}\" group: {e.detail()}")
    try:
        c.post("/v1/betaAppReviewSubmissions", {"data": {
            "type": "betaAppReviewSubmissions",
            "relationships": {"build": {"data": {"type": "builds", "id": build["id"]}}}}})
        asc.note("  build sent to Beta App Review (Apple, usually within a day)")
    except asc.AppleError as e:
        if e.status == 409:
            asc.note(f"  Beta App Review: {e.detail()}")
        else:
            asc.todo(f"Send the build to Beta App Review: {e.detail()}")

    if link:
        print(f"\nPublic TestFlight link: {link}")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as f:
                f.write(f"### Public TestFlight link\n\n{link}\n\nIt works for people outside the team once Apple's Beta App Review approves the build.\n\n")
    asc.summary()


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "prepare":
        cmd_prepare()
    elif cmd == "signing" and len(sys.argv) > 2:
        cmd_signing(sys.argv[2])
    elif cmd == "sign-project" and len(sys.argv) > 2:
        cmd_sign_project(sys.argv[2])
    elif cmd == "testflight" and len(sys.argv) > 2:
        cmd_testflight(int(sys.argv[2]))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
