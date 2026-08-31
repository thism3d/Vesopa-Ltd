import { q, exec } from "./db.js";
import { toUser, toAdmins } from "./realtime.js";

/**
 * Persist a notification, then push it. Order matters: the row is the record,
 * the socket frame is only an accelerant. If the push fails nobody loses the
 * notification, they simply see it a moment later.
 */
export async function notify(userId, { kind, title, body = null, href = null }) {
  const res = await exec(
    "INSERT INTO notifications (user_id, kind, title, body, href) VALUES (?,?,?,?,?)",
    [userId, kind, title, body, href],
  );
  toUser(userId, "notification", { id: res.insertId, kind, title, body, href, created_at: new Date() });
  return res.insertId;
}

/** Same, for every admin — used for new quotes, enquiries and payments. */
export async function notifyAdmins({ kind, title, body = null, href = null }) {
  const admins = await q("SELECT id FROM users WHERE role='admin' AND status='active'");
  for (const a of admins) {
    await exec(
      "INSERT INTO notifications (user_id, kind, title, body, href) VALUES (?,?,?,?,?)",
      [a.id, kind, title, body, href],
    );
  }
  toAdmins("notification", { kind, title, body, href, created_at: new Date() });
}

export const unreadCount = async (userId) =>
  (await q("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL", [userId]))[0].n;

export const recent = (userId, limit = 12) =>
  q("SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT ?", [userId, limit]);
