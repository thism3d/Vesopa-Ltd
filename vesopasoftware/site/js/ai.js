/* Vesopa AI — the chat dock.
 *
 * Talks to /api/ai, which holds the model keys and streams the answer back as
 * Server-Sent Events. Nothing here knows a key exists.
 *
 * Conversations are kept on the server so a reload, or coming back tomorrow,
 * carries on. This browser holds only two random values: a visitor key and the
 * id of the open conversation. Nothing identifies the visitor.
 *
 * The dock only mounts if the server says the assistant is configured. A chat
 * button that opens onto an error is worse than no chat button, and the site
 * has to keep working on a box with no AI_KEY set.
 */

const SUGGESTIONS = [
  "What does Vesopa EPOS do?",
  "Does the till work offline?",
  "What would a booking system cost?",
  "How does the client portal work?",
];

const GREETING =
  "I'm Vesopa AI. Ask me about the till, the kitchen display, hosting, or what a build would cost.";

export async function mountAI() {
  // Ask first. A dock that cannot answer should never appear.
  let enabled = false;
  try {
    const r = await fetch("/api/ai/status", { headers: { Accept: "application/json" } });
    enabled = r.ok && (await r.json()).enabled === true;
  } catch { enabled = false; }
  if (!enabled) return null;

  const root = document.createElement("div");
  root.id = "ai";
  root.innerHTML = `
    <button class="ai-fab" type="button" aria-expanded="false" aria-controls="ai-panel">
      <span class="ai-fab-dot" aria-hidden="true"></span>
      <span>Vesopa AI</span>
    </button>
    <section class="ai-panel" id="ai-panel" role="dialog" aria-label="Vesopa AI" hidden>
      <div class="ai-grip" role="separator" aria-label="Resize" title="Drag to resize"></div>
      <header class="ai-head">
        <span class="ai-title"><i aria-hidden="true"></i>Vesopa AI</span>
        <button class="ai-new" type="button" title="Start a new conversation">New chat</button>
        <button class="ai-x" type="button" aria-label="Close Vesopa AI">
          <span aria-hidden="true">&times;</span><span class="ai-x-lbl">Close</span>
        </button>
      </header>
      <div class="ai-log" role="log" aria-live="polite"></div>
      <div class="ai-sugg"></div>
      <form class="ai-form">
        <input class="ai-in" type="text" autocomplete="off" placeholder="Ask about Vesopa…"
               aria-label="Ask Vesopa AI" maxlength="1500">
        <button class="ai-send" type="submit" aria-label="Send">→</button>
      </form>
      <p class="ai-foot">It can be wrong — check anything that matters. Kept 30 days. <button class="ai-forget" type="button">Forget this chat</button></p>
    </section>`;
  document.body.appendChild(root);

  const fab = root.querySelector(".ai-fab");
  const panel = root.querySelector(".ai-panel");
  const log = root.querySelector(".ai-log");
  const sugg = root.querySelector(".ai-sugg");
  const form = root.querySelector(".ai-form");
  const input = root.querySelector(".ai-in");
  const closeBtn = root.querySelector(".ai-x");

  /** The transcript as shown. The server keeps its own copy; this is for older servers and storage-less browsers. */
  let history = [];
  let busy = false;

  /* Two random values in this browser's own storage, and nothing else. */
  const KEY_VISITOR = "vesopa.ai.visitor";
  const KEY_SESSION = "vesopa.ai.session";
  const randomId = () => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const stored = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
  const keep = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* storage off */ } };
  let visitor = stored(KEY_VISITOR);
  if (!visitor) { visitor = randomId(); keep(KEY_VISITOR, visitor); }
  let session = stored(KEY_SESSION);

  function bubble(role, text = "") {
    const el = document.createElement("div");
    el.className = `ai-msg ai-${role}`;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function showSuggestions() {
    sugg.innerHTML = "";
    for (const s of SUGGESTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ai-chip";
      b.textContent = s;
      b.addEventListener("click", () => { input.value = s; form.requestSubmit(); });
      sugg.appendChild(b);
    }
    sugg.hidden = false;
  }

  function fresh() {
    log.innerHTML = "";
    history = [];
    session = "";
    keep(KEY_SESSION, "");
    bubble("bot", GREETING);
    showSuggestions();
  }
  bubble("bot", GREETING);
  showSuggestions();

  /** Pick up the open conversation, or offer to carry on the last one. */
  (async () => {
    try {
      const qs = new URLSearchParams({ visitor, session: stored(KEY_SESSION) });
      const r = await fetch("/api/ai/sessions?" + qs, { headers: { Accept: "application/json" } });
      const data = r.ok ? await r.json() : null;
      if (!data) return;
      if (data.current && data.current.transcript && data.current.transcript.length) {
        session = data.current.id;
        keep(KEY_SESSION, session);
        log.innerHTML = "";
        sugg.hidden = true;
        history = data.current.transcript.slice();
        for (const m of history) bubble(m.role === "user" ? "you" : "bot", m.content);
        return;
      }
      const last = (data.sessions || [])[0];
      if (last) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ai-chip ai-resume";
        b.textContent = "Carry on: " + last.title;
        b.addEventListener("click", () => { keep(KEY_SESSION, last.id); resume(last.id); });
        sugg.prepend(b);
      }
    } catch { /* offline: start fresh */ }
  })();

  async function resume(id) {
    try {
      const r = await fetch("/api/ai/sessions?" + new URLSearchParams({ visitor, session: id }));
      const data = r.ok ? await r.json() : null;
      if (!data || !data.current) return;
      session = data.current.id;
      log.innerHTML = "";
      sugg.hidden = true;
      history = data.current.transcript.slice();
      for (const m of history) bubble(m.role === "user" ? "you" : "bot", m.content);
    } catch { /* leave as it is */ }
  }

  root.querySelector(".ai-new").addEventListener("click", () => { if (!busy) fresh(); });
  root.querySelector(".ai-forget").addEventListener("click", async () => {
    if (busy) return;
    const id = session;
    fresh();
    if (!id) return;
    try {
      await fetch("/api/ai/forget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visitor, session: id }) });
    } catch { /* it expires on its own */ }
  });

  function open() {
    panel.hidden = false;
    fab.setAttribute("aria-expanded", "true");
    root.classList.add("open");
    // Focusing an input on iOS zooms the viewport unless the font is 16px+;
    // the CSS handles that, but don't steal focus on a phone regardless.
    if (!matchMedia("(pointer: coarse)").matches) input.focus();
  }
  function close() {
    panel.hidden = true;
    fab.setAttribute("aria-expanded", "false");
    root.classList.remove("open");
  }

  fab.addEventListener("click", () => (panel.hidden ? open() : close()));
  closeBtn.addEventListener("click", close);
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) close(); });

  /* ---------- resize ----------
   * The panel is anchored bottom-right, so the grip is on its top-left corner
   * and dragging away from the anchor grows it. Size is written to two custom
   * properties rather than to width/height directly, which keeps the CSS in
   * charge of the clamps and lets the mobile full-screen rule ignore both.
   *
   * Not the CSS `resize` property: that needs `overflow` on the element, and
   * this panel is a flex column whose middle child does the scrolling — giving
   * the panel itself an overflow breaks the layout it depends on.
   */
  const MIN_W = 300, MIN_H = 320;
  const store = { w: null, h: null };

  try {
    const saved = JSON.parse(localStorage.getItem("vesopa.ai.size") || "null");
    if (saved && saved.w && saved.h) { store.w = saved.w; store.h = saved.h; applySize(); }
  } catch { /* private window, or a browser that refuses storage entirely */ }

  function applySize() {
    // Never let a remembered size exceed the window it is being restored into:
    // a panel sized on a desktop and reopened on a laptop would hang off it.
    const w = Math.min(store.w, innerWidth - 24);
    const h = Math.min(store.h, innerHeight - 40);
    panel.style.setProperty("--ai-w", Math.max(MIN_W, w) + "px");
    panel.style.setProperty("--ai-h", Math.max(MIN_H, h) + "px");
  }

  const grip = root.querySelector(".ai-grip");
  grip.addEventListener("pointerdown", (e) => {
    // The full-screen mobile panel has nowhere to be resized to.
    if (matchMedia("(max-width: 640px)").matches) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const r = panel.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY, w0 = r.width, h0 = r.height;
    root.classList.add("resizing");

    const move = (ev) => {
      // Anchored bottom-right: moving the grip left/up must make it bigger.
      store.w = Math.max(MIN_W, Math.min(w0 - (ev.clientX - x0), innerWidth - 24));
      store.h = Math.max(MIN_H, Math.min(h0 - (ev.clientY - y0), innerHeight - 40));
      applySize();
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      root.classList.remove("resizing");
      try {
        localStorage.setItem("vesopa.ai.size", JSON.stringify({ w: store.w, h: store.h }));
      } catch { /* nothing worth failing a resize over */ }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });

  // A window that shrinks under a remembered size has to be honoured too.
  addEventListener("resize", () => { if (store.w) applySize(); }, { passive: true });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    ask(text, false);
  });

  /** "Try again" under the last answer: the same question, asked with a little more thought. */
  function offerAgain(out, text) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ai-again";
    b.textContent = "Try again";
    b.addEventListener("click", () => {
      if (busy) return;
      b.remove();
      out.remove();
      history.pop();
      ask(text, true, true);
    });
    out.after(b);
  }

  async function ask(text, again, reuseBubble) {
    sugg.hidden = true;
    busy = true;
    form.classList.add("busy");
    for (const old of log.querySelectorAll(".ai-again")) old.remove();

    if (!reuseBubble) {
      bubble("you", text);
      history.push({ role: "user", content: text });
    }

    const out = bubble("bot");
    out.classList.add("thinking");
    out.innerHTML = '<i class="ai-dots"><b></b><b></b><b></b></i>';

    let answer = "";
    let failed = false;
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitor, session: session || undefined, text, again, messages: history }),
      });

      if (!res.ok || !res.body) throw new Error("upstream " + res.status);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        let cut;
        while ((cut = buf.indexOf("\n\n")) !== -1) {
          const evt = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of evt.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const p = line.slice(5).trim();
            if (!p || p === "[DONE]") continue;
            try {
              const msg = JSON.parse(p);
              if (msg.session) { session = msg.session; keep(KEY_SESSION, session); }
              if (msg.error) failed = true;
              const t = msg.t;
              if (!t) continue;
              if (!answer) out.classList.remove("thinking");
              answer += t;
              out.textContent = answer;
              log.scrollTop = log.scrollHeight;
            } catch { /* keepalive */ }
          }
        }
      }

      if (!answer) throw new Error("empty");
      if (failed) {
        out.classList.add("bad");
        history.pop();
      } else {
        history.push({ role: "assistant", content: answer });
        if (!again) offerAgain(out, text);
      }
    } catch {
      out.classList.remove("thinking");
      out.classList.add("bad");
      out.textContent = "That did not go through. Try again, or email info@vesopa.com.";
      // Drop the unanswered turn so the next question is not sent with a
      // dangling user message the model has to make sense of.
      history.pop();
    } finally {
      busy = false;
      form.classList.remove("busy");
      log.scrollTop = log.scrollHeight;
    }
  }

  return { open, close, el: root };
}
