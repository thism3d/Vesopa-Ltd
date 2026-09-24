/* Listing the contents of a .zip without unpacking it, and without a dependency.
 *
 * A zip's index lives in the "central directory" at the end of the file, so a
 * listing only needs the tail — we never inflate a byte of the payload, which
 * is what makes previewing a 25MB archive cheap and safe. Nothing here writes
 * to disk or executes anything from the archive.
 *
 * Layout, per PKWARE APPNOTE:
 *   [ local headers + file data ... ][ central directory ][ EOCD ]
 * EOCD signature 0x06054b50 holds the offset and count of the central
 * directory; each central-directory entry is signature 0x02014b50.
 */
import fs from "node:fs/promises";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const EOCD_MIN = 22;               // EOCD with an empty comment
const MAX_COMMENT = 0xffff;

export async function listZip(filePath, { max = 500 } = {}) {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size < EOCD_MIN) return { ok: false, error: "Not a zip file." };

    // The EOCD sits at the end, after a comment of unknown length, so scan
    // backwards over the largest region it could occupy.
    const tailLen = Math.min(size, EOCD_MIN + MAX_COMMENT);
    const tail = Buffer.alloc(tailLen);
    await handle.read(tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) return { ok: false, error: "No zip index found — the file may be corrupt or split." };

    const entryCount = tail.readUInt16LE(eocd + 10);
    const cenSize = tail.readUInt32LE(eocd + 12);
    const cenOffset = tail.readUInt32LE(eocd + 16);

    // Zip64 marks these fields as 0xffff/0xffffffff and puts the real values in
    // its own record. Rather than half-support it, say so plainly.
    if (cenOffset === 0xffffffff || entryCount === 0xffff) {
      return { ok: false, error: "Zip64 archive — too large to preview here." };
    }
    if (cenOffset + cenSize > size) return { ok: false, error: "Zip index is out of bounds." };

    const cen = Buffer.alloc(cenSize);
    await handle.read(cen, 0, cenSize, cenOffset);

    const entries = [];
    let off = 0;
    let truncated = false;

    while (off + 46 <= cen.length && entries.length < max) {
      if (cen.readUInt32LE(off) !== CEN_SIG) break;
      const nameLen = cen.readUInt16LE(off + 28);
      const extraLen = cen.readUInt16LE(off + 30);
      const commentLen = cen.readUInt16LE(off + 32);
      const compressed = cen.readUInt32LE(off + 20);
      const uncompressed = cen.readUInt32LE(off + 24);
      const dosTime = cen.readUInt16LE(off + 12);
      const dosDate = cen.readUInt16LE(off + 14);
      const name = cen.toString("utf8", off + 46, off + 46 + nameLen);

      entries.push({
        name,
        directory: name.endsWith("/"),
        size: uncompressed,
        compressed,
        modified: dosToDate(dosDate, dosTime),
      });
      off += 46 + nameLen + extraLen + commentLen;
    }
    if (entries.length >= max && entryCount > max) truncated = true;

    const totalBytes = entries.reduce((s, e) => s + e.size, 0);
    return { ok: true, entries, count: entryCount, truncated, totalBytes };
  } catch (err) {
    return { ok: false, error: `Could not read that archive: ${err.message}` };
  } finally {
    await handle.close();
  }
}

/** MS-DOS packed date/time — the only timestamp a basic zip entry carries. */
function dosToDate(date, time) {
  if (!date) return null;
  const d = new Date(
    1980 + ((date >> 9) & 0x7f), ((date >> 5) & 0x0f) - 1, date & 0x1f,
    (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2,
  );
  return Number.isNaN(d.getTime()) ? null : d;
}
