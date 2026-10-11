"""
A venue's own Android and iPhone app, made from this one.

    python vesopa_loyalty/tool/make_venue_app.py PontardaweRFC

ONE CODEBASE, MANY APPS. vesopa_loyalty is every venue's app: the venue's
name, colours and logo come from the back office at run time. What cannot
come at run time is what the phone knows before the app has started -- the
package name the stores list it under, the name and icon on the home screen,
the splash -- so a venue with its own store listing gets its own copy of the
project with those swapped in. This writes that copy:

    <venue>/build/app/        a complete Flutter project, ready to build
                              (gitignored; rewritten on every run)

from three things in the venue's folder:

    <venue>/venue.json        slug, names, package name, colours, version
    <venue>/overlay/          files laid over the copy at the same paths:
                              icons, splash pictures, the intro's crest
                              (tool/make_venue_art.py draws them)
    <venue>/google-services.json   Firebase's file for the venue's package
                              (gitignored; tool/firebase_android_app.py
                              fetches it). Android only.

and edits the rest in place: the applicationId and bundle ids, the label, the
notification colour, the Android 12+ and older splash themes, the iPhone
launch screen's colour, and the Watch app's name.

NOTHING IN vesopa_loyalty CHANGES, so the Kitchen demonstration build and the
Store app are untouched, and a fix made there reaches every venue's app the
next time this is run. Standard library only, so it runs on the Windows PC and
on a Mac as they are.

Then build in <venue>/build/app with the venue's dart-defines:

    flutter build appbundle --release --dart-define-from-file=venue_defines.json
    flutter build ipa --release --dart-define-from-file=venue_defines.json

(or the venue folder's build-android.ps1 / build-ios.sh, which do all of it).
"""

import json
import re
import shutil
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]  # vesopa_loyalty
REPO = HERE.parent

# What the copy leaves behind: machine output, per-machine settings and the
# demonstration venue's own secrets. key.properties is copied separately
# (below), with its keystore path made absolute.
SKIP_NAMES = {
    "build", ".dart_tool", ".gradle", ".cxx", "Pods", ".symlinks", "ephemeral",
    "local.properties", "key.properties", "google-services.json", "GoogleService-Info.plist",
    "Generated.xcconfig", "flutter_export_environment.sh", ".flutter-plugins",
    ".flutter-plugins-dependencies", "xcuserdata", ".idea",
}
COPY = ["lib", "assets", "android", "ios", "pubspec.yaml", "pubspec.lock", "analysis_options.yaml"]

# The demonstration venue the source project is built as.
SOURCE_APP_ID = "com.vesopaepos.thevesopakitchen"
SOURCE_NAME = "The Vesopa Kitchen"


def ignore(_dir, names):
    return [n for n in names if n in SKIP_NAMES or n.endswith(".iml")]


def edit(path: Path, pairs, *, count_required=True):
    text = path.read_text(encoding="utf-8")
    for old, new in pairs:
        if old not in text:
            if count_required:
                raise SystemExit(f"{path}: expected to find {old!r} -- has vesopa_loyalty changed shape?")
            continue
        text = text.replace(old, new)
    path.write_text(text, encoding="utf-8")


def png_size(path: Path):
    with path.open("rb") as f:
        head = f.read(24)
    return struct.unpack(">II", head[16:24])


def xml_escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "\\'")


def plist_escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def rgb_floats(hex_colour):
    h = hex_colour.lstrip("#")
    return [round(int(h[i : i + 2], 16) / 255, 4) for i in (0, 2, 4)]


