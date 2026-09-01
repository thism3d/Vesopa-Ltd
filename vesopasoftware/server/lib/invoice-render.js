/* Gather everything an invoice PDF needs, from an invoice row.
 *
 * Shared by the download route and the mailer so the PDF a customer opens in
 * the portal is byte-identical to the one attached to the email that told them
 * about it. Two call sites assembling the same document separately is how they
 * drift — different address, different bank details, same number on both.
 */
import { q, one } from "./db.js";
import { invoicePDF } from "./invoice-pdf.js";
import { config } from "./config.js";

/** Settings are key/value rows; missing ones fall back to the registered name. */
async function companyDetails() {
  const rows = await q("SELECT `key`, `value` FROM settings WHERE `key` LIKE 'company_%'").catch(() => []);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    name: s.company_name || "Vesopa Software Ltd",
    address: s.company_address || "Baglan, Port Talbot, SA12 7AX, United Kingdom",
    email: s.company_email || config.mail.admin,
    phone: s.company_phone || "+44 1792 316282",
    vat: s.company_vat || "",
  };
}

/** @returns {Promise<Buffer>} */
export async function renderInvoicePDF(inv) {
  const [items, payments, customer, project, org, bank, from] = await Promise.all([
    q("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id", [inv.id]),
    // Only settled money belongs on the document.
    q("SELECT * FROM payments WHERE invoice_id = ? AND status = 'settled' ORDER BY paid_at", [inv.id]),
    inv.user_id ? one("SELECT * FROM users WHERE id = ?", [inv.user_id]) : null,
    inv.project_id ? one("SELECT title FROM projects WHERE id = ?", [inv.project_id]) : null,
    inv.org_id ? one("SELECT * FROM organisations WHERE id = ?", [inv.org_id]) : null,
    one("SELECT * FROM bank_accounts WHERE active = 1 ORDER BY is_default DESC, id LIMIT 1").catch(() => null),
    companyDetails(),
  ]);

  return invoicePDF({
    inv: { ...inv, project_title: project?.title || null },
    items,
    payments,
    to: {
      name: customer?.name || "",
      // Bill the organisation where there is one: that is the entity that
      // pays, and an accountant reconciling it needs to see its own name.
      company: org?.name || customer?.company || "",
      email: org?.billing_email || customer?.email || "",
      address: org?.address || "",
    },
    from,
    bank,
  });
}
