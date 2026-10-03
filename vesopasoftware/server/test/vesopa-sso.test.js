/* Continue with Vesopa: the OIDC client against a key made here, and the
 * sign-in pages rendered with the button on and off.
 *
 *     node --test server/test/
 *
 * No network and no database: auth.vesopa.com is played by a fake `fetch`
 * that serves a JWKS and a token endpoint signing with a locally generated
 * RSA key. The view checks need `ejs` from node_modules and are skipped
 * without it (the deploy runs them on the server, where it is installed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "../lib/vesopa-oidc.js";

const ISSUER = "https://auth.example.test";
const CLIENT_ID = "portal-client";
const REDIRECT = "https://vesopasoftware.com/portal/auth/vesopa/callback";

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function keyPair(kid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

function sign(key, claims, header = {}) {
  const head = b64({ alg: "RS256", typ: "JWT", kid: key.kid, ...header });
  const body = b64(claims);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

/** A fake auth.vesopa.com. `mint(nonce, body)` returns the id_token. */
function fakeProvider({ keys, mint }) {
  const calls = { jwks: 0, token: [] };
  const fetchImpl = async (url, init = {}) => {
    if (url === `${ISSUER}/jwks.json`) {
      calls.jwks += 1;
      return new Response(JSON.stringify({ keys: keys().map((k) => k.jwk) }), { status: 200 });
    }
    if (url === `${ISSUER}/oauth/token`) {
      const body = new URLSearchParams(init.body);
      calls.token.push(body);
      return new Response(JSON.stringify({ access_token: "a", id_token: mint(body) }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls };
}

const now = () => Math.floor(Date.now() / 1000);
const goodClaims = (nonce) => ({
  iss: ISSUER, aud: CLIENT_ID, sub: "sub-123", email: "Ada@Example.com", email_verified: true,
  name: "Ada Lovelace", iat: now(), exp: now() + 300, nonce,
});

function setup(claimsFor = goodClaims, { keyFor } = {}) {
  const key = keyPair("k1");
  let nonce = null;
  const provider = fakeProvider({
    keys: () => [key],
    mint: () => sign(keyFor ? keyFor(key) : key, claimsFor(nonce)),
  });
  const client = createClient({
    label: "test", issuer: ISSUER, clientId: CLIENT_ID, clientSecret: "s3cret",
    redirectUri: REDIRECT, fetchImpl: provider.fetchImpl,
  });
  const begin = (opts) => {
    const out = client.begin(opts);
    nonce = new URL(out.url).searchParams.get("nonce");
    return out;
  };
  return { client, begin, provider, key };
}

test("begin builds an authorisation request with PKCE, state, nonce and the hint", () => {
  const { begin } = setup();
  const { url, state } = begin({ returnTo: "/portal/projects", hint: "ada@example.com" });
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, `${ISSUER}/oauth/authorize`);
  const p = u.searchParams;
  assert.equal(p.get("client_id"), CLIENT_ID);
  assert.equal(p.get("redirect_uri"), REDIRECT);
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("scope"), "openid profile email");
  assert.equal(p.get("state"), state);
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.ok(p.get("code_challenge") && p.get("nonce"));
  assert.equal(p.get("login_hint"), "ada@example.com");
});

test("complete exchanges the code with the verifier and returns verified claims", async () => {
  const { begin, client, provider } = setup();
  const { url, state } = begin({ returnTo: "/portal/invoices" });
  const challenge = new URL(url).searchParams.get("code_challenge");
  const out = await client.complete({ state, code: "the-code" });
  assert.equal(out.claims.sub, "sub-123");
  assert.equal(out.claims.email_verified, true);
  assert.equal(out.returnTo, "/portal/invoices");
  const sent = provider.calls.token[0];
  assert.equal(sent.get("code"), "the-code");
  assert.equal(sent.get("client_secret"), "s3cret");
  assert.equal(sent.get("redirect_uri"), REDIRECT);
  // The verifier sent is the one whose hash was the challenge.
  assert.equal(crypto.createHash("sha256").update(sent.get("code_verifier")).digest("base64url"), challenge);
});

test("a state can be used once", async () => {
  const { begin, client } = setup();
  const { state } = begin();
  await client.complete({ state, code: "c" });
  await assert.rejects(client.complete({ state, code: "c" }), /expired or was already used/);
});

test("an unknown state is refused before any token request", async () => {
  const { client, provider } = setup();
  await assert.rejects(client.complete({ state: "nope", code: "c" }), /expired/);
  assert.equal(provider.calls.token.length, 0);
});

test("an error from the provider is reported", async () => {
  const { begin, client } = setup();
  const { state } = begin();
  await assert.rejects(client.complete({ state, error: "access_denied" }), /access_denied/);
});

const refusals = [
  ["another audience", (n) => ({ ...goodClaims(n), aud: "someone-else" }), /different application/],
  ["another issuer", (n) => ({ ...goodClaims(n), iss: "https://evil.test" }), /somewhere else/],
  ["an expired token", (n) => ({ ...goodClaims(n), exp: now() - 120 }), /expired/],
  ["a token not valid yet", (n) => ({ ...goodClaims(n), nbf: now() + 600 }), /not valid yet/],
  ["the wrong nonce", (n) => ({ ...goodClaims(n), nonce: `${n}x` }), /does not answer/],
];
for (const [what, claimsFor, why] of refusals) {
  test(`refuses ${what}`, async () => {
    const { begin, client } = setup(claimsFor);
    const { state } = begin();
    await assert.rejects(client.complete({ state, code: "c" }), why);
  });
}

test("refuses a token signed by a key that is not the published one (same kid)", async () => {
  const forged = keyPair("k1");
  const { begin, client } = setup(goodClaims, { keyFor: () => forged });
  const { state } = begin();
  await assert.rejects(client.complete({ state, code: "c" }), /signature/);
});

test("refuses alg:none however the header is written", async () => {
  const { client } = setup();
  const unsigned = `${b64({ alg: "none", kid: "k1" })}.${b64(goodClaims("n"))}.`;
  await assert.rejects(client.verifyIdToken(unsigned, "n"), /signature/);
});

test("an unknown kid refetches the key set once (key rotation)", async () => {
  const oldKey = keyPair("old");
  const newKey = keyPair("new");
  let published = [oldKey];
  let nonce = null;
  const provider = fakeProvider({ keys: () => published, mint: () => sign(newKey, goodClaims(nonce)) });
  const client = createClient({
    label: "t", issuer: ISSUER, clientId: CLIENT_ID, clientSecret: "s", redirectUri: REDIRECT,
    fetchImpl: provider.fetchImpl,
  });
  await client.jwks(); // warm cache with the old key only
  published = [oldKey, newKey];
  const { url, state } = client.begin();
  nonce = new URL(url).searchParams.get("nonce");
  const out = await client.complete({ state, code: "c" });
  assert.equal(out.claims.sub, "sub-123");
  assert.equal(provider.calls.jwks, 2);
});

test("not enabled without a secret", () => {
  const c = createClient({ label: "t", issuer: ISSUER, clientId: CLIENT_ID, clientSecret: "", redirectUri: REDIRECT });
  assert.equal(c.enabled, false);
});

/* ---------- the pages ---------- */

let ejs = null;
try { ejs = (await import("ejs")).default; } catch { /* not installed here */ }

const VIEWS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "views");
const render = (view, locals) =>
  ejs.renderFile(path.join(VIEWS, view), { title: "t", csrf: "x", flash: null, ...locals });

