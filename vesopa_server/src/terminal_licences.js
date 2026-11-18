/**
 * Terminals: licensed once by access key, settings kept in the back office.
 *
 * Nicky, 2026-11-04, showing Newbridge's console: "the till needs to work 24/7
 * without asking customers to log in", and "each terminal all the settings are
 * saved to the back office so we never lose the settings".
 *
 * WHAT A TERMINAL IS
 *
 * A numbered device of one kind at one venue, under an optional site: company,
 * site, terminal, as Newbridge lays it out. The row exists before the machine
 * does, so a manager can set up "Till 3" and its printers first and hand the
 * key to whoever is installing it. `bo_terminals` sits beside the licence seats
 * and does not replace them: a licensed machine still holds a seat, and the
 * seat is still what signing a device out takes back (src/till_seats.js).
 *
 * THE KEY OPENS ONE DEVICE AND NOTHING ELSE
 *
 * Licensing issues a device token and no back-office session. Somebody who
 * reads a key off a till can run that one till and cannot see a single page of
 * the back office, because `requireAuth` refuses every scoped token.
 *
 * It binds to the first machine that presents it. The same machine can present
 * it again, which is how a reinstall gets going with nobody signing in. Another
 * machine is refused until a manager moves the licence, so a key copied into a
 * second PC is not a second till.
 *
 * SETTINGS ARE ROWS, NOT A BLOB
 *
 * One row per setting, each with the terminal's revision number when it last
 * changed. Rows are what let the page search, edit one value, and copy one
 * value or a whole category to another till, and revisions are what let it say
 * which changes a till has not picked up yet ("View pending updates").
 *
 * Tills that exist already enrol themselves: the first time one reports, a
 * terminal row is made for it and its own settings fill the rows. Nothing has
 * to be typed in for a venue that is already open, and until a till reports
 * there is no row at all, so this changes nothing for it.
 */
'use strict';

const crypto = require('crypto');

const express = require('express');
const jwt = require('jsonwebtoken');

const licences = require('./licences');
const tillSeats = require('./till_seats');
const { attachAccess, requirePermission } = require('./permissions');

/** Devices licensed here. The kiosk has its own commission and 10-year token. */
const LICENSED_KINDS = ['till', 'go', 'kitchen', 'display'];
const ALL_KINDS = [...LICENSED_KINDS, 'express'];

/** Which product a device token is for. Read off the token, never the caller. */
const SCOPE_KINDS = {
  terminal: ['till', 'go'],
  kitchen: ['kitchen'],
  display: ['display'],
  express: ['express'],
};

const DEVICE_TOKEN_TTL = '3650d';

/** Who takes this device's cards, where it differs from the venue. '' follows the venue. */
const CARD_PROVIDERS = ['', 'dojo', 'teya', 'barclays', 'stripe'];
const MAX_ROWS = 800;
const MAX_VALUE = 8000;

const clamp = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const asInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * May this machine use this terminal's key?
 *
 * The fingerprint is the hash of things a copied install cannot bring along, so
 * it decides when both sides have one. The device id only decides when one of
 * them does not, because a reinstall changes the id on the very same machine.
 */
function bindDecision(row, { fingerprint, deviceId }) {
  if (!row.device_fingerprint && !row.device_id) return 'bind';
  if (row.device_fingerprint && fingerprint) {
    return row.device_fingerprint === fingerprint ? 'same' : 'other';
  }
  if (row.device_id && deviceId) return row.device_id === deviceId ? 'same' : 'other';
  // Nothing to compare: an older app sending neither. Treated as another
  // machine, because accepting it would let any caller holding a copied key in.
  return 'other';
}

/**
 * Which pushed values a till may write.
 *
 * A row changed in the back office after the revision the till last read is
 * left alone: the till has not seen it, so what it is pushing is the old value,
 * and the manager's change has to survive. It reaches the till on its next pull.
 */
function mergeValues(existing, values, baseRev) {
  const byKey = new Map(existing.map((r) => [`${r.category}\u0000${r.name}`, r]));
  const write = [];
  const held = [];
  for (const v of values) {
    const row = byKey.get(`${v.category}\u0000${v.name}`);
    if (row && row.value === v.value) continue;
    if (row && Number(row.rev) > baseRev) {
      held.push({ category: v.category, name: v.name });
      continue;
    }
    write.push(v);
  }
  return { write, held };
}

/** Clean what a device or a page sent, dropping anything that is not a setting. */
function cleanValues(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, MAX_ROWS)) {
    const category = clamp(item && item.category, 48);
    const name = clamp(item && item.name, 80);
    if (!category || !name) continue;
    const value = JSON.stringify(item.value === undefined ? null : item.value);
    if (value.length > MAX_VALUE) continue;
    out.push({ category, name, value });
  }
  return out;
}

/** Rows for a page: `pending` is what the terminal has not picked up yet. */
function rowsForPage(rows, appliedRev) {
  return rows.map((r) => ({
    category: r.category,
    name: r.name,
    value: parse(r.value),
    updated_by: r.updated_by || null,
    updated_at: r.updated_at || null,
    pending: Number(r.rev) > appliedRev,
  }));
}

