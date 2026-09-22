/**
 * Invoices — the document that proves what somebody bought.
 *
 * ---------------------------------------------------------------------------
 * AN INVOICE IS NOT A VIEW OF AN ORDER
 * ---------------------------------------------------------------------------
 * That distinction is the whole design of this file. An order is live data: the
 * customer can edit their address, an admin can rename a plan, a currency rate
 * can be corrected. An invoice has to keep saying exactly what it said on the
 * day it was issued, for as long as anybody keeps it — which for a business
 * expense is at least six years under HMRC's rules.
 *
 * So the invoice COPIES what it needs at issue time: the billed party's name
 * and address, the line descriptions, the amounts and the currency. Nothing on
 * it is joined from `customers` or `plans` at render time. A customer who moves
 * house next year must not retroactively change the address on a receipt their
 * accountant has already filed.
 *
 * The PDF is written once and kept on disk for the same reason. Regenerating it
 * from current data on each download would quietly undo all of the above.
 *
 * ---------------------------------------------------------------------------
 * NUMBERING
 * ---------------------------------------------------------------------------
 * VES-2026-00001, sequential within the year, allocated inside the same
 * transaction that writes the row. Sequential and gap-free is not decoration —
 * it is what a tax authority expects of an invoice series, and it is why the
 * number is taken with a locking read rather than from a count.
 */

const fs = require('fs');
const path = require('path');

const db = require('./db');
const currency = require('./currency');
const { Pdf } = require('./pdf');
const { CONTACT, SITE_URL } = require('./config');

/** Where the PDFs live. Outside public/ — an invoice is not a public document. */
const DIR = path.join(__dirname, '..', 'files', 'invoices');

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

