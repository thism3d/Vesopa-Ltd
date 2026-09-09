"""Generate an image with Gemini and save it into the repository.

    python tool/gemini_image.py <name> "<prompt>" [--out DIR] [--model M]

Reads GEMINI_API_KEY from `.env.claude-tools`, which is gitignored.

WHY THE IMAGES ARE GENERATED AND THEN STORED, rather than fetched at render
time: the Content-Security-Policy on auth.vesopa.com is `img-src 'self' data:`,
and the sign-in domain is the last place to make an exception. Every picture the
landing page shows is served from this origin, so nothing tells a third party
when somebody is looking at a Vesopa page.

It costs money per image, so it writes NOTHING if a file of that name already
exists unless --force is given. Re-running the landing page build should not
quietly spend credit.
"""

import base64
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "vesopa_auth" / "public" / "brand" / "art"
DEFAULT_MODEL = "gemini-3-pro-image"


def key():
    text = (ROOT / ".env.claude-tools").read_text(encoding="utf-8", errors="replace")
    for line in text.splitlines():
        m = re.match(r"^GEMINI_API_KEY=(.*)$", line.strip())
        if m:
            return m.group(1).strip().strip('"').strip("'")
    raise SystemExit("GEMINI_API_KEY not found in .env.claude-tools")


def generate(prompt, model, api_key):
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={api_key}"
    )
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        # Ask for an image back. Without this the model answers with prose
        # describing the picture it would have drawn, which is a confusing
        # thing to receive and easy to mistake for a failure.
        "generationConfig": {"responseModalities": ["IMAGE"]},
    }).encode("utf-8")

    request = urllib.request.Request(
        url, data=body, headers={"content-type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:400]
        raise SystemExit(f"gemini {error.code}: {detail}")

    for candidate in data.get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"]), inline.get("mimeType", "image/png")

    raise SystemExit(f"no image came back: {json.dumps(data)[:400]}")


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        raise SystemExit(__doc__)

    name, prompt = args[0], args[1]
    out_dir = DEFAULT_OUT
    model = DEFAULT_MODEL
    if "--out" in args:
        out_dir = pathlib.Path(args[args.index("--out") + 1])
    if "--model" in args:
        model = args[args.index("--model") + 1]
    force = "--force" in args

    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{name}.png"
    if target.exists() and not force:
        print(f"  = {target.name} already there ({target.stat().st_size // 1024} KB) — not regenerating")
        return

    blob, mime = generate(prompt, model, key())
    if "png" not in mime and "jpeg" in mime:
        target = out_dir / f"{name}.jpg"
    target.write_bytes(blob)
    print(f"  + {target.name}  {len(blob) // 1024} KB  ({mime})")


if __name__ == "__main__":
    main()
