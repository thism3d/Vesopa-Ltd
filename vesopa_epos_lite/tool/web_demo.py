"""Build the Vesopa EPOS Lite demo as a web page anyone can open, and add to an
iPhone's home screen as an app (full screen, the V icon, no browser bar).

    python vesopa_epos_lite/tool/web_demo.py <out_dir>                        # works under any address
    python vesopa_epos_lite/tool/web_demo.py <out_dir> --base-href /Vesopa-Ltd/  # under one fixed path

The real app built with LITE_DEMO_ONLY: straight into the demo venue (PIN 1111),
pretend card payments. Built in a scratch copy of vesopa_epos_lite, so the
checkout is not touched (Flutter's web/ folder is made there, not committed).
Without --base-href every path in the page is relative, so the same files work
wherever they are served (share-lite-demo.yml, through githack); with it, they
expect that one path (web-lite-demo.yml, GitHub Pages).

The output is only what the page loads: one renderer (CanvasKit, both builds),
no source maps, no Flutter service worker.
"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LITE = REPO / "vesopa_epos_lite"
SKIP = re.compile(r"(\.symbols$|^canvaskit/(skwasm|wimp|webparagraph)|^flutter_service_worker\.js$|^\.last_build_id$|NOTICES$|^icons/|^favicon\.png$|^manifest\.json$)")

INDEX = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
{base_tag}  <title>Vesopa EPOS Lite</title>
  <meta name="description" content="Try Vesopa EPOS Lite, the fast till for bars, cafés, pop-ups and events. Enter PIN 1111.">
  <meta property="og:title" content="Vesopa EPOS Lite demo">
  <meta property="og:description" content="The fast till for bars, cafés, pop-ups and events. Open it and enter PIN 1111.">
  <meta property="og:image" content="icon-512.png">
  <meta name="theme-color" content="#10130A">
  <!-- Add to Home Screen on an iPhone: full screen, the V icon, its own name. -->
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="EPOS Lite">
  <link rel="apple-touch-icon" href="icon-180.png">
  <link rel="icon" type="image/png" href="icon-192.png">
  <link rel="manifest" href="manifest.json">
  <style>
    html, body {{ height: 100%; margin: 0; background: #10130A; color: #E9EDE0; overflow: hidden; }}
    #boot {{ position: fixed; inset: 0; display: grid; place-items: center; font: 600 15px/1.4 -apple-system, system-ui, sans-serif; }}
    #boot .wrap {{ text-align: center; padding: 0 24px; }}
    #boot img {{ display: block; width: 72px; height: 72px; border-radius: 16px; margin: 0 auto 16px; }}
    #boot small {{ display: block; margin-top: 6px; font-weight: 400; opacity: 0.7; }}
    @media (prefers-reduced-motion: no-preference) {{ #boot img {{ animation: pulse 1.4s ease-in-out infinite; }} }}
    @keyframes pulse {{ 50% {{ transform: scale(0.92); opacity: 0.8; }} }}
  </style>
</head>
<body>
  <div id="boot"><div class="wrap"><img src="icon-192.png" alt="Vesopa">Loading the Vesopa EPOS Lite demo…<small>PIN 1111</small></div></div>
  <script>window.addEventListener('flutter-first-frame', function () {{ var b = document.getElementById('boot'); if (b) b.remove(); }});</script>
  <script src="flutter_bootstrap.js" async></script>
</body>
</html>
"""

MANIFEST = """{{
  "name": "Vesopa EPOS Lite",
  "short_name": "EPOS Lite",
  "description": "The fast till for bars, cafés, pop-ups and events. Demo: PIN 1111.",
  "start_url": "{start}",
  "scope": "{start}",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#10130A",
  "theme_color": "#10130A",
  "icons": [
    {{"src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"}},
    {{"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"}}
  ]
}}
"""


def flutter():
    exe = shutil.which("flutter") or shutil.which("flutter.bat")
    if not exe:
        raise SystemExit("Flutter is not on PATH.")
    return exe


def run(cmd, cwd):
    print("  $ flutter " + " ".join(cmd[1:]), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def icons(out):
    """The V at the sizes a home screen and a browser tab ask for, from the
    app's own 512px mark (an iPhone rounds the corners itself)."""
    src = LITE / "assets" / "brand" / "vesopa_v.png"
    try:
        from PIL import Image
    except ImportError:
        for n in (180, 192, 512):
            shutil.copy(src, out / f"icon-{n}.png")
        return
    im = Image.open(src).convert("RGB")
    for n in (180, 192, 512):
        im.resize((n, n), Image.LANCZOS).save(out / f"icon-{n}.png", optimize=True)


def build(out_dir, base=None):
    if base is not None and not (base.startswith("/") and base.endswith("/")):
        raise SystemExit("--base-href starts and ends with /")
    out_dir = Path(out_dir).resolve()
    fl = flutter()
    with tempfile.TemporaryDirectory(prefix="lite-web-") as tmp:
        app = Path(tmp) / "vesopa_epos_lite"
        shutil.copytree(LITE, app, ignore=shutil.ignore_patterns("build", ".dart_tool", ".idea", "*.iml", "android", "ios"))
        pub = app / "pubspec.yaml"
        pub.write_text(pub.read_text(encoding="utf-8").replace(
            "path: ../vesopa_tap", f"path: {(REPO / 'vesopa_tap').as_posix()}"), encoding="utf-8")
        run([fl, "create", "--platforms", "web", "--project-name", "vesopa_epos_lite", "."], app)
        run([fl, "build", "web", "--release", "--no-web-resources-cdn", "--no-wasm-dry-run",
             *(["--base-href", base] if base else []), "--dart-define=LITE_DEMO_ONLY=true"], app)
        web = app / "build" / "web"
        if out_dir.exists():
            shutil.rmtree(out_dir)
        for p in sorted(web.rglob("*")):
            rel = p.relative_to(web).as_posix()
            if p.is_file() and not SKIP.search(rel):
                (out_dir / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(p, out_dir / rel)
    boot = out_dir / "flutter_bootstrap.js"
    js = boot.read_text(encoding="utf-8")
    # Relative: the engine, its renderer and the assets are found next to the page.
    config = "{}" if base else '{config: {entrypointBaseUrl: "./", assetBase: "./", canvasKitBaseUrl: "canvaskit/"}}'
    boot.write_text(js[:js.rindex("_flutter.loader.load(")] + f"_flutter.loader.load({config});\n", encoding="utf-8")
    base_tag = f'  <base href="{base}">\n' if base else ""
    (out_dir / "index.html").write_text(INDEX.format(base_tag=base_tag), encoding="utf-8")
    (out_dir / "manifest.json").write_text(MANIFEST.format(start=base or "./"), encoding="utf-8")
    icons(out_dir)
    # GitHub Pages runs Jekyll unless told not to, and Jekyll drops folders
    # whose names start with "_" or ".".
    (out_dir / ".nojekyll").write_text("")
    print(f"Built {sum(1 for p in out_dir.rglob('*') if p.is_file())} files into {out_dir}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    base = sys.argv[sys.argv.index("--base-href") + 1] if "--base-href" in sys.argv else None
    build(sys.argv[1], base)
