/* GitHub webhooks for vesopasoftware.com (owner, 2026-11-22: "Add proper
 * Github webhooks to this url and use proper system to use the webhooks").
 *
 *   POST /webhooks/github        GitHub's deliveries. Signed with the secret
 *                                set below, or refused; each kept once, as a
 *                                one-line summary (lib/github.js).
 *   /portal/admin/github         admins: what to put in GitHub's "Add webhook"
 *                                form (the payload URL and this site's own
 *                                secret, made here), each workflow's latest
 *                                result, open pull requests, releases, and
 *                                every recent event, live.
 *
 * What it does with an event:
 *   - a workflow run that fails or times out: a notification to every admin
 *     in the portal and an email to MAIL_ADMIN (info@vesopasoftware.com)
 *   - a release published, a pull request opened or merged: a notification
 *   - everything: on the GitHub page, live (the portal's socket, "github")
 *
 * The secret lives in the github_webhook table (one row), or in the
 * GITHUB_WEBHOOK_SECRET environment variable, which wins when set. Until one
 * of them is set every delivery is refused (503): an unsigned endpoint would
 * let anyone write into the admin's feed and inbox.
 */
import express, { Router } from "express";
import { q, one, exec } from "../lib/db.js";
import { requireAdmin } from "../lib/auth.js";
import { verifySignature, newSecret, row, alertFor } from "../lib/github.js";
import { notifyAdmins } from "../lib/notify.js";
import { toAdmins } from "../lib/realtime.js";
import { sendMail, layout, esc } from "../lib/mail.js";
import { config } from "../lib/config.js";

export const PAYLOAD_URL = "https://vesopasoftware.com/webhooks/github";
const KEEP_DAYS = 120;

export async function webhookSecret() {
  if (process.env.GITHUB_WEBHOOK_SECRET) return process.env.GITHUB_WEBHOOK_SECRET;
  const r = await one("SELECT secret FROM github_webhook WHERE id = 1").catch(() => null);
  return (r && r.secret) || null;
}

/** The receiver: mounted before the JSON parser, so it signs the exact bytes. */
export function webhookRouter({ store = defaultStore } = {}) {
  const router = Router();
  router.post(
    "/webhooks/github",
    express.raw({ type: () => true, limit: "10mb" }),
    async (req, res) => {
      const secret = await store.secret();
      if (!secret) return res.status(503).json({ error: "The webhook secret is not set yet (vesopasoftware.com/portal/admin/github)." });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!verifySignature(secret, body, req.get("x-hub-signature-256"))) {
        return res.status(401).json({ error: "Signature does not match." });
      }
      const event = String(req.get("x-github-event") || "").slice(0, 40);
      const delivery = String(req.get("x-github-delivery") || "").slice(0, 64);
      if (!event || !delivery) return res.status(400).json({ error: "Not a GitHub delivery." });
      let payload;
      try {
        // GitHub sends JSON, or a form with the JSON in `payload`.
        const text = body.toString("utf8");
        payload = text.startsWith("payload=") ? JSON.parse(new URLSearchParams(text).get("payload")) : JSON.parse(text);
      } catch {
        return res.status(400).json({ error: "The body is not JSON." });
      }
      const r = row(event, payload);
      const fresh = await store.save(delivery, r);
      // Answered at once: GitHub gives up after ten seconds.
      res.status(fresh ? 202 : 200).json({ ok: true, duplicate: !fresh });
      if (fresh) store.after(r).catch((e) => console.warn(`[github] after ${event}: ${e.message}`));
    },
  );
  return router;
}

const defaultStore = {
  secret: webhookSecret,
  async save(delivery, r) {
    const res = await exec(
      `INSERT IGNORE INTO github_events (delivery, event, action, repo, ref, actor, title, url, state, number)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [delivery, r.event, r.action, r.repo, r.ref, r.actor, r.title, r.url, r.state, r.number],
    );
    return !!(res && res.affectedRows);
  },
  async after(r) {
    toAdmins("github", r);
    const alert = alertFor(r);
    if (alert) {
      await notifyAdmins({ kind: "github", title: alert.title.slice(0, 190), body: alert.body, href: r.url || "/portal/admin/github" });
      if (alert.email) {
        await sendMail({
          to: config.mail.admin,
          subject: alert.title.slice(0, 190),
          template: "github_alert",
          text: `${alert.title}\n${alert.body}\n${r.url || ""}`,
          html: layout({
            heading: alert.title,
            lines: [esc(alert.body), r.actor ? `Started by ${esc(r.actor)}` : ""].filter(Boolean),
            cta: r.url ? { href: r.url, label: "Open on GitHub" } : null,
          }),
        });
      }
    }
    // Kept for KEEP_DAYS; pruned now and then rather than on every delivery.
    if (Math.random() < 0.02) await exec(`DELETE FROM github_events WHERE received_at < DATE_SUB(NOW(), INTERVAL ${KEEP_DAYS} DAY)`);
  },
};

/** The admin page, under /portal/admin/github. */
export function adminRouter() {
  const router = Router();
  router.use(requireAdmin);

  router.get("/", async (req, res, next) => {
    try {
      const secret = await webhookSecret();
      const fromEnv = !!process.env.GITHUB_WEBHOOK_SECRET;
      const recent = await q("SELECT * FROM github_events ORDER BY id DESC LIMIT 150").catch(() => []);
      // The latest finished run of each workflow, per repository.
      const runs = await q(
        `SELECT e.* FROM github_events e
           JOIN (SELECT MAX(id) id FROM github_events
                  WHERE event = 'workflow_run' AND action = 'completed'
                  GROUP BY repo, title) last ON last.id = e.id
          ORDER BY e.received_at DESC LIMIT 60`,
      ).catch(() => []);
      // Pull requests whose last word was opened / reopened / ready.
      const prs = await q(
        `SELECT e.* FROM github_events e
           JOIN (SELECT MAX(id) id FROM github_events WHERE event = 'pull_request' GROUP BY repo, number) last ON last.id = e.id
          WHERE e.state IN ('open', 'draft') ORDER BY e.received_at DESC LIMIT 40`,
      ).catch(() => []);
      const releases = await q(
        "SELECT * FROM github_events WHERE event = 'release' AND action = 'published' ORDER BY id DESC LIMIT 10",
      ).catch(() => []);
      const last = recent[0] || null;
      res.render("admin/github", {
        title: "GitHub",
        payloadUrl: PAYLOAD_URL,
        secret,
        fromEnv,
        last,
        recent,
        runs,
        prs,
        releases,
        mailAdmin: config.mail.admin,
      });
    } catch (err) {
      next(err);
    }
  });

  /** A new secret. The old one stops working at once. */
  router.post("/secret", async (req, res, next) => {
    try {
      if (process.env.GITHUB_WEBHOOK_SECRET) {
        req.flash("warn", "The secret is set in the server's environment (GITHUB_WEBHOOK_SECRET); change it there.");
        return res.redirect("/portal/admin/github");
      }
      await exec(
        `INSERT INTO github_webhook (id, secret) VALUES (1, ?)
         ON DUPLICATE KEY UPDATE secret = VALUES(secret)`,
        [newSecret()],
      );
      req.flash("ok", "New secret made. Paste it into the webhook's Secret on GitHub and press Update webhook.");
      res.redirect("/portal/admin/github");
    } catch (err) {
      next(err);
    }
  });

  return router;
}
