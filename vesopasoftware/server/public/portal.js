/* Portal front-end.
 *
 * One websocket, opened once per tab and shared by every widget on the page.
 * Nothing here is required for the page to work: every view renders complete
 * from the server, and this only keeps it current. If the socket never
 * connects, the portal is a normal, fully functional server-rendered app.
 */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- time, everywhere ----------
     Timestamps render on the server in UTC-safe ISO and are localised here, so
     a page cached anywhere still shows the reader's own clock. */
  const rtf = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
  const STEPS = [[60, "second", 1], [3600, "minute", 60], [86400, "hour", 3600],
                 [604800, "day", 86400], [2629800, "week", 604800],
                 [31557600, "month", 2629800], [Infinity, "year", 31557600]];

  function relative(iso) {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return "";
    const diff = (then - Date.now()) / 1000;
    const abs = Math.abs(diff);
    for (const [limit, unit, div] of STEPS) {
      if (abs < limit) return rtf.format(Math.round(diff / div), unit);
    }
    return then.toLocaleDateString("en-GB");
  }

  function paintTimes(root = document) {
    for (const el of $$("time[datetime]", root)) {
      const iso = el.getAttribute("datetime");
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      const full = d.toLocaleString("en-GB", {
        day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
      });
      el.title = full;
      if (el.dataset.rel !== "off") el.textContent = relative(iso);
      else el.textContent = full;
    }
  }
  paintTimes();
  setInterval(() => paintTimes(), 60000);

  // Live clock in the top bar — the "time in every panel" anchor.
  const clock = $("#clock");
  if (clock) {
    const tick = () => {
      const now = new Date();
      clock.innerHTML =
        `<b>${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</b>` +
        now.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ---------- the socket ---------- */
  const listeners = new Map();
  const on = (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]);
  const emitLocal = (type, data) => (listeners.get(type) || []).forEach((fn) => fn(data));

  let ws = null;
  let backoff = 1000;
  const dot = $("#live");

  function connect() {
    if (!window.WebSocket) return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/portal/ws`;
    try { ws = new WebSocket(url); } catch { return; }

    ws.addEventListener("open", () => {
      backoff = 1000;
      dot?.classList.add("on");
      dot && (dot.lastElementChild.textContent = "live");
    });
    ws.addEventListener("message", (ev) => {
      let frame; try { frame = JSON.parse(ev.data); } catch { return; }
      emitLocal(frame.type, frame.data);
    });
    ws.addEventListener("close", () => {
      dot?.classList.remove("on");
      dot && (dot.lastElementChild.textContent = "offline");
      // Reconnect with a widening gap, capped, so a server restart is picked
      // up quickly but a long outage does not hammer it.
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 1.7, 20000);
    });
    ws.addEventListener("error", () => ws?.close());
  }
  const send = (obj) => { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); };
  connect();

  window.VesopaLive = { on, send };

  /* ---------- notifications ---------- */
  const bell = $("#bell");
  const drawer = $("#drawer");
  const badge = $("#bell b");

  if (bell && drawer) {
    bell.addEventListener("click", async (e) => {
      e.stopPropagation();
      drawer.classList.toggle("on");
      if (!drawer.classList.contains("on")) return;
      try {
        const r = await fetch("/portal/notifications.json", { headers: { accept: "application/json" } });
        const data = await r.json();
        drawer.innerHTML = data.items?.length
          ? data.items.map((n) => `
            <a href="${esc(n.href || "/portal")}" class="${n.read_at ? "" : "unread"}">
              ${esc(n.title)}
              ${n.body ? `<small>${esc(n.body)}</small>` : ""}
              <time datetime="${new Date(n.created_at).toISOString()}"></time>
            </a>`).join("")
          : `<div style="padding:.9rem;color:var(--muted);font-size:.85rem">Nothing yet.</div>`;
        paintTimes(drawer);
        if (data.unread) {
          await fetch("/portal/notifications/read", {
            method: "POST", headers: { "x-csrf-token": window.CSRF || "" },
          });
          if (badge) badge.remove();
        }
      } catch { /* the drawer is a convenience; a failure is not worth a dialog */ }
    });
    document.addEventListener("click", (e) => {
      if (!drawer.contains(e.target)) drawer.classList.remove("on");
    });
  }

  on("notification", (n) => {
    if (badge) { badge.textContent = String((Number(badge.textContent) || 0) + 1); }
    else if (bell) {
      const b = document.createElement("b");
      b.textContent = "1";
      bell.appendChild(b);
    }
    toast(n.title, n.href);
    desktopNotify(n);
  });

  /* ---------- browser notifications ----------
     Permission is only ever asked for after a deliberate click on the enable
     button: a permission prompt thrown at someone the instant a page loads is
     the fastest way to get "Block" pressed for good.
     A native notification only fires when the tab is not the one being looked
     at — otherwise the in-page toast has already said it. */
  const notifyBtn = $("#enable-notifications");

  function paintNotifyButton() {
    if (!notifyBtn || !("Notification" in window)) return;
    const state = Notification.permission;
    notifyBtn.hidden = state === "granted";
    notifyBtn.textContent = state === "denied" ? "Notifications blocked" : "Enable notifications";
    notifyBtn.disabled = state === "denied";
    notifyBtn.title = state === "denied"
      ? "Your browser is blocking notifications for this site. Turn them back on in site settings."
      : "Get a desktop alert when something happens";
  }
  paintNotifyButton();

  notifyBtn?.addEventListener("click", async () => {
    if (!("Notification" in window)) return;
    try {
      const result = await Notification.requestPermission();
      paintNotifyButton();
      if (result === "granted") {
        new Notification("Vesopa Software", {
          body: "You will be told here when a project, message or invoice moves.",
          icon: "/assets/logo.svg",
        });
      }
    } catch { /* Safari on http can refuse outright; the portal still works */ }
  });

  function desktopNotify(n) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return;
    try {
      const note = new Notification(n.title || "Vesopa Software", {
        body: n.body || "",
        icon: "/assets/logo.svg",
        // A tag replaces an earlier notification of the same kind rather than
        // stacking six of them while somebody was at lunch.
        tag: `vesopa-${n.kind || "general"}`,
        renotify: true,
      });
      note.addEventListener("click", () => {
        window.focus();
        if (n.href) location.href = n.href;
        note.close();
      });
    } catch { /* not fatal */ }
  }

  // Messages and payments deserve the same treatment as notifications.
  on("message", (d) => {
    if (document.visibilityState === "visible") return;
    const m = d.message || {};
    if (Number(m.user_id) === Number(document.body.dataset.user)) return;
    desktopNotify({ kind: "message", title: `${m.author || "New message"}`, body: m.body, href: location.pathname });
  });

  function toast(text, href) {
    const el = document.createElement("a");
    el.href = href || "#";
    el.textContent = text;
    el.style.cssText =
      "position:fixed;right:1rem;bottom:1rem;z-index:99;max-width:22rem;background:#12160F;" +
      "border:1px solid rgba(237,235,226,.24);border-left:3px solid #A5C715;border-radius:3px;" +
      "padding:.7rem .85rem;font-size:.85rem;color:#EDEBE2;text-decoration:none;" +
      "box-shadow:0 14px 34px rgba(0,0,0,.5)";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  /* ---------- live message thread ---------- */
  const thread = $("#thread");
  if (thread) {
    const projectId = Number(thread.dataset.project);
    const me = Number(document.body.dataset.user);
    const form = $("#composer");
    const typing = $("#typing");
    const bottom = () => { thread.scrollTop = thread.scrollHeight; };
    bottom();

    const render = (m) => {
      if ($(`[data-msg="${m.id}"]`, thread)) return;   // our own echo, already drawn
      const mine = Number(m.user_id) === me;
      const el = document.createElement("div");
      el.className = `msg ${mine ? "mine" : ""} ${m.author_role === "admin" ? "vesopa" : ""} ${m.recipient_id ? "private" : ""}`;
      el.dataset.msg = m.id;
      const initials = (m.author || "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
      el.innerHTML = `
        <div class="who">${esc(initials)}</div>
        <div class="bubble">
          <div class="meta">
            <b>${esc(m.author || "Someone")}</b>
            ${m.author_role === "admin" ? '<span class="pill lime">Vesopa</span>' : ""}
            ${m.recipient_id ? '<span class="pill warn">Private</span>' : ""}
            <time datetime="${new Date(m.created_at).toISOString()}"></time>
          </div>
          <div class="body">${esc(m.body)}</div>
        </div>`;
      thread.appendChild(el);
      paintTimes(el);
      bottom();
    };

    on("message", (d) => { if (d.projectId === projectId) render(d.message); });
    on("typing", (d) => {
      if (d.projectId !== projectId || d.userId === me || !typing) return;
      typing.textContent = `${d.name} is typing…`;
      clearTimeout(typing._t);
      typing._t = setTimeout(() => { typing.textContent = ""; }, 2500);
    });

    if (form) {
      const box = $("textarea", form);
      let lastTyped = 0;
      box?.addEventListener("input", () => {
        const now = Date.now();
        if (now - lastTyped > 1500) { send({ type: "typing", projectId }); lastTyped = now; }
      });
      // Enter sends, Shift+Enter makes a new line — the convention everywhere
      // else people type into a thread.
      box?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
      });

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const body = box.value.trim();
        if (!body) return;
        box.value = "";
        const fd = new FormData(form);
        try {
          const r = await fetch(form.action, {
            method: "POST",
            headers: { "x-csrf-token": window.CSRF || "", accept: "application/json" },
            body: new URLSearchParams(fd),
          });
          const data = await r.json();
          if (data.ok) render(data.message);
          else { box.value = body; alert(data.error || "Could not send that."); }
        } catch {
          box.value = body;
          alert("Could not reach the server. Your message has not been sent.");
        }
      });
    }
  }

  /* ---------- live progress ---------- */
  on("project:progress", (d) => {
    const bar = $(`[data-progress="${d.projectId}"]`);
    if (bar) {
      $("i", bar).style.width = `${d.progress_pct}%`;
      const label = $(`[data-progress-label="${d.projectId}"]`);
      if (label) label.textContent = `${d.progress_pct}%`;
    }
  });
  on("project:update", () => toast("This project has a new update — reload to see it.", location.pathname));

  /* ---------- tasks ---------- */
  $$(".task input[type=checkbox]").forEach((box) => {
    box.addEventListener("change", async () => {
      const li = box.closest(".task");
      const url = box.dataset.url;
      li.classList.toggle("done", box.checked);
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "x-csrf-token": window.CSRF || "" },
          body: new URLSearchParams({ status: box.checked ? "done" : "todo" }),
        });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error);
        const bar = $("[data-task-progress]");
        if (bar && data.total) {
          $("i", bar).style.width = `${data.pct}%`;
          const label = $("[data-task-progress-label]");
          if (label) label.textContent = `${data.done}/${data.total}`;
        }
      } catch {
        box.checked = !box.checked;
        li.classList.toggle("done", box.checked);
      }
    });
  });
  on("task", (d) => {
    const box = $(`[data-task="${d.taskId}"]`);
    if (box && box.checked !== (d.status === "done")) {
      box.checked = d.status === "done";
      box.closest(".task")?.classList.toggle("done", box.checked);
    }
  });

  /* ---------- file preview ---------- */
  const viewer = $("#viewer");
  if (viewer) {
    const stage = $(".stage", viewer);
    const label = $("#viewer-name", viewer);
    const dl = $("#viewer-download", viewer);

    const close = () => { viewer.classList.remove("on"); stage.innerHTML = ""; };
    $("#viewer-close", viewer)?.addEventListener("click", close);
    viewer.addEventListener("click", (e) => { if (e.target === viewer) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

    $$("[data-preview]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.preventDefault();
        const { id, mime, name } = el.dataset;
        label.textContent = name;
        dl.href = `/portal/files/${id}`;
        stage.innerHTML = '<p class="muted mono">loading…</p>';
        viewer.classList.add("on");

        if (mime.startsWith("image/")) {
          stage.innerHTML = `<img src="/portal/files/${id}" alt="${esc(name)}">`;
        } else if (mime === "application/pdf") {
          stage.innerHTML = `<iframe src="/portal/files/${id}#view=FitH" title="${esc(name)}"></iframe>`;
        } else if (/zip/.test(mime) || /\.zip$/i.test(name)) {
          try {
            const r = await fetch(`/portal/files/${id}/zip.json`);
            const data = await r.json();
            stage.innerHTML = data.ok
              ? `<div class="ziplist">
                   <div class="panel-head"><h3>${esc(name)}</h3><span class="spacer"></span>
                     <span class="pill">${data.count} entries</span></div>
                   <div class="table-wrap"><table><thead><tr><th>Path</th><th class="num">Size</th><th class="num">Modified</th></tr></thead>
                   <tbody>${data.entries.map((f) => `
                     <tr><td>${f.directory ? "📁 " : "📄 "}${esc(f.name)}</td>
                     <td class="num">${f.directory ? "—" : fmtBytes(f.size)}</td>
                     <td class="num">${f.modified ? new Date(f.modified).toLocaleDateString("en-GB") : "—"}</td></tr>`).join("")}
                   </tbody></table></div>
                   ${data.truncated ? '<p class="hint">Only the first 500 entries are listed.</p>' : ""}
                 </div>`
              : `<p class="muted">${esc(data.error || "Could not read that archive.")}</p>`;
          } catch {
            stage.innerHTML = '<p class="muted">Could not read that archive.</p>';
          }
        } else {
          stage.innerHTML =
            `<div style="text-align:center">
               <p class="muted">No preview for this type.</p>
               <p style="margin-top:.8rem"><a class="btn" href="/portal/files/${id}">Download ${esc(name)}</a></p>
             </div>`;
        }
      });
    });
  }

  const fmtBytes = (n) =>
    n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

  /* ---------- drag and drop upload ---------- */
  const drop = $("#dropzone");
  if (drop) {
    const input = $("input[type=file]", drop.closest("form"));
    ["dragenter", "dragover"].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => {
      if (!input || !e.dataTransfer?.files?.length) return;
      input.files = e.dataTransfer.files;
      drop.closest("form").requestSubmit();
    });
    drop.addEventListener("click", () => input?.click());
    input?.addEventListener("change", () => { if (input.files.length) drop.closest("form").requestSubmit(); });
  }

  /* ---------- batch payment selection ---------- */
  const batch = $("#batch-form");
  if (batch) {
    const boxes = $$("input[name='invoice_ids']", batch);
    const total = $("#batch-total");
    const btn = $("#batch-pay");
    const all = $("#batch-all");
    const sum = () => {
      const n = boxes.filter((b) => b.checked).reduce((s, b) => s + Number(b.dataset.due || 0), 0);
      if (total) total.textContent = n.toLocaleString("en-GB", { style: "currency", currency: total.dataset.currency || "GBP" });
      if (btn) btn.disabled = n <= 0;
    };
    boxes.forEach((b) => b.addEventListener("change", sum));
    all?.addEventListener("change", () => { boxes.forEach((b) => { b.checked = all.checked; }); sum(); });
    sum();
  }

  /* ---------- invoice line-item rows ---------- */
  const lines = $("#lines");
  if (lines) {
    const recount = () => {
      let sub = 0;
      $$(".line", lines).forEach((row) => {
        const qty = Number($("[name=qty]", row).value) || 0;
        const price = Number($("[name=unit_price]", row).value) || 0;
        const amount = qty * price;
        $(".line-amount", row).textContent = amount.toFixed(2);
        sub += amount;
      });
      const taxRate = Number($("[name=tax_rate]")?.value) || 0;
      const tax = sub * taxRate / 100;
      $("#sub").textContent = sub.toFixed(2);
      $("#tax").textContent = tax.toFixed(2);
      $("#tot").textContent = (sub + tax).toFixed(2);
    };
    lines.addEventListener("input", recount);
    $("[name=tax_rate]")?.addEventListener("input", recount);
    $("#add-line")?.addEventListener("click", () => {
      const row = $(".line", lines).cloneNode(true);
      $$("input", row).forEach((i) => { if (i.name !== "qty") i.value = ""; else i.value = "1"; });
      lines.appendChild(row);
      recount();
    });
    lines.addEventListener("click", (e) => {
      if (!e.target.matches(".drop-line")) return;
      if ($$(".line", lines).length > 1) e.target.closest(".line").remove();
      recount();
    });
    recount();
  }
})();
