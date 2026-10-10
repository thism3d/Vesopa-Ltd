"""Copy the X photos and videos Chrome already holds for a page you have open.

    python PontardaweRFC/website/tool/extract_x_cache.py

Run on the PC with the X page (x.com/PontardaweRFC) already open and scrolled
in Chrome. The page is not reloaded and Chrome is not touched: this reads
Chrome's disk cache and copies only the entries served from twimg.com (X's
image and video hosts). Nothing else in the cache is read past its address.

Output: Documents\\PontardaweRFC-X\\media\\*.jpg|png|webp|mp4 and
Documents\\PontardaweRFC-X\\media.json (file, original address, size).
"""
import json
import os
import pathlib

EOF_MAGIC = bytes.fromhex("d8410d97456ffaf4")  # end of a stream in Chrome's simple cache
OUT = pathlib.Path.home() / "Documents" / "PontardaweRFC-X"
MEDIA = OUT / "media"
MEDIA.mkdir(parents=True, exist_ok=True)
SIGS = [(b"\xff\xd8\xff", ".jpg"), (b"\x89PNG", ".png"), (b"GIF8", ".gif")]

found = []
stats = {"files": 0, "unreadable": 0, "twimg": 0, "no_image": 0}
base = pathlib.Path(os.environ["LOCALAPPDATA"]) / "Google" / "Chrome" / "User Data"
for profile in sorted(p for p in base.iterdir() if (p / "Cache" / "Cache_Data").is_dir()):
    for f in (profile / "Cache" / "Cache_Data").iterdir():
        if not f.name.endswith("_0"):
            continue
        stats["files"] += 1
        try:
            data = f.read_bytes()
        except OSError:
            stats["unreadable"] += 1
            continue
        if len(data) < 24:
            continue
        klen = int.from_bytes(data[12:16], "little")
        if not 0 < klen < 4096:
            # Not the layout expected: find the address by hand.
            m = data.find(b"twimg.com/", 0, 4096)
            if m < 0:
                continue
            klen = data.find(b"\x00", m, 4096) - 24 if data.find(b"\x00", m, 4096) > 0 else m + 200 - 24
        key = data[24:24 + klen].decode("utf-8", "replace")
        if "twimg.com/" not in key:
            continue
        stats["twimg"] += 1
        start = 24 + klen
        end = data.find(EOF_MAGIC, start)
        body = data[start:end if end > 0 else len(data)]
        ext = next((e for sig, e in SIGS if body.startswith(sig)), None)
        if body[:4] == b"RIFF" and body[8:12] == b"WEBP":
            ext = ".webp"
        if body[4:8] == b"ftyp":
            ext = ".mp4"
        if not ext:
            # The body may not start right after the address: look for it.
            for sig, e in SIGS + [(b"RIFF", ".webp")]:
                i = data.find(sig, start, start + 4096)
                if i >= 0:
                    body = data[i:end if end > i else len(data)]
                    ext = e
                    break
        if not ext or len(body) < 2000:
            stats["no_image"] += 1
            continue
        url = key.split(" ")[-1]
        name = f"{profile.name.replace(' ', '')}_{f.name[:16]}{ext}"
        (MEDIA / name).write_bytes(body)
        found.append({"file": name, "url": url, "bytes": len(body)})

(OUT / "media.json").write_text(json.dumps(found, indent=1), encoding="utf-8")
print(f"{len(found)} files in {MEDIA}")
print("cache entries looked at:", stats)
