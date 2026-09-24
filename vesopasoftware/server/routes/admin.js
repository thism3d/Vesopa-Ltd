import { Router } from "express";
import { q, one, exec, nextRef } from "../lib/db.js";
import { requireAdmin, createUser, findUserByEmail, normaliseEmail, emailProblem } from "../lib/auth.js";
import { recalc, balanceOf, isOverdue, PROJECT_STATUS } from "../lib/invoices.js";
import { createInvoice, sendInvoice, invoicePendingCharges, runSubscriptionSweep, addInterval } from "../lib/billing.js";
import { SERVICES, moneyRound } from "../lib/pricing.js";
import { sendMail, layout, esc } from "../lib/mail.js";
import { notify, unreadCount } from "../lib/notify.js";
import { toProject, toUser, joinProjectRoom } from "../lib/realtime.js";
import { ORG_ROLES, roleLabel } from "../lib/permissions.js";
import { buildTimeline, groupByDay, monthGrid, bucketTasks } from "../lib/timeline.js";
import { prettySize } from "../lib/uploads.js";
import { config } from "../lib/config.js";

const router = Router();
router.use(requireAdmin);

router.use(async (req, res, next) => {
  try {
    res.locals.unread = await unreadCount(req.user.id);
    res.locals.admin = true;
    next();
  } catch (err) { next(err); }
});

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/* ---------- the money view ---------- */

router.get("/", async (req, res, next) => {
  try {
    const [
      [totals], monthly, [pipeline], recentPayments, openProjects,
      newQuotes, overdue, [customers], recurring, topCustomers,
    ] = await Promise.all([
      // Earnings are read from settled payments, never from invoice status:
      // money received is the only figure worth putting on a dashboard.
      q(`SELECT COALESCE(SUM(amount),0) AS lifetime,
                COALESCE(SUM(CASE WHEN YEAR(paid_at)=YEAR(CURDATE()) THEN amount END),0) AS this_year,
                COALESCE(SUM(CASE WHEN YEAR(paid_at)=YEAR(CURDATE()) AND MONTH(paid_at)=MONTH(CURDATE()) THEN amount END),0) AS this_month
           FROM payments WHERE status='settled'`),
      q(`SELECT DATE_FORMAT(paid_at,'%Y-%m') AS ym, SUM(amount) AS total, COUNT(*) AS n
           FROM payments WHERE status='settled' AND paid_at >= DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
          GROUP BY ym ORDER BY ym`),
      q(`SELECT COALESCE(SUM(total - amount_paid),0) AS outstanding
           FROM invoices WHERE status IN ('sent','part_paid')`),
      q(`SELECT p.*, u.name AS customer, i.number FROM payments p
           JOIN users u ON u.id = p.user_id JOIN invoices i ON i.id = p.invoice_id
          WHERE p.status='settled' ORDER BY p.paid_at DESC LIMIT 8`),
      q(`SELECT pr.*, u.name AS customer FROM projects pr JOIN users u ON u.id = pr.user_id
          WHERE pr.status IN ('enquiry','scoping','in_progress','review')
          ORDER BY FIELD(pr.status,'enquiry','scoping','in_progress','review'), pr.created_at DESC LIMIT 10`),
      q("SELECT * FROM quotes WHERE status='new' ORDER BY created_at DESC LIMIT 8"),
      q(`SELECT i.*, u.name AS customer FROM invoices i JOIN users u ON u.id = i.user_id
          WHERE i.status IN ('sent','part_paid') AND i.due_date < CURDATE() ORDER BY i.due_date`),
      q("SELECT COUNT(*) AS n FROM users WHERE role='customer' AND status='active'"),
      q(`SELECT COALESCE(SUM(CASE interval_unit WHEN 'yearly' THEN amount/12
                                                WHEN 'quarterly' THEN amount/3
                                                ELSE amount END),0) AS mrr,
                COUNT(*) AS n
           FROM subscriptions WHERE status='active'`),
      q(`SELECT u.id, u.name, u.company, COALESCE(SUM(p.amount),0) AS paid
           FROM users u LEFT JOIN payments p ON p.user_id = u.id AND p.status='settled'
          WHERE u.role='customer' GROUP BY u.id ORDER BY paid DESC LIMIT 6`),
    ]);

    res.render("admin/dashboard", {
      title: "Vesopa admin",
      totals, monthly, pipeline, recentPayments, openProjects, newQuotes, overdue,
      customerCount: customers.n, recurring: recurring[0], topCustomers,
    });
  } catch (err) { next(err); }
});

/* ---------- quotes ---------- */

router.get("/quotes", async (req, res, next) => {
  try {
    const status = String(req.query.status || "");
    const rows = await q(
      `SELECT q.*, u.id AS uid FROM quotes q LEFT JOIN users u ON u.id = q.user_id
        ${status ? "WHERE q.status = ?" : ""} ORDER BY q.created_at DESC LIMIT 200`,
      status ? [status] : [],
    );
    res.render("admin/quotes", { title: "Quotes", quotes: rows, status });
  } catch (err) { next(err); }
});