function parse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** One terminal for a page. Never the key: it is shown once, when issued. */
function terminalView(row) {
  return {
    id: row.id,
    kind: row.kind,
    label: licences.LABELS[row.kind] || row.kind,
    number: row.terminal_no,
    name: row.name,
    site_id: row.site_id,
    key_prefix: row.key_prefix,
    device_name: row.device_name,
    bound: Boolean(row.device_fingerprint || row.device_id),
    version: row.app_version,
    card_provider: row.card_provider || '',
    licensed_at: row.licensed_at,
    last_ping_at: row.last_ping_at,
    revoked_at: row.revoked_at,
    settings_rev: Number(row.settings_rev),
    applied_rev: Number(row.applied_rev),
    pending: Math.max(0, Number(row.settings_rev) - Number(row.applied_rev)),
  };
}

/** Ten wrong tries from one address in fifteen minutes, then it waits. */
function attemptLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const seen = new Map();
  return {
    blocked(ip) {
      const hit = seen.get(ip);
      if (!hit) return false;
      if (Date.now() - hit.since > windowMs) {
        seen.delete(ip);
        return false;
      }
      return hit.count >= max;
    },
    failed(ip) {
      const hit = seen.get(ip);
      if (hit && Date.now() - hit.since <= windowMs) hit.count += 1;
      else seen.set(ip, { count: 1, since: Date.now() });
    },
    passed(ip) {
      seen.delete(ip);
    },
  };
}

