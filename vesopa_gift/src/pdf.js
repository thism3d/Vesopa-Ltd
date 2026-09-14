/**
 * Paper: the printable voucher, and tickets.
 *
 * A4 for a voucher, because that is what is in every printer in the country and
 * a voucher is often handed over in a card. A5 per ticket, because a ticket is
 * shown at a door and a full sheet folded in four is a nuisance in a pocket.
 *
 * Light on ink on purpose. The only flood of colour on the voucher is the
 * picture the buyer chose; everything else is black on white.
 *
 * The QR code is drawn as squares, not placed as an image, so it prints sharp at
 * any size and a scanner at a till reads it off cheap paper.
 */

const fs = require('fs');
const PDFDocument = require('pdfkit');
const { qrMatrix } = require('./png');
const { money, when, dateLong } = require('./util');

function collect(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function drawQr(doc, text, x, y, size) {
  const m = qrMatrix(text);
  const n = m.length;
  const quiet = 2;
  const cell = size / (n + quiet * 2);
  doc.save();
  doc.rect(x, y, size, size).fill('#ffffff');
  doc.fillColor('#111111');
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) doc.rect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell + 0.2, cell + 0.2);
    }
  }
  doc.fill();
  doc.restore();
}

/** An image file pdfkit can place: JPEG or PNG, read from disk. */
function readImage(path) {
  try {
    const buf = fs.readFileSync(path);
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const png = buf[0] === 0x89 && buf[1] === 0x50;
    return jpeg || png ? buf : null;
  } catch {
    return null;
  }
}

function hexOk(h) {
  return /^#[0-9a-f]{6}$/i.test(String(h || '')) ? h : '#1f2a24';
}

/**
 * The voucher, A4.
 *
 * `art` is the design's picture as a Buffer (or null, in which case a plain
 * band in the venue's colour stands in for it).
 */
async function voucherPdf({ brand, order, line, art, balanceUrl }) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `${brand.name} gift voucher`, Author: brand.name } });
  const done = collect(doc);
  const W = 595.28;
  const M = 48;
  const inner = W - M * 2;

  doc.font('Times-Roman').fontSize(22).fillColor('#14161a').text(brand.name, M, 52, { width: inner, align: 'center' });

  // The picture, with rounded corners.
  const artY = 96;
  const artH = Math.round(inner * 0.63);
  doc.save();
  doc.roundedRect(M, artY, inner, artH, 16).clip();
  if (art) {
    doc.image(art, M, artY, { cover: [inner, artH], align: 'center', valign: 'center' });
  } else {
    doc.rect(M, artY, inner, artH).fill(hexOk(brand.primary));
  }
  doc.restore();

  // The plate on the picture: what it is and what it is worth.
  const plateW = 230;
  const plateH = 92;
  const px = M + 22;
  const py = artY + artH - plateH - 22;
  doc.save();
  doc.roundedRect(px, py, plateW, plateH, 12).fillOpacity(0.92).fill('#ffffff');
  doc.restore();
  const caption = line.kind === 'experience' ? line.label : 'Gift voucher';
  doc.font('Helvetica').fontSize(9).fillColor('#3b3f45')
    .text(caption.toUpperCase(), px + 16, py + 14, { width: plateW - 32, characterSpacing: 1.2, lineBreak: false, ellipsis: true });
  doc.font('Times-Roman').fontSize(46).fillColor('#14161a').text(money(line.unit_minor), px + 14, py + 30, { width: plateW - 28, lineBreak: false });

  // Who it is for.
  let y = artY + artH + 30;
  const forLine = line.recipient_name
    ? `For ${line.recipient_name}, from ${order.buyer_name.split(' ')[0]}`
    : `From ${brand.name}`;
  doc.font('Times-Roman').fontSize(20).fillColor('#14161a').text(forLine, M, y, { width: inner, align: 'center' });
  y = doc.y + 8;
  if (line.message) {
    doc.font('Times-Italic').fontSize(15).fillColor('#3a3f45').text(`“${line.message}”`, M + 40, y, { width: inner - 80, align: 'center' });
    y = doc.y + 6;
  }

  // The code.
  const boxY = Math.max(y + 18, 560);
  const boxH = 150;
  doc.roundedRect(M, boxY, inner, boxH, 14).lineWidth(1.2).strokeColor('#e6e8e3').stroke();
  drawQr(doc, line.card_code, M + 16, boxY + 13, 124);
  const tx = M + 160;
  doc.font('Helvetica').fontSize(11).fillColor('#63696f').text('Voucher code', tx, boxY + 26);
  doc.font('Courier-Bold').fontSize(24).fillColor('#111111').text(line.card_code, tx, boxY + 44, { characterSpacing: 2 });
  if (line.expires_on) {
    doc.font('Helvetica').fontSize(12).fillColor('#111111').text(`Valid until ${dateLong(line.expires_on)}`, tx, boxY + 80);
  }
  doc.font('Helvetica').fontSize(10.5).fillColor('#63696f')
    .text(line.kind === 'experience' ? 'Show this at the till.' : 'Show this at the till. Spend it all at once or a bit at a time.', tx, boxY + 100, { width: inner - 175 });
  if (line.usable_from && new Date(line.usable_from) > new Date()) {
    doc.font('Helvetica').fontSize(10.5).fillColor('#b06d00').text(`Can be spent from ${when(line.usable_from)}.`, tx, boxY + 124);
  }

  // The small print, at the foot of the page.
  const footY = 770;
  doc.font('Helvetica').fontSize(9).fillColor('#63696f').text(
    `Can be used for food and drink at ${brand.name}. Not exchangeable for cash. Treat it like cash: anybody with the code can spend it. Balance and terms: ${balanceUrl.replace(/^https?:\/\//, '')}`,
    M, footY, { width: inner }
  );
  doc.font('Helvetica').fontSize(9).fillColor('#9aa0a6').text(brand.address || '', M, 810, { width: inner / 2 });
  doc.font('Helvetica').fontSize(9).fillColor('#9aa0a6').text('Powered by Vesopa', M + inner / 2, 810, { width: inner / 2, align: 'right' });

  doc.end();
  return done;
}