router.get("/quotes/:id", async (req, res, next) => {
  try {
    const quote = await one("SELECT * FROM quotes WHERE id = ?", [req.params.id]);
    if (!quote) return res.status(404).render("error", { title: "No such quote", message: "Gone.", back: "/portal/admin/quotes" });
    const customer = quote.user_id ? await one("SELECT * FROM users WHERE id = ?", [quote.user_id]) : null;
    res.render("admin/quote", { title: `Quote ${quote.ref}`, quote, customer, SERVICES });
  } catch (err) { next(err); }
});

router.post("/quotes/:id/status", async (req, res, next) => {
  try {
    const allowed = ["new", "reviewing", "quoted", "accepted", "declined"];
    const status = allowed.includes(req.body.status) ? req.body.status : "new";
    await exec("UPDATE quotes SET status = ? WHERE id = ?", [status, req.params.id]);
    req.flash("ok", `Quote marked ${status}.`);
    res.redirect(`/portal/admin/quotes/${req.params.id}`);
  } catch (err) { next(err); }
});

/** Turn a quote into a live project. If the enquirer has no account we make
 *  one, so a cold lead can be onboarded without asking them to register. */
router.post("/quotes/:id/convert", async (req, res, next) => {
  try {
    const quote = await one("SELECT * FROM quotes WHERE id = ?", [req.params.id]);
    if (!quote) return res.status(404).render("error", { title: "No such quote", message: "Gone.", back: "/portal/admin/quotes" });

    let customer = quote.user_id
      ? await one("SELECT * FROM users WHERE id = ?", [quote.user_id])
      : await findUserByEmail(quote.email);
    let tempPassword = null;

    if (!customer) {
      tempPassword = Math.random().toString(36).slice(2, 10) + "A1";
      const id = await createUser({
        email: quote.email, password: tempPassword, name: quote.name,
        company: quote.company, phone: quote.phone, role: "customer",
      });
      const org = await exec("INSERT INTO organisations (name, owner_id) VALUES (?,?)",
        [quote.company || quote.name, id]);
      await exec("UPDATE users SET org_id = ?, org_role='owner' WHERE id = ?", [org.insertId, id]);
      await exec("UPDATE quotes SET user_id = ? WHERE id = ?", [id, quote.id]);
      customer = await one("SELECT * FROM users WHERE id = ?", [id]);
    }

    const ref = await nextRef("projects", "ref", "VP");
    const project = await exec(
      `INSERT INTO projects (ref, user_id, org_id, quote_id, title, service_type, description,
                             status, budget_amount, currency, start_date)
       VALUES (?,?,?,?,?,?,?, 'scoping', ?, ?, CURDATE())`,
      [ref, customer.id, customer.org_id, quote.id,
       String(req.body.title || `${quote.service_type} for ${quote.company || quote.name}`).slice(0, 160),
       quote.service_type, quote.message, num(req.body.budget, quote.estimate_min), quote.currency],
    );

    await exec("INSERT INTO project_members (project_id, user_id, side, role_label) VALUES (?,?, 'customer', 'Main contact')",
      [project.insertId, customer.id]);
    await exec("INSERT INTO project_members (project_id, user_id, side, role_label) VALUES (?,?, 'vesopa', 'Account lead')",
      [project.insertId, req.user.id]);
    await exec(
      "INSERT INTO project_updates (project_id, author_id, title, body, progress_pct) VALUES (?,?,?,?,10)",
      [project.insertId, req.user.id, "Project opened", "We are scoping the work and will come back with a plan."],
    );
    await exec("UPDATE quotes SET status='accepted' WHERE id = ?", [quote.id]);

    joinProjectRoom(customer.id, project.insertId);

    await sendMail({
      to: customer.email,
      subject: `Your project is open — ${ref}`,
      template: "project_opened",
      text: `We have opened ${ref}. Track it at ${config.baseUrl}/portal/projects/${project.insertId}`,
      html: layout({
        heading: "Your project is open",
        lines: [
          `We have turned quote ${quote.ref} into a live project, <b>${ref}</b>.`,
          `You can watch progress, talk to the people working on it and settle invoices in your portal.`,
          tempPassword
            ? `We made you an account. Sign in with <b>${esc(customer.email)}</b> and the temporary password <b>${esc(tempPassword)}</b>, then change it on your account page.`
            : `Sign in with <b>${esc(customer.email)}</b>.`,
        ],
        cta: { label: "Open the project", href: `${config.baseUrl}/portal/projects/${project.insertId}` },
      }),
    });
    await notify(customer.id, {
      kind: "project", title: `Project ${ref} is open`,
      body: "We are scoping the work now.", href: `/portal/projects/${project.insertId}`,
    });

    req.flash("ok", `Project ${ref} created${tempPassword ? ` and an account was made for ${customer.email}.` : "."}`);
    res.redirect(`/portal/admin/projects/${project.insertId}`);
  } catch (err) { next(err); }
});

