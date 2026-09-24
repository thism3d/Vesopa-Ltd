#!/usr/bin/env python
"""Ask Gemini about a YouTube video by URL (no download needed).

Usage:  python gemini_youtube.py <youtube-url> "<question>" [--model M]

Needs GEMINI_API_KEY in the environment (see .env.claude-tools).
YouTube blocks yt-dlp from this server's IP, but Gemini fetches the
video itself when given the URL as file_data.
"""
import json, os, sys, urllib.request, urllib.error

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

API = "https://generativelanguage.googleapis.com"


def ask(key, model, url, question):
    payload = {
        "contents": [{"parts": [{"file_data": {"file_uri": url}}, {"text": question}]}],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 32768},
    }
    r = urllib.request.Request(
        f"{API}/v1beta/models/{model}:generateContent",
        data=json.dumps(payload).encode(),
        headers={"X-goog-api-key": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(r, timeout=600) as resp:
            out = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code}\n{e.read().decode('utf-8', 'replace')[:4000]}")
    try:
        return "".join(p.get("text", "") for p in out["candidates"][0]["content"]["parts"])
    except (KeyError, IndexError):
        return json.dumps(out, indent=2)[:4000]


def main():
    args = sys.argv[1:]
    model = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
    if "--model" in args:
        i = args.index("--model"); model = args[i + 1]; del args[i:i + 2]
    if len(args) < 2:
        raise SystemExit(__doc__)
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise SystemExit("GEMINI_API_KEY is not set — source .env.claude-tools first")
    print(ask(key, model, args[0], args[1]))


if __name__ == "__main__":
    main()
