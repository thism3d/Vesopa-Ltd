"""Ask Vesopa AI about one domain, then another, and check it changes.

    python tool/cloud_ai_domain_switch_test.py

WHAT THE OWNER REPORTED (2026-09-17): "I've searched a domain and it every
time showing me that domain although I'm asking to change the domain search."

This holds a real conversation with the live assistant -- the same POST
/ai/turn the widget makes, carrying the same page snapshot and the running
history -- and asks for three different names in a row. Each answer must name
the domain that was just asked for, and must not fall back to the first.

The reply is kept in Documents/Vesopa-Claude-Images so the wording can be read
afterwards, not just the pass or fail.
"""

import datetime
import json
import pathlib
import sys

import requests

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://cloud.vesopa.com").rstrip("/")
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images"
STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")

ASKS = [
    ("rahimstore.co.uk", "Is rahimstore.co.uk available?"),
    ("vesopakitchen.co.uk", "Now check vesopakitchen.co.uk instead."),
    ("dhakaspice.co.uk", "What about dhakaspice.co.uk?"),
]

PAGE = {
    "url": "/domains",
    "title": "Domain names",
    "headings": ["Find your domain"],
    "text": "Search and register a domain with Vesopa.",
    "elements": [{"ref": "e1", "kind": "text", "name": "q", "label": "Search a domain", "value": ""}],
}


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 (VesopaAI domain switch test)"
    sess = s.get(f"{BASE}/ai/session", timeout=30).json()
    token = sess["token"]
    csrf = s.cookies.get("vh_csrf") or ""

    history = []
    rows = []
    ok = True
    for wanted, text in ASKS:
        res = s.post(
            f"{BASE}/ai/turn",
            json={
                "text": text,
                "lang": "en",
                "voice": False,
                "page": PAGE,
                "local": {"memory": [], "history": history[-24:]},
            },
            headers={"X-CSRF-Token": csrf, "X-AI-Token": token, "Referer": BASE + "/domains", "Origin": BASE},
            timeout=120,
        )
        data = res.json() if res.status_code == 200 else {"error": res.text[:200]}
        say = data.get("say") or ""
        actions = data.get("actions") or []
        history.append({"role": "user", "content": text})
        if say:
            history.append({"role": "assistant", "content": say})

        # The name it actually talked about: the one it says, and the one any
        # basket or search link carries.
        others = [w for w, _ in ASKS if w != wanted]
        stale = [w for w in others if w in say or any(w in json.dumps(a) for a in actions)]
        named = wanted in say or any(wanted in json.dumps(a) for a in actions)
        rows.append({
            "asked": wanted,
            "status": res.status_code,
            "names_the_new_one": named,
            "names_an_older_one": stale,
            "say": say,
            "actions": actions,
        })
        if not named or stale:
            ok = False
        print(f"{wanted}: named={named} stale={stale}")

    out = SHOTS / f"ai-domain-switch-{STAMP}.json"
    out.write_text(json.dumps({"base": BASE, "pass": ok, "turns": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    print("PASS" if ok else "FAIL", "->", out)


if __name__ == "__main__":
    main()