/* ---------- projects ---------- */

router.get("/projects", async (req, res, next) => {
  try {
    const status = String(req.query.status || "");
    const rows = await q(
      `SELECT p.*, u.name AS customer, u.company,
              (SELECT COALESCE(SUM(total),0) FROM invoices WHERE project_id = p.id AND status <> 'void') AS invoiced,
              (SELECT COALESCE(SUM(amount_paid),0) FROM invoices WHERE project_id = p.id AND status <> 'void') AS collected
         FROM projects p JOIN users u ON u.id = p.user_id
        ${status ? "WHERE p.status = ?" : ""}
        ORDER BY FIELD(p.status,'in_progress','review','scoping','enquiry','on_hold','live','complete','cancelled'),
                 p.created_at DESC`,
      status ? [status] : [],
    );
    res.render("admin/projects", { title: "Projects", projects: rows, status, PROJECT_STATUS });
  } catch (err) { next(err); }
});

router.get("/projects/:id", async (req, res, next) => {
  try {
    const project = await one("SELECT * FROM projects WHERE id = ?", [req.params.id]);
    if (!project) return res.status(404).render("error", { title: "No such project", message: "Gone.", back: "/portal/admin/projects" });

    const [customer, updates, messages, invoices, members, charges, staff, orgPeople, subs, files, tasks] =
      await Promise.all([
      one("SELECT * FROM users WHERE id = ?", [project.user_id]),
      q(`SELECT pu.*, u.name AS author FROM project_updates pu LEFT JOIN users u ON u.id = pu.author_id
          WHERE pu.project_id = ? ORDER BY pu.created_at DESC`, [project.id]),
      q(`SELECT m.*, u.name AS author, u.role AS author_role, u.job_title,
                i.number AS invoice_number, i.total AS invoice_total, i.status AS invoice_status,
                i.currency AS invoice_currency, i.amount_paid AS invoice_paid
           FROM messages m LEFT JOIN users u ON u.id = m.user_id
           LEFT JOIN invoices i ON i.id = m.invoice_id
          WHERE m.project_id = ? ORDER BY m.created_at ASC`, [project.id]),
      q("SELECT * FROM invoices WHERE project_id = ? ORDER BY issue_date DESC", [project.id]),
      q(`SELECT pm.*, u.name, u.email, u.job_title, u.org_role, u.role FROM project_members pm
           JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY pm.side DESC, u.name`, [project.id]),
      q("SELECT * FROM charges WHERE project_id = ? ORDER BY status, incurred_on DESC", [project.id]),
      q("SELECT id, name, email FROM users WHERE role='admin' AND status='active' ORDER BY name"),
      project.org_id
        ? q("SELECT id, name, email, org_role FROM users WHERE org_id = ? ORDER BY name", [project.org_id])
        : Promise.resolve([]),
      q("SELECT * FROM subscriptions WHERE project_id = ? ORDER BY next_charge_date", [project.id]),
      q(`SELECT f.*, u.name AS uploader FROM project_files f LEFT JOIN users u ON u.id = f.user_id
          WHERE f.project_id = ? ORDER BY f.created_at DESC`, [project.id]),
      /* Every task, including the ones hidden from the customer. The customer
         view filters on `is_visible`; this is the side that decides what that
         flag should be, so it has to be able to see both. */
      q(`SELECT t.*, a.name AS assignee, c.name AS creator
           FROM project_tasks t
           LEFT JOIN users a ON a.id = t.assignee_id
           LEFT JOIN users c ON c.id = t.created_by
          WHERE t.project_id = ?
          ORDER BY FIELD(t.status,'doing','todo','blocked','done'), t.sort_order, t.id`, [project.id]),
    ]);

    /* The same one-feed treatment the customer hub has, for the same reason:
       whoever picks this project up needs the order events happened in, not
       five separate lists to reconcile. The difference is what goes into it —
       internal updates and hidden tasks are part of the admin's record. */
    const now = new Date();
    const cy = Number(req.query.y) || now.getFullYear();
    const cm = Number.isInteger(Number(req.query.m)) ? Number(req.query.m) : now.getMonth();
    const month = new Date(cy, cm, 1);

    res.render("admin/project", {
      title: project.title, project, customer, updates, messages, invoices, members,
      charges, staff, orgPeople, subs, files, tasks, PROJECT_STATUS, roleLabel, prettySize,
      timeline: groupByDay(buildTimeline({ messages, updates, files, tasks })),
      buckets: bucketTasks(tasks),
      calendar: { month, cells: monthGrid(cy, cm, tasks) },
    });
  } catch (err) { next(err); }
});