def android(app: Path, venue_dir: Path, v):
    a = app / "android" / "app"
    edit(a / "build.gradle.kts", [(f'applicationId = "{SOURCE_APP_ID}"', f'applicationId = "{v["app_id"]}"')])
    edit(
        a / "src" / "main" / "AndroidManifest.xml",
        [(
            f'android:label="{SOURCE_NAME}"',
            f'android:label="{xml_escape(v["name"])}"\n        android:roundIcon="@mipmap/ic_launcher_round"',
        )],
    )
    res = a / "src" / "main" / "res"
    bg = v["colours"]["background"]
    edit(res / "values" / "push.xml", [("#A5C715", bg)])
    # The PNG status-bar icons in the overlay replace the Kitchen's vector V.
    (res / "drawable" / "ic_notification.xml").unlink(missing_ok=True)

    (res / "values" / "splash.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!-- Written by vesopa_loyalty/tool/make_venue_app.py from venue.json. -->\n"
        "<resources>\n"
        f'    <color name="splash_background">{bg}</color>\n'
        "</resources>\n",
        encoding="utf-8",
    )
    launch = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!-- Before Android 12: the crest on the venue colour, 140dp tall, as the\n"
        "     Flutter intro's first frame draws it. Written by make_venue_app.py. -->\n"
        '<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <item android:drawable="@color/splash_background" />\n'
        "    <item>\n"
        '        <bitmap android:gravity="center" android:src="@drawable/splash_crest" />\n'
        "    </item>\n"
        "</layer-list>\n"
    )
    for d in ("drawable", "drawable-v21"):
        (res / d / "launch_background.xml").write_text(launch, encoding="utf-8")

    # The window stays the venue colour behind Flutter too, so there is no
    # white flash between the splash and the intro's first frame.
    styles = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!-- Written by vesopa_loyalty/tool/make_venue_app.py. -->\n"
        "<resources>\n"
        '    <style name="LaunchTheme" parent="@android:style/Theme.Black.NoTitleBar">\n'
        '        <item name="android:windowBackground">@drawable/launch_background</item>\n'
        "{extra}"
        "    </style>\n"
        '    <style name="NormalTheme" parent="@android:style/Theme.Black.NoTitleBar">\n'
        '        <item name="android:windowBackground">@color/splash_background</item>\n'
        "    </style>\n"
        "</resources>\n"
    )
    v31 = (
        "        <!-- Android 12+: the system splash. The crest sits inside the\n"
        "             192dp circle at the same 140dp (splash_icon.png). -->\n"
        '        <item name="android:windowSplashScreenBackground">@color/splash_background</item>\n'
        '        <item name="android:windowSplashScreenAnimatedIcon">@drawable/splash_icon</item>\n'
    )
    for d, extra in (("values", ""), ("values-night", ""), ("values-v31", v31), ("values-night-v31", v31)):
        (res / d).mkdir(exist_ok=True)
        (res / d / "styles.xml").write_text(styles.format(extra=extra), encoding="utf-8")

    # Firebase binds its file to the package name, and the Gradle plugin
    # refuses to build without one.
    gs = venue_dir / "google-services.json"
    if gs.exists():
        data = json.loads(gs.read_text(encoding="utf-8"))
        packages = [c["client_info"]["android_client_info"]["package_name"] for c in data.get("client", [])]
        if v["app_id"] not in packages:
            raise SystemExit(f"{gs} has no entry for {v['app_id']} (it has {packages}).")
        shutil.copy2(gs, a / "google-services.json")
    else:
        print(f"! no {gs.name} in {venue_dir.name}: the Android build will stop until it is there"
              " (python vesopa_loyalty/tool/firebase_android_app.py ...).")

    # The upload key: the same one signs every Vesopa Android app.
    for src in (HERE / "android" / "key.properties", REPO / "MetricMembership" / "app" / "android" / "key.properties"):
        if not src.exists():
            continue
        out = []
        for line in src.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("storeFile="):
                store = line.split("=", 1)[1].strip()
                p = Path(store)
                if not p.is_absolute():
                    # Gradle resolves it from android/app of the source project.
                    p = (src.parent / "app" / store).resolve()
                line = "storeFile=" + p.as_posix()
            out.append(line)
        (app / "android" / "key.properties").write_text("\n".join(out) + "\n", encoding="utf-8")
        print(f"  upload key settings from {src.relative_to(REPO)}")
        break
    else:
        print("! no android/key.properties found: a release build needs the Vesopa upload key.")


def ios(app: Path, v):
    ios_dir = app / "ios"
    name = v["name"]
    display = v.get("ios_display_name", name)
    short = v.get("short_name", name)
    # Every bundle id (the app, its tests, the Watch app and the Watch app's
    # pointer back to its phone app) is the Kitchen's with a suffix.
    for p in list(ios_dir.rglob("*.pbxproj")) + list(ios_dir.rglob("*.plist")) + list(ios_dir.rglob("*.xcscheme")):
        text = p.read_text(encoding="utf-8")
        new = text.replace(SOURCE_APP_ID, v["app_id"])
        if new != text:
            p.write_text(new, encoding="utf-8")

    edit(ios_dir / "Runner.xcodeproj" / "project.pbxproj", [
        ("INFOPLIST_KEY_CFBundleDisplayName = Kitchen;", f'INFOPLIST_KEY_CFBundleDisplayName = "{short}";'),
    ])
    edit(ios_dir / "Runner" / "Info.plist", [
        (f"<string>{SOURCE_NAME}</string>", f"<string>{plist_escape(display)}</string>"),
        ("<string>vesopa_loyalty</string>", f"<string>{plist_escape(short[:15])}</string>"),
    ])
    for swift in (ios_dir / "VesopaWatch").glob("*.swift"):
        edit(swift, [(SOURCE_NAME, name)], count_required=False)

    # The launch screen: the venue colour, and the crest at its 140pt.
    sb = ios_dir / "Runner" / "Base.lproj" / "LaunchScreen.storyboard"
    r, g, b = rgb_floats(v["colours"]["background"])
    text = sb.read_text(encoding="utf-8")
    text = re.sub(
        r'<color key="backgroundColor" red="[^"]*" green="[^"]*" blue="[^"]*" alpha="1"',
        f'<color key="backgroundColor" red="{r}" green="{g}" blue="{b}" alpha="1"',
        text,
    )
    w, h = png_size(ios_dir / "Runner" / "Assets.xcassets" / "LaunchImage.imageset" / "LaunchImage.png")
    text = re.sub(r'<image name="LaunchImage" width="\d+" height="\d+"/>', f'<image name="LaunchImage" width="{w}" height="{h}"/>', text)
    sb.write_text(text, encoding="utf-8")


