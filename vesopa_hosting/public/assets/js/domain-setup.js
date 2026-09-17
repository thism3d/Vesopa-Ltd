/**
 * The setup card on a domain's page, kept in step with the job.
 *
 * The server rendered the card complete (partials/domain-setup.ejs). This
 * polls the run's status every second and repaints the same markup: the bar
 * moves, the running step gets a spinner and its "what is happening" line, a
 * finished step gets a tick and what happened, and an elapsed clock ticks so
 * a slow certificate still visibly IS taking time rather than being stuck.
 *
 * When the run finishes the head becomes the outcome, and a moment later the
 * rest of the page is refreshed through the no-reload router so its cards
 * agree with what just happened — the "not pointing at us" alert goes, the
 * certificate card fills in. No browser reload at any point.
 *
 * A page script, re-created by nav.js on every arrival at a domain page; it
 * guards on its root and stops itself when the page is left.
 */
(function () {
  'use strict';

  const root = document.querySelector('[data-domain-setup]');
  if (!root) return;

  const $ = (sel) => root.querySelector(sel);
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const url = root.dataset.statusUrl;
  const bar = $('[data-ds-bar]');
  const fill = bar && bar.querySelector('i');
  const list = $('[data-ds-steps]');
  const title = $('[data-ds-title]');
  const sub = $('[data-ds-sub]');
  const iconWrap = $('[data-ds-icon]');
  const clock = $('[data-ds-clock]');
  const actions = $('[data-ds-actions]');

  const TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  const DASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg>';
  const CROSS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  const WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
  const MARK = { pending: '', running: '<span class="spinner"></span>', ok: TICK, skipped: DASH, failed: CROSS };

  let stopped = root.dataset.finished === '1';
  let misses = 0;
  const startedAt = root.dataset.started ? new Date(root.dataset.started).getTime() : Date.now();

  function paintSteps(steps) {
    if (!list) return;
    list.innerHTML = steps.map((s) =>
      `<li class="dsetup-step is-${esc(s.status)}">
        <span class="dsetup-mark">${MARK[s.status] || ''}</span>
        <span class="dsetup-text"><b>${esc(s.label)}</b>${s.detail ? `<span>${esc(s.detail)}</span>` : ''}</span>
      </li>`).join('');
  }

  function paintOutcome(data) {
    root.classList.remove('is-running');
    root.classList.add(data.kind === 'ok' ? 'is-ok' : (data.kind === 'error' ? 'is-error' : 'is-warn'));
    if (iconWrap) iconWrap.innerHTML = data.kind === 'ok' ? TICK : WARN;
    if (title) title.textContent = data.headline || 'Done';
    if (sub) sub.textContent = data.message || '';
    if (clock) clock.hidden = true;
    if (actions) {
      const here = window.location.pathname;
      actions.innerHTML =
        `<a class="btn btn-sm" href="${esc(here)}" data-ds-refresh>Show me the domain</a>` +
        '<a class="btn btn-ghost btn-sm" href="/panel/domains">Back to domains</a>';
    }
  }

  function render(data) {
    if (fill) fill.style.width = `${data.percent}%`;
    if (bar) {
      bar.setAttribute('aria-valuenow', String(data.percent));
      bar.classList.toggle('is-done', Boolean(data.finished));
      bar.classList.toggle('is-failed', Boolean(data.finished && data.kind !== 'ok'));
    }
    paintSteps(data.steps || []);
    if (data.finished) paintOutcome(data);
  }

  /*
   * The rest of the page after the run: fetched and swapped by the router, so
   * the alerts and cards below the card agree with what just happened. The
   * card itself comes back too, rendered finished, for one more look.
   */
  function refreshPage() {
    if (window.VesopaNav && typeof window.VesopaNav.go === 'function') {
      window.VesopaNav.go(window.location.href, false);
    } else {
      window.location.reload();
    }
  }

  async function poll() {
    if (stopped) return;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      misses = 0;
      render(data);
      if (data.finished) {
        stopped = true;
        setTimeout(refreshPage, 1600);
        return;
      }
    } catch (err) {
      // A failed poll is not a failed setup — the work is on the server
      // whatever this tab can reach. Give up only after several in a row,
      // and say so rather than pretending to still be watching.
      if (++misses >= 8) {
        stopped = true;
        if (sub) sub.textContent = VT.t('Lost contact with this page — the setup is still running on the server. Refresh in a moment to see how it went.');
        return;
      }
    }
    setTimeout(poll, 1000);
  }

  // The clock: seconds since the run began, so a long step is visibly long
  // rather than visibly stuck.
  let ticking = null;
  if (clock && !stopped) {
    clock.hidden = false;
    ticking = setInterval(() => {
      if (stopped) { clearInterval(ticking); return; }
      clock.textContent = `${Math.max(0, Math.round((Date.now() - startedAt) / 1000))}s`;
    }, 1000);
  }

  // Leaving the page ends the watching, never the work.
  window.addEventListener('vesopa:navigating', () => { stopped = true; if (ticking) clearInterval(ticking); }, { once: true });

  if (!stopped) poll();
})();
