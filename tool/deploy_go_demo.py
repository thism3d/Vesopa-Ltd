"""Put the Vesopa Go demo on vesopaepos.com, for links anyone can open:

    https://vesopaepos.com/demo/index.html               iPhone, or any browser
    https://vesopaepos.com/app/Vesopa-Go-Demo.apk   Android

    python tool/deploy_go_demo.py --check      # what is live now; builds and changes nothing
    python tool/deploy_go_demo.py              # build both, back up, upload, verify
    python tool/deploy_go_demo.py --web-only   # only the browser demo
    python tool/deploy_go_demo.py --apk-only   # only the Android demo
    python tool/deploy_go_demo.py --remove     # take both off the site (backed up first)

Both are the real app built with GO_DEMO_ONLY: straight into the demo bar
(PIN 1111), pretend card payments, nothing reaches a back office. Builds on this
PC with Flutter, in a scratch copy of vesopa_go (the checkout is not
touched).

Static files only: the site's own `express.static` serves public/demo/ and
public/app/ (where .apk is already sent as a download), so no site code changes
and nothing restarts. The demo goes up as public/demo.new and is swapped in with
one rename, the APK as a .part renamed over the old one, so a half-finished
upload is never what someone downloads. The old demo is kept in
/home/vesopasoftware/backups/vesopaepos.com-demo-<stamp>.tgz.

public/demo/ is not in git and not in deploy.sh's rsync excludes; deploy.sh
targets the legacy box, so it cannot remove it from the live one.

Credentials: as tool/deploy_websites_cookie_notice.py (.env.claude-tools, else
.env.claude). To roll back the demo:
    rm -rf <app>/public/demo && tar -xzf /home/vesopasoftware/backups/vesopaepos.com-demo-<stamp>.tgz -C <app>/public
"""
import os
import pathlib
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import deploy_websites_cookie_notice as base  # noqa: E402  (settings + ssh helpers)

ROOT = base.ROOT
USER = base.USER
DOMAIN = "vesopaepos.com"
APP = f"/home/{USER}/web/{DOMAIN}/private/nodeapp"
DEMO = f"{APP}/public/demo"
APK_NAME = "Vesopa-Go-Demo.apk"
APK = f"{APP}/public/app/{APK_NAME}"
WEB_URL = f"https://{DOMAIN}/demo/index.html"
APK_URL = f"https://{DOMAIN}/app/{APK_NAME}"
DEFINE = "--dart-define=GO_DEMO_ONLY=true"

