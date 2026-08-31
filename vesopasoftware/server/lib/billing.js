/* Invoicing: raising them, and the subscription sweep that raises them for you. */
import { q, one, exec, nextRef } from "./db.js";
import { recalc } from "./invoices.js";
import { sendMail, layout, esc } from "./mail.js";
import { notify } from "./notify.js";
import { toUser } from "./realtime.js";
import { moneyRound } from "./pricing.js";
import { config } from "./config.js";

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Add months without JS's month-end surprise: adding one month to 31 Jan
 *  gives 3 March by default. Clamp to the last day of the target month so a
 *  subscription started on the 31st bills on the 28th/30th, not next month. */
export function addInterval(date, unit) {
  const d = new Date(date);
  const months = unit === "yearly" ? 12 : unit === "quarterly" ? 3 : 1;
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

/**
 * Create an invoice from a list of line items.
 * Returns the full invoice row. Nothing is emailed here — sending is a
 * separate, deliberate act (see sendInvoice), because an invoice is often
 * built in a few passes before anybody should see it.
 */
export async function createInvoice({
  user_id, org_id = null, project_id = null, subscription_id = null,
  items = [], issue_date = new Date(), due_days = 14, notes = null,
  tax_rate = config.taxRate, currency = config.currency, status = "draft",
}) {
  const number = await nextRef("invoices", "number", "INV");
  const due = new Date(issue_date);
  due.setDate(due.getDate() + due_days);

  const res = await exec(
    `INSERT INTO invoices (number, user_id, org_id, project_id, subscription_id,
                           issue_date, due_date, currency, tax_rate, notes, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [number, user_id, org_id, project_id, subscription_id,
     iso(issue_date), iso(due), currency, tax_rate, notes, status],
  );

  let sort = 0;
  for (const item of items) {
    const qty = Number(item.qty) || 1;
    const unit = Number(item.unit_price) || 0;
    await exec(
      `INSERT INTO invoice_items (invoice_id, description, qty, unit_price, amount, sort_order)
       VALUES (?,?,?,?,?,?)`,
      [res.insertId, String(item.description || "Work").slice(0, 255), qty, unit, round2(qty * unit), sort++],
    );
  }

  await recalc(res.insertId);
  return one("SELECT * FROM invoices WHERE id = ?", [res.insertId]);
}

/** Mark an invoice sent, email it, notify and push. Idempotent on sent_at. */
export async function sendInvoice(invoiceId, { note = null } = {}) {
  const inv = await one("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
  if (!inv) return null;
  const user = await one("SELECT * FROM users WHERE id = ?", [inv.user_id]);
  if (!user) return null;

  if (inv.status === "draft") {
    await exec("UPDATE invoices SET status='sent', sent_at=COALESCE(sent_at, NOW()) WHERE id=?", [invoiceId]);
  } else if (!inv.sent_at) {
    await exec("UPDATE invoices SET sent_at = NOW() WHERE id = ?", [invoiceId]);
  }

  const items = await q("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id", [invoiceId]);
  const rows = items
    .map((i) => `<tr><td style="padding:6px 0">${esc(i.description)}</td>
      <td style="padding:6px 0;text-align:right;white-space:nowrap">${moneyRound(i.amount, inv.currency)}</td></tr>`)
    .join("");

  await sendMail({
    to: user.email,
    subject: `Invoice ${inv.number} — ${moneyRound(inv.total, inv.currency)}`,
    template: "invoice",
    text: `Invoice ${inv.number} for ${moneyRound(inv.total, inv.currency)}, due ${inv.due_date}. Pay at ${config.baseUrl}/portal/invoices/${inv.id}`,
    html: layout({
      heading: `Invoice ${inv.number}`,
      lines: [
        note ? esc(note) : `Here is invoice <b>${inv.number}</b>.`,
        `<table style="width:100%;border-collapse:collapse;font-size:14px;
          border-top:1px solid rgba(11,14,10,.2);border-bottom:1px solid rgba(11,14,10,.2)">${rows}</table>`,
        `<b style="font-size:18px">Total ${moneyRound(inv.total, inv.currency)}</b> · due ${esc(String(inv.due_date))}`,
      ],
      cta: { label: "View and pay", href: `${config.baseUrl}/portal/invoices/${inv.id}` },
    }),
  });

  await notify(inv.user_id, {
    kind: "invoice",
    title: `Invoice ${inv.number} — ${moneyRound(inv.total, inv.currency)}`,
    body: `Due ${inv.due_date}.`,
    href: `/portal/invoices/${inv.id}`,
  });
  toUser(inv.user_id, "invoice", { id: inv.id, number: inv.number, total: inv.total, status: "sent" });

  return one("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
}

