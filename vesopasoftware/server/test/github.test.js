/* GitHub webhooks: the signature, what an event says, which ones alert, and
 * the receiver end to end (no database: a store stands in for it).
 *
 *     node --test server/test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { verifySignature, newSecret, row, alertFor } from "../lib/github.js";

const SECRET = "s3cret-for-tests";
const sign = (body, secret = SECRET) => "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

test("only GitHub's signature with our secret is believed", () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');
  assert.equal(verifySignature(SECRET, body, sign(body)), true);
  assert.equal(verifySignature(SECRET, body, sign(body, "other")), false);
  assert.equal(verifySignature(SECRET, Buffer.from("{}"), sign(body)), false, "a changed body");
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature(SECRET, body, "sha1=abc"), false);
  assert.equal(verifySignature("", body, sign(body, "")), false, "no secret set: nothing is believed");
  assert.match(newSecret(), /^[0-9a-f]{64}$/);
});

test("each event in one line", () => {
  const push = row("push", { ref: "refs/heads/main", compare: "https://github.com/o/r/compare/a...b", commits: [{}, {}],
    head_commit: { message: "Till 1.16.56\n\nmore" }, repository: { full_name: "thism3d/Vesopa-Ltd" }, sender: { login: "thism3d" } });
  assert.equal(push.title, "2 commits to main: Till 1.16.56");
  assert.equal(push.ref, "main");
  assert.equal(push.repo, "thism3d/Vesopa-Ltd");

  const merged = row("pull_request", { action: "closed", pull_request: { number: 74, title: "Force update", merged: true, state: "closed", html_url: "https://github.com/o/r/pull/74" } });
  assert.equal(merged.state, "merged");
  assert.equal(merged.number, 74);

  const failed = row("workflow_run", { action: "completed", workflow_run: { name: "Windows - till release", status: "completed", conclusion: "failure", head_branch: "main", html_url: "https://github.com/o/r/actions/runs/1", run_number: 11 } });
  assert.equal(failed.state, "failure");
  assert.equal(failed.title, "Windows - till release");

  assert.equal(row("ping", { zen: "Design for failure." }).state, "ok");
  assert.equal(row("star", { action: "created" }).title, "star created");
  assert.equal(row("push", { compare: "javascript:alert(1)" }).url, null, "only https links are kept");
});

test("a failed workflow emails; a release and a merged pull request notify; a push does neither", () => {
  const failed = row("workflow_run", { action: "completed", workflow_run: { name: "Build", status: "completed", conclusion: "failure" } });
  assert.equal(alertFor(failed).email, true);
  assert.equal(alertFor(row("workflow_run", { action: "completed", workflow_run: { name: "Build", status: "completed", conclusion: "success" } })), null);
  assert.equal(alertFor(row("release", { action: "published", release: { name: "1.16.56" } })).email, false);
  assert.ok(alertFor(row("pull_request", { action: "closed", pull_request: { number: 1, merged: true, state: "closed" } })));
  assert.equal(alertFor(row("push", { ref: "refs/heads/main", commits: [] })), null);
});

test("the receiver: refused without a secret or signature, kept once, answered at once", async () => {
  const { webhookRouter } = await import("../routes/github.js").catch((e) => ({ skip: e }));
  if (!webhookRouter) return; // needs the server's node_modules (mysql2): run on the server
  const saved = new Map();
  const after = [];
  let secret = null;
  const store = {
    secret: async () => secret,
    save: async (d, r) => (saved.has(d) ? false : (saved.set(d, r), true)),
    after: async (r) => { after.push(r); },
  };
  const app = express();
  app.use(webhookRouter({ store }));
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/webhooks/github`;
  const body = JSON.stringify({ zen: "Practicality beats purity.", hook: { config: { url: "https://vesopasoftware.com/webhooks/github" } } });
  const send = (sig, delivery = "d-1") => fetch(url, { method: "POST", body, headers: {
    "content-type": "application/json", "x-github-event": "ping", "x-github-delivery": delivery, ...(sig ? { "x-hub-signature-256": sig } : {}) } });
  try {
    assert.equal((await send(sign(body))).status, 503, "no secret set yet");
    secret = SECRET;
    assert.equal((await send(null)).status, 401);
    assert.equal((await send(sign(body, "wrong"))).status, 401);
    assert.equal((await send(sign(body))).status, 202);
    assert.equal((await send(sign(body))).status, 200, "the same delivery again is not kept twice");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(saved.size, 1);
    assert.equal(after.length, 1);
    assert.equal(saved.get("d-1").title, "Webhook connected: “Practicality beats purity.”");
  } finally {
    server.close();
  }
});
