import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { one, exec } from "./db.js";

const ROUNDS = 10;

export const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);
export const checkPassword = (plain, hash) => bcrypt.compare(plain, hash);

/** Password rules kept deliberately mild: length is what matters, and a rule
 *  set that rejects a good passphrase pushes people to "Password1!". */
export function passwordProblem(pw) {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters.";
  if (pw.length > 200) return "Password is too long.";
  return null;
}

export const normaliseEmail = (e) => String(e || "").trim().toLowerCase();

export function emailProblem(email) {
  const e = normaliseEmail(email);
  if (!e) return "Email is required.";
  if (e.length > 190) return "Email is too long.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return "That does not look like an email address.";
  return null;
}

export async function findUserByEmail(email) {
  return one("SELECT * FROM users WHERE email = ? LIMIT 1", [normaliseEmail(email)]);
}

export async function createUser({ email, password, name, company, phone, role = "customer" }) {
  const res = await exec(
    `INSERT INTO users (role, email, password_hash, name, company, phone)
     VALUES (?,?,?,?,?,?)`,
    [role, normaliseEmail(email), await hashPassword(password), name, company || null, phone || null],
  );
  return res.insertId;
}

/* ---------- middleware ---------- */

/** Loads req.user from the session on every request. A session pointing at a
 *  deleted or suspended account is destroyed rather than trusted. */
export async function loadUser(req, res, next) {
  res.locals.user = null;
  if (!req.session?.userId) return next();
  try {
    // org_id and org_role must be here: lib/permissions.js decides every
    // customer-side capability from org_role, and a missing column reads as
    // undefined, which silently denies everything.
    const user = await one(
      `SELECT id, role, org_id, org_role, job_title, email, name, company, phone, status
         FROM users WHERE id = ? LIMIT 1`,
      [req.session.userId],
    );
    if (!user || user.status !== "active") {
      req.session.destroy(() => {});
      return next();
    }
    req.user = user;
    res.locals.user = user;
  } catch (err) {
    return next(err);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    // Send them back where they were headed once they are in.
    req.session.returnTo = req.originalUrl;
    return res.redirect("/portal/login");
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect("/portal/login");
  }
  if (req.user.role !== "admin") return res.status(403).render("error", {
    title: "Not your door",
    message: "That area is for Vesopa staff. Your projects are on your dashboard.",
    back: "/portal",
  });
  next();
}

/* ---------- CSRF ----------
   A per-session token compared in constant time. csurf is deprecated and
   unmaintained; this is the whole of what it did for a same-site form app. */

export function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString("hex");
  res.locals.csrf = req.session.csrf;
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const sent = String(req.body?._csrf || req.get("x-csrf-token") || "");
  const want = req.session.csrf;
  const ok =
    sent.length === want.length &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want));
  if (!ok) {
    return res.status(403).render("error", {
      title: "That form went stale",
      message: "Security check failed — the page was probably open a long time. Go back and try again.",
      back: req.get("referer") || "/portal",
    });
  }
  next();
}
