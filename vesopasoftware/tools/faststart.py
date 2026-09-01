#!/usr/bin/env python3
"""Move an MP4's `moov` index in front of its media, losslessly.

This is what `ffmpeg -movflags +faststart` does, and nothing else: no decode,
no re-encode, not one pixel touched. It exists as its own tool because the
site's clips were produced without it and re-encoding them to fix a byte
ordering problem would cost quality for no reason.

Why it matters: a player cannot begin playback until it has read `moov`, the
table of where every frame lives. With `moov` written after `mdat` — which is
what most encoders do by default, because the table is only complete once the
media is — a browser must either download the entire file first or issue a
speculative range request for the tail. On a phone on a slow line the first is
what happens, and the clip appears never to load at all.

Moving the box means every absolute file offset recorded inside it is now
wrong by exactly the length of the box that jumped the queue, so the chunk
offset tables (`stco`, or `co64` for files over 4GB) are rewritten to match.
That is the entire operation, and it is why this can be trusted: the media
bytes are copied through verbatim.
"""

import struct
import sys
import shutil
from pathlib import Path

CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"udta"}


def walk(buf, start, end):
    """Yield (type, header_end, box_end) for each box in [start, end)."""
    pos = start
    while pos + 8 <= end:
        size, typ = struct.unpack_from(">I4s", buf, pos)
        head = 8
        if size == 1:                      # 64-bit extended size
            size = struct.unpack_from(">Q", buf, pos + 8)[0]
            head = 16
        elif size == 0:                    # runs to end of file
            size = end - pos
        if size < head or pos + size > end:
            raise ValueError(f"malformed box {typ!r} at {pos}")
        yield typ, pos + head, pos + size
        pos += size


def shift_offsets(moov, delta):
    """Add `delta` to every chunk offset in a moov buffer, in place."""
    patched = 0

    def recurse(start, end):
        nonlocal patched
        for typ, body, box_end in walk(moov, start, end):
            if typ in CONTAINERS:
                recurse(body, box_end)
            elif typ == b"stco":
                n = struct.unpack_from(">I", moov, body + 4)[0]
                for i in range(n):
                    at = body + 8 + i * 4
                    v = struct.unpack_from(">I", moov, at)[0] + delta
                    if v >= 1 << 32:
                        raise ValueError("offset overflows 32 bits; needs co64")
                    struct.pack_into(">I", moov, at, v)
                patched += n
            elif typ == b"co64":
                n = struct.unpack_from(">I", moov, body + 4)[0]
                for i in range(n):
                    at = body + 8 + i * 8
                    v = struct.unpack_from(">Q", moov, at)[0] + delta
                    struct.pack_into(">Q", moov, at, v)
                patched += n

    recurse(0, len(moov))
    return patched


def faststart(path: Path):
    raw = path.read_bytes()
    tops = [(t, b, e) for t, b, e in walk(raw, 0, len(raw))]
    names = [t for t, _, _ in tops]

    if b"moov" not in names or b"mdat" not in names:
        return "skipped (no moov/mdat)"
    if names.index(b"moov") < names.index(b"mdat"):
        return "already faststart"

    moov_i = names.index(b"moov")
    mdat_i = names.index(b"mdat")
    moov = bytearray(raw[_box_start(tops, moov_i):tops[moov_i][2]])

    # moov jumps in front of mdat, so every byte from mdat onward moves down
    # by exactly the length of moov. Chunk offsets point into mdat.
    n = shift_offsets(moov, len(moov))

    out = bytearray()
    for i, (typ, _, box_end) in enumerate(tops):
        if i == moov_i:
            continue                        # dropped from its old position
        if i == mdat_i:
            out += moov                     # ...and reinserted here
        out += raw[_box_start(tops, i):box_end]

    assert len(out) == len(raw), "length changed; refusing to write"
    backup = path.with_suffix(path.suffix + ".orig")
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_bytes(bytes(out))
    return f"moved moov to front ({n} chunk offsets rewritten)"


def _box_start(tops, i):
    """The byte the i'th top-level box starts at, header included."""
    return 0 if i == 0 else tops[i - 1][2]


if __name__ == "__main__":
    files = [Path(a) for a in sys.argv[1:]]
    if not files:
        sys.exit("usage: faststart.py FILE.mp4 [FILE.mp4 ...]")
    for f in sorted(files):
        try:
            print(f"{f.name:24} {faststart(f)}")
        except Exception as e:                       # noqa: BLE001
            print(f"{f.name:24} FAILED: {e}")