test("login: Continue with Vesopa above the password form only when switched on", { skip: !ejs && "ejs not installed" }, async () => {
  const on = await render("auth/login.ejs", { error: null, email: "ada@example.com", vesopaSso: true });
  assert.match(on, /Continue with Vesopa/);
  assert.match(on, /href="\/portal\/auth\/vesopa\/start\?hint=ada%40example\.com"/);
  assert.match(on, /or use your password/);
  assert.ok(on.indexOf("Continue with Vesopa") < on.indexOf('action="/portal/login"'));

  const off = await render("auth/login.ejs", { error: null, email: "" , vesopaSso: false });
  assert.doesNotMatch(off, /Continue with Vesopa/);
  assert.match(off, /autofocus/);

  // Rendered without the app's locals at all (a script, a test) it is simply off.
  const bare = await render("auth/login.ejs", { error: null, email: "" });
  assert.doesNotMatch(bare, /Continue with Vesopa/);

  const flashed = await render("auth/login.ejs", {
    error: null, email: "", vesopaSso: true, flash: { kind: "bad", message: "No confirmed address" },
  });
  assert.match(flashed, /notice bad">No confirmed address/);
});

test("register: the button is there when switched on", { skip: !ejs && "ejs not installed" }, async () => {
  const html = await render("auth/register.ejs", {
    error: null, quote: null, vesopaSso: true, form: { email: "", name: "", company: "", phone: "" },
  });
  assert.match(html, /Continue with Vesopa/);
  assert.match(html, /or create one with a password/);
});

test("invite: Join with your Vesopa account carries the invitation", { skip: !ejs && "ejs not installed" }, async () => {
  const invite = { org_name: "Metric Group", org_role: "member", email: "bob@example.com", name: "Bob" };
  const html = await render("auth/invite.ejs", { error: null, invite, token: "tok_123", vesopaSso: true });
  assert.match(html, /Join with your Vesopa account/);
  assert.match(html, /href="\/portal\/auth\/vesopa\/start\?invite=tok_123"/);
  assert.match(html, /rel="noreferrer"/);
  const dead = await render("auth/invite.ejs", { error: "gone", invite: null, token: null, vesopaSso: true });
  assert.doesNotMatch(dead, /Join with your Vesopa account/);
});

test("first set-password page offers Continue with Vesopa instead", { skip: !ejs && "ejs not installed" }, async () => {
  const first = await render("auth/reset.ejs", { error: null, token: "t", first: true, email: "ada@example.com", vesopaSso: true });
  assert.match(first, /or skip the password/);
  assert.match(first, /start\?hint=ada%40example\.com/);
  const reset = await render("auth/reset.ejs", { error: null, token: "t", first: false, email: "ada@example.com", vesopaSso: true });
  assert.doesNotMatch(reset, /Continue with Vesopa/);
});
