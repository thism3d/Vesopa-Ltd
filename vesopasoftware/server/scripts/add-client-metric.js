/* Onboard Metric Group, Vesopa's first client on the portal.
 *
 *   node server/scripts/add-client-metric.js                 # from the app root, where .env lives
 *   node server/scripts/add-client-metric.js --no-invite     # set everything up, send no email
 *   node server/scripts/add-client-metric.js --resend-invite # new set-password link for Matt
 *
 * Creates, or finds and leaves alone:
 *   - the organisation  Metric Group
 *   - Matt Hammond's customer account, owner of that organisation, with NO
 *     password: he is emailed a single-use link to choose his own
 *     (lib/onboarding.js — the portal's own reset mechanism, valid 7 days)
 *   - the project "Metric Membership app", its milestones, its links and two
 *     published updates
 *
 * Safe to run twice. Everything is matched before it is inserted, and nothing
 * that already exists is overwritten — once the project is in the portal,
 * staff change it there, and a re-run must not undo their changes. The invite
 * goes out once: on a re-run it is re-sent only if Matt has never signed in
 * and his last link has expired, or if --resend-invite is given.
 *
 * No invoices, quotes, budgets or prices: those are agreed with Metric, not
 * written into a script. Mail goes wherever MAIL_MODE says; in mock mode the
 * invite is only in email_log (/portal/admin/mail).
 */
import { migrate, assertConnection, one, exec, nextRef, pool } from "../lib/db.js";
import { findUserByEmail, normaliseEmail } from "../lib/auth.js";
import { createInvitedUser, sendSetPasswordLink, hasLiveSetPasswordLink, WELCOME_LINK_DAYS } from "../lib/onboarding.js";
import { config } from "../lib/config.js";

const args = new Set(process.argv.slice(2));
const NO_INVITE = args.has("--no-invite");
const RESEND = args.has("--resend-invite");

const ORG = {
  name: "Metric Group",
  notes: "METRIC Group Ltd · metricgroup.co.uk · UK parking and ANPR. " +
         "Client for the white-label membership app at metric.vesopa.com (code: MetricMembership/).",
};

const CONTACT = {
  name: "Matt Hammond",
  email: normaliseEmail("m.hammond@metricgroup.co.uk"),
  company: "Metric Group",
  role_label: "Admin contact",
};

const PROJECT = {
  title: "Metric Membership app",
  service_type: "membership_app",
  status: "in_progress",
  description:
    "Metric Group's white-label membership app. Members register their number plates, " +
    "and the ANPR cameras at Metric's car parks open the barriers for them. " +
    "Web app live at metric.vesopa.com; Windows app submitted to the Microsoft Store; " +
    "Android app in progress.",
};

/* The plan, in order. `done_at` only where the date is actually known: a
 * milestone marked done today when it was done months ago would put a false
 * event on the customer's timeline. */
const MILESTONES = [
  { title: "Web app live at metric.vesopa.com", status: "done",
    detail: "Members sign in with Vesopa ID, register their cars and see their visits. Staff console at /admin." },
  { title: "Number plates linked to the ANPR barriers", status: "done",
    detail: "A registered plate opens the member barriers at Metric car parks, on the way in and out." },
  { title: "Windows app submitted to the Microsoft Store", status: "done", done_at: "2026-09-27 12:00:00",
    detail: "Version 1.0.1.0, Store ID 9NTLR9S47K4W, submitted 27 September 2026." },
  { title: "Windows app published on the Microsoft Store", status: "doing",
    detail: "Waiting on Microsoft's certification of version 1.0.1.0." },
  { title: "Android app built and tested", status: "doing",
    detail: "The same app on Android phones." },
  { title: "Android app released to members", status: "todo", detail: null },
];

const LINKS = [
  { label: "Metric Membership — web app", url: "https://metric.vesopa.com", kind: "live",
    note: "Live · what members use" },
  { label: "Staff console", url: "https://metric.vesopa.com/admin", kind: "admin",
    note: "Approve members, manage cars and sites" },
  { label: "Windows app — Microsoft Store", url: "https://apps.microsoft.com/detail/9NTLR9S47K4W", kind: "store",
    note: "Store ID 9NTLR9S47K4W · v1.0.1.0 submitted 27 Sep 2026" },
];

const UPDATES = [
  { title: "Windows app submitted to the Microsoft Store", at: "2026-09-27 12:00:00",
    body: "Version 1.0.1.0 is with Microsoft for certification. It appears on the Store once they approve it." },
  { title: "Your project is now in the portal", at: null,
    body: "Everything about the membership app is in one place from here: the plan, the links to the live app " +
          "and the Store listing, files, and a direct line to the people building it. The web app is live, " +
          "the Windows app is with Microsoft, and the Android app is being built." },
];

