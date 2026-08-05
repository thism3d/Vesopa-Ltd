/* ===========================================================================
   Post-payment onboarding.

   Two independent pieces, only one of which is ever on the page:

     1. The free-domain search, which offers only extensions inside the price
        cap and posts the chosen one back to be registered.
     2. The build watcher, which kicks provisioning off and then polls for the
        step rows the server writes as it works.

   The server decides which. This file never changes state on its own.
   =========================================================================== */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const orderId = () => {
    const el = $('[data-setup-run]') || $('[data-setup-domain]');
    return el && el.dataset.order;
  };

  /* ======================================================================
     1. Free domain search
     ====================================================================== */
  const domainCard = $('[data-setup-domain]');
  if (domainCard) {
    const form = $('[data-free-search]', domainCard);
    const results = $('[data-free-results]', domainCard);
    const claim = $('[data-free-claim]', domainCard);

    if (form && results && claim) {
      const id = claim.action.match(/setup\/(\d+)/)[1];

      const skeleton = () =>
        '<div class="fd"><span class="fd-name muted">Checking…</span>' +
        '<span class="fd-end"><span class="checking"><i></i><i></i><i></i></span></span></div>';

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = $('.dsearch-input', form);
        const q = (input.value || '').trim();
        if (!q) { input.focus(); return; }

        const btn = $('[type=submit]', form);
        btn.disabled = true;
        const label = btn.innerHTML;
        btn.innerHTML = '<span class="spinner"></span>';

        results.hidden = false;
        results.innerHTML = '<div class="fd-list">' + skeleton() + '</div>';

        try {
          const res = await fetch(`/panel/setup/${id}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q }),
          });
          const data = await res.json();

          if (data.error) {
            results.innerHTML = `<div class="alert alert-warn">${esc(data.error)}</div>`;
            return;
          }

          const rows = (data.results || []).filter((r) => !r.errored);
          if (!rows.length) {
            results.innerHTML = '<div class="alert alert-warn">We could not check that just now. Try again in a moment.</div>';
            return;
          }

          results.innerHTML =
            '<div class="fd-list">' +
            rows
              .map((r, i) => {
                const style = `style="animation-delay:${i * 55}ms"`;
                if (!r.available) {
                  return `<div class="fd is-taken" ${style}>
                    <span class="fd-name">${esc(r.sld)}.${esc(r.tld)}</span>
                    <span class="fd-end"><span class="badge badge-grey">Taken</span></span>
                  </div>`;
                }
                return `<div class="fd" ${style}>
                  <span class="fd-name"><b>${esc(r.sld)}</b>.${esc(r.tld)}</span>
                  <span class="fd-end">
                    <span class="fd-worth"><s>${esc(r.worth)}</s><br>then ${esc(r.renew)}/yr</span>
                    <span class="fd-free">Free</span>
                    <button class="btn btn-sm" type="button" data-pick="${esc(r.domain)}">Claim it</button>
                  </span>
                </div>`;
              })
              .join('') +
            '</div>';
        } catch (err) {
          results.innerHTML = '<div class="alert alert-warn">We could not check that just now. Try again in a moment.</div>';
        } finally {
          btn.disabled = false;
          btn.innerHTML = label;
        }
      });

      // Delegated, because the buttons are rebuilt on every search.
      results.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pick]');
        if (!btn) return;
        // Freeze the row being claimed so a second click cannot register two.
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
        results.querySelectorAll('[data-pick]').forEach((b) => { if (b !== btn) b.disabled = true; });
        claim.querySelector('[name=domain]').value = btn.dataset.pick;
        claim.submit();
      });
    }
  }

  /* ======================================================================
     2. The build watcher
     ====================================================================== */
  const run = $('[data-setup-run]');
  if (!run) return;

  const id = run.dataset.order;
  const bar = $('[data-run-bar]', run);
  const fill = bar && bar.querySelector('i');
  const pct = $('[data-run-percent]', run);
  const list = $('[data-run-steps]', run);
  const done = $('[data-run-done]', run);
  const title = $('[data-run-title]', run);
  const sub = $('[data-run-sub]', run);
  const iconWrap = $('[data-run-icon]', run);

  const TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  const DASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg>';
  const CROSS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';

  const MARK = {
    pending: '<span class="setup-step-mark"></span>',
    running: '<span class="setup-step-mark"><span class="spinner spinner-dark"></span></span>',
    ok: `<span class="setup-step-mark">${TICK}</span>`,
    skipped: `<span class="setup-step-mark">${DASH}</span>`,
    failed: `<span class="setup-step-mark">${CROSS}</span>`,
  };

  function render(data) {
    if (fill) fill.style.width = `${data.percent}%`;
    if (bar) {
      bar.setAttribute('aria-valuenow', String(data.percent));
      bar.classList.toggle('is-done', Boolean(data.finished));
      bar.classList.toggle('is-failed', Boolean(data.failed));
    }
    if (pct) {
      pct.textContent = data.finished
        ? (data.failed ? 'Finished with something to look at' : 'All done')
        : `${data.percent}% — this usually takes under a minute`;
    }

    if (list && data.steps.length) {
      list.innerHTML = data.steps
        .map(
          (s) => `<li class="setup-step is-${esc(s.status)}">
            ${MARK[s.status] || MARK.pending}
            <span class="setup-step-text"><b>${esc(s.label)}</b>${s.detail ? `<span>${esc(s.detail)}</span>` : ''}</span>
          </li>`,
        )
        .join('');
    }

    if (data.finished) {
      if (done) done.hidden = false;
      if (data.failed) {
        if (title) title.textContent = 'Almost there';
        if (sub) sub.textContent = 'Most of your setup is done. A couple of steps need us to look at them — we have been told, and we will email you shortly. Nothing is lost.';
        if (iconWrap) iconWrap.className = 'setup-icon setup-icon-amber';
      } else {
        if (title) title.textContent = 'Your hosting is ready';
        if (sub) sub.textContent = 'Everything is set up and your welcome email is on its way. Open your account to add a site.';
      }
    }
  }

  let stopped = false;
  let misses = 0;

  async function poll() {
    if (stopped) return;
    try {
      const res = await fetch(`/panel/setup/${id}/status`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      misses = 0;
      render(data);
      if (data.finished) { stopped = true; return; }
    } catch (err) {
      /*
       * A failed poll is not a failed setup — the work is happening on the
       * server whatever this tab can reach. Give up only after several in a
       * row, and say so honestly rather than pretending to still be watching.
       */
      if (++misses >= 6) {
        stopped = true;
        if (pct) pct.textContent = 'Lost contact with this page — your setup is still running. Refresh to check.';
        if (done) done.hidden = false;
        return;
      }
    }
    setTimeout(poll, 1000);
  }

  (async function begin() {
    // Kick the work off, unless the server says it is already under way (a
    // reload mid-provision must watch, not start a second run).
    if (run.dataset.started === '0') {
      try {
        await fetch(`/panel/setup/${id}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _csrf: run.dataset.csrf }),
        });
      } catch (err) {
        /* The poll below will show whatever actually happened. */
      }
    }
    poll();
  })();
})();