/** Roll every pending charge for a customer into one invoice. */
export async function invoicePendingCharges(userId, { project_id = null, send = false } = {}) {
  const charges = await q(
    `SELECT * FROM charges WHERE user_id = ? AND status = 'pending'
       ${project_id ? "AND project_id = ?" : ""} ORDER BY incurred_on, id`,
    project_id ? [userId, project_id] : [userId],
  );
  if (!charges.length) return null;

  const user = await one("SELECT * FROM users WHERE id = ?", [userId]);
  const inv = await createInvoice({
    user_id: userId,
    org_id: user?.org_id || null,
    project_id: project_id || charges[0].project_id || null,
    items: charges.map((c) => ({ description: c.description, qty: c.qty, unit_price: c.unit_price })),
    currency: charges[0].currency,
  });

  await exec(
    `UPDATE charges SET status='invoiced', invoice_id=? WHERE id IN (${charges.map(() => "?").join(",")})`,
    [inv.id, ...charges.map((c) => c.id)],
  );

  return send ? sendInvoice(inv.id) : inv;
}

/**
 * The subscription sweep.
 *
 * Runs on boot and then daily. A subscription whose next_charge_date has
 * arrived is invoiced and its date rolled forward by exactly one interval —
 * in a loop, so a sweep that has not run for three months raises the three
 * invoices it owes rather than one. The last_invoiced_at guard means running
 * it twice in a day cannot double-bill.
 */
export async function runSubscriptionSweep({ send = true, now = new Date() } = {}) {
  const due = await q(
    `SELECT * FROM subscriptions
      WHERE status = 'active' AND next_charge_date <= ? ORDER BY next_charge_date`,
    [iso(now)],
  );

  const raised = [];
  for (const sub of due) {
    let cursor = new Date(sub.next_charge_date);
    let guard = 0;

    while (cursor <= now && guard++ < 36) {
      const already = await one(
        `SELECT id FROM invoices WHERE subscription_id = ? AND issue_date = ? LIMIT 1`,
        [sub.id, iso(cursor)],
      );

      if (!already) {
        const period = new Date(cursor).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
        const inv = await createInvoice({
          user_id: sub.user_id,
          org_id: sub.org_id,
          project_id: sub.project_id,
          subscription_id: sub.id,
          issue_date: cursor,
          items: [{
            description: `${sub.name} — ${period}`,
            qty: 1,
            unit_price: sub.amount,
          }],
          currency: sub.currency,
          notes: sub.description,
        });
        raised.push(inv.id);
        if (send) await sendInvoice(inv.id, { note: `Your ${sub.interval_unit} charge for <b>${esc(sub.name)}</b>.` });
      }

      cursor = addInterval(cursor, sub.interval_unit);
    }

    await exec(
      "UPDATE subscriptions SET next_charge_date = ?, last_invoiced_at = NOW() WHERE id = ?",
      [iso(cursor), sub.id],
    );
  }

  if (raised.length) console.log(`  ↻ subscription sweep raised ${raised.length} invoice(s)`);
  return raised;
}

/** Start the sweep on a daily timer. Cheap, and it means a local run that is
 *  left open overnight behaves like the real thing. */
export function startBillingScheduler() {
  const run = () => runSubscriptionSweep().catch((err) => console.error("sweep failed:", err.message));
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}
