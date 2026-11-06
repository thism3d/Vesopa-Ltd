"""go.vesopa.com polish (2026-11-06): the home page with css/premium.css and
js/premium.js: the headline rising line by line, a slow glow, the devices row,
the features as a bento of tiles with line icons and small live pictures, and
the scroll story's step count and dots.

    python vesopa_go/tool/go_site_polish.py preview   # web/site/preview/a (dark) and /b (with cream sections), not indexed
    python vesopa_go/tool/go_site_polish.py apply a   # the chosen one becomes the home page

Reads web/site/index.html as it is; the previews are copies, so the live page
does not change until `apply`.
"""
import pathlib
import sys

SITE = pathlib.Path(__file__).resolve().parents[1] / "web" / "site"

ICON = {  # simple line icons, 24 grid, stroke only
    "screens": '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/>'
               '<rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
    "tables": '<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5"/>',
    "loyalty": '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
    "shield": '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z"/><path d="M8.8 12.2l2.2 2.2 4.4-4.6"/>',
    "share": '<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>',
    "offline": '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.2 4.7 4.7 0 0 0 7 18.5z"/><path d="M12 9.5v4.5M12 16.8v.2"/>',
    "phone": '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    "tablet": '<rect x="3.5" y="3" width="17" height="18" rx="2.5"/><path d="M11 18h2"/>',
}


def svg(name):
    return f'<svg viewBox="0 0 24 24" aria-hidden="true">{ICON[name]}</svg>'


BENTO = f'''      <div class="bento">
        <article class="tile wide reveal"><div class="ic">{svg("screens")}</div><h3>The till's own screens</h3><p>The buttons, colours and pages you programmed for the till, on iPhone, iPad and Android. Managers arrange them for each kind of device.</p><div class="mini keys" aria-hidden="true"></div></article>
        <article class="tile reveal"><div class="ic">{svg("tables")}</div><h3>Tables and the kitchen</h3><p>The floor plan as you drew it. Seat a table, send courses, hold the mains and fire them when it's time.</p><div class="mini floor" aria-hidden="true"></div></article>
        <article class="tile reveal"><div class="ic">{svg("loyalty")}</div><h3>Customers and loyalty</h3><p>Find a member, add their points and discount, sell memberships and tickets, check them in at the gate.</p></article>
        <article class="tile reveal"><div class="ic">{svg("shield")}</div><h3>The same permissions</h3><p>Staff sign on with their PIN, card or face. Voids, refunds and the drawer follow each person's permissions.</p></article>
        <article class="tile reveal"><div class="ic">{svg("share")}</div><h3>Shared bills in an instant</h3><p>Open bills move between Go and the tills straight away, over the venue's own network.</p></article>
        <article class="tile full reveal"><div><div class="ic">{svg("offline")}</div><h3>Keeps working offline</h3><p>Orders wait safely on the device when the internet drops, and go to the back office in order when it is back.</p></div>
          <div class="signal" aria-hidden="true"><span class="label">Online · sent</span><span class="wire"></span><span class="dot a"></span><span class="dot b"></span><span class="q"><i></i><i></i><i></i></span></div></article>
      </div>'''


def polish(html, theme):
    def rep(old, new):
        nonlocal html
        assert html.count(old) == 1, old[:70]
        html = html.replace(old, new)

    # one grid of feature cards becomes the bento
    a = html.index('      <div class="grid">')
    b = html.index("      </div>\n    </div>\n  </section>", a) + len("      </div>")
    html = html[:a] + BENTO + html[b:]
    rep('<link rel="stylesheet" href="/style.css?v=6">',
        '<link rel="stylesheet" href="/style.css?v=6">\n<link rel="stylesheet" href="/css/premium.css?v=4">')
    rep('<body>', f'<body{" class=\"theme-mix\"" if theme == "b" else ""}>\n<div class="progress" aria-hidden="true"></div>')
    rep('<canvas id="stage" aria-hidden="true"></canvas>', '<canvas id="stage" aria-hidden="true"></canvas>\n    <div class="aura" aria-hidden="true"></div>')
    rep('<p class="eyebrow"><span class="pulse"></span>', '<p class="eyebrow pill"><span class="pulse"></span>')
    rep('<h1>The till,<br><em>in your hand.</em></h1>',
        '<h1><span class="ln"><span>The till,</span></span><span class="ln"><em>in your hand.</em></span></h1>')
    rep('''      <p class="fine">For venues on Vesopa EPOS.''',
        f'''      <ul class="devices-row"><li>{svg("phone")}iPhone</li><li>{svg("tablet")}iPad</li><li>{svg("phone")}Android</li><li>{svg("share")}Same back office as your tills</li></ul>
      <p class="fine">For venues on Vesopa EPOS.''')
    rep('      <div class="steps-phone" aria-hidden="true">',
        '      <div class="steps-phone" aria-hidden="true">\n        <div class="glow"></div>\n        <p class="count">Step <b>1</b> of 5</p>')
    rep('        <div class="steps-bar"><i></i></div>', '        <div class="steps-bar"><i></i></div>\n        <div class="dots"></div>')
    rep('<script src="/js/go.js?v=6" defer></script>',
        '<script src="/js/go.js?v=7" defer></script>\n<script src="/js/premium.js?v=3" defer></script>\n<script src="/js/sound.js?v=2" defer></script>')
    # the Sound button, beside "Get the app"
    rep('    <a class="btn small primary" href="#get">Get the app</a>',
        '    <button class="sound-btn" type="button" aria-pressed="false" title="Sound"><i aria-hidden="true"><b></b><b></b><b></b></i><span>Sound</span></button>\n'
        '    <a class="btn small primary" href="#get">Get the app</a>')
    # the phone zooming in from the top, with its closing line
    rep('<html lang="en-GB">', '<html lang="en-GB" class="zoom-hero">')
    rep('    <a class="scroll-cue" href="#film"',
        '    <p class="zoom-caption" aria-hidden="true">Every sale, <em>in your hand.</em><small>Seat it, send it, take the payment. All on one phone.</small></p>\n'
        '    <a class="scroll-cue" href="#film"')
    # the live strip, between the scroll story and the features
    rep('  <section class="features" id="features">',
        '  <section class="live" id="live" aria-label="A night on Vesopa Go">\n'
        '    <div class="wrap"><div class="section-head reveal"><p class="eyebrow">A night on Vesopa Go</p>'
        '<h2>Every table, <em>paid as it goes.</em></h2></div></div>\n'
        '    <div class="lane" aria-hidden="true"><div class="row"></div><div class="row"></div></div>\n'
        '  </section>\n\n'
        '  <section class="features" id="features">')
    return html


def main():
    src = (SITE / "index.html").read_text(encoding="utf-8")
    if "premium.css" in src:
        sys.exit("index.html already has the polish")
    if sys.argv[1:2] == ["preview"]:
        for theme in ("a",):
            out = SITE / "preview" / theme / "index.html"
            out.parent.mkdir(parents=True, exist_ok=True)
            page = polish(src, theme).replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="robots" content="noindex, nofollow">')
            out.write_text(page, encoding="utf-8", newline="\n")
            print(out.relative_to(SITE))
    elif sys.argv[1:2] == ["apply"]:
        theme = sys.argv[2]
        (SITE / "index.html").write_text(polish(src, theme), encoding="utf-8", newline="\n")
        print("index.html polished, option", theme)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
