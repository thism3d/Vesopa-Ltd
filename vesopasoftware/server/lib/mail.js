import nodemailer from "nodemailer";
import { config } from "./config.js";
import { exec } from "./db.js";

let transport = null;

function getTransport() {
  if (transport) return transport;
  transport =
    config.mail.mode === "smtp"
      ? nodemailer.createTransport({
          host: config.mail.host,
          port: config.mail.port,
          secure: config.mail.secure,
          auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
        })
      // jsonTransport serialises the message and delivers nowhere. Nothing can
      // escape to a real inbox while MAIL_MODE=mock, which is what makes the
      // seeded demo data safe to play with.
      : nodemailer.createTransport({ jsonTransport: true });
  return transport;
}

/**
 * Send, and log either way. A failed send never throws into a request: a
 * customer who submitted a quote should get their confirmation page even if
 * our mail host is down, because the quote is already saved.
 */
export async function sendMail({ to, subject, text, html, template = null }) {
  const mode = config.mail.mode;
  let status = "sent";
  let error = null;

  try {
    await getTransport().sendMail({ from: config.mail.from, to, subject, text, html });
    if (mode === "mock") {
      console.log(`\n  ✉  [mock mail] → ${to}\n     ${subject}\n     ${(text || "").split("\n")[0]}\n`);
    }
  } catch (err) {
    status = "failed";
    error = String(err.message || err).slice(0, 500);
    console.error(`  ✉  mail failed → ${to}: ${error}`);
  }

  try {
    await exec(
      `INSERT INTO email_log (to_email, subject, body, template, mode, status, error)
       VALUES (?,?,?,?,?,?,?)`,
      [to, subject, html || text || null, template, mode, status, error],
    );
  } catch (err) {
    console.error("  ✉  could not write email_log:", err.message);
  }

  return { status, error };
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** House style for every transactional mail: one ink block, one lime rule. */
export function layout({ heading, lines = [], cta = null }) {
  const body = lines.map((l) => `<p style="margin:0 0 14px;line-height:1.6">${l}</p>`).join("");
  const button = cta
    ? `<p style="margin:26px 0 0"><a href="${esc(cta.href)}" style="display:inline-block;
        background:#A5C715;color:#0B0E0A;text-decoration:none;padding:12px 22px;
        border-radius:2px;font-weight:700">${esc(cta.label)}</a></p>`
    : "";
  return `<div style="background:#0B0E0A;padding:32px">
  <div style="max-width:560px;margin:0 auto;background:#F2EFE6;color:#0B0E0A;
       font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;padding:32px">
    <div style="border-left:3px solid #A5C715;padding-left:12px;margin-bottom:24px;
         font-weight:700;letter-spacing:.02em">VESOPA SOFTWARE</div>
    <h1 style="font-size:22px;margin:0 0 18px;line-height:1.2">${esc(heading)}</h1>
    ${body}${button}
    <p style="margin:28px 0 0;font-size:12px;opacity:.6;border-top:1px solid rgba(11,14,10,.15);padding-top:14px">
      Vesopa Software Ltd · Baglan, Port Talbot SA12 7AX · +44 1792 316282
    </p>
  </div></div>`;
}

export { esc };
