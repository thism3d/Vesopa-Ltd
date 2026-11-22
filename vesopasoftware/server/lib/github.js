/* GitHub webhooks: the signature check and what an event means.
 *
 * GitHub signs every delivery with the webhook's secret (X-Hub-Signature-256,
 * HMAC-SHA256 of the exact bytes it sent). Nothing is believed without it:
 * a delivery with no secret set here, no signature or a wrong one is refused
 * before it is read.
 *
 * summarise() turns a payload into one line we keep: which repository, what
 * happened, who did it, the link to it and its outcome. The payload itself is
 * not stored: it is large, and it can carry more than this needs.
 *
 * No database here, so it is tested on its own (test/github.test.js).
 */
import crypto from "node:crypto";

/** True when `signature` (sha256=<hex>) is GitHub's HMAC of `body` with `secret`. */
export function verifySignature(secret, body, signature) {
  if (!secret || !Buffer.isBuffer(body) || typeof signature !== "string") return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!m) return false;
  const want = crypto.createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(m[1], "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** A new secret: 32 random bytes as hex, as GitHub suggests. */
export const newSecret = () => crypto.randomBytes(32).toString("hex");

const cut = (v, n) => (v == null ? null : String(v).slice(0, n));
const branch = (ref) => String(ref || "").replace(/^refs\/(heads|tags)\//, "");

/**
 * What a delivery says, in one row:
 *   { event, action, repo, ref, actor, title, url, state, number }
 * `state` is the outcome where there is one: success / failure / cancelled /
 * timed_out for a workflow run, open / merged / closed for a pull request,
 * published for a release.
 */
export function summarise(event, p = {}) {
  const repo = p.repository?.full_name || p.organization?.login || null;
  const actor = p.sender?.login || null;
  const base = { event, action: p.action || null, repo, actor, ref: null, title: null, url: null, state: null, number: null };
  switch (event) {
    case "ping":
      return { ...base, title: `Webhook connected${p.zen ? `: “${p.zen}”` : ""}`, url: p.hook?.config?.url || null, state: "ok" };
    case "push": {
      const n = (p.commits || []).length;
      const head = p.head_commit?.message?.split("\n")[0] || "";
      const deleted = p.deleted === true;
      return {
        ...base,
        ref: branch(p.ref),
        title: deleted ? `Deleted ${branch(p.ref)}` : `${n} commit${n === 1 ? "" : "s"} to ${branch(p.ref)}${head ? `: ${head}` : ""}`,
        url: p.compare || p.head_commit?.url || null,
        state: deleted ? "deleted" : p.forced ? "forced" : null,
      };
    }
    case "pull_request": {
      const pr = p.pull_request || {};
      const state = pr.merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";
      return {
        ...base,
        ref: pr.head?.ref || null,
        number: pr.number ?? p.number ?? null,
        title: `#${pr.number ?? p.number} ${pr.title || ""}`.trim(),
        url: pr.html_url || null,
        state,
      };
    }
    case "workflow_run": {
      const r = p.workflow_run || {};
      return {
        ...base,
        ref: r.head_branch || null,
        number: r.run_number ?? null,
        title: r.name || p.workflow?.name || "Workflow",
        url: r.html_url || null,
        state: r.status === "completed" ? r.conclusion || "completed" : r.status || null,
      };
    }
    case "workflow_job": {
      const j = p.workflow_job || {};
      return { ...base, ref: j.head_branch || null, title: `${j.workflow_name || "Workflow"}: ${j.name || "job"}`, url: j.html_url || null, state: j.conclusion || j.status || null };
    }
    case "release": {
      const r = p.release || {};
      return { ...base, ref: r.tag_name || null, title: r.name || r.tag_name || "Release", url: r.html_url || null, state: p.action || null };
    }
    case "issues": {
      const i = p.issue || {};
      return { ...base, number: i.number ?? null, title: `#${i.number} ${i.title || ""}`.trim(), url: i.html_url || null, state: i.state || null };
    }
    case "issue_comment":
    case "pull_request_review_comment": {
      const subject = p.issue || p.pull_request || {};
      return { ...base, number: subject.number ?? null, title: `Comment on #${subject.number} ${subject.title || ""}`.trim(), url: p.comment?.html_url || subject.html_url || null };
    }
    case "pull_request_review": {
      const pr = p.pull_request || {};
      return { ...base, number: pr.number ?? null, title: `Review on #${pr.number} ${pr.title || ""}`.trim(), url: p.review?.html_url || pr.html_url || null, state: p.review?.state || null };
    }
    case "create":
    case "delete":
      return { ...base, ref: p.ref || null, title: `${event === "create" ? "Created" : "Deleted"} ${p.ref_type || "ref"} ${p.ref || ""}`.trim() };
    case "deployment_status": {
      const d = p.deployment_status || {};
      return { ...base, ref: p.deployment?.ref || null, title: `Deployment to ${p.deployment?.environment || "?"}`, url: d.target_url || d.log_url || null, state: d.state || null };
    }
    case "check_run":
    case "check_suite": {
      const c = p.check_run || p.check_suite || {};
      return { ...base, ref: c.head_branch || c.check_suite?.head_branch || null, title: c.name || c.app?.name || event, url: c.html_url || null, state: c.conclusion || c.status || null };
    }
    default:
      return { ...base, title: event.replace(/_/g, " ") + (p.action ? ` ${p.action}` : "") };
  }
}

/** Trimmed to the columns' sizes. */
export function row(event, payload) {
  const s = summarise(event, payload);
  return {
    event: cut(s.event, 40), action: cut(s.action, 40), repo: cut(s.repo, 140), ref: cut(s.ref, 190),
    actor: cut(s.actor, 80), title: cut(s.title, 300), url: /^https:\/\//.test(s.url || "") ? cut(s.url, 500) : null,
    state: cut(s.state, 30), number: Number.isInteger(s.number) ? s.number : null,
  };
}

/**
 * Whether an event is worth telling the admins about, and how:
 *   { title, body, email } or null.
 * A failed workflow run is the one that is emailed: it is the thing that needs
 * someone, and the others are on the page.
 */
export function alertFor(r) {
  if (r.event === "workflow_run" && r.action === "completed" && ["failure", "timed_out", "startup_failure"].includes(r.state)) {
    return { title: `GitHub: ${r.title} failed`, body: `${r.repo || ""}${r.ref ? ` · ${r.ref}` : ""} · ${r.state.replace("_", " ")}`, email: true };
  }
  if (r.event === "release" && r.action === "published") {
    return { title: `GitHub: release ${r.title}`, body: r.repo || "", email: false };
  }
  if (r.event === "pull_request" && (r.action === "opened" || (r.action === "closed" && r.state === "merged"))) {
    return { title: `GitHub: ${r.state === "merged" ? "merged" : "new pull request"} ${r.title}`, body: r.repo || "", email: false };
  }
  return null;
}