# The page itself. Flutter's own index.html is a template; this one carries the
# name, a loading screen in the brand, and no service worker (the site has its
# own at /sw.js).
INDEX = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <base href="/demo/">
  <title>Vesopa Go demo</title>
  <meta name="description" content="Try Vesopa Go, orders and payments anywhere in the venue. PIN 1111.">
  <meta property="og:title" content="Vesopa Go demo">
  <meta property="og:description" content="The fast till for bars, pop-ups and events. Open it and enter PIN 1111.">
  <meta property="og:image" content="https://vesopaepos.com/demo/assets/assets/brand/go_mark.png">
  <meta name="theme-color" content="#10130A">
  <link rel="icon" type="image/png" href="assets/assets/brand/go_mark.png">
  <link rel="apple-touch-icon" href="assets/assets/brand/go_mark.png">
  <style>
    html, body { height: 100%; margin: 0; background: #10130A; color: #E9EDE0; overflow: hidden; }
    #boot { position: fixed; inset: 0; display: grid; place-items: center; font: 600 15px/1.4 system-ui, sans-serif; }
    #boot .wrap { text-align: center; }
    #boot img { display: block; width: 72px; height: 72px; border-radius: 16px; margin: 0 auto 16px; }
    @media (prefers-reduced-motion: no-preference) { #boot img { animation: pulse 1.4s ease-in-out infinite; } }
    @keyframes pulse { 50% { transform: scale(0.92); opacity: 0.8; } }
  </style>
</head>
<body>
  <div id="boot"><div class="wrap"><img src="assets/assets/brand/go_mark.png" alt="Vesopa">Loading the Vesopa Go demo…</div></div>
  <script>window.addEventListener('flutter-first-frame', function () { var b = document.getElementById('boot'); if (b) b.remove(); });</script>
  <script src="flutter_bootstrap.js" async></script>
</body>
</html>
"""

# Only what the page loads: one renderer (CanvasKit, both builds of it), no
# source maps, no Flutter service worker.
SKIP = re.compile(r"(\.symbols$|^canvaskit/(skwasm|wimp|webparagraph)|^flutter_service_worker\.js$|^\.last_build_id$|^NOTICES$|/NOTICES$)")


def flutter():
    exe = shutil.which("flutter") or shutil.which("flutter.bat")
    if not exe:
        raise SystemExit("Flutter is not on PATH. It builds the demo on this PC.")
    return exe


def step(cmd, cwd):
    print("  $ " + " ".join(cmd[1:] if cmd[0].endswith(("flutter", "flutter.bat")) else cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def scratch_copy(tmp):
    """vesopa_go in a scratch folder (the checkout is not touched)."""
    src = ROOT / "vesopa_go"
    dst = pathlib.Path(tmp) / "vesopa_go"
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("build", ".dart_tool", ".idea", "*.iml", "local.properties"))
    return dst


def build_web(app):
    fl = flutter()
    step([fl, "create", "--platforms", "web", "--project-name", "vesopa_go", "."], app)
    step([fl, "build", "web", "--release", "--no-web-resources-cdn", "--base-href", "/demo/", DEFINE], app)
    out = app / "build" / "web"
    boot = out / "flutter_bootstrap.js"
    js = boot.read_text(encoding="utf-8")
    i = js.rindex("_flutter.loader.load(")
    boot.write_text(js[:i] + "_flutter.loader.load({});\n", encoding="utf-8")
    (out / "index.html").write_text(INDEX, encoding="utf-8")
    return out


def build_apk(app):
    fl = flutter()
    step([fl, "build", "apk", "--release", DEFINE, "--target-platform", "android-arm,android-arm64"], app)
    return app / "build" / "app" / "outputs" / "flutter-apk" / "app-release.apk"


def web_files(out):
    for p in sorted(out.rglob("*")):
        rel = p.relative_to(out).as_posix()
        if p.is_file() and not SKIP.search(rel):
            yield p, rel


def head(url):
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "Mozilla/5.0 vesopa-deploy-check", "Range": "bytes=0-0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, dict(r.headers)


def check_live():
    for url in (WEB_URL, APK_URL):
        try:
            status, h = head(url)
            print(f"  {url}: {status} {h.get('Content-Type', '')} {h.get('Content-Range', '')}")
            if h.get("Content-Security-Policy"):
                print(f"    note: the page has a Content-Security-Policy: {h['Content-Security-Policy']}")
        except Exception as e:  # noqa: BLE001
            print(f"  {url}: {e}")


def remove():
    """Take the demo off the site. Both are backed up first, so this can be undone:
    tar -xzf <backup> -C <app>/public restores demo/ and app/Vesopa-Go-Demo.apk."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"{base.BACKUPS}/{DOMAIN}-demo-removed-{stamp}.tgz"
    client = base.vesopa_ssh.connect()
    try:
        status, _ = base.sh(client, f"cd {APP}/public && mkdir -p {base.BACKUPS} && "
                                    f"items=''; [ -d demo ] && items='demo'; [ -f app/{APK_NAME} ] && items=\"$items app/{APK_NAME}\"; "
                                    f"if [ -z \"$items\" ]; then echo 'Nothing to remove: the demo is not on the site.'; "
                                    f"else tar -czf {backup} $items && echo 'Backed up to {backup}' && "
                                    f"rm -rf demo demo.new demo.old app/{APK_NAME} app/{APK_NAME}.part && echo 'Removed:' $items; fi")
        if status:
            raise SystemExit("Stopped: nothing was removed unless it says so above.")
    finally:
        client.close()
    print("-- live (both should now be 404):")
    check_live()


def main():
    if "--remove" in sys.argv:
        print(f"== {DOMAIN}: removing the Vesopa Go demo")
        remove()
        return
    check_only = "--check" in sys.argv
    web = "--apk-only" not in sys.argv
    apk = "--web-only" not in sys.argv
    print(f"== {DOMAIN}: Vesopa Go demo ({'web' if web else ''}{' + ' if web and apk else ''}{'apk' if apk else ''})")
    if check_only:
        client = base.vesopa_ssh.connect()
        try:
            base.sh(client, f"ls -la {DEMO} 2>/dev/null | head -5; ls -la {APK} 2>/dev/null; true")
        finally:
            client.close()
        check_live()
        return

    with tempfile.TemporaryDirectory(prefix="lite-demo-") as tmp:
        app = scratch_copy(tmp)
        out = build_web(app) if web else None
        apk_file = build_apk(app) if apk else None

        client = base.vesopa_ssh.connect()
        try:
            sftp = client.open_sftp()
            stamp = time.strftime("%Y%m%d-%H%M%S")
            if out:
                files = list(web_files(out))
                print(f"-- web demo: {len(files)} files")
                base.sh(client, f"rm -rf {DEMO}.new && mkdir -p {DEMO}.new && mkdir -p {base.BACKUPS} && "
                                f"if [ -d {DEMO} ]; then tar -czf {base.BACKUPS}/{DOMAIN}-demo-{stamp}.tgz -C {APP}/public demo; fi")
                made = set()
                for p, rel in files:
                    d = posixpath.dirname(posixpath.join(f"{DEMO}.new", rel))
                    if d not in made:
                        base.sh(client, f"mkdir -p '{d}'", quiet=True)
                        made.add(d)
                    sftp.put(str(p), posixpath.join(f"{DEMO}.new", rel))
                status, _ = base.sh(client, f"rm -rf {DEMO}.old && if [ -d {DEMO} ]; then mv {DEMO} {DEMO}.old; fi && "
                                            f"mv {DEMO}.new {DEMO} && rm -rf {DEMO}.old && chown -R {USER}:{USER} {DEMO}")
                if status:
                    raise SystemExit("Could not swap the demo in; the old one is in the backup.")
            if apk_file:
                size = os.path.getsize(apk_file)
                print(f"-- android demo: {size / 1e6:.1f} MB")
                sftp.put(str(apk_file), f"{APK}.part")
                base.sh(client, f"mv -f {APK}.part {APK} && chown {USER}:{USER} {APK}")
            sftp.close()
        finally:
            client.close()

    print("-- live:")
    check_live()
    print(f"\nShare:\n  iPhone / any browser: {WEB_URL}\n  Android: {APK_URL}")


if __name__ == "__main__":
    main()
