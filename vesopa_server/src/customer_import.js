/**
 * Bringing customers in from a spreadsheet (2026-10-05).
 *
 * "A way of importing customers. Their name, loyalty scheme & how many
 * points they've got." (Nicki Tidbell.) A club moving to Vesopa arrives with
 * its members in Excel or a CSV from the till it is replacing, and typing two
 * hundred of them into the Add customer form is the thing that stops it going
 * live.
 *
 * It is the catalogue import's sibling (src/imports.js) and borrows its rules:
 * download the template, Check the file, then Import; an import is all or
 * nothing, so a file with any error writes nobody; and nobody is ever deleted
 * by an import.
 *
 * WHO IS ALREADY HERE
 *
 * A row is matched to an existing customer by card number, then email, then
 * phone, in that order: a card number is the venue's own key and the most
 * likely to be right, a phone number the most likely to be shared. A matched
 * customer is updated with what the row says; a blank cell leaves that field
 * alone, exactly as the catalogue import does.
 *
 * POINTS
 *
 * The Points column is the balance the member HAS, not points to add, because
 * that is what the old system's export says. The difference is written to the
 * loyalty ledger as an adjustment noted "Imported", so the member's history
 * explains their balance. Joining a scheme by import gives no welcome points:
 * the balance in the file already includes whatever the old system gave.
 */
const crypto = require('crypto');

const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');

const { requireAuth } = require('./auth');
const {
  MAX_BYTES,
  clean,
  headerKey,
  readRows,
  makeReport,
  parseInteger,
  parseYesNo,
} = require('./imports');
const { ensureMemberNumber } = require('./member_numbers');
const loyaltySchemes = require('./loyalty_schemes');

const SHEET_CUSTOMERS = 'Customers';

/** The columns, in the order the template shows them. */
const COLUMNS = [
  { key: 'name', header: 'Name', width: 28, required: true },
  { key: 'email', header: 'Email', width: 30 },
  { key: 'phone', header: 'Phone', width: 18 },
  { key: 'card_number', header: 'Card number', width: 18 },
  { key: 'scheme', header: 'Loyalty scheme', width: 22 },
  { key: 'points', header: 'Points', width: 10 },
  { key: 'membership_expiry', header: 'Membership expiry', width: 18 },
  { key: 'marketing_opt_in', header: 'Marketing', width: 12 },
  { key: 'postcode', header: 'Postcode', width: 12 },
  { key: 'notes', header: 'Notes', width: 30 },
];

/** Other names an old system's export uses for the same column. */
const ALIASES = {
  name: ['fullname', 'customer', 'customername', 'member', 'membername'],
  email: ['emailaddress'],
  phone: ['mobile', 'telephone', 'phonenumber', 'mobilenumber'],
  card_number: ['card', 'cardno', 'memberno', 'membernumber', 'membershipnumber'],
  scheme: ['scheme', 'loyalty', 'loyaltyscheme', 'membershiptype', 'tier'],
  points: ['pointsbalance', 'balance', 'loyaltypoints'],
  membership_expiry: ['expiry', 'expires', 'expirydate', 'renewaldate', 'paiduntil'],
  marketing_opt_in: ['marketingoptin', 'optin', 'newsletter'],
};

const EXAMPLES = [
  ['Gareth Evans', 'gareth@example.com', '07700 900123', '', 'Members', 120, '2027-05-31', 'Yes', 'SA8 4AA', ''],
  ['Sian Morgan', '', '07700 900456', '', 'Vice Presidents', 0, '2027-05-31', 'No', '', 'Committee'],
];

/** The columns readRows looks for: the template's headings and their aliases. */
function headerColumns() {
  const out = [];
  for (const c of COLUMNS) {
    out.push(c);
    for (const alias of ALIASES[c.key] || []) out.push({ key: c.key, header: alias });
  }
  return out;
}

