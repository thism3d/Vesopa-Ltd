/**
 * Two jobs, once a minute:
 *
 *   * finish what a grace day put off, for apps with no grace of their own
 *     (Gift): when a pause's day is up, switch it off;
 *   * the owner's daily summary ("Owner and venue"): at 08:00 London time,
 *     every change in the last day, to OWNER_EMAIL. Sent once a day, and a
 *     day with no changes sends nothing.
 */
const db = require('./db');
const gift = require('./apps/gift');
const audit = require('./audit');
const mail = require('./mail');
const config = require('./config');

async function runDue(now = new Date()) {
  const due = await db.all(
    'SELECT * FROM adm_scheduled WHERE done_at IS NULL AND cancelled_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 20',
    [now]
  );
  for (const job of due) {
    try {
      if (job.app === 'gift' && (job.action === 'pause' || job.action === 'remove')) {
        await gift.disable(job.venue_id, job.actor || 'admin.vesopa.com');
      }
      await db.run('UPDATE adm_scheduled SET done_at = UTC_TIMESTAMP() WHERE id = ?', [job.id]);
      await audit.record({ actor: job.actor || 'admin.vesopa.com', action: `${job.item}.${job.action}.stopped`, app: job.app, venueId: job.venue_id, item: job.item, detail: 'The grace day ended.' });
    } catch (e) {
      await db.run('UPDATE adm_scheduled SET error = ? WHERE id = ?', [String(e.message).slice(0, 255), job.id]);
    }
  }
  return due.length;
}

const londonDay = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const londonHour = (d) => Number(d.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }));

function summaryMail(rows, day) {
  const esc = mail.esc;
  const list = rows.map((r) => {
    const when = new Date(r.at).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
    return `<tr><td style="padding:6px 8px;color:#6b7262">${esc(when)}</td><td style="padding:6px 8px">${esc(r.venue_name || '')}</td>`
      + `<td style="padding:6px 8px">${esc(r.action)}${r.ok ? '' : ' <b style="color:#c0392b">failed</b>'}</td><td style="padding:6px 8px;color:#6b7262">${esc(r.actor)}</td></tr>`;
  }).join('');
  return {
    subject: `admin.vesopa.com: ${rows.length} change${rows.length === 1 ? '' : 's'} in the last day`,
    html: mail.shell(`Changes up to ${day}`, `<table style="width:100%;border-collapse:collapse;font-size:13px">${list}</table>`
      + `<p><a href="${config.BASE_URL}/audit">See the audit log</a></p>`),
    text: rows.map((r) => `${r.at} ${r.venue_name || ''} ${r.action} ${r.ok ? '' : 'FAILED '}by ${r.actor}`).join('\n'),
  };
}

async function dailySummary(now = new Date()) {
  if (londonHour(now) < 8) return false;
  const day = londonDay(now);
  const last = await db.one("SELECT v FROM adm_state WHERE k = 'summary_day'");
  if (last && last.v === day) return false;
  await db.run("INSERT INTO adm_state (k, v) VALUES ('summary_day', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [day]);
  const rows = await audit.recent({ limit: 500, since: new Date(now.valueOf() - 24 * 3600 * 1000) });
  const changes = rows.filter((r) => !/^(signin|signout)/.test(r.action));
  if (!changes.length) return false;
  await mail.send({ to: config.OWNER_EMAIL, ...summaryMail(changes.reverse(), day) });
  return true;
}

function start() {
  const tick = async () => {
    try { await runDue(); } catch (e) { console.warn('[scheduler] due:', e.message); }
    try { await dailySummary(); } catch (e) { console.warn('[scheduler] summary:', e.message); }
  };
  const t = setInterval(tick, 60 * 1000);
  t.unref();
  setTimeout(tick, 5000).unref();
}

module.exports = { start, runDue, dailySummary, summaryMail };