router.post("/projects/:id", async (req, res, next) => {
  try {
    const project = await one("SELECT * FROM projects WHERE id = ?", [req.params.id]);
    if (!project) return res.redirect("/portal/admin/projects");

    const status = Object.keys(PROJECT_STATUS).includes(req.body.status) ? req.body.status : project.status;
    const pct = Math.max(0, Math.min(100, num(req.body.progress_pct, project.progress_pct)));

    await exec(
      `UPDATE projects SET title=?, status=?, progress_pct=?, budget_amount=?, description=?,
                           start_date=?, target_date=? WHERE id=?`,
      [String(req.body.title || project.title).slice(0, 160), status, pct,
       num(req.body.budget_amount, project.budget_amount),
       String(req.body.description || "").slice(0, 4000) || null,
       req.body.start_date || null, req.body.target_date || null, project.id],
    );

    if (status !== project.status || pct !== project.progress_pct) {
      toProject(project.id, "project:progress", { projectId: project.id, status, progress_pct: pct });
      await notify(project.user_id, {
        kind: "progress", title: `${project.title}: ${PROJECT_STATUS[status]?.label || status}`,
        body: `Progress ${pct}%.`, href: `/portal/projects/${project.id}`,
      });
    }
    req.flash("ok", "Project saved.");
    res.redirect(`/portal/admin/projects/${project.id}`);
  } catch (err) { next(err); }
});

/** A progress note. Customer-visible unless flagged internal. */
router.post("/projects/:id/updates", async (req, res, next) => {
  try {
    const project = await one("SELECT * FROM projects WHERE id = ?", [req.params.id]);
    if (!project) return res.redirect("/portal/admin/projects");

    const title = String(req.body.title || "").trim().slice(0, 160);
    if (!title) { req.flash("warn", "An update needs a title."); return res.redirect(`/portal/admin/projects/${project.id}`); }

    const isInternal = req.body.is_internal ? 1 : 0;
    const pct = req.body.progress_pct === "" || req.body.progress_pct == null
      ? null : Math.max(0, Math.min(100, num(req.body.progress_pct)));

    await exec(
      "INSERT INTO project_updates (project_id, author_id, title, body, progress_pct, is_internal) VALUES (?,?,?,?,?,?)",
      [project.id, req.user.id, title, String(req.body.body || "").slice(0, 4000) || null, pct, isInternal],
    );
    if (pct != null) await exec("UPDATE projects SET progress_pct = ? WHERE id = ?", [pct, project.id]);

    if (!isInternal) {
      toProject(project.id, "project:update", { projectId: project.id, title, progress_pct: pct });
      await notify(project.user_id, {
        kind: "progress", title: `${project.title}: ${title}`,
        body: String(req.body.body || "").slice(0, 200), href: `/portal/projects/${project.id}`,
      });
      const customer = await one("SELECT email, name FROM users WHERE id = ?", [project.user_id]);
      if (customer && req.body.email_customer) {
        await sendMail({
          to: customer.email,
          subject: `${project.title} — ${title}`,
          template: "project_update",
          text: `${title}\n\n${String(req.body.body || "")}`,
          html: layout({
            heading: title,
            lines: [String(req.body.body || "").split("\n").map(esc).join("<br>"),
                    pct != null ? `Progress is now <b>${pct}%</b>.` : ""].filter(Boolean),
            cta: { label: "See the project", href: `${config.baseUrl}/portal/projects/${project.id}` },
          }),
        });
      }
    }
    req.flash("ok", "Update posted.");
    res.redirect(`/portal/admin/projects/${project.id}`);
  } catch (err) { next(err); }
});

router.post("/projects/:id/members", async (req, res, next) => {
  try {
    const project = await one("SELECT * FROM projects WHERE id = ?", [req.params.id]);
    if (!project) return res.redirect("/portal/admin/projects");
    const userId = num(req.body.user_id);
    const person = await one("SELECT * FROM users WHERE id = ?", [userId]);
    if (!person) { req.flash("warn", "No such person."); return res.redirect(`/portal/admin/projects/${project.id}`); }

    await exec(
      `INSERT INTO project_members (project_id, user_id, side, role_label) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE role_label = VALUES(role_label)`,
      [project.id, userId, person.role === "admin" ? "vesopa" : "customer",
       String(req.body.role_label || "").slice(0, 60) || null],
    );
    joinProjectRoom(userId, project.id);
    req.flash("ok", `${person.name} added to the project.`);
    res.redirect(`/portal/admin/projects/${project.id}`);
  } catch (err) { next(err); }
});

router.post("/projects/:id/members/:userId/remove", async (req, res, next) => {
  try {
    await exec("DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
      [req.params.id, req.params.userId]);
    req.flash("ok", "Removed from the project.");
    res.redirect(`/portal/admin/projects/${req.params.id}`);
  } catch (err) { next(err); }
});

/* ---------- charges ---------- */