/** The store. Every route below is a thin door onto these. */
function terminalStore(pool) {
  let ready = null;
  function ensure() {
    ready ||= (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS bo_terminals (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        office VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
        kind VARCHAR(24) NOT NULL DEFAULT 'till',
        terminal_no INT NOT NULL,
        name VARCHAR(80) NULL,
        site_id INT NULL,
        key_hash CHAR(64) NULL,
        key_prefix VARCHAR(40) NULL,
        device_id VARCHAR(64) NULL,
        device_fingerprint VARCHAR(64) NULL,
        device_name VARCHAR(120) NULL,
        seat_id VARCHAR(64) NULL,
        app_version VARCHAR(32) NULL,
        settings_rev BIGINT NOT NULL DEFAULT 0,
        applied_rev BIGINT NOT NULL DEFAULT 0,
        licensed_at DATETIME NULL,
        last_ping_at DATETIME NULL,
        revoked_at DATETIME NULL,
        revoked_by VARCHAR(191) NULL,
        created_by VARCHAR(191) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_terminal_number (office, kind, terminal_no),
        UNIQUE KEY uq_terminal_key (key_hash),
        KEY idx_terminal_device (office, device_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS bo_terminal_settings (
        terminal_id INT NOT NULL,
        category VARCHAR(48) NOT NULL,
        name VARCHAR(80) NOT NULL,
        value TEXT NOT NULL,
        rev BIGINT NOT NULL DEFAULT 0,
        updated_by VARCHAR(191) NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (terminal_id, category, name),
        KEY idx_terminal_rev (terminal_id, rev)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    })().catch((e) => {
      ready = null;
      throw e;
    });
    return ready;
  }

  async function list(office) {
    await ensure();
    const [rows] = await pool.query(
      'SELECT * FROM bo_terminals WHERE office = ? ORDER BY kind, terminal_no',
      [office]
    );
    if (rows.length) {
      const [chosen] = await pool.query(
        `SELECT terminal_id, value FROM bo_terminal_settings
          WHERE category = 'Payment' AND name = 'card_provider' AND terminal_id IN (?)`,
        [rows.map((r) => r.id)]
      );
      const by = new Map(chosen.map((c) => [c.terminal_id, parse(c.value)]));
      for (const r of rows) r.card_provider = by.get(r.id) || '';
    }
    return rows;
  }

  async function get(office, id) {
    await ensure();
    const [[row]] = await pool.query('SELECT * FROM bo_terminals WHERE id = ? AND office = ?', [
      id,
      office,
    ]);
    return row || null;
  }

  async function nextNumber(office, kind) {
    const [[row]] = await pool.query(
      'SELECT COALESCE(MAX(terminal_no), 0) + 1 AS n FROM bo_terminals WHERE office = ? AND kind = ?',
      [office, kind]
    );
    return Number(row.n);
  }

  /**
   * A new terminal and its key. `enforce` is true for a venue's manager, who
   * issues keys within the seats the venue pays for. The platform admin sets
   * those limits, so is not held to them.
   */
  async function create(office, { kind, name, siteId, number, by, enforce }) {
    await ensure();
    if (enforce) {
      const limit = await licences.limitFor(pool, office, kind);
      if (limit != null) {
        const [[row]] = await pool.query(
          `SELECT COUNT(*) AS n FROM bo_terminals
            WHERE office = ? AND kind = ? AND revoked_at IS NULL`,
          [office, kind]
        );
        if (Number(row.n) >= limit) {
          const e = new Error(
            `All ${limit} ${licences.LABELS[kind] || kind} licences are in use. ` +
              'Withdraw one, or ask Vesopa for more.'
          );
          e.status = 409;
          throw e;
        }
      }
    }
    const made = licences.newKey(kind);
    const no = number || (await nextNumber(office, kind));
    let result;
    try {
      [result] = await pool.execute(
        `INSERT INTO bo_terminals
           (office, kind, terminal_no, name, site_id, key_hash, key_prefix, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [office, kind, no, name || null, siteId || null, made.hash, made.prefix, by || null]
      );
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      const dup = new Error(`There is already a ${licences.LABELS[kind] || kind} number ${no}.`);
      dup.status = 409;
      throw dup;
    }
    return { id: result.insertId, key: made.key };
  }

  /** A fresh key for a terminal. The old key stops; the running device does not. */
  async function reissue(office, id) {
    const row = await get(office, id);
    if (!row) return null;
    const made = licences.newKey(row.kind);
    await pool.execute(
      'UPDATE bo_terminals SET key_hash = ?, key_prefix = ?, revoked_at = NULL, revoked_by = NULL WHERE id = ?',
      [made.hash, made.prefix, id]
    );
    return { id, key: made.key };
  }

  async function update(office, id, { name, siteId, number }) {
    const row = await get(office, id);
    if (!row) return null;
    try {
      await pool.execute(
        'UPDATE bo_terminals SET name = ?, site_id = ?, terminal_no = ? WHERE id = ?',
        [
          name === undefined ? row.name : name || null,
          siteId === undefined ? row.site_id : siteId || null,
          number || row.terminal_no,
          id,
        ]
      );
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      const dup = new Error(`There is already a ${row.kind} number ${number}.`);
      dup.status = 409;
      throw dup;
    }
    return get(office, id);
  }

  /** Let the key work on a new machine. The settings stay with the terminal. */
  async function unbind(office, id, by) {
    const row = await get(office, id);
    if (!row) return null;
    if (row.seat_id) {
      await tillSeats.releaseSeat(pool, {
        office,
        seatId: row.seat_id,
        by,
        reason: 'licence moved to another machine',
      });
    }
    await pool.execute(
      `UPDATE bo_terminals
          SET device_id = NULL, device_fingerprint = NULL, device_name = NULL, seat_id = NULL
        WHERE id = ?`,
      [id]
    );
    return get(office, id);
  }

  /** Take the licence back. The seat goes, so the device stops on its next call. */
  async function revoke(office, id, by) {
    const row = await unbind(office, id, by);
    if (!row) return null;
    await pool.execute('UPDATE bo_terminals SET revoked_at = NOW(), revoked_by = ? WHERE id = ?', [
      by || null,
      id,
    ]);
    return get(office, id);
  }

  async function settings(terminalId) {
    const [rows] = await pool.query(
      'SELECT * FROM bo_terminal_settings WHERE terminal_id = ? ORDER BY category, name',
      [terminalId]
    );
    return rows;
  }

  /** Write rows at the terminal's next revision. No rows, no new revision. */
  async function writeSettings(terminalId, values, by) {
    if (!values.length) return null;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('UPDATE bo_terminals SET settings_rev = settings_rev + 1 WHERE id = ?', [
        terminalId,
      ]);
      const [[row]] = await conn.query('SELECT settings_rev FROM bo_terminals WHERE id = ?', [
        terminalId,
      ]);
      for (const v of values) {
        await conn.execute(
          `INSERT INTO bo_terminal_settings (terminal_id, category, name, value, rev, updated_by)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE value = VALUES(value), rev = VALUES(rev),
             updated_by = VALUES(updated_by)`,
          [terminalId, v.category, v.name, v.value, row.settings_rev, by || null]
        );
      }
      await conn.commit();
      return Number(row.settings_rev);
    } catch (e) {
      try { await conn.rollback(); } catch { /* already done */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  /** Copy one row, a category or everything to other terminals of the venue. */
  async function copy(office, fromId, { to, category, name, by }) {
    const from = await get(office, fromId);
    if (!from) return null;
    const rows = (await settings(fromId)).filter(
      (r) => (!category || r.category === category) && (!name || r.name === name)
    );
    const values = rows.map((r) => ({ category: r.category, name: r.name, value: r.value }));
    const copied = [];
    for (const id of to) {
      if (id === fromId) continue;
      const target = await get(office, id);
      // A kitchen screen has no use for a till's printers, and the reverse.
      if (!target || target.kind !== from.kind) continue;
      await writeSettings(id, values, by);
      copied.push(id);
    }
    return { copied, rows: values.length };
  }

  /** Find the terminal this device is, making the row the first time it reports. */
  async function enrol(office, { kind, deviceId, deviceName, version }) {
    await ensure();
    const [[found]] = await pool.query(
      'SELECT * FROM bo_terminals WHERE office = ? AND device_id = ? AND kind = ? AND revoked_at IS NULL',
      [office, deviceId, kind]
    );
    if (found) return found;
    const no = await nextNumber(office, kind);
    try {
      await pool.execute(
        `INSERT INTO bo_terminals
           (office, kind, terminal_no, name, device_id, device_name, app_version, licensed_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'enrolled')`,
        [office, kind, no, deviceName || null, deviceId, deviceName || null, version || null]
      );
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      // Two devices reporting at once took the same number: this one asks again.
      return enrol(office, { kind, deviceId, deviceName, version });
    }
    const [[row]] = await pool.query(
      'SELECT * FROM bo_terminals WHERE office = ? AND device_id = ? AND kind = ?',
      [office, deviceId, kind]
    );
    return row;
  }

  /**
   * Which terminal this machine is (Nicky, 2026-11-18): "when we sign in to a
   * new terminal ... ask which terminal number this till is. ... if a till
   * dies or breaks it will be listed by its PC name and new terminal, which is
   * incorrect and needs to report under the terminal it's replacing."
   *
   * `number` empty: a new terminal, the next number. `number` given: this
   * machine becomes that terminal. The machine it replaces gives its seat
   * back; a row this machine made for itself before it was asked was never a
   * terminal of its own, and goes. A terminal still in use elsewhere in the
   * last ten minutes is only taken when `confirm` says so.
   */
  async function claim(office, { kind, deviceId, deviceName, number, name, seatId, confirm }) {
    await ensure();
    const [[mine]] = await pool.query(
      'SELECT * FROM bo_terminals WHERE office = ? AND kind = ? AND device_id = ? AND revoked_at IS NULL',
      [office, kind, deviceId]
    );
    const rename = async (id) => {
      if (name) await pool.execute('UPDATE bo_terminals SET name = ? WHERE id = ?', [name, id]);
      return get(office, id);
    };
    if (!number) {
      const row = mine || (await enrol(office, { kind, deviceId, deviceName }));
      return { row: await rename(row.id) };
    }
    const [[target]] = await pool.query(
      'SELECT * FROM bo_terminals WHERE office = ? AND kind = ? AND terminal_no = ?',
      [office, kind, number]
    );
    if (target && mine && target.id === mine.id) return { row: await rename(target.id) };
    if (target && target.device_id && target.device_id !== deviceId && !confirm && target.last_ping_at &&
        Date.now() - new Date(target.last_ping_at).getTime() < 10 * 60 * 1000) {
      return {
        busy: {
          number: target.terminal_no,
          name: target.name,
          device_name: target.device_name,
          last_ping_at: target.last_ping_at,
        },
      };
    }
    if (mine) {
      if (mine.created_by === 'enrolled' && !mine.key_hash) {
        await pool.execute('DELETE FROM bo_terminal_settings WHERE terminal_id = ?', [mine.id]);
        await pool.execute('DELETE FROM bo_terminals WHERE id = ?', [mine.id]);
      } else {
        // A terminal of its own (it had a key): it lets go of this machine,
        // and keeps its number and settings for whatever replaces it.
        await pool.execute(
          `UPDATE bo_terminals SET device_id = NULL, device_fingerprint = NULL, device_name = NULL,
                  seat_id = NULL WHERE id = ?`,
          [mine.id]
        );
      }
    }
    if (!target) {
      await pool.execute(
        `INSERT INTO bo_terminals
           (office, kind, terminal_no, name, device_id, device_name, seat_id, licensed_at, last_ping_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'claimed')`,
        [office, kind, number, name || null, deviceId, deviceName || null, seatId || null]
      );
    } else {
      if (target.seat_id && target.seat_id !== seatId) {
        await tillSeats.releaseSeat(pool, {
          office,
          seatId: target.seat_id,
          by: deviceName || 'a replacement till',
          reason: 'replaced by another machine',
        });
      }
      await pool.execute(
        `UPDATE bo_terminals
            SET device_id = ?, device_name = ?, device_fingerprint = NULL, seat_id = ?,
                name = COALESCE(?, name), revoked_at = NULL, revoked_by = NULL,
                licensed_at = COALESCE(licensed_at, NOW()), last_ping_at = NOW()
          WHERE id = ?`,
        [deviceId, deviceName || null, seatId || null, name || null, target.id]
      );
    }
    const [[row]] = await pool.query(
      'SELECT * FROM bo_terminals WHERE office = ? AND kind = ? AND terminal_no = ?',
      [office, kind, number]
    );
    return { row };
  }

  async function ping(id, { version, appliedRev, fingerprint }) {
    await pool.execute(
      `UPDATE bo_terminals
          SET last_ping_at = NOW(), app_version = COALESCE(?, app_version),
              applied_rev = GREATEST(applied_rev, ?),
              device_fingerprint = COALESCE(device_fingerprint, ?)
        WHERE id = ?`,
      [version || null, appliedRev || 0, fingerprint || null, id]
    );
  }

  return {
    pool, ensure, list, get, create, reissue, update, unbind, revoke, settings,
    writeSettings, copy, enrol, claim, ping,
  };
}

/** The credential a licensed device runs on. Scoped, so never a back-office login. */
function deviceToken({ kind, office, officeId, terminal, seatId, secret }) {
  const by = `terminal ${terminal.terminal_no}`;
  const options = { expiresIn: DEVICE_TOKEN_TTL, ...(seatId ? { jwtid: seatId } : {}) };
  if (kind === 'kitchen' || kind === 'display') {
    return jwt.sign(
      { scope: kind, office, user: by, name: terminal.name || by, via: 'access-key' },
      secret,
      options
    );
  }
  return jwt.sign({ scope: 'terminal', office, officeId, commissionedBy: by }, secret, options);
}

/** Pages: the venue's own, and admin.vesopa.com's for any venue. */
function pageRoutes(store, router, officeOf, { enforce, guard }) {
  const load = async (req, res) => {
    const office = await officeOf(req);
    if (!office) {
      res.status(404).json({ error: 'No such venue' });
      return null;
    }
    return office;
  };
  const who = (req) => (req.user && req.user.email) || null;

  router.get('/', guard, async (req, res, next) => {
    try {
      const office = await load(req, res);
      if (!office) return;
      const rows = await store.list(office);
      const [[venue]] = await store.pool.query('SELECT id FROM offices WHERE contact_email = ?', [office]);
      res.json({
        terminals: rows.map(terminalView),
        kinds: LICENSED_KINDS,
        // What a person types on the device, with the number and the key.
        venue_code: venue ? venue.id : null,
      });
    } catch (e) { next(e); }
  });

  router.post('/', guard, express.json(), async (req, res, next) => {
    try {
      const office = await load(req, res);
      if (!office) return;
      const body = req.body || {};
      const kind = clamp(body.kind, 24) || 'till';
      if (!LICENSED_KINDS.includes(kind)) return res.status(400).json({ error: 'Not a device kind' });
      const made = await store.create(office, {
        kind,
        name: clamp(body.name, 80),
        siteId: asInt(body.site_id),
        number: asInt(body.number),
        by: who(req),
        enforce,
      });
      // The only time the whole key is ever shown.
      res.status(201).json({ ...terminalView(await store.get(office, made.id)), key: made.key });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.put('/:id', guard, express.json(), async (req, res, next) => {
    try {
      const office = await load(req, res);
      if (!office) return;
      const body = req.body || {};
      const row = await store.update(office, asInt(req.params.id), {
        name: body.name === undefined ? undefined : clamp(body.name, 80),
        siteId: body.site_id === undefined ? undefined : asInt(body.site_id),
        number: asInt(body.number),
      });
      if (!row) return res.status(404).json({ error: 'No such terminal' });
      res.json(terminalView(row));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.post('/:id/key', guard, async (req, res, next) => {
    try {
      const office = await load(req, res);
      if (!office) return;
      const made = await store.reissue(office, asInt(req.params.id));
      if (!made) return res.status(404).json({ error: 'No such terminal' });
      res.json({ ...terminalView(await store.get(office, made.id)), key: made.key });
    } catch (e) { next(e); }
  });

  for (const [path, act] of [['unbind', 'unbind'], ['revoke', 'revoke']]) {
    router.post(`/:id/${path}`, guard, async (req, res, next) => {
      try {
        const office = await load(req, res);
        if (!office) return;
        const row = await store[act](office, asInt(req.params.id), who(req));
        if (!row) return res.status(404).json({ error: 'No such terminal' });
        res.json(terminalView(row));
      } catch (e) { next(e); }
    });
  }

  router.put('/:id/provider', guard, express.json(), async (req, res, next) => {
    try {
      const office = await load(req, res);
      if (!office) return;
      const provider = clamp((req.body || {}).provider, 16);
      if (!CARD_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'That is not a card provider' });
      const row = await store.get(office, asInt(req.params.id));
      if (!row) return res.status(404).json({ error: 'No such terminal' });
      await store.writeSettings(row.id, [{
        category: 'Payment', name: 'card_provider', value: JSON.stringify(provider),
      }], who(req));
      res.json({ ok: true, provider });
    } catch (e) { next(e); }
  });

  router.get('/:id/settings', guard, async (req, res, next) => {
    try {
      const office = await load(req, res);
      if (!office) return;
      const row = await store.get(office, asInt(req.params.id));
      if (!row) return res.status(404).json({ error: 'No such terminal' });
      const rows = await store.settings(row.id);
      res.json({ terminal: terminalView(row), settings: rowsForPage(rows, Number(row.applied_rev)) });
    } catch (e) { next(e); }
  });

  router.put('/:id/settings', guard, express.json({ limit: '1mb' }), async (req, res, next) => {
    try {
      const office = await load(req, res);
      if (!office) return;
      const row = await store.get(office, asInt(req.params.id));
      if (!row) return res.status(404).json({ error: 'No such terminal' });
      const rev = await store.writeSettings(row.id, cleanValues((req.body || {}).values), who(req));
      res.json({ ok: true, rev });
    } catch (e) { next(e); }
  });

  router.post('/:id/settings/copy', guard, express.json(), async (req, res, next) => {
    try {
      const office = await load(req, res);
      if (!office) return;
      const body = req.body || {};
      const to = (Array.isArray(body.to) ? body.to : []).map(asInt).filter(Boolean);
      const done = await store.copy(office, asInt(req.params.id), {
        to,
        category: clamp(body.category, 48),
        name: clamp(body.name, 80),
        by: who(req),
      });
      if (!done) return res.status(404).json({ error: 'No such terminal' });
      res.json(done);
    } catch (e) { next(e); }
  });
}

/** A device's own credential, whichever app it is. */
function requireDevice(secret) {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    let claims;
    try {
      claims = jwt.verify(token || '', secret);
    } catch {
      return res.status(401).json({ error: 'This device is not signed in' });
    }
    const kinds = SCOPE_KINDS[claims.scope];
    if (!kinds || !claims.office) return res.status(401).json({ error: 'Not a device token' });
    try {
      const seat = await tillSeats.seatFor(claims, token);
      if (seat && seat.released) {
        return res.status(401).json({ error: 'This device was signed out', signed_out: true });
      }
    } catch (e) {
      // As in requireTerminal: a licence lookup must never stop a venue trading.
      console.warn('[terminal_licences] could not check a seat:', e.message);
    }
    const asked = clamp((req.body && req.body.kind) || req.query.kind, 24);
    req.deviceKind = kinds.includes(asked) ? asked : kinds[0];
    req.office = claims.office;
    req.deviceSeat = claims.jti || null;
    next();
  };
}

function terminalLicenceRoutes({ pool, secret, auth, requireAdmin }) {
  const router = express.Router();
  const store = terminalStore(pool);
  const limiter = attemptLimiter();
  const device = requireDevice(secret);

  /**
   * License a device. Venue code, terminal number, access key; no person.
   *
   * Every wrong answer gets the same words, so this cannot be used to find out
   * which venues exist or which numbers they have.
   */
  router.post('/api/terminal/license', express.json(), async (req, res, next) => {
    try {
      const ip = req.ip;
      if (limiter.blocked(ip)) {
        return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
      }
      await store.ensure();
      const body = req.body || {};
      const refuse = () => {
        limiter.failed(ip);
        return res.status(403).json({ error: 'Those details do not match a terminal.', licence_key: true });
      };
      const venue = asInt(body.venue_code);
      const number = asInt(body.terminal_number);
      const key = clamp(body.access_key, 64);
      if (!venue || !number || !key) return refuse();

      const [[row]] = await pool.query(
        `SELECT t.*, o.id AS office_id, o.name AS office_name
           FROM bo_terminals t
           JOIN offices o
             ON o.contact_email COLLATE utf8mb4_general_ci = t.office COLLATE utf8mb4_general_ci
          WHERE t.key_hash = ?`,
        [licences.hashKey(key)]
      );
      if (!row || Number(row.office_id) !== venue || row.terminal_no !== number) return refuse();
      if (row.revoked_at) return refuse();
      if (!LICENSED_KINDS.includes(row.kind)) return refuse();
      // A till's key is not a kitchen screen's, or one key would run two apps.
      if (clamp(body.device_kind, 24) !== row.kind) return refuse();

      const fingerprint = clamp(body.device_fingerprint, 64);
      const deviceId = clamp(body.device_id, 64);
      const deviceName = clamp(body.device_name, 120);
      if (bindDecision(row, { fingerprint, deviceId }) === 'other') {
        limiter.failed(ip);
        return res.status(403).json({
          error:
            `This licence is in use on ${row.device_name || 'another machine'}. ` +
            'A manager can move it from Terminals in the back office.',
          licence_key: true,
        });
      }

      const answer = await licensed(row, { fingerprint, deviceId, deviceName, version: clamp(body.app_version, 32) });
      limiter.passed(ip);
      res.status(answer.status || 200).json(answer.body);
    } catch (e) { next(e); }
  });

  /**
   * A machine the back office knows, come back with no session.
   *
   * Pontardawe's lounge till logged the manager out and lost its printers on
   * 2026-11-04. The fingerprint is a hash of things that survive that, and it
   * only ever finds a terminal of this venue that has not been withdrawn, so
   * the worst a copied hash can do is run that one till: no back-office access.
   */
  router.post('/api/terminal/relicense', express.json(), async (req, res, next) => {
    try {
      const ip = req.ip;
      if (limiter.blocked(ip)) return res.status(429).json({ error: 'Too many tries.' });
      await store.ensure();
      const body = req.body || {};
      const fingerprint = clamp(body.device_fingerprint, 64);
      const kind = clamp(body.device_kind, 24);
      if (fingerprint.length < 16 || !LICENSED_KINDS.includes(kind)) {
        limiter.failed(ip);
        return res.status(404).json({ error: 'This machine is not known.' });
      }
      const [[row]] = await pool.query(
        `SELECT t.*, o.id AS office_id, o.name AS office_name
           FROM bo_terminals t
           JOIN offices o
             ON o.contact_email COLLATE utf8mb4_general_ci = t.office COLLATE utf8mb4_general_ci
          WHERE t.device_fingerprint = ? AND t.kind = ? AND t.revoked_at IS NULL
          ORDER BY t.last_ping_at DESC LIMIT 1`,
        [fingerprint, kind]
      );
      if (!row) {
        limiter.failed(ip);
        return res.status(404).json({ error: 'This machine is not known.' });
      }
      const answer = await licensed(row, {
        fingerprint,
        deviceId: clamp(body.device_id, 64),
        deviceName: row.device_name,
        version: clamp(body.app_version, 32),
      });
      res.status(answer.status || 200).json(answer.body);
    } catch (e) { next(e); }
  });

  /** A seat and a token for a terminal, and the row brought up to date. */
  async function licensed(row, { fingerprint, deviceId, deviceName, version }) {
      let seatId;
      try {
        seatId = await tillSeats.claimSeat(pool, {
          office: row.office,
          kind: row.kind,
          deviceId,
          deviceName,
          fingerprint,
          by: `terminal ${row.terminal_no}`,
        });
      } catch (e) {
        if (e instanceof tillSeats.SeatLimitError) return { status: 409, body: { error: e.message } };
        throw e;
      }

      await pool.execute(
        `UPDATE bo_terminals
            SET device_id = ?, device_fingerprint = COALESCE(?, device_fingerprint),
                device_name = ?, seat_id = ?, app_version = ?,
                licensed_at = COALESCE(licensed_at, NOW()), last_ping_at = NOW()
          WHERE id = ?`,
        [
          deviceId || null, fingerprint || null, deviceName || null, seatId,
          version || null, row.id,
        ]
      );

      const token = deviceToken({
        kind: row.kind,
        office: row.office,
        officeId: row.office_id,
        terminal: row,
        seatId,
        secret,
      });
      return { body: {
        // The device token in both places, and no person's session. The till
        // treats it as it does a session that has run out: the back office
        // refuses it, and everything a till does runs on its terminal token.
        token,
        terminalToken: token,
        user: {
          name: row.name || `Terminal ${row.terminal_no}`,
          officeEmail: row.office,
          officeName: row.office_name,
        },
        office: row.office,
        office_id: row.office_id,
        venue: row.office_name,
        terminal: terminalView(row),
      } };
  }

  // -------------------------------------------------------------------------
  // Scan and connect (2026-11-16)
  // -------------------------------------------------------------------------
  //
  // A TV has no browser to sign in with and a remote is no way to type a venue
  // code, a number and an access key (the owner: "in the Vesopa Go TV app it
  // should be like scan and connect"). So the screen shows a code and a QR,
  // and somebody who is already in the venue lets it in: a signed-in Vesopa Go
  // phone scans it, or it is typed on Terminals in the back office.
  //
  //   start    the screen asks for a code. Nothing is created yet.
  //   approve  a device or a back-office user of the venue says yes: a Go
  //            licence is made for the screen, exactly as Terminals makes one.
  //   poll     the screen collects its venue code, number and access key, once,
  //            and licenses itself with them through /api/terminal/license.
  //
  // The code is short because a person may have to read it across a room; the
  // secret the screen polls with is long and never shown. Both last ten
  // minutes. Kept in memory: a restart only means the screen asks again.
  const LINK_MINUTES = 10;
  const LINK_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const links = new Map(); // code -> { secret, device, until, grant }

  function linkSweep() {
    const now = Date.now();
    for (const [code, link] of links) if (link.until < now) links.delete(code);
  }
  function linkCode() {
    const bytes = crypto.randomBytes(8);
    let out = '';
    for (let i = 0; i < 8; i += 1) out += LINK_ALPHABET[bytes[i] % LINK_ALPHABET.length];
    return out;
  }
  const cleanCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

  router.post('/api/device/link/start', express.json(), (req, res) => {
    const ip = req.ip;
    if (limiter.blocked(ip)) {
      return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
    }
    linkSweep();
    if (links.size > 2000) return res.status(503).json({ error: 'Busy. Try again in a minute.' });
    const body = req.body || {};
    let code = linkCode();
    while (links.has(code)) code = linkCode();
    const secret = crypto.randomBytes(32).toString('hex');
    links.set(code, {
      secret,
      until: Date.now() + LINK_MINUTES * 60 * 1000,
      device: {
        name: clamp(body.device_name, 80) || 'Screen',
        tv: body.tv === true,
        version: clamp(body.app_version, 32),
      },
      grant: null,
    });
    res.json({
      code,
      secret,
      // What the QR holds. A phone's camera opens the page; Vesopa Go reads
      // the code out of it.
      url: `https://go.vesopa.com/link/?c=${code}`,
      expires_in: LINK_MINUTES * 60,
    });
  });

  /** A venue's device, or one of its back-office users. Either may let a screen in. */
  async function linkApprover(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    let claims;
    try {
      claims = jwt.verify(token, secret);
    } catch {
      return res.status(401).json({ error: 'Sign in first.' });
    }
    try {
      if (SCOPE_KINDS[claims.scope] && claims.office) {
        req.office = claims.office;
        req.linkBy = `device:${claims.commissionedBy || claims.scope}`;
        return next();
      }
      if (claims.officeId && claims.email) {
        const [[office]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [claims.officeId]);
        if (!office) return res.status(403).json({ error: 'No venue to connect it to.' });
        req.office = office.contact_email;
        req.linkBy = claims.email;
        return next();
      }
      return res.status(403).json({ error: 'This sign-in cannot connect a screen.' });
    } catch (e) {
      return next(e);
    }
  }

  router.post('/api/device/link/approve', express.json(), linkApprover, async (req, res, next) => {
    try {
      const ip = req.ip;
      if (limiter.blocked(ip)) {
        return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
      }
      linkSweep();
      const body = req.body || {};
      const code = cleanCode(body.code);
      const link = links.get(code);
      if (!link) {
        limiter.failed(ip);
        return res.status(404).json({ error: 'That code is not on a screen now. Check it, or get a new one on the screen.' });
      }
      if (link.grant) return res.status(409).json({ error: 'That screen is already connected.' });

      const mode = ['epos', 'kitchen', 'display', 'terminal'].includes(body.mode) ? body.mode : 'display';
      const name = clamp(body.name, 80) || link.device.name;
      const made = await store.create(req.office, { kind: 'go', name, by: req.linkBy, enforce: true });
      const row = await store.get(req.office, made.id);
      const [[venue]] = await pool.query('SELECT id, name FROM offices WHERE contact_email = ?', [req.office]);
      link.grant = {
        venue_code: venue ? venue.id : null,
        terminal_number: row.terminal_no,
        access_key: made.key,
        mode,
        venue: venue ? venue.name : null,
      };
      limiter.passed(ip);
      res.json({ ok: true, name, mode, venue: venue ? venue.name : null, terminal_number: row.terminal_no });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.post('/api/device/link/poll', express.json(), (req, res) => {
    linkSweep();
    const body = req.body || {};
    const link = links.get(cleanCode(body.code));
    const given = Buffer.from(String(body.secret || ''));
    if (!link || given.length !== link.secret.length || !crypto.timingSafeEqual(given, Buffer.from(link.secret))) {
      return res.status(404).json({ status: 'gone', error: 'This code has run out. Get a new one.' });
    }
    if (!link.grant) return res.json({ status: 'waiting', expires_in: Math.max(0, Math.round((link.until - Date.now()) / 1000)) });
    // Handed over once. The key is the screen's from here.
    links.delete(cleanCode(body.code));
    res.json({ status: 'approved', ...link.grant });
  });

  /** A device's own terminal and settings. Also its "last ping". */
  router.get('/api/device/terminal', device, async (req, res, next) => {
    try {
      const deviceId = clamp(req.query.device_id, 64);
      if (!deviceId) return res.status(400).json({ error: 'device_id is required' });
      const row = await store.enrol(req.office, {
        kind: req.deviceKind,
        deviceId,
        deviceName: clamp(req.query.device_name, 120),
        version: clamp(req.query.version, 32),
      });
      await store.ping(row.id, {
        version: clamp(req.query.version, 32),
        appliedRev: Math.max(0, Number(req.query.applied_rev) || 0),
        fingerprint: clamp(req.query.fingerprint, 64),
      });
      const rows = await store.settings(row.id);
      res.json({
        terminal: terminalView(row),
        rev: Number(row.settings_rev),
        settings: rows.map((r) => ({ category: r.category, name: r.name, value: parse(r.value) })),
      });
    } catch (e) { next(e); }
  });

  /**
   * The venue's terminals of this kind, for a till being signed in to say
   * which one it is: number, name, and the machine each was last on.
   */
  router.get('/api/device/terminals', device, async (req, res, next) => {
    try {
      const deviceId = clamp(req.query.device_id, 64);
      const rows = (await store.list(req.office)).filter(
        (r) => r.kind === req.deviceKind && !r.revoked_at
      );
      res.json({
        terminals: rows.map((r) => ({
          number: r.terminal_no,
          name: r.name,
          device_name: r.device_name,
          last_ping_at: r.last_ping_at,
          version: r.app_version,
          mine: Boolean(deviceId) && r.device_id === deviceId,
        })),
      });
    } catch (e) { next(e); }
  });

  /** This machine is terminal `number` (or a new one). See store.claim. */
  router.post('/api/device/terminal/claim', express.json(), device, async (req, res, next) => {
    try {
      const body = req.body || {};
      const deviceId = clamp(body.device_id, 64);
      if (!deviceId) return res.status(400).json({ error: 'device_id is required' });
      const number = body.number == null || body.number === '' ? null : asInt(body.number);
      if (body.number != null && body.number !== '' && !number) {
        return res.status(400).json({ error: 'A terminal number is a whole number from 1.' });
      }
      const done = await store.claim(req.office, {
        kind: req.deviceKind,
        deviceId,
        deviceName: clamp(body.device_name, 120),
        number,
        name: clamp(body.name, 80) || null,
        seatId: req.deviceSeat,
        confirm: body.confirm === true,
      });
      if (done.busy) {
        const b = done.busy;
        return res.status(409).json({
          busy: true,
          error: `Terminal ${b.number}${b.name ? ` (${b.name})` : ''} is still in use on ` +
            `${b.device_name || 'another machine'}. Replace it anyway? That machine will be signed out.`,
        });
      }
      res.json({ terminal: terminalView(done.row) });
    } catch (e) { next(e); }
  });

  /** A device's local changes, sent up. Also how an open venue's tills fill in. */
  router.put('/api/device/terminal/settings', express.json({ limit: '1mb' }), device, async (req, res, next) => {
    try {
      const body = req.body || {};
      const deviceId = clamp(body.device_id, 64);
      if (!deviceId) return res.status(400).json({ error: 'device_id is required' });
      const row = await store.enrol(req.office, { kind: req.deviceKind, deviceId });
      const existing = await store.settings(row.id);
      const { write, held } = mergeValues(
        existing,
        cleanValues(body.values),
        Math.max(0, Number(body.base_rev) || 0)
      );
      const rev = await store.writeSettings(row.id, write, 'device');
      // What it just sent is what it runs, so it has nothing of its own pending.
      if (rev) await store.ping(row.id, { appliedRev: held.length ? 0 : rev });
      res.json({ rev: rev || Number(row.settings_rev), written: write.length, held });
    } catch (e) { next(e); }
  });

  const venueRouter = express.Router();
  pageRoutes(
    store,
    venueRouter,
    async (req) => {
      const [[row]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [
        req.user.officeId,
      ]);
      return row ? row.contact_email : null;
    },
    {
      enforce: true,
      guard: [auth, attachAccess({ pool }), requirePermission('programming.devices')],
    }
  );
  router.use('/api/terminals', venueRouter);

  const adminRouter = express.Router({ mergeParams: true });
  pageRoutes(
    store,
    adminRouter,
    async (req) => {
      const [[row]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [
        req.params.officeId,
      ]);
      return row ? row.contact_email : null;
    },
    { enforce: false, guard: [auth, requireAdmin] }
  );
  router.use('/api/admin/offices/:officeId/terminals', adminRouter);

  return router;
}

/**
 * The provider chosen for one signed-in device, or '' to follow the venue.
 *
 * Never throws: every till and phone asks this on its way to taking a card, and
 * a failed read must leave it doing what the venue does.
 */
async function deviceProvider(pool, office, seatId) {
  if (!seatId) return '';
  try {
    const [[row]] = await pool.query(
      `SELECT s.value FROM bo_till_seats q
         JOIN bo_terminals t ON t.office = q.office AND t.device_id = q.device_id AND t.revoked_at IS NULL
         JOIN bo_terminal_settings s ON s.terminal_id = t.id
        WHERE q.id = ? AND q.office = ? AND s.category = 'Payment' AND s.name = 'card_provider'
        LIMIT 1`,
      [seatId, office]
    );
    const value = row ? parse(row.value) : '';
    return CARD_PROVIDERS.includes(value) ? value : '';
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') console.warn('[terminal_licences] could not read a device provider:', e.message);
    return '';
  }
}

module.exports = {
  terminalLicenceRoutes,
  requireDevice,
  deviceProvider,
  CARD_PROVIDERS,
  bindDecision,
  mergeValues,
  cleanValues,
  rowsForPage,
  attemptLimiter,
  deviceToken,
  terminalStore,
  LICENSED_KINDS,
  ALL_KINDS,
};
