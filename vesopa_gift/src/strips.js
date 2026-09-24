/**
 * A voucher design as the band across a Wallet pass.
 *
 * Apple wants two PNGs at exact sizes -- 375×123 and 750×246 -- and the back
 * office has no image codec; this one does. The band is cut from the right-hand
 * side of the design, where the picture is (the left third is the calm space
 * the name and value sit on), and kept on disk under uploads/strips so a design
 * is rendered once, however many vouchers wear it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const venues = require('./venues');

const SIZES = [['', 375, 123], ['@2x', 750, 246]];
const inflight = new Map();

function dir() {
  const d = path.join(config.UPLOADS_DIR, 'strips');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function render(design) {
  const sharp = require('sharp');
  const file = venues.designFile(design);
  const source = fs.readFileSync(file);
  const key = crypto.createHash('sha256').update(source).digest('hex').slice(0, 20);
  const out = {};
  for (const [suffix, w, h] of SIZES) {
    const target = path.join(dir(), `${key}${suffix}.png`);
    if (!fs.existsSync(target)) {
      const meta = await sharp(source).metadata();
      const left = Math.round((meta.width || 0) * 0.3);
      const png = await sharp(source)
        .extract({ left, top: 0, width: Math.max(1, (meta.width || 0) - left), height: meta.height || 1 })
        .resize(w, h, { fit: 'cover', position: 'centre' })
        .png({ compressionLevel: 9, palette: true })
        .toBuffer();
      fs.writeFileSync(target, png);
    }
    out[suffix] = fs.readFileSync(target);
  }
  return out;
}

/** { png, png2x } as base64, or null when the design cannot be read. */
async function stripsFor(design) {
  if (!design) return null;
  const k = `${design.office_id}:${design.image}`;
  if (!inflight.has(k)) {
    inflight.set(k, render(design).finally(() => inflight.delete(k)));
  }
  try {
    const pair = await inflight.get(k);
    return { png: pair[''].toString('base64'), png2x: pair['@2x'].toString('base64') };
  } catch (e) {
    console.warn(`[strips] ${k}: ${e.message}`);
    return null;
  }
}

module.exports = { stripsFor };