router.post("/projects/:id/charges", async (req, res, next) => {
  try {
    const project = await one("SELECT * FROM projects WHERE id = ?", [req.params.id]);
    if (!project) return res.redirect("/portal/admin/projects");

    const qty = num(req.body.qty, 1);
    const unit = num(req.body.unit_price, 0);
    await exec(
      `INSERT INTO charges (user_id, org_id, project_id, description, qty, unit_price, amount, currency, incurred_on)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [project.user_id, project.org_id, project.id,
       String(req.body.description || "Work").slice(0, 255), qty, unit,
       Math.round(qty * unit * 100) / 100, project.currency, req.body.incurred_on || iso(new Date())],
    );

    await notify(project.user_id, {
      kind: "charge", title: `New pending charge on ${project.title}`,
      body: `${String(req.body.description || "Work")} — ${moneyRound(qty * unit, project.currency)}`,
      href: `/portal/projects/${project.id}`,
    });
    toProject(project.id, "charge:new", { projectId: project.id });

    req.flash("ok", "Charge added. It shows on the customer's pending charges.");
    res.redirect(`/portal/admin/projects/${project.id}`);
  } catch (err) { next(err); }
});

router.post("/charges/:id/void", async (req, res, next) => {
  try {
    const charge = await one("SELECT * FROM charges WHERE id = ?", [req.params.id]);
    if (charge) await exec("UPDATE charges SET status='void' WHERE id = ? AND status='pending'", [charge.id]);
    req.flash("ok", "Charge voided.");
    res.redirect(req.get("referer") || "/portal/admin");
  } catch (err) { next(err); }
});

/** Sweep every pending charge for one customer into a single invoice. */
router.post("/customers/:id/invoice-charges", async (req, res, next) => {
  try {
    const inv = await invoicePendingCharges(num(req.params.id), { send: !!req.body.send });
    if (!inv) { req.flash("warn", "No pending charges to invoice."); return res.redirect(`/portal/admin/customers/${req.params.id}`); }
    req.flash("ok", `Invoice ${inv.number} raised from pending charges.`);
    res.redirect(`/portal/admin/invoices/${inv.id}`);
  } catch (err) { next(err); }
});

/* ---------- invoices ---------- */

router.get("/invoices", async (req, res, next) => {
  try {
    const status = String(req.query.status || "");
    const rows = await q(
      `SELECT i.*, u.name AS customer, u.company, p.title AS project_title
         FROM invoices i JOIN users u ON u.id = i.user_id
         LEFT JOIN projects p ON p.id = i.project_id
        ${status ? "WHERE i.status = ?" : ""} ORDER BY i.issue_date DESC, i.id DESC LIMIT 300`,
      status ? [status] : [],
    );
    res.render("admin/invoices", { title: "Invoices", invoices: rows, status, isOverdue });
  } catch (err) { next(err); }
});

router.get("/invoices/new", async (req, res, next) => {
  try {
    const [customers, projects] = await Promise.all([
      q("SELECT id, name, email, company, org_id FROM users WHERE role='customer' ORDER BY name"),
      q("SELECT id, ref, title, user_id FROM projects ORDER BY created_at DESC"),
    ]);
    res.render("admin/invoice-new", {
      title: "New invoice", customers, projects,
      preset: { user_id: num(req.query.user_id) || "", project_id: num(req.query.project_id) || "" },
    });
  } catch (err) { next(err); }
});

router.post("/invoices/new", async (req, res, next) => {
  try {
    const userId = num(req.body.user_id);
    const customer = await one("SELECT * FROM users WHERE id = ?", [userId]);
    if (!customer) { req.flash("warn", "Pick a customer."); return res.redirect("/portal/admin/invoices/new"); }

    // Line items arrive as parallel arrays from the repeatable form rows.
    const descriptions = [].concat(req.body.description || []);
    const qtys = [].concat(req.body.qty || []);
    const prices = [].concat(req.body.unit_price || []);
    const items = descriptions
      .map((d, i) => ({ description: d, qty: num(qtys[i], 1), unit_price: num(prices[i], 0) }))
      .filter((it) => String(it.description || "").trim() && (it.qty * it.unit_price) !== 0);

    if (!items.length) { req.flash("warn", "An invoice needs at least one line."); return res.redirect("/portal/admin/invoices/new"); }

    const inv = await createInvoice({
      user_id: userId,
      org_id: customer.org_id,
      project_id: num(req.body.project_id) || null,
      items,
      due_days: num(req.body.due_days, 14),
      tax_rate: num(req.body.tax_rate, config.taxRate),
      notes: String(req.body.notes || "").slice(0, 2000) || null,
      status: "draft",
    });

    if (req.body.send) await sendInvoice(inv.id);
    req.flash("ok", `Invoice ${inv.number} created${req.body.send ? " and sent." : " as a draft."}`);
    res.redirect(`/portal/admin/invoices/${inv.id}`);
  } catch (err) { next(err); }
});

router.get("/invoices/:id", async (req, res, next) => {
  try {
    const inv = await one("SELECT * FROM invoices WHERE id = ?", [req.params.id]);
    if (!inv) return res.status(404).render("error", { title: "No such invoice", message: "Gone.", back: "/portal/admin/invoices" });
    const [items, payments, customer, project] = await Promise.all([
      q("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id", [inv.id]),
      q("SELECT * FROM payments WHERE invoice_id = ? ORDER BY paid_at DESC", [inv.id]),
      one("SELECT * FROM users WHERE id = ?", [inv.user_id]),
      inv.project_id ? one("SELECT * FROM projects WHERE id = ?", [inv.project_id]) : null,
    ]);
    res.render("admin/invoice", { title: `Invoice ${inv.number}`, inv, items, payments, customer, project });
  } catch (err) { next(err); }
});

router.post("/invoices/:id/send", async (req, res, next) => {
  try {
    const inv = await sendInvoice(num(req.params.id), { note: String(req.body.note || "").slice(0, 500) || null });
    req.flash("ok", inv ? `Invoice ${inv.number} sent.` : "Could not send that invoice.");
    res.redirect(`/portal/admin/invoices/${req.params.id}`);
  } catch (err) { next(err); }
});

/** Record a payment taken outside the portal — cash, transfer, card machine. */
router.post("/invoices/:id/payments", async (req, res, next) => {
  try {
    const inv = await one("SELECT * FROM invoices WHERE id = ?", [req.params.id]);
    if (!inv) return res.redirect("/portal/admin/invoices");

    const amount = num(req.body.amount, 0);
    if (amount <= 0) { req.flash("warn", "A payment needs an amount."); return res.redirect(`/portal/admin/invoices/${inv.id}`); }

    const method = ["manual", "bank_transfer", "card", "crypto", "mock"].includes(req.body.method)
      ? req.body.method : "manual";

    await exec(
      `INSERT INTO payments (invoice_id, user_id, amount, currency, method, provider, provider_ref, status, note, paid_at)
       VALUES (?,?,?,?,?, 'manual', ?, 'settled', ?, ?)`,
      [inv.id, inv.user_id, amount, inv.currency, method,
       String(req.body.provider_ref || "").slice(0, 120) || null,
       String(req.body.note || "").slice(0, 255) || null,
       req.body.paid_at || new Date()],
    );
    const totals = await recalc(inv.id);

    toUser(inv.user_id, "invoice", { id: inv.id, number: inv.number, status: totals.status });
    await notify(inv.user_id, {
      kind: "payment", title: `Payment recorded on ${inv.number}`,
      body: `${moneyRound(amount, inv.currency)} — now ${totals.status}.`, href: `/portal/invoices/${inv.id}`,
    });

    req.flash("ok", `Payment of ${moneyRound(amount, inv.currency)} recorded.`);
    res.redirect(`/portal/admin/invoices/${inv.id}`);
  } catch (err) { next(err); }
});

router.post("/invoices/:id/void", async (req, res, next) => {
  try {
    await exec("UPDATE invoices SET status='void' WHERE id = ?", [req.params.id]);
    req.flash("ok", "Invoice voided.");
    res.redirect(`/portal/admin/invoices/${req.params.id}`);
  } catch (err) { next(err); }
});

/** Post an invoice straight into a project's conversation, payable in place. */
router.post("/projects/:id/send-invoice", async (req, res, next) => {
  try {
    const project = await one("SELECT * FROM projects WHERE id = ?", [req.params.id]);
    if (!project) return res.redirect("/portal/admin/projects");

    let invoiceId = num(req.body.invoice_id) || null;

    // Either attach an existing invoice, or raise one from a single line.
    if (!invoiceId) {
      const amount = num(req.body.amount, 0);
      if (amount <= 0) { req.flash("warn", "Give an amount, or pick an existing invoice."); return res.redirect(`/portal/admin/projects/${project.id}`); }
      const inv = await createInvoice({
        user_id: project.user_id, org_id: project.org_id, project_id: project.id,
        items: [{ description: String(req.body.description || project.title).slice(0, 255), qty: 1, unit_price: amount }],
        due_days: num(req.body.due_days, 14),
        currency: project.currency,
        status: "draft",
      });
      invoiceId = inv.id;
    }

    const sent = await sendInvoice(invoiceId, { note: String(req.body.body || "").slice(0, 500) || null });
    const body = String(req.body.body || "").trim().slice(0, 4000) ||
      `Invoice ${sent.number} for ${moneyRound(sent.total, sent.currency)} — payable here.`;

    const result = await exec(
      "INSERT INTO messages (project_id, user_id, invoice_id, body) VALUES (?,?,?,?)",
      [project.id, req.user.id, invoiceId, body],
    );
    const row = await one(
      `SELECT m.*, u.name AS author, u.role AS author_role,
              i.number AS invoice_number, i.total AS invoice_total, i.status AS invoice_status,
              i.currency AS invoice_currency, i.amount_paid AS invoice_paid
         FROM messages m LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN invoices i ON i.id = m.invoice_id WHERE m.id = ?`, [result.insertId]);

    toProject(project.id, "message", { projectId: project.id, message: row });
    req.flash("ok", `Invoice ${sent.number} sent into the conversation.`);
    res.redirect(`/portal/admin/projects/${project.id}`);
  } catch (err) { next(err); }
});

/* ---------- subscriptions ---------- */

router.get("/subscriptions", async (req, res, next) => {
  try {
    const rows = await q(
      `SELECT s.*, u.name AS customer, u.company, p.title AS project_title
         FROM subscriptions s JOIN users u ON u.id = s.user_id
         LEFT JOIN projects p ON p.id = s.project_id
        ORDER BY FIELD(s.status,'active','paused','cancelled'), s.next_charge_date`,
    );
    const [mrr] = await q(
      `SELECT COALESCE(SUM(CASE interval_unit WHEN 'yearly' THEN amount/12
                                              WHEN 'quarterly' THEN amount/3
                                              ELSE amount END),0) AS mrr
         FROM subscriptions WHERE status='active'`);
    const customers = await q("SELECT id, name, company, org_id FROM users WHERE role='customer' ORDER BY name");
    const projects = await q("SELECT id, ref, title, user_id FROM projects ORDER BY created_at DESC");
    res.render("admin/subscriptions", { title: "Recurring", subs: rows, mrr: mrr.mrr, customers, projects });
  } catch (err) { next(err); }
});

router.post("/subscriptions", async (req, res, next) => {
  try {
    const userId = num(req.body.user_id);
    const customer = await one("SELECT * FROM users WHERE id = ?", [userId]);
    if (!customer) { req.flash("warn", "Pick a customer."); return res.redirect("/portal/admin/subscriptions"); }

    const interval = ["monthly", "quarterly", "yearly"].includes(req.body.interval_unit) ? req.body.interval_unit : "monthly";
    const start = req.body.next_charge_date || iso(new Date());

    await exec(
      `INSERT INTO subscriptions (user_id, org_id, project_id, name, description, amount, currency,
                                  interval_unit, next_charge_date, started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [userId, customer.org_id, num(req.body.project_id) || null,
       String(req.body.name || "Monthly retainer").slice(0, 160),
       String(req.body.description || "").slice(0, 400) || null,
       num(req.body.amount, 0), config.currency, interval, start, start],
    );

    await notify(userId, {
      kind: "subscription", title: `Recurring charge set up: ${String(req.body.name || "").slice(0, 80)}`,
      body: `${moneyRound(num(req.body.amount), config.currency)} ${interval}, from ${start}.`,
      href: "/portal/invoices",
    });

    req.flash("ok", "Recurring charge created.");
    res.redirect("/portal/admin/subscriptions");
  } catch (err) { next(err); }
});

router.post("/subscriptions/:id/status", async (req, res, next) => {
  try {
    const status = ["active", "paused", "cancelled"].includes(req.body.status) ? req.body.status : "paused";
    await exec(
      `UPDATE subscriptions SET status = ?, cancelled_at = ${status === "cancelled" ? "NOW()" : "NULL"} WHERE id = ?`,
      [status, req.params.id],
    );
    req.flash("ok", `Subscription ${status}.`);
    res.redirect("/portal/admin/subscriptions");
  } catch (err) { next(err); }
});

/** Run the sweep by hand — useful for a demo, and for catching up after the
 *  process has been down over a billing date. */
router.post("/subscriptions/run", async (req, res, next) => {
  try {
    const raised = await runSubscriptionSweep({ send: true });
    req.flash("ok", raised.length ? `Raised ${raised.length} invoice(s).` : "Nothing was due.");
    res.redirect("/portal/admin/subscriptions");
  } catch (err) { next(err); }
});

/* ---------- customers ---------- */

router.get("/customers", async (req, res, next) => {
  try {
    const rows = await q(
      `SELECT u.*, o.name AS org_name,
              (SELECT COUNT(*) FROM projects WHERE user_id = u.id) AS projects,
              (SELECT COALESCE(SUM(amount),0) FROM payments WHERE user_id = u.id AND status='settled') AS paid,
              (SELECT COALESCE(SUM(total - amount_paid),0) FROM invoices
                WHERE user_id = u.id AND status IN ('sent','part_paid')) AS outstanding
         FROM users u LEFT JOIN organisations o ON o.id = u.org_id
        WHERE u.role = 'customer' ORDER BY paid DESC, u.created_at DESC`,
    );
    res.render("admin/customers", { title: "Customers", customers: rows, roleLabel });
  } catch (err) { next(err); }
});

router.get("/customers/:id", async (req, res, next) => {
  try {
    const customer = await one("SELECT * FROM users WHERE id = ?", [req.params.id]);
    if (!customer) return res.status(404).render("error", { title: "No such customer", message: "Gone.", back: "/portal/admin/customers" });

    const [projects, invoices, payments, quotes, charges, subs, colleagues, org] = await Promise.all([
      q("SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC", [customer.id]),
      q("SELECT * FROM invoices WHERE user_id = ? ORDER BY issue_date DESC", [customer.id]),
      q("SELECT p.*, i.number FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.user_id = ? ORDER BY p.paid_at DESC", [customer.id]),
      q("SELECT * FROM quotes WHERE user_id = ? ORDER BY created_at DESC", [customer.id]),
      q("SELECT * FROM charges WHERE user_id = ? AND status='pending' ORDER BY incurred_on DESC", [customer.id]),
      q("SELECT * FROM subscriptions WHERE user_id = ? AND status <> 'cancelled' ORDER BY next_charge_date", [customer.id]),
      customer.org_id
        ? q("SELECT id, name, email, org_role, status FROM users WHERE org_id = ? AND id <> ? ORDER BY name",
            [customer.org_id, customer.id])
        : Promise.resolve([]),
      customer.org_id ? one("SELECT * FROM organisations WHERE id = ?", [customer.org_id]) : null,
    ]);

    const lifetime = payments.filter((p) => p.status === "settled").reduce((s, p) => s + Number(p.amount), 0);
    const outstanding = invoices
      .filter((i) => ["sent", "part_paid"].includes(i.status))
      .reduce((s, i) => s + balanceOf(i), 0);

    res.render("admin/customer", {
      title: customer.name, customer, projects, invoices, payments, quotes, charges, subs,
      colleagues, org, lifetime, outstanding, roleLabel, ORG_ROLES,
    });
  } catch (err) { next(err); }
});

router.post("/customers/:id/status", async (req, res, next) => {
  try {
    const status = req.body.status === "suspended" ? "suspended" : "active";
    await exec("UPDATE users SET status = ? WHERE id = ? AND role='customer'", [status, req.params.id]);
    req.flash("ok", `Customer ${status}.`);
    res.redirect(`/portal/admin/customers/${req.params.id}`);
  } catch (err) { next(err); }
});

/* ---------- enquiries, mail log, staff ---------- */

router.get("/enquiries", async (req, res, next) => {
  try {
    const rows = await q("SELECT * FROM enquiries ORDER BY created_at DESC LIMIT 200");
    await exec("UPDATE enquiries SET status='read' WHERE status='new'");
    res.render("admin/enquiries", { title: "Enquiries", enquiries: rows });
  } catch (err) { next(err); }
});

/** Reply to an enquiry by email, straight from the panel. */
router.post("/enquiries/:id/reply", async (req, res, next) => {
  try {
    const enq = await one("SELECT * FROM enquiries WHERE id = ?", [req.params.id]);
    if (!enq) return res.redirect("/portal/admin/enquiries");
    const body = String(req.body.body || "").trim();
    if (!body) { req.flash("warn", "Write something first."); return res.redirect("/portal/admin/enquiries"); }

    await sendMail({
      to: enq.email,
      subject: String(req.body.subject || `Re: your message to Vesopa Software`).slice(0, 190),
      template: "enquiry_reply",
      text: body,
      html: layout({ heading: "From Vesopa Software", lines: body.split("\n").map(esc) }),
    });
    await exec("UPDATE enquiries SET status='replied' WHERE id = ?", [enq.id]);
    req.flash("ok", `Replied to ${enq.email}.`);
    res.redirect("/portal/admin/enquiries");
  } catch (err) { next(err); }
});

router.get("/mail", async (req, res, next) => {
  try {
    const rows = await q("SELECT * FROM email_log ORDER BY created_at DESC LIMIT 100");
    res.render("admin/mail", { title: "Mail log", emails: rows });
  } catch (err) { next(err); }
});

router.get("/staff", async (req, res, next) => {
  try {
    const rows = await q("SELECT id, name, email, status, last_login_at, created_at FROM users WHERE role='admin' ORDER BY name");
    res.render("admin/staff", { title: "Vesopa staff", staff: rows, error: null });
  } catch (err) { next(err); }
});

router.post("/staff", async (req, res, next) => {
  try {
    const email = normaliseEmail(req.body.email);
    const ep = emailProblem(email);
    if (ep) { req.flash("warn", ep); return res.redirect("/portal/admin/staff"); }
    if (await findUserByEmail(email)) { req.flash("warn", "That address already has an account."); return res.redirect("/portal/admin/staff"); }
    if (String(req.body.password || "").length < 8) { req.flash("warn", "Password must be at least 8 characters."); return res.redirect("/portal/admin/staff"); }

    await createUser({
      email, password: req.body.password,
      name: String(req.body.name || "").trim().slice(0, 120) || email,
      role: "admin",
    });
    req.flash("ok", `Staff account created for ${email}.`);
    res.redirect("/portal/admin/staff");
  } catch (err) { next(err); }
});

export default router;
