/* ===========================================================================
   Live domain availability.
   ---------------------------------------------------------------------------
   Two requests, in this order:

     1. /api/domains/check        the exact name the visitor typed
     2. /api/domains/suggestions  the other extensions

   The registrar refuses concurrent calls (429) and takes roughly 350ms per
   name, so asking about seven extensions in one go means four seconds of
   spinner before the visitor learns the one thing they came to find out. The
   exact answer is painted the moment it lands — usually about a second — and
   the alternatives drop in underneath while it is being read.

   Falls back to a plain form GET with JS disabled; the results page renders
   server-side too.
   =========================================================================== */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const form = $('[data-domain-search]');
  if (!form) return;

  const input = $('.dsearch-input', form);
  const results = $('[data-domain-results]');
  const submit = $('[type=submit]', form);

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /**
   * Bring the results into view.
   *
   * THE SEARCH USED TO LOOK BROKEN, AND THIS IS WHY.
   *
   * The box is in the hero and the answers render a screenful below it. On a
   * laptop nothing visible changed when you pressed Search: the skeleton, the
   * result and the price all appeared off screen, so the page read as "clicked,
   * nothing happened" and people clicked again. The request had worked every
   * time.
   *
   * Called on submit rather than on arrival, so it happens once per search
   * while the answer is still loading and the reader is already looking at the
   * right place when it lands.
   *
   * `smooth` is skipped for anyone who has asked for less motion — a page that
   * lurches is worse than one that jumps.
   */
  function revealResults() {
    if (!results) return;
    const anchor = results.closest('section') || results;
    const top = anchor.getBoundingClientRect().top + window.scrollY - 18;
    // Already there, or above it? Leave the scroll alone. Yanking somebody back
    // up to the results they are already reading is its own annoyance.
    if (Math.abs(window.scrollY - top) < 40) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
  }

  /* Quick-pick extension chips under the box. */
  $$('[data-tld-chip]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const name = (input.value || '').trim().split('.')[0];
      if (!name) {
        input.focus();
        return;
      }
      input.value = `${name}.${chip.dataset.tldChip}`;
      form.requestSubmit();
    });
  });

  function skeleton(count) {
    return Array.from({ length: count })
      .map(
        (_, i) => `<div class="dresult" style="animation-delay:${i * 45}ms">
          <div class="dresult-name muted">Checking…</div>
          <div class="dresult-price"><span class="checking"><i></i><i></i><i></i></span></div>
        </div>`,
      )
      .join('');
  }

  function resultRow(r, isExact) {
    const cls = ['dresult'];
    if (!r.available) cls.push('is-taken');
    if (isExact && r.available) cls.push('dresult-hero');

    const price = r.available
      ? `<div class="dresult-price">
           <div class="amt">${esc(r.price_display || '')}</div>
           <div class="per">first year</div>
         </div>
         <a class="btn btn-sm" href="/cart/add-domain?domain=${encodeURIComponent(r.domain)}">Add</a>`
      : `<div class="dresult-price"><span class="badge badge-grey">Taken</span></div>
         ${
           r.whois_url
             ? `<a class="btn btn-ghost btn-sm" href="${esc(r.whois_url)}" target="_blank" rel="noopener">Who owns it</a>`
             : ''
         }`;

    const label = r.invalid || r.errored
      ? `<div class="dresult-name muted">${esc(r.domain)} — ${esc(r.reason || 'Could not check')}</div>`
      : `<div class="dresult-name"><b>${esc(r.sld || '')}</b>.${esc(r.tld || '')}</div>`;

    return `<div class="${cls.join(' ')}">${label}${r.invalid || r.errored ? '' : price}</div>`;
  }

  form.addEventListener('submit', async (e) => {
    // Let the plain GET happen if the results container is not on this page —
    // the homepage box navigates to /domains, it does not render there.
    if (!results) return;
    e.preventDefault();

    const raw = (input.value || '').trim();
    if (!raw) {
      input.focus();
      return;
    }

    if (submit) {
      submit.disabled = true;
      submit.dataset.label = submit.innerHTML;
      submit.innerHTML = '<span class="spinner"></span>';
    }

    // One skeleton row: we are waiting on one answer, so promising six is a
    // lie the layout has to take back a second later.
    results.innerHTML = skeleton(1);
    results.hidden = false;
    // Move to the answer WHILE it loads, not after. The skeleton is already on
    // screen, so the scroll lands on something rather than on blank space.
    revealResults();

    // So a reload or a shared link shows the same search. The #results fragment
    // is kept on the URL for the same reason the form action carries it: a
    // reload of a shared link should open on the answer.
    const url = new URL(window.location.href);
    url.searchParams.set('q', raw);
    url.hash = 'results';
    window.history.replaceState({}, '', url);

    // Bumped on every submit. A slow suggestions response from a previous
    // search must not paint itself over the results of a newer one — the
    // visitor types, waits, retypes, and the stale answer wins by arriving
    // last. Compared on return; a mismatch means abandon the render.
    const token = (form.dataset.searchToken = String(Date.now()));

    const restoreButton = () => {
      if (submit) {
        submit.disabled = false;
        submit.innerHTML = submit.dataset.label;
      }
    };

    let data;
    try {
      const res = await fetch('/api/domains/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: raw }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      if (form.dataset.searchToken !== token) return;
      results.innerHTML =
        '<div class="alert alert-warn">We could not check that just now. Please try again in a moment.</div>';
      if (window.vhToast) window.vhToast('Domain lookup failed.', 'error');
      restoreButton();
      return;
    }

    if (form.dataset.searchToken !== token) return;
    restoreButton();

    if (data.error) {
      results.innerHTML = `<div class="alert alert-warn">${esc(data.error)}</div>`;
      return;
    }

    // ---- Paint the answer they asked for, now. ----
    const head = [];
    if (data.exact) {
      head.push(
        `<p class="kicker mb-2">${data.exact.available ? 'Good news' : 'That one is taken'}</p>`,
        resultRow(data.exact, true),
      );
    }
    const suggestTlds = Array.isArray(data.suggest) ? data.suggest : [];
    if (suggestTlds.length) {
      head.push(
        '<p class="kicker mt-3 mb-2">Other extensions</p>',
        `<div data-suggestions>${skeleton(Math.min(suggestTlds.length, 6))}</div>`,
      );
    }
    results.innerHTML = head.join('');

    // ---- Then fill in the alternatives. ----
    if (!suggestTlds.length) return;
    const slot = results.querySelector('[data-suggestions]');
    try {
      const res = await fetch('/api/domains/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sld: data.sld, tlds: suggestTlds }),
      });
      const more = await res.json();
      if (form.dataset.searchToken !== token || !slot) return;

      const rows = (more.suggestions || []).filter((s) => !s.errored);
      slot.innerHTML = rows.length
        ? rows
            .map((s, i) =>
              resultRow(s, false).replace('class="dresult', `style="animation-delay:${i * 55}ms" class="dresult`),
            )
            .join('')
        : '';
    } catch (err) {
      // The exact answer is already on screen and is the one that mattered.
      // Quietly drop the cross-sell rather than replacing a good result with
      // an error banner.
      if (slot) slot.innerHTML = '';
    }
  });

  // A ?q= already in the URL means the page was linked to or reloaded.
  const initial = new URLSearchParams(window.location.search).get('q');
  if (initial && results) {
    if (results.dataset.serverRendered) {
      /*
       * The server already drew the answer, so there is nothing to fetch — but
       * the reader still arrives at the top of a hero with the result off
       * screen, which is the same confusion by a different route. The #results
       * fragment handles most arrivals; this covers the ones without it (an old
       * bookmark, a link shared before this change, a form posted from another
       * page). Deferred a frame so it runs after the browser's own fragment
       * scroll rather than fighting it.
       */
      requestAnimationFrame(revealResults);
    } else {
      input.value = initial;
      form.requestSubmit();
    }
  }
})();