def dart(app: Path, v):
    # The intro's crest, and the version the stores see.
    edit(app / "pubspec.yaml", [
        ("    - assets/vesopa-mark.png\n", "    - assets/vesopa-mark.png\n    # The venue's crest, for the opening (lib/ui/venue_intro.dart).\n    - assets/venue/\n"),
    ])
    text = (app / "pubspec.yaml").read_text(encoding="utf-8")
    text = re.sub(r"^version: .*$", f"version: {v['version']}+{v['build']}", text, count=1, flags=re.M)
    (app / "pubspec.yaml").write_text(text, encoding="utf-8")

    # The venue's typeface, when its overlay brings one (assets/venue/fonts/,
    # files named Family-Weight.ttf): the whole app is set in it.
    weights = {"Thin": 100, "ExtraLight": 200, "Light": 300, "Regular": 400, "Medium": 500,
               "SemiBold": 600, "Bold": 700, "ExtraBold": 800, "Black": 900}
    faces = sorted((app / "assets" / "venue" / "fonts").glob("*.ttf")) if (app / "assets" / "venue" / "fonts").is_dir() else []
    font = ""
    if faces:
        font = "VenueFont"
        block = "\n  # The venue's own typeface (lib/data/venue_style.dart).\n  fonts:\n    - family: VenueFont\n      fonts:\n"
        for f in faces:
            w = weights.get(f.stem.rsplit("-", 1)[-1], 400)
            block += f"        - asset: assets/venue/fonts/{f.name}\n          weight: {w}\n"
        edit(app / "pubspec.yaml", [("  uses-material-design: true\n", "  uses-material-design: true\n" + block)])

    c = v["colours"]
    defines = {
        "LOYALTY_SLUG": v["slug"],
        "VESOPA_LOYALTY_CLIENT_ID": v.get("vesopa_client_id", ""),
        "VENUE_NAME": v["name"],
        "VENUE_TAGLINE": v.get("tagline", ""),
        "VENUE_SPLASH_BG": c["background"].lstrip("#"),
        "VENUE_SPLASH_DEEP": c.get("deep", "").lstrip("#"),
        "VENUE_SPLASH_GLOW": c.get("glow", "").lstrip("#"),
        "VENUE_FONT": font,
        # Sign in with Apple, passkeys and Google on the device (lib/platform/native_auth.dart).
        "VENUE_NATIVE_AUTH": "true",
        "GOOGLE_IOS_CLIENT_ID": v.get("google_ios_client_id", ""),
    }

    # The entitlements those need: Sign in with Apple, and the sites whose
    # passkeys the app may use, each of which names the app in its own
    # apple-app-site-association: vesopa.com for the member's Vesopa passkey
    # (auth.vesopa.com's RP ID; tool/deploy_pontardawe_app.py), and
    # loyalty.vesopa.com for one made for the venue's own sign-in
    # (vesopa_server/src/loyalty_host.js).
    ent = app / "ios" / "Runner" / "Runner.entitlements"
    domains = v.get("passkey_domains", ["vesopa.com", "loyalty.vesopa.com"])
    edit(ent, [("</dict>\n</plist>", (
        "\t<key>com.apple.developer.applesignin</key>\n\t<array>\n\t\t<string>Default</string>\n\t</array>\n"
        "\t<key>com.apple.developer.associated-domains</key>\n\t<array>\n"
        + "".join(f"\t\t<string>webcredentials:{d}</string>\n" for d in domains)
        + "\t</array>\n</dict>\n</plist>"))])
    (app / "venue_defines.json").write_text(json.dumps(defines, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python vesopa_loyalty/tool/make_venue_app.py <venue folder>")
    venue_dir = Path(sys.argv[1]).resolve()
    v = json.loads((venue_dir / "venue.json").read_text(encoding="utf-8"))
    overlay = venue_dir / "overlay"
    if not overlay.exists():
        raise SystemExit(f"{overlay} is missing: run tool/make_venue_art.py first.")

    app = venue_dir / "build" / "app"
    if app.exists():
        shutil.rmtree(app)
    app.mkdir(parents=True)
    for name in COPY:
        src = HERE / name
        if src.is_dir():
            shutil.copytree(src, app / name, ignore=ignore)
        else:
            shutil.copy2(src, app / name)
    shutil.copytree(overlay, app, dirs_exist_ok=True)

    android(app, venue_dir, v)
    ios(app, v)
    dart(app, v)
    print(f"{v['name']} {v['version']} ({v['build']}) as {v['app_id']}: {app}")


if __name__ == "__main__":
    main()
