/* Seed the portal.
 *
 * Idempotent: run it as often as you like. Accounts are matched on email and
 * their password is reset to the known one; demo records are only created if
 * the customer has none, so a second run does not pile up duplicate invoices.
 *
 *   npm run db:seed
 */
import { setup, q, one, exec, nextRef, pool } from "./lib/db.js";
import { hashPassword } from "./lib/auth.js";
import { createInvoice, sendInvoice } from "./lib/billing.js";
import { recalc } from "./lib/invoices.js";
import { config } from "./lib/config.js";

// ---------------------------------------------------------------------------
// These two passwords are in plain text in a file that goes into git. That is
// fine for a local development seed and NOT fine the moment this database is
// reachable from anywhere else. Before this server faces the internet:
//   1. sign in as each of these and change the password, or
//   2. delete these constants and create the real accounts by hand.
// The seed resets the password on every run, so leaving it wired up in
// production would silently undo any password change the next time it ran.
// ---------------------------------------------------------------------------
const ADMIN = { email: "info@vesopasoftware.com", password: "@Vesopa2026", name: "Vesopa Admin" };
const CUSTOMER = {
  email: "muzahid@onzep.uk", password: "@Vesopa2026", name: "Md Muzahidul Islam",
  company: "Onzep", phone: "+44 1792 316282",
};

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const daysAhead = (n) => new Date(Date.now() + n * 86400000);

async function upsertUser({ email, password, name, role, company = null, phone = null }) {
  const existing = await one("SELECT * FROM users WHERE email = ?", [email]);
  const hash = await hashPassword(password);
  if (existing) {
    await exec("UPDATE users SET password_hash=?, name=?, role=?, status='active' WHERE id=?",
      [hash, name, role, existing.id]);
    return existing.id;
  }
  const res = await exec(
    "INSERT INTO users (role, email, password_hash, name, company, phone) VALUES (?,?,?,?,?,?)",
    [role, email, hash, name, company, phone],
  );
  return res.insertId;
}

