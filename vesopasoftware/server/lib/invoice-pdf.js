/* The invoice, as a PDF.
 *
 * One page of A4 laid out on the same grid the portal uses: the mark and the
 * number at the top, who it is to and what it is for, the lines, the totals,
 * and how to pay. Built on lib/pdf.js — see the note there for why this is not
 * headless Chrome or a PDF library.
 *
 * Printed in ink on white rather than the portal's dark palette. An invoice
 * gets forwarded to an accountant and printed, and a page that lays down a
 * solid black background is both unreadable in monochrome and unkind to
 * whoever owns the printer.
 */
import { createPDF, textWidth } from "./pdf.js";
import { moneyRound } from "./pricing.js";

const LIME = "#5E7A0E";      // the deep lime; the bright one is illegible on white
const INK = "#111411";
const MUTED = "#6B7268";
const RULE = "#D8D8D2";

const date = (d) => (d ? new Date(d).toLocaleDateString("en-GB",
  { day: "numeric", month: "long", year: "numeric" }) : "—");

/**
 * @param {object} inv     the invoice row
 * @param {Array}  items   invoice_items
 * @param {Array}  payments settled payments against it
 * @param {object} to      { name, company, email, address }
 * @param {object} from    { name, address, email, phone, vat }
 * @param {object} bank    optional bank_accounts row
 * @returns {Buffer}
 */
