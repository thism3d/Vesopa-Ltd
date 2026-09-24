#!/usr/bin/env python
"""Ask Gemini about a video file (picture + audio) via the Files API.

Usage:  python gemini_video.py <video-path> "<question>" [--model M] [--fps N]

Needs GEMINI_API_KEY in the environment (see .env.claude-tools).
"""
import json, mimetypes, os, sys, time, urllib.request, urllib.error

try:                                    # Windows consoles default to cp1252
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

API = "https://generativelanguage.googleapis.com"


def _req(url, data=None, headers=None, method=None):
    r = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        body = e.read()
        raise SystemExit(f"HTTP {e.code} from {url}\n{body.decode('utf-8', 'replace')[:4000]}")


def upload(key, path):
    """Resumable upload; returns the file resource dict once ACTIVE."""
    size = os.path.getsize(path)
    mime = mimetypes.guess_type(path)[0] or "video/mp4"
    status, headers, _ = _req(
        f"{API}/upload/v1beta/files",
        data=json.dumps({"file": {"display_name": os.path.basename(path)}}).encode(),
        headers={
            "X-goog-api-key": key,
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(size),
            "X-Goog-Upload-Header-Content-Type": mime,
            "Content-Type": "application/json",
        },
    )
    up = headers.get("X-Goog-Upload-URL") or headers.get("x-goog-upload-url")
    if not up:
        raise SystemExit("no upload URL returned")
    with open(path, "rb") as fh:
        _, _, body = _req(
            up, data=fh.read(),
            headers={
                "X-goog-api-key": key,
                "Content-Length": str(size),
                "X-Goog-Upload-Offset": "0",
                "X-Goog-Upload-Command": "upload, finalize",
            },
        )
    f = json.loads(body)["file"]
    for _ in range(120):                       # wait for PROCESSING -> ACTIVE
        if f.get("state") == "ACTIVE":
            return f
        if f.get("state") == "FAILED":
            raise SystemExit(f"Gemini failed to process the video: {f}")
        time.sleep(3)
        _, _, body = _req(f"{API}/v1beta/{f['name']}", headers={"X-goog-api-key": key})
        f = json.loads(body)
    raise SystemExit("timed out waiting for the video to become ACTIVE")


def ask(key, model, f, question, fps=None):
    part = {"file_data": {"mime_type": f["mimeType"], "file_uri": f["uri"]}}
    if fps:
        part["video_metadata"] = {"fps": fps}
    payload = {
        "contents": [{"parts": [part, {"text": question}]}],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 16384},
    }
    _, _, body = _req(
        f"{API}/v1beta/models/{model}:generateContent",
        data=json.dumps(payload).encode(),
        headers={"X-goog-api-key": key, "Content-Type": "application/json"},
    )
    out = json.loads(body)
    try:
        cand = out["candidates"][0]
        return "".join(p.get("text", "") for p in cand["content"]["parts"])
    except (KeyError, IndexError):
        return json.dumps(out, indent=2)[:4000]


def main():
    args = [a for a in sys.argv[1:]]
    model = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
    fps = None
    for flag, cast in (("--model", str), ("--fps", float)):
        if flag in args:
            i = args.index(flag)
            val = cast(args[i + 1])
            del args[i:i + 2]
            if flag == "--model":
                model = val
            else:
                fps = val
    if len(args) < 2:
        raise SystemExit(__doc__)
    path, question = args[0], args[1]
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise SystemExit("GEMINI_API_KEY is not set — source .env.claude-tools first")
    print(ask(key, model, upload(key, path), question, fps))


if __name__ == "__main__":
    main()