/** A date as YYYY-MM-DD. Blank is null; nonsense is undefined. */
function parseDate(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // What Excel hands over for a date cell, through cellText.
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  let y; let mo; let d;
  if (m) [, y, mo, d] = m;
  else {
    // A UK date as people type it: 31/05/2027 or 31-05-27.
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
    if (!m) return undefined;
    [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
  }
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return undefined;
  return iso;
}

const normEmail = (v) => String(v ?? '').trim().toLowerCase();
const normPhone = (v) => String(v ?? '').replace(/[^\d+]/g, '');
const normCard = (v) => String(v ?? '').replace(/\s+/g, '');

/**
 * Read the file into records and per-row errors. Nothing here touches the
 * database, so it is tested on its own.
 */
function parseCustomers(worksheet, schemes) {
  const report = makeReport(SHEET_CUSTOMERS);
  const { rows, found, unknown } = readRows(worksheet, headerColumns());
  const byName = new Map(schemes.map((s) => [headerKey(s.name), s]));

  if (!found.has('name')) {
    report.fail(1, 'There is no Name column. Start from the template, or call the column "Name".');
  }

  const records = [];
  for (const { row, values } of rows) {
    const r = { row };
    const name = clean(values.name).slice(0, 255);
    if (!name) {
      report.fail(row, 'A customer needs a name.');
      continue;
    }
    r.name = name;

    const email = normEmail(values.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      report.fail(row, `"${values.email}" is not an email address.`);
    }
    r.email = email || null;
    r.phone = clean(values.phone).slice(0, 64) || null;
    r.card_number = normCard(values.card_number).slice(0, 64) || null;

    if (values.scheme) {
      const scheme = byName.get(headerKey(values.scheme));
      if (!scheme) {
        report.fail(
          row,
          `There is no loyalty scheme called "${values.scheme}". ` +
            (schemes.length
              ? `Use one of: ${schemes.map((s) => s.name).join(', ')}.`
              : 'Add it under Loyalty › Schemes first.')
        );
      } else r.scheme_id = scheme.id;
    }

    const points = parseInteger(values.points);
    if (points === undefined || (points !== null && points < 0)) {
      report.fail(row, `"${values.points}" is not a number of points.`);
    } else if (points !== null) r.points = points;

    const expiry = parseDate(values.membership_expiry);
    if (expiry === undefined) {
      report.fail(row, `"${values.membership_expiry}" is not a date. Use 31/05/2027 or 2027-05-31.`);
    } else if (expiry !== null) r.membership_expiry = expiry;

    const opt = parseYesNo(values.marketing_opt_in);
    if (opt === undefined) report.fail(row, `Marketing should be Yes or No, not "${values.marketing_opt_in}".`);
    else if (opt !== null) r.marketing_opt_in = opt;

    if (values.postcode) r.postcode = clean(values.postcode).toUpperCase().slice(0, 16);
    if (values.notes) r.notes = clean(values.notes).slice(0, 500);
    records.push(r);
  }

  return { records, errors: report.errors, unknownColumns: unknown };
}

/** The template a venue fills in. */
async function buildCustomerTemplate() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Vesopa EPOS';
  workbook.created = new Date();
  const help = workbook.addWorksheet('How to use this');
  help.columns = [{ width: 100 }];
  for (const line of [
    'Fill in the Customers sheet and upload it under Import › Customers in the back office.',
    '',
    'Name is the only column you must fill in. Leave any other cell blank to leave it as it is.',
    'Loyalty scheme must match the name of a scheme you have set up under Loyalty › Schemes.',
    'Points is the balance the customer has now, not points to add.',
    'Membership expiry is the date their paid membership runs to, for example 31/05/2027.',
    'Marketing is Yes or No: whether they agreed to hear from you.',
    '',
    'A customer already in Vesopa is found by card number, then email, then phone, and updated.',
    'Nobody is ever deleted by an import. Press Check first: nothing is written until you press Import.',
    'Delete the example rows before you upload, or they will be imported as customers.',
  ]) help.addRow([line]);

  const sheet = workbook.addWorksheet(SHEET_CUSTOMERS);
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true };
  for (const ex of EXAMPLES) sheet.addRow(ex);
  return workbook.xlsx.writeBuffer();
}

