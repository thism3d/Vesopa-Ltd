"""Put a development build of Vesopa Go on go.vesopa.com/install, showing its version.

    python vesopa_go/tool/publish_install.py path/to/VesopaGo.ipa

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


def main():
    ipa = pathlib.Path(next(a for a in sys.argv[1:] if not a.startswith("--")))
    version, build = version_of(ipa)
    shown = f"{version} ({build})"
    print(f"== Vesopa Go {shown}")
    stamp(INSTALL / "index.html", [
        (r"<title>[^<]*</title>", f"<title>Install Vesopa Go {version} (test)</title>"),
        (r"<h1>[^<]*</h1>", f"<h1>Vesopa Go {version}: test build</h1>"),
        (r'<p class="version">[^<]*</p>', f'<p class="version">Version {shown}</p>'),
    ])
    stamp(INSTALL / "manifest.plist", [
        (r"(<key>bundle-version</key><string>)[^<]*", rf"\g<1>{version}"),
        (r"(<key>title</key><string>)[^<]*", rf"\g<1>Vesopa Go {version} (test)"),
    ])
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
