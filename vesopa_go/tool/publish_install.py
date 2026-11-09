"""Put a development build of Vesopa Go on go.vesopa.com/install, showing its version.

    python vesopa_go/tool/publish_install.py path/to/VesopaGo.ipa
    python vesopa_go/tool/publish_install.py path/to/VesopaGo-<version>-<build>.apk

The version comes from the IPA itself, so the page, the manifest and the link
cannot disagree with what installs (owner, 2026-11-07: "in the link always show
the app version"). The IPA comes from go-ios.yml with adhoc=true. Nothing is
deleted; the old IPA is replaced. Prints the link to send, with its version.
"""
import pathlib
import plistlib
import re
import sys
import zipfile

sys.argv.append("--local")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import go_site  # noqa: E402
sys.path.insert(0, str(go_site.REPO / "tool"))
import deploy_pontardawe_app as app  # noqa: E402  (the server login, from a worktree too)

INSTALL = go_site.SITE / "install"


def version_of(ipa):
    with zipfile.ZipFile(ipa) as z:
        name = next(n for n in z.namelist() if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", n))
        info = plistlib.loads(z.read(name))
    return info["CFBundleShortVersionString"], info["CFBundleVersion"]


def stamp(path, pairs):
    raw = path.read_bytes().decode("utf-8")
    for pattern, new in pairs:
        raw, n = re.subn(pattern, new, raw)
        if n < 1:
            raise SystemExit(f"! {path.name}: {pattern} not found")
    path.write_bytes(raw.encode("utf-8"))


def apk_version(apk):
    """VesopaGo-<version>-<build>.apk, as go-android.yml names it."""
    m = re.fullmatch(r"VesopaGo-([0-9.]+)-([0-9]+)\.apk", apk.name)
    if not m:
        raise SystemExit(f"! {apk.name}: expected VesopaGo-<version>-<build>.apk from go-android.yml")
    return m.group(1), m.group(2)


def publish_apk(apk):
    """The Android build (go-android.yml's vesopa-go-apk artifact) beside the iPhone one."""
    version, build = apk_version(apk)
    shown = f"{version} ({build})"
    print(f"== Vesopa Go {shown} for Android")
    stamp(INSTALL / "index.html", [
        (r'<p class="version-android">[^<]*</p>', f'<p class="version-android">Version {shown}</p>'),
    ])
    go_site._client = app.vesopa_ssh.connect()
    user, folder = go_site.where()
    target = f"{folder}/install"
    go_site.sh(f"mkdir -p {target} && cat > {target}/VesopaGo.apk.new && mv {target}/VesopaGo.apk.new {target}/VesopaGo.apk", data=apk.read_bytes())
    go_site.sh(f"cat > {target}/index.html", data=(INSTALL / "index.html").read_bytes())
    go_site.sh(f"chown -R {user}:{user} {target} && chmod 644 {target}/*")
    print("  page:", go_site.status(f"https://{go_site.DOMAIN}/install/"), " apk:", go_site.status(f"https://{go_site.DOMAIN}/install/VesopaGo.apk"))
    print(f"Vesopa Go {shown} for Android: https://{go_site.DOMAIN}/install/?android={version}")


def main():
    path = pathlib.Path(next(a for a in sys.argv[1:] if not a.startswith("--")))
    if path.suffix.lower() == ".apk":
        return publish_apk(path)
    ipa = path
    version, build = version_of(ipa)
    shown = f"{version} ({build})"
    print(f"== Vesopa Go {shown}")
    stamp(INSTALL / "index.html", [
        (r'<p class="version">[^<]*</p>', f'<p class="version">Version {shown}</p>'),
    ])
    stamp(INSTALL / "manifest.plist", [
        (r"(<key>bundle-version</key><string>)[^<]*", rf"\g<1>{version}"),
        (r"(<key>title</key><string>)[^<]*", rf"\g<1>Vesopa Go {version} (test)"),
    ])
    go_site._client = app.vesopa_ssh.connect()
    user, folder = go_site.where()
    target = f"{folder}/install"
    go_site.sh(f"mkdir -p {target} && cat > {target}/VesopaGo.ipa.new && mv {target}/VesopaGo.ipa.new {target}/VesopaGo.ipa", data=ipa.read_bytes())
    for name in ("index.html", "manifest.plist"):
        go_site.sh(f"cat > {target}/{name}", data=(INSTALL / name).read_bytes())
    go_site.sh(f"chown -R {user}:{user} {target} && chmod 644 {target}/*")
    print("  page:", go_site.status(f"https://{go_site.DOMAIN}/install/"), " ipa:", go_site.status(f"https://{go_site.DOMAIN}/install/VesopaGo.ipa"))
    print(f"Vesopa Go {shown}: https://{go_site.DOMAIN}/install/?v={version}")


if __name__ == "__main__":
    main()