/** Absolute path of an invoice's PDF. */
function pathFor(invoice) {
  return path.join(DIR, invoice.pdf_path || `${invoice.number}.pdf`);
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/**
 * Allocate the next number for this year.
 *
 * `FOR UPDATE` on the read, inside the caller's transaction. Two checkouts
 * completing in the same millisecond would otherwise both read 41 and both
 * write VES-2026-00042 — one of which fails on the unique key, taking an
 * otherwise good order down with it.
 */
async function nextNumber(conn, year) {
  const [rows] = await conn.query(
    `SELECT number FROM invoices
      WHERE number LIKE ?
      ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [`VES-${year}-%`],
  );
  const last = rows[0] ? Number(String(rows[0].number).split('-')[2]) : 0;
  return `VES-${year}-${String(last + 1).padStart(5, '0')}`;
}

/**
 * Issue the invoice for a paid order.
 *
 * Idempotent: an order that already has one gets that one back rather than a
 * second. Payment settlement can be delivered twice — SSLCommerz in particular
 * calls back and is also polled — and two invoices for one payment is a
 * bookkeeping problem that is tedious to unpick.
 */
async function forOrder(orderId, { conn = null } = {}) {
  const existing = await (conn
    ? conn.query('SELECT * FROM invoices WHERE order_id = ? LIMIT 1', [orderId]).then(([r]) => r[0])
    : db.one('SELECT * FROM invoices WHERE order_id = ? LIMIT 1', [orderId]));
  if (existing) return existing;

  const order = await (conn
    ? conn.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [orderId]).then(([r]) => r[0])
    : db.one('SELECT * FROM orders WHERE id = ? LIMIT 1', [orderId]));
  if (!order) throw new Error(`No order ${orderId}`);

  const customer = await (conn
    ? conn.query('SELECT * FROM customers WHERE id = ? LIMIT 1', [order.customer_id]).then(([r]) => r[0])
    : db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [order.customer_id]));

  const items = await (conn
    ? conn.query('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [orderId]).then(([r]) => r[0] ? r : [])
    : db.query('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [orderId]));

  /*
   * The billed party. Checkout resolves this — same as the account, or a
   * separate billing contact — and writes the RESULT onto the order, so there
   * is no "same as customer" flag to re-interpret here. Falling back to the
   * customer covers orders written before those columns existed.
   */
  const bill = {
    name: order.bill_name || `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim(),
    company: order.bill_company || customer?.company || '',
    email: order.bill_email || customer?.email || '',
    address1: order.bill_address1 || customer?.address1 || '',
    address2: order.bill_address2 || customer?.address2 || '',
    city: order.bill_city || customer?.city || '',
    postcode: order.bill_postcode || customer?.postcode || '',
    country: order.bill_country || customer?.country || 'GB',
  };

  const lineItems = (items || []).map((it) => ({
    description: it.description || it.kind || 'Service',
    qty: Number(it.qty || 1),
    unit_pence: Number(it.unit_pence ?? it.total_pence ?? 0),
    total_pence: Number(it.total_pence || 0),
  }));

  const year = new Date().getFullYear();

  const write = async (c) => {
    const number = await nextNumber(c, year);
    const [ins] = await c.query(
      `INSERT INTO invoices
         (customer_id, order_id, number, status, currency,
          subtotal, discount, tax, total,
          bill_name, bill_company, bill_email, bill_address1, bill_address2,
          bill_city, bill_postcode, bill_country, line_items, pdf_path)
       VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.customer_id, orderId, number, order.currency || 'GBP',
        /*
         * THE SUBTOTAL IS THE SUM OF THE PRINTED LINES, not `orders.subtotal_pence`.
         *
         * That column holds the NET — after the discount and excluding VAT —
         * which is the right number for the books and the wrong one for a
         * document that prints its lines above it. On a fully-discounted order
         * it produced: lines totalling $10.08, "Subtotal $0.00", "Discount
         * -$10.08", "Total $0.00". Every figure individually correct and the
         * column visibly not adding up, on the one page a customer checks
         * against their bank statement.
         *
         * Summing the lines makes the arithmetic on the page true:
         * subtotal - discount = total, with VAT reported separately because it
         * is inside the total rather than added to it.
         */
        pence(lineItems.reduce((n, it) => n + Number(it.total_pence || 0), 0)),
        pence(order.discount_pence),
        pence(order.vat_pence), pence(order.total_pence),
        bill.name, bill.company, bill.email, bill.address1, bill.address2,
        bill.city, bill.postcode, bill.country,
        JSON.stringify(lineItems), `${number}.pdf`,
      ],
    );
    const [rows] = await c.query('SELECT * FROM invoices WHERE id = ?', [ins.insertId]);
    return rows[0];
  };

  const invoice = conn ? await write(conn) : await db.transaction(write);

  /*
   * The PDF is written AFTER the row is committed, and a failure here does not
   * fail the invoice. A missing file can be regenerated on demand — see
   * `ensurePdf` — whereas a rolled-back invoice on a paid order leaves a
   * customer who has been charged with nothing to show for it.
   */
  try {
    await writePdf(invoice, { order });
  } catch (err) {
    console.error(`[invoices] ${invoice.number}: could not write the PDF —`, err.message);
  }

  return invoice;
}

function pence(v) { return Number(v || 0) / 100; }

/** Write the PDF if it is not already on disk, and return its path. */
async function ensurePdf(invoice) {
  const file = pathFor(invoice);
  if (fs.existsSync(file)) return file;
  await writePdf(invoice);
  return file;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Draw the invoice.
 *
 * One page, A4. The layout is deliberately conventional — issuer top left,
 * billed party below it, number and date top right, lines in the middle,
 * totals bottom right — because an invoice is read by an accountant looking
 * for four specific things, and a creative layout only makes those harder to
 * find.
 */
async function writePdf(invoice, { order = null } = {}) {
  ensureDir();

  const cur = String(invoice.currency || 'GBP').toUpperCase();
  /*
   * The currency ROW, not the code. `currency.format` needs the symbol and the
   * locale to render "£1,234.56" rather than "1234.56", and resolve() falls
   * back to the default for a code that has since been deactivated — so an old
   * invoice in a retired currency still renders, with a symbol, instead of
   * throwing.
   */
  const curRow = await currency.resolve(cur);
  const money = (amount) => currency
    .format(Math.round(Number(amount || 0) * 100), curRow)
    // Some locales group with a NARROW NO-BREAK SPACE (U+202F) or a NO-BREAK
    // SPACE (U+00A0). Neither is in the width table, so a thousands separator
    // would be measured at the fallback width and throw the right-aligned
    // totals column out by a couple of points. A plain space measures true.
    .replace(/[\u00A0\u202F\u2009]/g, ' ');

  let items = [];
  try { items = JSON.parse(invoice.line_items || '[]'); } catch { items = []; }

  const doc = new Pdf({ title: `Invoice ${invoice.number}`, author: CONTACT.company });

  const M = 48;                 // page margin
  const RIGHT = doc.width - M;  // right-aligned column
  const INK = '#111111';
  const MUTED = '#6b6d62';

  // ---- Header ------------------------------------------------------------
  doc.mark(M, 44, 26, { ink: INK });
  doc.text('VESOPA', M + 46, 56, { size: 15, bold: true, color: INK });
  doc.text('CLOUD HOSTING', M + 46, 68, { size: 6.6, bold: true, color: MUTED });

  doc.text('INVOICE', RIGHT, 52, { size: 20, bold: true, align: 'right', color: INK });
  doc.text(invoice.number, RIGHT, 68, { size: 10, align: 'right', color: MUTED });

  doc.line(M, 92, RIGHT, 92, { color: '#a5c715', width: 2 });

  // ---- Who, and when -----------------------------------------------------
  let y = 118;
  doc.text('FROM', M, y, { size: 7, bold: true, color: MUTED });
  doc.text('BILL TO', M + 190, y, { size: 7, bold: true, color: MUTED });
  y += 14;

  const issuer = [
    CONTACT.company,
    CONTACT.address_line1,
    CONTACT.address_line2,
    CONTACT.email,
  ].filter(Boolean);
  const billed = [
    invoice.bill_company || null,
    invoice.bill_name || null,
    invoice.bill_address1 || null,
    invoice.bill_address2 || null,
    [invoice.bill_city, invoice.bill_postcode].filter(Boolean).join(', ') || null,
    invoice.bill_country || null,
    invoice.bill_email || null,
  ].filter(Boolean);

  const rows = Math.max(issuer.length, billed.length);
  for (let i = 0; i < rows; i += 1) {
    if (issuer[i]) doc.text(issuer[i], M, y, { size: 9, bold: i === 0, color: i === 0 ? INK : MUTED });
    if (billed[i]) doc.text(billed[i], M + 190, y, { size: 9, bold: i === 0, color: i === 0 ? INK : MUTED });
    y += 13;
  }

  // Dates and status, right column.
  const issued = new Date(invoice.issued_at || Date.now());
  let dy = 118;
  const kv = (k, v) => {
    doc.text(k, RIGHT - 108, dy, { size: 8, color: MUTED });
    doc.text(v, RIGHT, dy, { size: 9, bold: true, align: 'right', color: INK });
    dy += 15;
  };
  kv('Date issued', issued.toISOString().slice(0, 10));
  if (order?.reference) kv('Order', order.reference);
  kv('Currency', cur);
  kv('Status', String(invoice.status || 'paid').toUpperCase());

  y = Math.max(y, dy) + 18;

  // ---- Lines -------------------------------------------------------------
  doc.rect(M, y - 11, RIGHT - M, 22, { color: '#f1f3ea' });
  doc.text('DESCRIPTION', M + 10, y + 3, { size: 7.5, bold: true, color: MUTED });
  doc.text('QTY', RIGHT - 150, y + 3, { size: 7.5, bold: true, align: 'right', color: MUTED });
  doc.text('UNIT', RIGHT - 80, y + 3, { size: 7.5, bold: true, align: 'right', color: MUTED });
  doc.text('AMOUNT', RIGHT - 10, y + 3, { size: 7.5, bold: true, align: 'right', color: MUTED });
  y += 26;

  if (!items.length) {
    doc.text('Services as ordered', M + 10, y + 2, { size: 9.5, color: INK });
    doc.text(money(invoice.total), RIGHT - 10, y + 2, { size: 9.5, align: 'right', color: INK });
    y += 20;
  } else {
    for (const it of items) {
      // The description is the only field that can be long enough to wrap, and
      // the column it wraps inside stops short of the numbers on purpose.
      const after = doc.paragraph(it.description, M + 10, y + 2, RIGHT - M - 185, { size: 9.5, color: INK });
      doc.text(String(it.qty || 1), RIGHT - 150, y + 2, { size: 9.5, align: 'right', color: MUTED });
      doc.text(money(pence(it.unit_pence)), RIGHT - 80, y + 2, { size: 9.5, align: 'right', color: MUTED });
      doc.text(money(pence(it.total_pence)), RIGHT - 10, y + 2, { size: 9.5, align: 'right', color: INK });
      y = Math.max(after, y + 18) + 4;
      doc.line(M, y - 4, RIGHT, y - 4, { color: '#eef0e9' });
    }
  }

  // ---- Totals ------------------------------------------------------------
  y += 10;
  const totalRow = (label, value, { bold = false, size = 9.5, color = INK } = {}) => {
    doc.text(label, RIGHT - 150, y, { size, bold, color: bold ? INK : MUTED });
    doc.text(value, RIGHT - 10, y, { size, bold, align: 'right', color });
    y += bold ? 20 : 16;
  };

  totalRow('Subtotal', money(invoice.subtotal));
  if (Number(invoice.discount) > 0) {
    totalRow('Discount', `-${money(invoice.discount)}`, { color: '#4a7a12' });
  }

  /*
   * VAT is reported as the portion INSIDE the total, never added to it — the
   * same rule the basket and the checkout state. An invoice that added it would
   * disagree with the amount actually taken from the card, which is the one
   * number on this page that can be checked against a bank statement.
   */
  if (Number(invoice.tax) > 0) {
    totalRow('VAT included', money(invoice.tax));
  }

  doc.line(RIGHT - 160, y - 6, RIGHT, y - 6, { color: '#c9cdb9', width: 1 });
  y += 6;
  totalRow('Total paid', `${money(invoice.total)} ${cur}`, { bold: true, size: 12 });

  // ---- Footer ------------------------------------------------------------
  const footY = doc.height - 74;
  doc.line(M, footY - 16, RIGHT, footY - 16, { color: '#e1e3da' });
  doc.paragraph(
    Number(invoice.tax) > 0
      ? `VAT is included in the total shown and accounted for by ${CONTACT.company}. `
        + 'Nothing further is added.'
      : 'This is the full amount charged. Nothing further is added.',
    M, footY, RIGHT - M, { size: 8, color: MUTED },
  );
  doc.text(
    `${CONTACT.company} · ${CONTACT.address_line1}, ${CONTACT.address_line2} · ${SITE_URL.replace(/^https?:\/\//, '')}`,
    M, footY + 22, { size: 7.5, color: MUTED },
  );
  doc.text('Thank you.', RIGHT, footY + 22, { size: 7.5, align: 'right', color: MUTED });

  const file = pathFor(invoice);
  fs.writeFileSync(file, doc.build());
  return file;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function listFor(customerId, { limit = 50 } = {}) {
  return db.query(
    `SELECT i.*, o.reference
       FROM invoices i
       LEFT JOIN orders o ON o.id = i.order_id
      WHERE i.customer_id = ?
      ORDER BY i.issued_at DESC, i.id DESC
      LIMIT ?`,
    [customerId, Number(limit) || 50],
  );
}

/** One invoice, proving it belongs to this customer. Never trust an id in a URL. */
function ownedBy(customerId, id) {
  return db.one(
    `SELECT i.*, o.reference
       FROM invoices i
       LEFT JOIN orders o ON o.id = i.order_id
      WHERE i.id = ? AND i.customer_id = ? LIMIT 1`,
    [id, customerId],
  );
}

module.exports = {
  DIR,
  forOrder,
  writePdf,
  ensurePdf,
  pathFor,
  listFor,
  ownedBy,
  nextNumber,
};
