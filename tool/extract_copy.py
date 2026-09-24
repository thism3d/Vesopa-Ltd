"""Pull the words a human reads out of the back office, for a proof-read.

Only display copy: headings, hints, labels, placeholders, empty states and the
messages the server puts in front of somebody. Nothing that is a key, a URL, a
`data-view` value, an API field name or a permission key — those are compared
against elsewhere and moving one breaks something silently.

    python tool/extract_copy.py > copy.txt
"""
import html
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1] / "vesopa_server"

# Text between tags in index.html, plus the attributes a person reads.
TEXT = re.compile(r">([^<>{}]{12,})<")
ATTRS = re.compile(r'(?:placeholder|title|aria-label)="([^"]{8,})"')

# Single- and double-quoted strings in the JavaScript, long enough to be prose
# and containing a space, which rules out nearly every key and class name.
JS = re.compile(r"""(?<![\w$])'((?:[^'\\\n]|\\.){15,})'|"((?:[^"\\\n]|\\.){15,})\"""")

SKIP = re.compile(
    r"^(?:https?:|/|#|data:|[A-Za-z-]+\s*:\s*[^ ]|\.[a-z-]+ |[a-z-]+=)|"
    r"[{}<>$]|^\s*$|^[A-Z_]+$"
)


def looks_like_prose(text):
    text = text.strip()
    if len(text) < 12 or " " not in text:
        return False
    if SKIP.search(text):
        return False
    # A sentence has letters and at least a couple of words that are not code.
    words = [w for w in re.split(r"[ ]+", text) if w]
    return len(words) >= 3 and sum(c.isalpha() for c in text) > len(text) * 0.6


def main():
    seen = set()
    out = []

    index = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
    for match in TEXT.findall(index) + ATTRS.findall(index):
        text = html.unescape(match).strip()
        if looks_like_prose(text) and text not in seen:
            seen.add(text)
            out.append(("index.html", text))

    for name in ("public/app.js", "src/permissions.js"):
        source = (ROOT / name).read_text(encoding="utf-8")
        # Comments are for us, not for the venue.
        source = re.sub(r"^\s*(?://|\*|/\*).*$", "", source, flags=re.M)
        for a, b in JS.findall(source):
            text = (a or b).replace("\\'", "'").strip()
            if looks_like_prose(text) and text not in seen:
                seen.add(text)
                out.append((name, text))

    for where, text in out:
        print(f"{where}\t{text}")
    print(f"\n{len(out)} strings", file=sys.stderr)


if __name__ == "__main__":
    main()