const log = (verb, what) => console.log(`  ${verb.padEnd(9)} ${what}`);

async function main() {
  await assertConnection();
  await migrate();          // the same idempotent schema + patches the server applies on boot

  console.log(`\n  Onboarding Metric Group  ·  db=${config.db.database}  mail=${config.mail.mode}  base=${config.baseUrl}\n`);

  /* ---- the person, and the organisation they belong to ---- */
  let user = await findUserByEmail(CONTACT.email);
  if (user && user.role !== "customer") {
    throw new Error(`${CONTACT.email} is a Vesopa staff account, not a customer. Sort that out by hand first.`);
  }

  let org = user?.org_id ? await one("SELECT * FROM organisations WHERE id = ?", [user.org_id]) : null;
  if (!org) org = await one("SELECT * FROM organisations WHERE LOWER(name) = LOWER(?) ORDER BY id LIMIT 1", [ORG.name]);
  if (org) {
    log("found", `organisation #${org.id} ${org.name}`);
  } else {
    const r = await exec("INSERT INTO organisations (name, notes) VALUES (?,?)", [ORG.name, ORG.notes]);
    org = await one("SELECT * FROM organisations WHERE id = ?", [r.insertId]);
    log("created", `organisation #${org.id} ${org.name}`);
  }

  let createdUser = false;
  if (user) {
    if (user.org_id && user.org_id !== org.id) {
      throw new Error(`${CONTACT.email} already belongs to organisation #${user.org_id}, not #${org.id}. Not moving them.`);
    }
    log("found", `customer #${user.id} ${user.name} <${user.email}>`);
  } else {
    const id = await createInvitedUser({ email: CONTACT.email, name: CONTACT.name, company: CONTACT.company });
    createdUser = true;
    user = await one("SELECT * FROM users WHERE id = ?", [id]);
    log("created", `customer #${user.id} ${user.name} <${user.email}> — no password set`);
  }
  if (!user.org_id) {
    await exec("UPDATE users SET org_id = ?, org_role = 'owner' WHERE id = ?", [org.id, user.id]);
    user.org_id = org.id;
    user.org_role = "owner";
    log("linked", `${user.name} → ${org.name} as owner`);
  }
  if (!org.owner_id) {
    await exec("UPDATE organisations SET owner_id = ? WHERE id = ? AND owner_id IS NULL", [user.id, org.id]);
    log("set", `${org.name} owner → ${user.name}`);
  }
  await exec("INSERT IGNORE INTO email_prefs (user_id) VALUES (?)", [user.id]);

  /* ---- the project ---- */
  const staff = await one("SELECT id, name FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1");

  let project = await one(
    "SELECT * FROM projects WHERE org_id = ? AND title = ? ORDER BY id LIMIT 1", [org.id, PROJECT.title]);
  let createdProject = false;
  if (project) {
    log("found", `project ${project.ref} ${project.title} (status ${project.status}, ${project.progress_pct}%) — left as it is`);
  } else {
    const done = MILESTONES.filter((m) => m.status === "done").length;
    const pct = Math.round((done / MILESTONES.length) * 100);
    const ref = await nextRef("projects", "ref", "VP");
    // budget_amount stays 0: nothing has been agreed in the portal, and the
    // customer views show no budget rather than £0 when it is.
    const r = await exec(
      `INSERT INTO projects (ref, user_id, org_id, title, service_type, description, status, progress_pct, currency)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [ref, user.id, org.id, PROJECT.title, PROJECT.service_type, PROJECT.description,
       PROJECT.status, pct, config.currency]);
    project = await one("SELECT * FROM projects WHERE id = ?", [r.insertId]);
    createdProject = true;
    log("created", `project ${project.ref} ${project.title} (${PROJECT.status}, ${pct}% — ${done} of ${MILESTONES.length} milestones)`);
  }

  /* ---- who is on it ---- */
  const m1 = await exec(
    "INSERT IGNORE INTO project_members (project_id, user_id, side, role_label) VALUES (?,?, 'customer', ?)",
    [project.id, user.id, CONTACT.role_label]);
  if (m1.affectedRows) log("added", `${user.name} to the project (${CONTACT.role_label})`);
  if (staff) {
    const m2 = await exec(
      "INSERT IGNORE INTO project_members (project_id, user_id, side, role_label) VALUES (?,?, 'vesopa', 'Account lead')",
      [project.id, staff.id]);
    if (m2.affectedRows) log("added", `${staff.name} to the project (Account lead)`);
  } else {
    log("skipped", "Vesopa account lead — there is no active staff account yet");
  }

  /* ---- milestones ---- */
  let order = 0;
  for (const m of MILESTONES) {
    order += 1;
    const have = await one("SELECT id FROM project_tasks WHERE project_id = ? AND title = ?", [project.id, m.title]);
    if (have) { log("found", `milestone “${m.title}”`); continue; }
    await exec(
      `INSERT INTO project_tasks (project_id, title, detail, status, created_by, is_visible, is_milestone, sort_order, done_at)
       VALUES (?,?,?,?,?,1,1,?,?)`,
      [project.id, m.title, m.detail, m.status, staff?.id || null, order, m.done_at || null]);
    log("added", `milestone ${order}. ${m.title} [${m.status}]`);
  }

  /* ---- links ---- */
  let lorder = 0;
  for (const l of LINKS) {
    lorder += 1;
    const r = await exec(
      "INSERT IGNORE INTO project_links (project_id, label, url, kind, note, sort_order) VALUES (?,?,?,?,?,?)",
      [project.id, l.label, l.url, l.kind, l.note, lorder]);
    log(r.affectedRows ? "added" : "found", `link ${l.label} → ${l.url}`);
  }

  /* ---- published updates ---- */
  for (const u of UPDATES) {
    const have = await one("SELECT id FROM project_updates WHERE project_id = ? AND title = ?", [project.id, u.title]);
    if (have) { log("found", `update “${u.title}”`); continue; }
    await exec(
      `INSERT INTO project_updates (project_id, author_id, title, body, progress_pct, is_internal, created_at)
       VALUES (?,?,?,?,NULL,0, COALESCE(?, NOW()))`,
      [project.id, staff?.id || null, u.title, u.body, u.at]);
    log("added", `update “${u.title}”`);
  }

  if (createdProject) {
    await exec(
      "INSERT INTO notifications (user_id, kind, title, body, href) VALUES (?,?,?,?,?)",
      [user.id, "project", `${PROJECT.title} is in your portal`, "The plan, the links and the team, in one place.",
       `/portal/projects/${project.id}`]);
  }

  /* ---- the invitation ---- */
  const fresh = await one("SELECT last_login_at FROM users WHERE id = ?", [user.id]);
  const neverSignedIn = !fresh.last_login_at;
  let send = false;
  let why = "";
  if (NO_INVITE) why = "--no-invite given";
  else if (!neverSignedIn) why = "Matt has already signed in";
  else if (createdUser) send = true;
  else if (RESEND) send = true;
  else if (await hasLiveSetPasswordLink(user.id)) why = "a link sent earlier is still valid (use --resend-invite to replace it)";
  else send = true;

  if (send) {
    if (config.mail.mode === "smtp" && /localhost|127\.0\.0\.1/.test(config.baseUrl)) {
      throw new Error(`BASE_URL is ${config.baseUrl}; the emailed link would point at this machine. Set BASE_URL first.`);
    }
    const { expires, mail } = await sendSetPasswordLink(user, {
      subject: "Your Vesopa portal account — Metric Membership app",
      heading: `Welcome, ${user.name.split(" ")[0]}`,
      lines: [
        `It is where Metric Group's membership app lives on our side: the plan and where each part stands, ` +
          `links to the live web app, the staff console and the Microsoft Store listing, files, and a direct ` +
          `conversation with the people building it.`,
        `You are the owner of the Metric Group account, so you can add colleagues from the Team page.`,
      ],
      template: "welcome_metric",
    });
    log(mail.status === "sent" ? "emailed" : "FAILED",
      `set-password link to ${user.email} (${config.mail.mode}, valid until ${expires.toISOString().slice(0, 16).replace("T", " ")} UTC` +
      `${mail.error ? ` — ${mail.error}` : ""})`);
    if (config.mail.mode === "mock") log("note", "mail is mocked: the message is only in /portal/admin/mail");
  } else {
    log("skipped", `invite email — ${why}`);
  }

  console.log(`\n  Project:  ${config.baseUrl}/portal/admin/projects/${project.id}`);
  console.log(`  Customer: ${config.baseUrl}/portal/admin/customers/${user.id}\n`);
  console.log(`  Links expire after ${WELCOME_LINK_DAYS} days; re-run with --resend-invite for a new one.\n`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(`\n  ${err.message}\n`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