/** An .xlsx or a .csv, as the worksheet the parser reads. */
async function readUpload(file) {
  const workbook = new ExcelJS.Workbook();
  const name = String(file.originalname || '').toLowerCase();
  const isCsv = name.endsWith('.csv') || /csv|text\/plain/.test(String(file.mimetype || ''));
  if (isCsv) {
    const { Readable } = require('stream');
    // A BOM from Excel's "CSV UTF-8" would otherwise become part of the first heading.
    const text = file.buffer.toString('utf8').replace(/^﻿/, '');
    return workbook.csv.read(Readable.from([text]));
  }
  await workbook.xlsx.load(file.buffer);
  return workbook.getWorksheet(SHEET_CUSTOMERS) ||
    workbook.worksheets.find((w) => w.name !== 'How to use this') ||
    workbook.worksheets[0];
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

function customerImportRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  async function tenantEmail(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (office) return office.contact_email;
    }
    return req.user.email;
  }

  router.get('/import/customers/template', auth, async (_req, res, next) => {
    try {
      const buffer = await buildCustomerTemplate();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="vesopa-customers-template.xlsx"');
      res.send(Buffer.from(buffer));
    } catch (e) { next(e); }
  });

  async function run(req, res, apply) {
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    let worksheet;
    try {
      worksheet = await readUpload(req.file);
    } catch {
      return res.status(400).json({ error: 'That file could not be read. Save it as .xlsx or .csv and try again.' });
    }
    if (!worksheet) return res.status(400).json({ error: 'That file has no sheets in it.' });

    const office = await tenantEmail(req);
    let schemes = [];
    try {
      schemes = await loyaltySchemes.listSchemes(pool, office, { activeOnly: true });
    } catch { /* a venue without schemes still imports names and points */ }

    const parsed = parseCustomers(worksheet, schemes);

    const [existing] = await pool.query(
      `SELECT id, name, email, phone, card_number, points_balance
         FROM epos_customers WHERE email_key = ?`,
      [office]
    );
    const byCard = new Map();
    const byEmail = new Map();
    const byPhone = new Map();
    for (const c of existing) {
      if (c.card_number) byCard.set(normCard(c.card_number), c);
      if (c.email) byEmail.set(normEmail(c.email), c);
      if (c.phone && normPhone(c.phone).length >= 6) byPhone.set(normPhone(c.phone), c);
    }

    // Who each row is. A row repeating an earlier one in the same file is the
    // same customer: the later row wins, as in the catalogue import.
    const seen = new Map();
    const plan = [];
    const summary = { created: 0, updated: 0, repeated: 0, points: 0 };
    for (const r of parsed.records) {
      const key = (r.card_number && `c:${r.card_number}`) || (r.email && `e:${r.email}`) ||
        (r.phone && normPhone(r.phone).length >= 6 && `p:${normPhone(r.phone)}`) || `n:${r.row}`;
      const match = (r.card_number && byCard.get(r.card_number)) ||
        (r.email && byEmail.get(r.email)) ||
        (r.phone && byPhone.get(normPhone(r.phone))) || null;
      if (seen.has(key)) {
        summary.repeated += 1;
        Object.assign(seen.get(key), r);
        continue;
      }
      const step = { ...r, match };
      seen.set(key, step);
      plan.push(step);
      if (match) summary.updated += 1; else summary.created += 1;
    }
    for (const p of plan) if (p.points != null) summary.points += p.points;

    const blocked = parsed.errors.length > 0;
    const willApply = apply && !blocked && plan.length > 0;

    if (willApply) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const p of plan) await writeOne(conn, office, p);
        await conn.commit();
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
      } finally {
        conn.release();
      }
      // Member numbers and card-number matching, after the commit: neither
      // throws, and neither is worth rolling a whole import back for.
      for (const p of plan) {
        if (p.card_number) await loyaltySchemes.syncMemberNoToCard(pool, office, p.id, p.card_number);
        await ensureMemberNumber(pool, office, p.id);
      }
      broadcast({ type: 'customers.updated' });
    }

    res.json({
      applied: willApply,
      blocked,
      summary,
      rows: parsed.records.length,
      errors: parsed.errors,
      unknownColumns: parsed.unknownColumns,
    });
  }

  router.post('/import/customers/preview', auth, upload.single('file'), async (req, res, next) => {
    try { await run(req, res, false); } catch (e) { next(e); }
  });
  router.post('/import/customers', auth, upload.single('file'), async (req, res, next) => {
    try {
      await run(req, res, true);
    } catch (e) {
      if (e && e.code && String(e.code).startsWith('ER_')) {
        console.error('[customer import] refused by the database:', e.sqlMessage || e.message);
        return res.status(409).json({
          error: `The customers could not be written: ${e.sqlMessage || e.message}. Nothing was imported.`,
        });
      }
      next(e);
    }
  });

  return router;
}

/** Write one planned row: a new customer, or what the row says onto a match. */
async function writeOne(conn, office, p) {
  const before = p.match ? Number(p.match.points_balance) || 0 : 0;
  if (p.match) {
    p.id = p.match.id;
    const sets = ['name = ?'];
    const vals = [p.name];
    for (const col of ['email', 'phone', 'card_number', 'membership_expiry', 'notes']) {
      if (p[col] != null) { sets.push(`${col} = ?`); vals.push(p[col]); }
    }
    if (p.points != null) { sets.push('points_balance = ?'); vals.push(p.points); }
    await conn.execute(
      `UPDATE epos_customers SET ${sets.join(', ')} WHERE id = ? AND email_key = ?`,
      [...vals, p.id, office]
    );
  } else {
    p.id = crypto.randomUUID();
    await conn.execute(
      `INSERT INTO epos_customers
         (id, email_key, name, phone, email, card_number, points_balance, membership_expiry, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, office, p.name, p.phone, p.email, p.card_number, p.points ?? 0,
        p.membership_expiry ?? null, p.notes ?? null]
    );
  }

  // Scheme, marketing and postcode, where the database has the columns. Set
  // directly rather than through joinScheme: no welcome points on an import.
  await loyaltySchemes.saveCustomerExtras(conn, office, p.id, {
    scheme_id: p.scheme_id,
    marketing_opt_in: p.marketing_opt_in,
    postcode: p.postcode,
  });

  const delta = p.points == null ? 0 : p.points - before;
  if (delta !== 0) {
    try {
      await conn.execute(
        `INSERT INTO epos_loyalty_txns (id, office, customer_id, kind, points, balance_after, note)
         VALUES (UUID(), ?, ?, 'adjust', ?, ?, 'Imported')`,
        [office, p.id, delta, p.points]
      );
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
  }
}

module.exports = {
  SHEET_CUSTOMERS,
  COLUMNS,
  parseDate,
  parseCustomers,
  buildCustomerTemplate,
  readUpload,
  customerImportRoutes,
};
