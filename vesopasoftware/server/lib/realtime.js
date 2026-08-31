/* The live channel.
 *
 * One websocket per open tab, authenticated by the same session cookie the
 * pages use — there is no second token to leak or expire. Every socket lands
 * in a set of rooms:
 *
 *   user:<id>      everything addressed to one person
 *   project:<id>   the message thread and progress for one project
 *   admins         the staff feed: new quotes, enquiries, payments
 *
 * Publishing is fire-and-forget. Nothing in the request path may depend on a
 * socket being connected: every event pushed here is also written to the
 * database first, so a user who was offline sees it on their next page load.
 */
import { WebSocketServer } from "ws";
import { q } from "./db.js";

const rooms = new Map(); // room -> Set<ws>

const join = (ws, room) => {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
  ws.rooms.add(room);
};

const leaveAll = (ws) => {
  for (const room of ws.rooms) {
    const set = rooms.get(room);
    if (!set) continue;
    set.delete(ws);
    if (!set.size) rooms.delete(room);
  }
  ws.rooms.clear();
};

/** Send one event to every socket in a room. */
export function publish(room, type, data = {}) {
  const set = rooms.get(room);
  if (!set || !set.size) return 0;
  const frame = JSON.stringify({ type, data, at: Date.now() });
  let sent = 0;
  for (const ws of set) {
    if (ws.readyState === 1) { ws.send(frame); sent++; }
  }
  return sent;
}

export const toUser = (userId, type, data) => publish(`user:${userId}`, type, data);
export const toProject = (projectId, type, data) => publish(`project:${projectId}`, type, data);
export const toAdmins = (type, data) => publish("admins", type, data);

/** Which projects may this user listen to? Admins hear everything. */
async function projectIdsFor(user) {
  const rows =
    user.role === "admin"
      ? await q("SELECT id FROM projects")
      : await q("SELECT id FROM projects WHERE user_id = ?", [user.id]);
  return rows.map((r) => r.id);
}

export function attach(server, sessionMiddleware, loadUserFromSession) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/portal/ws") return socket.destroy();

    // Run the session middleware over the upgrade request so the cookie is
    // resolved exactly as it would be for a page request.
    sessionMiddleware(req, {}, async () => {
      const userId = req.session?.userId;
      if (!userId) return socket.destroy();
      const user = await loadUserFromSession(userId).catch(() => null);
      if (!user || user.status !== "active") return socket.destroy();

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.user = user;
        ws.rooms = new Set();
        wss.emit("connection", ws, req);
      });
    });
  });

  wss.on("connection", async (ws) => {
    const user = ws.user;
    join(ws, `user:${user.id}`);
    if (user.role === "admin") join(ws, "admins");
    for (const id of await projectIdsFor(user)) join(ws, `project:${id}`);

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("close", () => leaveAll(ws));
    ws.on("error", () => leaveAll(ws));

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      // Typing indicators are the only client-originated event, and they are
      // relayed rather than trusted: the server stamps the identity, so a tab
      // cannot claim to be somebody else.
      if (msg.type === "typing" && Number.isInteger(msg.projectId)) {
        if (!ws.rooms.has(`project:${msg.projectId}`)) return;
        const frame = JSON.stringify({
          type: "typing",
          data: { projectId: msg.projectId, name: user.name, userId: user.id },
          at: Date.now(),
        });
        for (const peer of rooms.get(`project:${msg.projectId}`) || []) {
          if (peer !== ws && peer.readyState === 1) peer.send(frame);
        }
      }
    });

    ws.send(JSON.stringify({ type: "ready", data: { userId: user.id, role: user.role } }));
  });

  // Drop sockets that stopped answering — a laptop that slept holds a room
  // entry open otherwise, and publish() then writes into a dead set forever.
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { leaveAll(ws); ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  beat.unref?.();

  return wss;
}

/** A socket opened before a project existed has not joined its room. Called
 *  when a project is created so its owner starts hearing about it at once. */
export function joinProjectRoom(userId, projectId) {
  for (const ws of rooms.get(`user:${userId}`) || []) join(ws, `project:${projectId}`);
  for (const ws of rooms.get("admins") || []) join(ws, `project:${projectId}`);
}
