import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const ROOT = path.resolve(here, "..", "..");
export const SERVER_DIR = path.resolve(here, "..");
export const SITE_DIR = path.join(ROOT, "site");

export const config = {
  env: process.env.NODE_ENV || "development",
  port: num(process.env.PORT, 5090),
  baseUrl: (process.env.BASE_URL || "http://localhost:5090").replace(/\/$/, ""),

  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD ?? "root",
    database: process.env.DB_NAME || "vesopa_portal",
    socketPath: process.env.DB_SOCKET || undefined,
  },

  session: {
    secret: process.env.SESSION_SECRET || "vesopa-dev-secret-not-for-production",
    ttlDays: num(process.env.SESSION_TTL_DAYS, 14),
  },

  mail: {
    mode: process.env.MAIL_MODE === "smtp" ? "smtp" : "mock",
    from: process.env.MAIL_FROM || "Vesopa Software <info@vesopasoftware.com>",
    admin: process.env.MAIL_ADMIN || "info@vesopasoftware.com",
    host: process.env.SMTP_HOST || "",
    port: num(process.env.SMTP_PORT, 587),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
  },

  payment: {
    mode: process.env.PAYMENT_MODE === "off" ? "off" : "mock",
  },

  currency: process.env.CURRENCY || "GBP",
  taxRate: num(process.env.TAX_RATE, 0),
};

export const isProd = config.env === "production";
