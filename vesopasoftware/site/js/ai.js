/* Vesopa AI — the chat dock.
 *
 * Talks to /api/ai, which holds the Grok credential and streams the answer
 * back as Server-Sent Events. Nothing here knows the key exists.
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
      <p class="ai-foot">Grok 4.3. It can be wrong — check anything that matters.</p>
    </section>`;
  document.body.appendChild(root);

  const fab = root.querySelector(".ai-fab");
  const panel = root.querySelector(".ai-panel");
  const log = root.querySelector(".ai-log");
  const sugg = root.querySelector(".ai-sugg");
  const form = root.querySelector(".ai-form");
  const input = root.querySelector(".ai-in");
  const closeBtn = root.querySelector(".ai-x");

  /** The transcript we replay to the server. System role never appears here. */
  const history = [];
  let busy = false;

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

  bubble("bot", GREETING);
  showSuggestions();

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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;

    input.value = "";
    sugg.hidden = true;
    busy = true;
    form.classList.add("busy");

    bubble("you", text);
    history.push({ role: "user", content: text });

    const out = bubble("bot");
    out.classList.add("thinking");
    // Grok 4.3 reasons before it emits anything, so there is a real pause
    // between asking and the first character. Say something during it.
    out.innerHTML = '<i class="ai-dots"><b></b><b></b><b></b></i>';

    let answer = "";
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
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
              const t = JSON.parse(p).t;
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
      history.push({ role: "assistant", content: answer });
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
  });

  return { open, close, el: root };
}