export function invoicePDF({ inv, items = [], payments = [], to = {}, from = {}, bank = null }) {
  const p = createPDF();
  const M = 48;                       // page margin
  const RIGHT = p.W - M;
  const cur = inv.currency || "GBP";
  const money = (n) => moneyRound(Number(n || 0), cur);

  /* ---------- masthead ---------- */
  // The V, drawn from the same three polygons as the mark everywhere else,
  // scaled into a 22pt box. Two lime strokes and the dark inner one.
  p.box(M, 40, 13, 22, LIME);
  p.box(M + 15, 40, 13, 10, LIME);
  p.box(M + 15, 51, 13, 11, INK);
  p.text(M + 34, 57, "vesopa", { size: 17, bold: true, colour: INK });

  p.text(M, 92, from.name || "Vesopa Software Ltd", { size: 9, bold: true, colour: INK });
  let y = p.paragraph(M, 105, from.address || "", { size: 8.5, leading: 11, width: 200, colour: MUTED });
  if (from.email) p.text(M, y, from.email, { size: 8.5, colour: MUTED }), y += 11;
  if (from.phone) p.text(M, y, from.phone, { size: 8.5, colour: MUTED }), y += 11;
  if (from.vat) p.text(M, y, `VAT ${from.vat}`, { size: 8.5, colour: MUTED }), y += 11;

  /* ---------- the number, top right ---------- */
  const status = String(inv.status || "").toUpperCase();
  p.text(M, 50, "INVOICE", { size: 22, bold: true, colour: INK, align: "right", width: p.W - M * 2 });
  p.text(M, 70, inv.number || "", { size: 11, colour: LIME, align: "right", width: p.W - M * 2 });
  p.text(M, 88, `Issued ${date(inv.issue_date)}`, { size: 8.5, colour: MUTED, align: "right", width: p.W - M * 2 });
  p.text(M, 100, `Due ${date(inv.due_date)}`, { size: 8.5, colour: MUTED, align: "right", width: p.W - M * 2 });
  if (status === "PAID") {
    const w = textWidth("PAID", 10, true) + 16;
    p.box(RIGHT - w, 110, w, 17, LIME);
    p.text(RIGHT - w, 122, "PAID", { size: 10, bold: true, colour: "#FFFFFF", align: "center", width: w });
  }

  /* ---------- billed to ---------- */
  y = Math.max(y, 150);
  p.text(M, y, "BILLED TO", { size: 7.5, bold: true, colour: MUTED });
  y += 13;
  p.text(M, y, to.company || to.name || "", { size: 10.5, bold: true, colour: INK }); y += 13;
  if (to.company && to.name) { p.text(M, y, to.name, { size: 9, colour: INK }); y += 12; }
  if (to.address) y = p.paragraph(M, y, to.address, { size: 9, leading: 11.5, width: 240, colour: MUTED });
  if (to.email) { p.text(M, y, to.email, { size: 9, colour: MUTED }); y += 12; }

  if (inv.project_title) {
    p.text(RIGHT - 240, 150, "FOR", { size: 7.5, bold: true, colour: MUTED, align: "right", width: 240 });
    p.text(RIGHT - 240, 163, inv.project_title, { size: 10, colour: INK, align: "right", width: 240 });
  }

  /* ---------- the lines ---------- */
  y = Math.max(y + 18, 205);
  const COL_QTY = 300, COL_UNIT = 360, COL_AMT = 450;
  p.box(M, y - 11, p.W - M * 2, 20, "#F4F4F0");
  p.text(M + 8, y + 3, "DESCRIPTION", { size: 7.5, bold: true, colour: MUTED });
  p.text(COL_QTY, y + 3, "QTY", { size: 7.5, bold: true, colour: MUTED, align: "right", width: 40 });
  p.text(COL_UNIT, y + 3, "UNIT", { size: 7.5, bold: true, colour: MUTED, align: "right", width: 70 });
  p.text(COL_AMT, y + 3, "AMOUNT", { size: 7.5, bold: true, colour: MUTED, align: "right", width: RIGHT - COL_AMT - 8 });
  y += 24;

  for (const it of items) {
    const startY = y;
    const after = p.paragraph(M + 8, y + 2, it.description || "", { size: 9.5, leading: 12, width: 270, colour: INK });
    p.text(COL_QTY, startY + 2, String(it.qty ?? 1), { size: 9.5, colour: MUTED, align: "right", width: 40 });
    p.text(COL_UNIT, startY + 2, money(it.unit_price), { size: 9.5, colour: MUTED, align: "right", width: 70 });
    p.text(COL_AMT, startY + 2, money(it.amount), { size: 9.5, colour: INK, align: "right", width: RIGHT - COL_AMT - 8 });
    y = Math.max(after, startY + 16) + 4;
    p.rule(M, y - 4, p.W - M * 2, { colour: RULE, thickness: 0.4 });
  }
  if (!items.length) {
    p.text(M + 8, y + 2, "No line items.", { size: 9.5, colour: MUTED });
    y += 20;
  }

  /* ---------- totals ---------- */
  y += 12;
  const LBL = 330, VAL = RIGHT;
  const row = (label, value, { bold = false, size = 9.5, colour = INK } = {}) => {
    p.text(LBL, y, label, { size, bold, colour: bold ? INK : MUTED, align: "right", width: 120 });
    p.text(LBL + 130, y, value, { size, bold, colour, align: "right", width: VAL - LBL - 130 });
    y += size + 6;
  };

  row("Subtotal", money(inv.subtotal));
  if (Number(inv.discount) > 0) row("Discount", "-" + money(inv.discount));
  if (Number(inv.tax) > 0) row(`Tax${inv.tax_rate ? ` (${inv.tax_rate}%)` : ""}`, money(inv.tax));

  p.rule(LBL, y - 2, VAL - LBL, { colour: INK, thickness: 0.8 });
  y += 8;
  row("Total", money(inv.total), { bold: true, size: 12 });

  const paid = Number(inv.amount_paid || 0);
  if (paid > 0) {
    row("Paid", "-" + money(paid), { colour: LIME });
    p.rule(LBL, y - 2, VAL - LBL, { colour: RULE, thickness: 0.4 });
    y += 6;
    row("Balance due", money(Number(inv.total) - paid), { bold: true, size: 11 });
  }

  /* ---------- payments taken ---------- */
  if (payments.length) {
    y += 14;
    p.text(M, y, "PAYMENTS RECEIVED", { size: 7.5, bold: true, colour: MUTED });
    y += 13;
    for (const pay of payments) {
      p.text(M, y, `${date(pay.paid_at)} · ${pay.method || "payment"}${pay.provider_ref ? ` · ${pay.provider_ref}` : ""}`,
        { size: 8.5, colour: MUTED });
      p.text(COL_AMT, y, money(pay.amount), { size: 8.5, colour: MUTED, align: "right", width: RIGHT - COL_AMT });
      y += 12;
    }
  }

  /* ---------- how to pay, and the foot ---------- */
  if (bank && Number(inv.total) - paid > 0) {
    y += 18;
    p.box(M, y - 12, p.W - M * 2, 62, "#F4F4F0");
    p.text(M + 10, y + 2, "HOW TO PAY", { size: 7.5, bold: true, colour: MUTED });
    p.text(M + 10, y + 18, `${bank.bank_name || ""}  ·  ${bank.account_name || ""}`, { size: 9, colour: INK });
    p.text(M + 10, y + 32, `Sort code ${bank.sort_code || "—"}   Account ${bank.account_number || "—"}`,
      { size: 9, colour: INK });
    p.text(M + 10, y + 44, `Please quote ${inv.number} as the reference.`, { size: 8.5, colour: MUTED });
    y += 62;
  }

  if (inv.notes) {
    y += 16;
    p.text(M, y, "NOTES", { size: 7.5, bold: true, colour: MUTED }); y += 12;
    y = p.paragraph(M, y, inv.notes, { size: 9, leading: 11.5, width: p.W - M * 2, colour: MUTED });
  }

  const foot = p.H - 46;
  p.rule(M, foot - 12, p.W - M * 2, { colour: RULE, thickness: 0.4 });
  p.text(M, foot, from.name || "Vesopa Software Ltd", { size: 8, colour: MUTED });
  p.text(M, foot, `${inv.number} · page 1 of 1`, { size: 8, colour: MUTED, align: "right", width: p.W - M * 2 });

  return p.end();
}
