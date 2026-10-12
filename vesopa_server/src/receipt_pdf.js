/**
 * One receipt as a real PDF file, for the back office's receipt viewer.
 *
 * "Receipt PDFs can't be viewed or opened on a computer." The viewer's only
 * way out was the browser's print dialog, which leaves "Save as PDF" to the
 * browser, prints the whole page wherever the print rule misses, and on some
 * machines gives nothing that opens at all. This is a file: the viewer fetches
 * it and opens it in a new tab, or saves it, and any PDF reader opens it.
 *
 * Drawn at roll width (80mm) and as tall as it needs to be, like the till's
 * own receipt, so a reprint looks like the slip the customer was given. Marked
 * COPY, and carries the refund history, so it cannot pass for a second sale.
 */
const PDFDocument = require('pdfkit');

const MM = 72 / 25.4;
const WIDTH = 80 * MM;
const MARGIN = 4 * MM;

const money = (minor) => {
  const n = Number(minor) || 0;
  const sign = n < 0 ? '-' : '';
  return `${sign}£${(Math.abs(n) / 100).toFixed(2)}`;
};

const fmt = (d) => {
  if (!d) return '';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return String(d);
  return t.toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const METHOD = { cash: 'Cash', card: 'Card', giftcard: 'Gift card', voucher: 'Voucher', account: 'Account' };
const methodName = (p) => {
  const base = METHOD[String(p.method || '').toLowerCase()] || p.method || 'Payment';
  return p.reference && String(p.reference).startsWith('pi_') ? `${base} (Dojo)` : base;
};

const STATUS = { paid: 'PAID', part_refunded: 'PART REFUNDED', refunded: 'REFUNDED' };

/**
 * @param {{order, lines, payments, status}} r   as GET /api/receipts/:id sends it
 * @param {string} venue
 * @returns {Promise<Buffer>}
 */
function receiptPdf(r, venue) {
  const { order, lines = [], payments = [], status } = r;
  const inner = WIDTH - MARGIN * 2;

  // Two passes: measure the height on a throwaway document, then draw on a page
  // exactly that tall. A fixed A4 page would put a ten-line receipt at the top
  // of a mostly blank sheet; a fixed short one would cut a long bill off.
  const draw = (doc, measuring) => {
    let y = MARGIN;
    const text = (s, opts = {}) => {
      const o = { width: inner, ...opts };
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 8.5);
      const h = doc.heightOfString(String(s), o);
      if (!measuring) doc.fillColor(opts.color || '#000').text(String(s), MARGIN, y, o);
      y += h + (opts.gap ?? 1.5);
    };
    const row = (left, right, opts = {}) => {
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 8.5);
      const rw = doc.widthOfString(String(right)) + 2;
      const lw = inner - rw - 6;
      const h = Math.max(doc.heightOfString(String(left), { width: lw }), doc.currentLineHeight());
      if (!measuring) {
        doc.fillColor(opts.color || '#000');
        doc.text(String(left), MARGIN, y, { width: lw });
        doc.text(String(right), MARGIN + inner - rw, y, { width: rw, align: 'right' });
      }
      y += h + 1.5;
    };
    const rule = () => {
      if (!measuring) {
        doc.moveTo(MARGIN, y + 2).lineTo(MARGIN + inner, y + 2).dash(1.5, { space: 1.5 })
          .strokeColor('#777').lineWidth(0.5).stroke().undash();
      }
      y += 6;
    };

    text(venue || 'Vesopa EPOS', { bold: true, size: 11, align: 'center' });
    text('COPY RECEIPT', { size: 7.5, align: 'center', color: '#555' });
    text(fmt(order.closed_at), { size: 8, align: 'center' });
    text(
      `Receipt ${String(order.id).slice(0, 8)}${order.table_number ? ` · Table ${order.table_number}` : ''}`,
      { size: 8, align: 'center', gap: 4 }
    );
    rule();

    for (const l of lines) {
      const q = Number(l.quantity) || 1;
      const name = `${Number(l.is_modifier) ? '   ' : ''}${q === 1 ? '' : `${q % 1 ? q.toFixed(2) : q} × `}${l.name}`;
      row(name, money(Math.round((Number(l.unit_price_minor) || 0) * q)));
      if (l.note) text(`   ${l.note}`, { size: 7.5, color: '#444' });
    }
    rule();
    if (order.subtotal_minor != null) row('Subtotal', money(order.subtotal_minor));
    if (Number(order.discount_minor)) row('Discount', money(-order.discount_minor));
    if (order.tax_minor != null) row('VAT included', money(order.tax_minor));
    row('TOTAL', money(order.total_minor), { bold: true, size: 10.5 });
    rule();
    for (const p of payments) row(methodName(p), money(p.amount_minor));

    if (status) {
      rule();
      text(STATUS[status.status] || 'PAID', {
        bold: true,
        size: 10,
        align: 'center',
        color: status.status === 'paid' ? '#0a7d33' : '#b3261e',
      });
      for (const f of status.refunds || []) {
        row(`Refund ${fmt(f.at)}${f.staff_name ? ` · ${f.staff_name}` : ''}`, money(-f.amount_minor), { color: '#b3261e' });
        if (f.reason) text(`   ${f.reason}`, { size: 7.5, color: '#444' });
      }
      if (!(status.refunds || []).length && status.refunded_minor > 0) {
        row('Refunded to card (Dojo)', money(-status.refunded_minor), { color: '#b3261e' });
      }
    }
    y += 6;
    text('Thank you', { size: 8, align: 'center' });
    return y + MARGIN;
  };

  const probe = new PDFDocument({ size: [WIDTH, 2000], margin: 0, autoFirstPage: true });
  const height = Math.ceil(draw(probe, true));
  probe.end();

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [WIDTH, Math.max(height, 120)],
      margin: 0,
      info: { Title: `Receipt ${String(order.id).slice(0, 8)}`, Author: venue || 'Vesopa EPOS', Creator: 'Vesopa EPOS' },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    draw(doc, false);
    doc.end();
  });
}

module.exports = { receiptPdf, money };
