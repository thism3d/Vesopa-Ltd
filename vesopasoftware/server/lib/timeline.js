/* The project timeline.
 *
 * A project's history lives in four tables — the conversation, the team's
 * published updates, the files, and the tasks — and the portal used to show
 * each of them in its own tab. That is fine if you were here all along and
 * wrong for everybody else: someone joining a project three weeks in had to
 * read four separate lists and hold the chronology in their head to work out
 * what had actually happened.
 *
 * So they are merged into one feed, newest last, the way a conversation reads.
 * Each entry keeps its own kind so the view can render a message as a bubble,
 * an update as a milestone and a file as a thumbnail, but they sit on one
 * spine in the order they happened.
 *
 * Nothing here queries. It takes what the route already loaded and arranges
 * it, so adding the hub cost no extra round trips.
 */

const time = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/**
 * @param {object} src
 * @param {Array} src.messages  open + visible-to-me thread, oldest first
 * @param {Array} src.updates   published progress updates
 * @param {Array} src.files     uploads
 * @param {Array} src.tasks     tasks, for the created/completed events
 * @returns {Array} entries, oldest first, each { kind, at, ...payload }
 */
export function buildTimeline({ messages = [], updates = [], files = [], tasks = [] } = {}) {
  const out = [];

  for (const m of messages) {
    out.push({
      kind: "message", at: m.created_at, id: m.id,
      author: m.author, authorRole: m.author_role, jobTitle: m.job_title,
      userId: m.user_id, body: m.body,
      private: Boolean(m.recipient_id),
      invoice: m.invoice_number ? {
        number: m.invoice_number, total: m.invoice_total, status: m.invoice_status,
        currency: m.invoice_currency, paid: m.invoice_paid,
      } : null,
      // Filled in below: uploads posted with this message.
      attachments: [],
    });
  }

  for (const u of updates) {
    out.push({
      kind: "update", at: u.created_at, id: u.id,
      author: u.author, title: u.title, body: u.body, progress: u.progress_pct,
    });
  }

  // A file posted with a message belongs inside that message; a file uploaded
  // on its own is an event in its own right.
  const byMessage = new Map();
  for (const f of files) {
    if (f.message_id) {
      if (!byMessage.has(f.message_id)) byMessage.set(f.message_id, []);
      byMessage.get(f.message_id).push(f);
    } else {
      out.push({
        kind: "file", at: f.created_at, id: f.id,
        name: f.original_name, mime: f.mime, size: f.size_bytes,
        uploader: f.uploader, side: f.side, caption: f.caption,
      });
    }
  }
  for (const entry of out) {
    if (entry.kind === "message" && byMessage.has(entry.id)) {
      entry.attachments = byMessage.get(entry.id);
    }
  }

  /* Tasks have no event log, and they do not need one: `created_at` and
     `done_at` are the two moments worth showing, and both are already on the
     row. Anything more would be a table to maintain for very little. */
  for (const t of tasks) {
    if (t.archived_at) continue;                    // archived work leaves the feed
    out.push({
      kind: "task", at: t.created_at, id: t.id, event: "added",
      title: t.title, status: t.status, assignee: t.assignee, due: t.due_date,
    });
    if (t.done_at) {
      out.push({
        kind: "task", at: t.done_at, id: t.id, event: "done",
        title: t.title, status: t.status, assignee: t.assignee, due: t.due_date,
      });
    }
  }

  out.sort((a, b) => time(a.at) - time(b.at));
  return out;
}

/** Group a sorted timeline by calendar day, for the date rules in the feed. */
export function groupByDay(entries) {
  const days = [];
  let current = null;
  for (const e of entries) {
    const d = new Date(e.at);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!current || current.key !== key) {
      current = { key, date: d, entries: [] };
      days.push(current);
    }
    current.entries.push(e);
  }
  return days;
}

/**
 * The calendar's month grid, with tasks hung on their due dates.
 *
 * Starts on a Monday, always six rows, so the grid does not change height as
 * the visitor pages through months — a calendar that resizes under the cursor
 * makes the next-month button move away from the pointer.
 */
export function monthGrid(year, month, tasks = []) {
  const byDay = new Map();
  for (const t of tasks) {
    if (!t.due_date || t.archived_at) continue;
    const d = new Date(t.due_date);
    if (d.getFullYear() !== year || d.getMonth() !== month) continue;
    const k = d.getDate();
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(t);
  }

  const first = new Date(year, month, 1);
  // getDay() is Sunday-first; the UK week starts on Monday.
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - lead);

  const today = new Date();
  const isToday = (d) =>
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth()
    && d.getDate() === today.getDate();

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const inMonth = d.getMonth() === month;
    cells.push({
      date: d, day: d.getDate(), inMonth, today: isToday(d),
      tasks: inMonth ? (byDay.get(d.getDate()) || []) : [],
    });
  }
  return cells;
}

/** Split tasks into the three lists the board shows. */
export function bucketTasks(tasks = []) {
  const live = tasks.filter((t) => !t.archived_at);
  const now = Date.now();
  return {
    open: live.filter((t) => t.status !== "done")
      .sort((a, b) => {
        // Overdue first, then by due date, then undated at the end.
        const ad = a.due_date ? new Date(a.due_date).getTime() : Infinity;
        const bd = b.due_date ? new Date(b.due_date).getTime() : Infinity;
        return ad - bd;
      }),
    done: live.filter((t) => t.status === "done")
      .sort((a, b) => time(b.done_at || b.created_at) - time(a.done_at || a.created_at)),
    archived: tasks.filter((t) => t.archived_at)
      .sort((a, b) => time(b.archived_at) - time(a.archived_at)),
    overdue: live.filter((t) => t.status !== "done" && t.due_date && new Date(t.due_date).getTime() < now).length,
  };
}