async function main() {
  await setup();
  console.log("  schema ready");

  /* ---- accounts ---- */
  const adminId = await upsertUser({ ...ADMIN, role: "admin" });
  const customerId = await upsertUser({ ...CUSTOMER, role: "customer" });

  let customer = await one("SELECT * FROM users WHERE id = ?", [customerId]);
  if (!customer.org_id) {
    const org = await exec(
      `INSERT INTO organisations (name, owner_id, billing_email, billing_contact, address, country)
       VALUES (?,?,?,?,?,?)`,
      [CUSTOMER.company, customerId, CUSTOMER.email, CUSTOMER.name,
       "Baglan, Port Talbot SA12 7AX", "United Kingdom"],
    );
    await exec("UPDATE users SET org_id=?, org_role='owner', job_title=? WHERE id=?",
      [org.insertId, "Founder", customerId]);
    customer = await one("SELECT * FROM users WHERE id = ?", [customerId]);
  }
  for (const id of [adminId, customerId]) {
    await exec("INSERT IGNORE INTO email_prefs (user_id) VALUES (?)", [id]);
  }
  console.log(`  admin    ${ADMIN.email} / ${ADMIN.password}`);
  console.log(`  customer ${CUSTOMER.email} / ${CUSTOMER.password}`);

  /* ---- where money is sent ---- */
  if (!(await one("SELECT id FROM bank_accounts LIMIT 1"))) {
    await exec(
      `INSERT INTO bank_accounts (label, account_name, bank_name, account_number, sort_code,
                                  iban, swift, currency, instructions, is_default)
       VALUES (?,?,?,?,?,?,?,?,?,1)`,
      ["Vesopa Software Ltd — GBP", "Vesopa Software Ltd", "Example Bank plc",
       "00000000", "00-00-00", "GB00EXMP00000000000000", "EXMPGB2L", "GBP",
       "Quote the invoice number as the payment reference. Mock details — replace before going live."],
    );
    console.log("  bank account (placeholder) added");
  }

  /* ---- demo workload ---- */
  const already = await one("SELECT id FROM projects WHERE user_id = ? LIMIT 1", [customerId]);
  if (already) {
    console.log("  demo data already present — left alone");
    await pool.end();
    return;
  }

  // Two separate projects, so the "each project is separate" split is visible
  // the moment you sign in: one mid-build, one just enquired.
  const quoteRef = await nextRef("quotes", "ref", "VQ");
  const quote = await exec(
    `INSERT INTO quotes (ref, user_id, name, email, phone, company, service_type, scope_tier, timeline,
                         features, estimate_min, estimate_max, currency, message, source, status, created_at)
     VALUES (?,?,?,?,?,?,'webapp','standard','normal',?,?,?,?,?, 'website','accepted',?)`,
    [quoteRef, customerId, CUSTOMER.name, CUSTOMER.email, CUSTOMER.phone, CUSTOMER.company,
     JSON.stringify(["accounts", "payments", "analytics"]), 8200, 26000, config.currency,
     "Customer portal with billing and a live progress view.", daysAgo(38)],
  );

  const p1Ref = await nextRef("projects", "ref", "VP");
  const p1 = await exec(
    `INSERT INTO projects (ref, user_id, org_id, quote_id, title, service_type, description, status,
                           progress_pct, budget_amount, currency, start_date, target_date, created_at)
     VALUES (?,?,?,?,?,'webapp',?, 'in_progress', 55, ?, ?, ?, ?, ?)`,
    [p1Ref, customerId, customer.org_id, quote.insertId, "Onzep customer portal",
     "Accounts, project tracking, invoicing and a live message thread.",
     14500, config.currency, iso(daysAgo(30)), iso(daysAhead(24)), daysAgo(35)],
  );

  const p2Ref = await nextRef("projects", "ref", "VP");
  const p2 = await exec(
    `INSERT INTO projects (ref, user_id, org_id, title, service_type, description, status,
                           progress_pct, budget_amount, currency, target_date, created_at)
     VALUES (?,?,?,?, 'mobile', ?, 'scoping', 15, ?, ?, ?, ?)`,
    [p2Ref, customerId, customer.org_id, "Onzep mobile app",
     "iOS and Android companion to the portal.", 18000, config.currency, iso(daysAhead(90)), daysAgo(6)],
  );

  for (const pid of [p1.insertId, p2.insertId]) {
    await exec("INSERT INTO project_members (project_id, user_id, side, role_label) VALUES (?,?, 'customer', 'Main contact')",
      [pid, customerId]);
    await exec("INSERT INTO project_members (project_id, user_id, side, role_label) VALUES (?,?, 'vesopa', 'Account lead')",
      [pid, adminId]);
  }

  const updates = [
    [p1.insertId, "Project opened", "Scope agreed and the build slot is booked.", 10, daysAgo(30)],
    [p1.insertId, "Design signed off", "Both dashboards approved. Build starts on the data layer.", 25, daysAgo(22)],
    [p1.insertId, "Accounts and billing live", "Login, teams, invoices and payments all working on staging.", 55, daysAgo(5)],
    [p2.insertId, "Brief received", "Scoping the app against the portal's API.", 15, daysAgo(6)],
  ];
  for (const [pid, title, body, pct, at] of updates) {
    await exec(
      "INSERT INTO project_updates (project_id, author_id, title, body, progress_pct, created_at) VALUES (?,?,?,?,?,?)",
      [pid, adminId, title, body, pct, at]);
  }

  const tasks = [
    [p1.insertId, "Agree scope and timeline", "done", 0],
    [p1.insertId, "Design both dashboards", "done", 1],
    [p1.insertId, "Accounts, teams and permissions", "done", 2],
    [p1.insertId, "Invoicing and payments", "doing", 3],
    [p1.insertId, "Live message thread", "doing", 4],
    [p1.insertId, "Send us your brand assets", "todo", 5],
    [p1.insertId, "User acceptance testing", "todo", 6],
    [p2.insertId, "Confirm the platforms", "doing", 0],
    [p2.insertId, "Store accounts and certificates", "todo", 1],
  ];
  for (const [pid, title, status, order] of tasks) {
    await exec(
      `INSERT INTO project_tasks (project_id, title, status, assignee_id, created_by, sort_order, done_at, due_date)
       VALUES (?,?,?,?,?,?,?,?)`,
      [pid, title, status, status === "todo" && title.startsWith("Send") ? customerId : adminId,
       adminId, order, status === "done" ? daysAgo(20 - order) : null,
       status === "done" ? null : iso(daysAhead(order * 4 + 3))],
    );
  }

  const thread = [
    [p1.insertId, customerId, "Morning — how is the billing side looking?", daysAgo(6)],
    [p1.insertId, adminId, "Invoices and part-payments are done. Batch payment is in today, then it is testing.", daysAgo(6)],
    [p1.insertId, customerId, "Good. Can my accountant get an account that only sees invoices?", daysAgo(5)],
    [p1.insertId, adminId, "Yes — invite them from your Team page and pick the Billing role.", daysAgo(5)],
  ];
  for (const [pid, uid, body, at] of thread) {
    await exec("INSERT INTO messages (project_id, user_id, body, created_at, read_at) VALUES (?,?,?,?,?)",
      [pid, uid, body, at, at]);
  }

  /* ---- money: one paid, one outstanding, one overdue, plus pending charges ---- */
  const paid = await createInvoice({
    user_id: customerId, org_id: customer.org_id, project_id: p1.insertId,
    issue_date: daysAgo(30), due_days: 14, status: "sent",
    notes: "Stage one of two.",
    items: [
      { description: "Discovery, scope and technical plan", qty: 1, unit_price: 1800 },
      { description: "Design — both dashboards", qty: 1, unit_price: 2400 },
    ],
  });
  await exec(
    `INSERT INTO payments (invoice_id, user_id, amount, currency, method, provider, provider_ref, status, note, paid_at)
     VALUES (?,?,?,?, 'bank_transfer', 'manual', ?, 'settled', ?, ?)`,
    [paid.id, customerId, 4200, config.currency, "seed_bank_0001", "Bank transfer received", daysAgo(24)],
  );
  await recalc(paid.id);

  const open = await createInvoice({
    user_id: customerId, org_id: customer.org_id, project_id: p1.insertId,
    issue_date: daysAgo(9), due_days: 14, status: "sent",
    notes: "Stage two — build.",
    items: [
      { description: "Accounts, teams and permissions", qty: 1, unit_price: 3200 },
      { description: "Invoicing, payments and the earnings view", qty: 1, unit_price: 2900 },
    ],
  });
  await exec("UPDATE invoices SET sent_at = ? WHERE id = ?", [daysAgo(9), open.id]);

  const overdue = await createInvoice({
    user_id: customerId, org_id: customer.org_id, project_id: p2.insertId,
    issue_date: daysAgo(40), due_days: 14, status: "sent",
    notes: "Scoping work for the mobile app.",
    items: [{ description: "Mobile scoping workshop", qty: 1, unit_price: 950 }],
  });
  await exec("UPDATE invoices SET sent_at = ? WHERE id = ?", [daysAgo(40), overdue.id]);

  const charges = [
    [p1.insertId, "Extra reporting screen (out of scope)", 1, 650, daysAgo(4)],
    [p1.insertId, "Data migration from the old system", 6, 95, daysAgo(2)],
    [p2.insertId, "App Store account setup", 1, 120, daysAgo(1)],
  ];
  for (const [pid, desc, qty, unit, at] of charges) {
    await exec(
      `INSERT INTO charges (user_id, org_id, project_id, description, qty, unit_price, amount, currency, incurred_on)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [customerId, customer.org_id, pid, desc, qty, unit, qty * unit, config.currency, iso(at)],
    );
  }

  await exec(
    `INSERT INTO subscriptions (user_id, org_id, project_id, name, description, amount, currency,
                                interval_unit, status, next_charge_date, started_at)
     VALUES (?,?,?,?,?,?,?, 'monthly','active',?,?)`,
    [customerId, customer.org_id, p1.insertId, "Hosting and support cover",
     "Managed hosting, backups, monitoring and priority support.", 149, config.currency,
     iso(daysAhead(11)), iso(daysAgo(19))],
  );

  await exec(
    `INSERT INTO contacts (org_id, user_id, name, job_title, email, phone, kind, is_primary, created_by)
     VALUES (?,?,?,?,?,?, 'customer', 1, ?)`,
    [customer.org_id, customerId, CUSTOMER.name, "Founder", CUSTOMER.email, CUSTOMER.phone, adminId],
  );

  await exec(
    `INSERT INTO notifications (user_id, kind, title, body, href, created_at) VALUES
      (?, 'progress', 'Onzep customer portal: Accounts and billing live', 'Progress is now 55%.', ?, ?),
      (?, 'invoice', 'Invoice is due', 'Stage two is awaiting payment.', '/portal/invoices', ?)`,
    [customerId, `/portal/projects/${p1.insertId}`, daysAgo(5), customerId, daysAgo(9)],
  );

  console.log(`  2 projects, 3 invoices, 1 payment, 3 pending charges, 1 subscription, 9 tasks`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
