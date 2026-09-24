import { q, one, exec } from "./db.js";

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Recompute an invoice from its items and its settled payments.
 *
 * Deliberately a full recalculation rather than an increment. Payments arrive
 * from more than one place — an admin marking cash received, the mock gateway,
 * one day a real webhook that may fire twice — and a running total that is
 * added to is a total that eventually drifts. Reading the truth back out of
 * the rows costs one query and can never double-count.
 */
export async function recalc(invoiceId) {
  const inv = await one("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
  if (!inv) return null;

  const [{ subtotal }] = await q(
    "SELECT COALESCE(SUM(amount),0) AS subtotal FROM invoice_items WHERE invoice_id = ?",
    [invoiceId],
  );
  const [{ paid }] = await q(
    `SELECT COALESCE(SUM(amount),0) AS paid FROM payments
      WHERE invoice_id = ? AND status = 'settled'`,
    [invoiceId],
  );

  const sub = round2(subtotal);
  const tax = round2(sub * (Number(inv.tax_rate) || 0) / 100);
  const total = round2(sub + tax);
  const amountPaid = round2(paid);

  // A void invoice stays void — settling a payment against it must not quietly
  // bring it back to life. Draft likewise: an unsent invoice is not "paid".
  let status = inv.status;
  if (status !== "void") {
    if (amountPaid <= 0) status = inv.status === "draft" ? "draft" : "sent";
    else if (amountPaid + 0.005 < total) status = "part_paid";
    else status = "paid";
  }

  const paidAt =
    status === "paid"
      ? inv.paid_at ||
        (await one(
          `SELECT MAX(paid_at) AS at FROM payments WHERE invoice_id = ? AND status='settled'`,
          [invoiceId],
        ))?.at ||
        new Date()
      : null;

  await exec(
    `UPDATE invoices SET subtotal=?, tax_amount=?, total=?, amount_paid=?, status=?, paid_at=?
      WHERE id = ?`,
    [sub, tax, total, amountPaid, status, paidAt, invoiceId],
  );

  return { subtotal: sub, tax_amount: tax, total, amount_paid: amountPaid, status };
}

export const balanceOf = (inv) => round2((Number(inv.total) || 0) - (Number(inv.amount_paid) || 0));

/** Overdue is derived, never stored: a stored flag needs a cron to stay true. */
export function isOverdue(inv) {
  if (!inv || inv.status === "paid" || inv.status === "void" || inv.status === "draft") return false;
  return new Date(inv.due_date) < new Date(new Date().toDateString());
}

export const STATUS_LABEL = {
  draft: "Draft", sent: "Awaiting payment", part_paid: "Part paid", paid: "Paid", void: "Void",
};

export const PROJECT_STATUS = {
  enquiry:     { label: "Enquiry",     pct: 0 },
  scoping:     { label: "Scoping",     pct: 10 },
  in_progress: { label: "In progress", pct: 45 },
  review:      { label: "In review",   pct: 80 },
  live:        { label: "Live",        pct: 95 },
  on_hold:     { label: "On hold",     pct: null },
  complete:    { label: "Complete",    pct: 100 },
  cancelled:   { label: "Cancelled",   pct: null },
};