/** Tickets, one A5 page each. */
async function ticketsPdf({ brand, event, tickets, typesById, holder }) {
  const doc = new PDFDocument({ size: 'A5', margin: 0, autoFirstPage: false, info: { Title: `${event.title} tickets`, Author: brand.name } });
  const done = collect(doc);
  const W = 419.53;
  const M = 32;
  const inner = W - M * 2;
  const primary = hexOk(brand.primary);
  const ink = require('./util').onColour(primary);

  tickets.forEach((t, i) => {
    doc.addPage();
    doc.rect(0, 0, W, 64).fill(primary);
    doc.font('Times-Roman').fontSize(17).fillColor(ink).text(brand.name, M, 24, { width: inner });

    doc.font('Times-Roman').fontSize(24).fillColor('#14161a').text(event.title, M, 88, { width: inner });
    let y = doc.y + 10;
    const rows = [
      ['Date', when(event.starts_at)],
      ...(event.doors_at ? [['Doors', when(event.doors_at).split(', ').pop()]] : []),
      ...(event.location ? [['Where', event.location]] : []),
      ['Ticket', (typesById[t.ticket_type_id] || {}).name || 'Ticket'],
      ['Name', holder],
    ];
    for (const [k, v] of rows) {
      doc.font('Helvetica').fontSize(8.5).fillColor('#63696f').text(k.toUpperCase(), M, y, { characterSpacing: 1 });
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#14161a').text(v, M + 70, y - 2, { width: inner - 70 });
      y = Math.max(doc.y, y + 14) + 6;
    }

    // Perforation, then the code.
    y += 10;
    doc.save();
    doc.moveTo(M, y).lineTo(W - M, y).dash(4, { space: 4 }).lineWidth(1).strokeColor('#d5d8d1').stroke();
    doc.restore();
    const q = 190;
    drawQr(doc, t.code, (W - q) / 2, y + 20, q);
    doc.font('Courier-Bold').fontSize(20).fillColor('#111111').text(t.code, M, y + q + 30, { width: inner, align: 'center', characterSpacing: 2 });
    doc.font('Helvetica').fontSize(10).fillColor('#63696f').text(`Ticket ${i + 1} of ${tickets.length} · lets one person in, once`, M, y + q + 58, { width: inner, align: 'center' });
    doc.font('Helvetica').fontSize(8.5).fillColor('#9aa0a6').text('Powered by Vesopa', M, 565, { width: inner, align: 'center' });
  });

  doc.end();
  return done;
}

module.exports = { voucherPdf, ticketsPdf, readImage };
