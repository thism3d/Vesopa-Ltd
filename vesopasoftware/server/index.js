import express from "express";
import session from "express-session";
import MySQLStoreFactory from "express-mysql-session";
import http from "node:http";
import path from "node:path";
import { config, isProd, SITE_DIR, SERVER_DIR } from "./lib/config.js";
import { assertConnection, migrate, pool, one } from "./lib/db.js";
import { attach } from "./lib/realtime.js";
import { startBillingScheduler } from "./lib/billing.js";
import { loadUser, csrf } from "./lib/auth.js";
import { money, moneyRound } from "./lib/pricing.js";
import { STATUS_LABEL, PROJECT_STATUS, balanceOf, isOverdue } from "./lib/invoices.js";

import publicRoutes from "./routes/public.js";
import aiRoutes from "./routes/ai.js";
import authRoutes from "./routes/auth.js";
import customerRoutes from "./routes/customer.js";
import adminRoutes from "./routes/admin.js";

const app = express();
app.disable("x-powered-by");
// Behind nginx in production; needed for secure cookies and real client IPs.
app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(SERVER_DIR, "views"));

app.use(express.urlencoded({ extended: false, limit: "200kb" }));
app.use(express.json({ limit: "200kb" }));

const MySQLStore = MySQLStoreFactory(session);
const store = new MySQLStore({ createDatabaseTable: true, charset: "utf8mb4_unicode_ci" }, pool);

// Held in a variable because the websocket upgrade handler runs the very same
// middleware over the upgrade request — one session implementation, one cookie.
const sessionMiddleware = session({
  name: "vesopa.sid",
  secret: config.session.secret,
  store,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: config.session.ttlDays * 24 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);

app.use(loadUser);

// Helpers every template can reach without being passed them one by one.
app.locals.money = money;
app.locals.moneyRound = moneyRound;
app.locals.STATUS_LABEL = STATUS_LABEL;
app.locals.PROJECT_STATUS = PROJECT_STATUS;
app.locals.balanceOf = balanceOf;
app.locals.isOverdue = isOverdue;
app.locals.currency = config.currency;
app.locals.paymentMode = config.payment.mode;
app.locals.date = (d) =>
  d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
app.locals.datetime = (d) =>
  d ? new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

// Flash messages: one-shot notices that survive exactly one redirect.
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.path = req.path;
  next();
});
app.use((req, res, next) => {
  req.flash = (kind, message) => { req.session.flash = { kind, message }; };
  next();
});

/* ---------- public API, deliberately ahead of the CSRF guard ----------
   /api/quote and /api/contact are anonymous: they read nothing from the
   session and act with nobody's authority, so a forged cross-site POST to
   them achieves exactly what an honest one does — it files a lead. There is
   no privilege to steal, and the marketing site is static HTML that cannot
   carry a per-session token. They are defended by the rate limiter and the
   honeypot field in routes/public.js instead.
   Everything below this line does carry authority, and is guarded. */
app.use("/api", publicRoutes);
// Vesopa AI sits on the same side of the line and for the same reason: it is
// anonymous, it acts with nobody's authority, and it is posted from static
// HTML that carries no session token. Its own rate limiter is what stops it
// being used as a free model endpoint.
app.use("/api", aiRoutes);

app.use(csrf);

/* ---------- portal assets (before the catch-all static site) ---------- */
app.use("/portal/static", express.static(path.join(SERVER_DIR, "public"), {
  maxAge: isProd ? "7d" : 0,
}));

/* ---------- routes ---------- */
app.use("/portal", authRoutes);
app.use("/portal", customerRoutes);
app.use("/portal/admin", adminRoutes);

/* ---------- the marketing site ----------
   express.static answers HTTP Range requests with a 206. The old
   tools/serve.py (SimpleHTTPRequestHandler) does not, and Safari refuses to
   play an <video> source that cannot be range-requested — which is why the
   clips looked broken there and fine in Chrome. */
app.use(
  express.static(SITE_DIR, {
    extensions: ["html"],
    setHeaders(res, filePath) {
      if (/\.(webp|png|jpg|svg|mp4|woff2?)$/i.test(filePath)) {
        // Hashless filenames, so keep it short in dev and let nginx override live.
        res.setHeader("Cache-Control", isProd ? "public, max-age=604800" : "no-cache");
      }
    },
  }),
);

app.use((req, res) => {
  if (req.path.startsWith("/portal") || req.path.startsWith("/api")) {
    return res.status(404).render("error", {
      title: "Nothing here",
      message: "That page does not exist.",
      back: "/portal",
    });
  }
  res.status(404).sendFile(path.join(SITE_DIR, "index.html"));
});

// eslint-disable-next-line no-unused-vars -- express identifies error handlers by arity
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render("error", {
    title: "That went wrong at our end",
    message: isProd ? "Something failed on the server. We have logged it." : String(err.stack || err),
    back: "/portal",
  });
});

const boot = async () => {
  await assertConnection();
  await migrate();

  const server = http.createServer(app);

  // The live channel shares this port and this session cookie, so nothing has
  // to be opened, proxied or authenticated separately.
  attach(server, sessionMiddleware, (userId) =>
    one("SELECT id, role, name, email, status, org_id, org_role FROM users WHERE id = ?", [userId]));

  startBillingScheduler();

  server.listen(config.port, () => {
    console.log(`\n  Vesopa Software`);
    console.log(`  site    http://localhost:${config.port}/`);
    console.log(`  portal  http://localhost:${config.port}/portal`);
    console.log(`  admin   http://localhost:${config.port}/portal/admin`);
    console.log(`  live    ws://localhost:${config.port}/portal/ws`);
    console.log(`  mail=${config.mail.mode}  payments=${config.payment.mode}  db=${config.db.database}\n`);
  });
};

boot().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
