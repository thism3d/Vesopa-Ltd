#!/usr/bin/env python3
"""Move the moov atom in front of mdat so clips start playing before they finish
downloading (what ffmpeg calls -movflags +faststart).

Hailuo writes moov last, which forces a browser to fetch the whole file before
the first frame. The clips are lazy-loaded one viewport ahead, so on a fast
connection this is invisible - on 4G it is a visible stall against the brief's
mobile budget.

Moving moov earlier shifts every media chunk later by exactly len(moov), so the
chunk offset tables (stco, 32-bit; co64, 64-bit) must be rewritten to match.
"""
import struct, sys, os, shutil

def atoms(buf):
    off = 0
    while off < len(buf) - 8:
        size, typ = struct.unpack('>I4s', buf[off:off + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack('>Q', buf[off + 8:off + 16])[0]; hdr = 16
        elif size == 0:
            size = len(buf) - off
        if size < hdr:
            raise ValueError(f'bad atom {typ!r} size {size}')
        yield off, size, typ.decode('latin1')
        off += size

def patch_offsets(moov, delta):
    """Add delta to every entry in every stco/co64 inside moov."""
    out = bytearray(moov)
    for tag, fmt, width in ((b'stco', '>I', 4), (b'co64', '>Q', 8)):
        i = 0
        while True:
            i = out.find(tag, i)
            if i < 0:
                break
            # tag is preceded by its 4-byte size; body is version/flags then count
            p = i + 4
            count = struct.unpack('>I', out[p + 4:p + 8])[0]
            base = p + 8
            for n in range(count):
                q = base + n * width
                v = struct.unpack(fmt, out[q:q + width])[0] + delta
                out[q:q + width] = struct.pack(fmt, v)
            i += 4
    return bytes(out)

def faststart(path):
    buf = open(path, 'rb').read()
    tops = list(atoms(buf))
    names = [t[2] for t in tops]
    if 'moov' not in names or 'mdat' not in names:
        return 'no moov/mdat'
    if names.index('moov') < names.index('mdat'):
        return 'already faststart'

    moov_off, moov_size, _ = tops[names.index('moov')]
    moov = buf[moov_off:moov_off + moov_size]
    moov = patch_offsets(moov, moov_size)

    # everything except moov, in original order, with moov reinserted just
    # before the first mdat
    out = bytearray()
    for off, size, typ in tops:
        if typ == 'moov':
            continue
        if typ == 'mdat' and bytes(moov) not in out:
            out += moov
        out += buf[off:off + size]
    open(path, 'wb').write(bytes(out))
    return f'moved moov ({moov_size} bytes) before mdat'

if __name__ == '__main__':
    for p in sys.argv[1:]:
        bak = p + '.orig'
        if not os.path.exists(bak):
            shutil.copy2(p, bak)
        try:
            print(f'{os.path.basename(p):18} {faststart(p)}')
        except Exception as e:
            shutil.copy2(bak, p)
            print(f'{os.path.basename(p):18} FAILED, restored: {e}')
