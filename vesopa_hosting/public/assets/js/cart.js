/* ===========================================================================
   Basket behaviour.

   Two things, both of which must degrade to a plain form post:

     1. Every basket change — the billing period, quantity, removing a line,
        applying a code — posts in the background and swaps the two columns in
        place. No reload, no scroll jump, no losing your place halfway down.
     2. The domain search inside the basket, which reuses the same two-stage
        endpoints as the main search but renders into the basket card and adds
        straight to this basket.

   THE BROWSER NEVER WORKS OUT A PRICE. It posts the change, the server prices
   the basket exactly as it does for a full page load, and sends back the two
   columns already rendered. Patching the numbers here would have meant a second
   copy of the discount rules, the free-domain rules and the VAT arithmetic in
   another language — and the customer would be the one to find the day they
   disagreed.

   Everything degrades. Each control is a real submit button in a real form, so
   with this file blocked or still loading, clicking one posts and redirects
   exactly as it always did.
   =========================================================================== */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const root = $('[data-cart]');
  const mainCol = $('#cart-main');
  const sumCol = $('#cart-summary');

  /* ---- In-place basket updates ------------------------------------------ */
  /*
   * One request at a time, and the LAST click wins.
   *
   * Tapping 1 year then 3 years quickly fires two posts, and without this the
   * basket lands on whichever reply happened to arrive last — which on a flaky
   * connection is routinely the first one. A token per request means a stale
   * reply is recognised and dropped.
   */
  let token = 0;

  async function postCart(form, submitter) {
    if (!root || !mainCol || !sumCol) return false;

    const body = new URLSearchParams(new FormData(form));
    // FormData omits the button that was pressed, and on the period picker the
    // button IS the value. Without this every tab would post the same term.
    if (submitter && submitter.name) body.set(submitter.name, submitter.value);

    const mine = ++token;
    root.classList.add('is-busy');
    if (submitter) submitter.classList.add('is-working');

    let data;
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Cart-Fragment': '1',
        },
        body: body.toString(),
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
    } catch (err) {
      // A failed update must not leave the page showing a change that did not
      // happen. Falling back to the plain post gets the customer a correct
      // page, which matters more than avoiding the reload.
      form.submit();
      return true;
    }

    if (mine !== token) return true;      // a newer click already went out
    root.classList.remove('is-busy');

    // An emptied basket is a different page, not a different fragment.
    if (data.empty) { window.location.assign('/cart'); return true; }

    mainCol.innerHTML = data.main;
    sumCol.innerHTML = data.summary;
    bind();
    if (data.message && window.vhToast) window.vhToast(data.message, data.kind);
    return true;
  }

  /**
   * Wire up whatever is currently in the two columns.
   *
   * Called again after every swap, because innerHTML replaces the nodes the
   * previous listeners were attached to. Delegation from `root` would avoid
   * that, but the domain search below keeps per-element state and is far
   * clearer re-bound than reconstructed from an event target.
   */
  function bind() {
    $$('[data-cart-form]', root).forEach((form) => {
      if (form.dataset.bound) return;
      form.dataset.bound = '1';
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        postCart(form, e.submitter);
      });
    });

    // The period tabs light up the moment they are pressed rather than when
    // the reply lands. The server's answer is authoritative and arrives a
    // moment later; this only removes the pause where nothing acknowledged
    // the click at all.
    $$('.seg-opt', root).forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        $$('.seg-opt', btn.closest('.seg')).forEach((b) => {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-pressed', String(b === btn));
        });
      });
    });

    bindDomainSearch();
  }

  if (root) bind();

  /* ---- Domain search inside the basket ----------------------------------- */
  function bindDomainSearch() {
  const form = $('[data-domain-search]');
  const results = $('[data-domain-results]');
  if (!form || !results || form.dataset.bound) return;
  form.dataset.bound = '1';

  const input = $('.dsearch-input', form);
  const submit = $('[type=submit]', form);

  $$('[data-tld-chip]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const name = (input.value || '').trim().split('.')[0];
      if (!name) { input.focus(); return; }
      input.value = `${name}.${chip.dataset.tldChip}`;
      form.requestSubmit();
    });
  });

  const skeleton = (n) =>
    Array.from({ length: n })
      .map(() => '<div class="dresult"><span class="dresult-name muted">Checking…</span>' +
                 '<span class="dresult-price"><span class="checking"><i></i><i></i><i></i></span></span></div>')
      .join('');

  function row(r, hero) {
    if (r.invalid || r.errored) {
      return `<div class="dresult is-taken"><span class="dresult-name muted">${esc(r.domain)} — ${esc(r.reason || 'could not check')}</span></div>`;
    }
    if (!r.available) {
      return `<div class="dresult is-taken">
        <span class="dresult-name">${esc(r.sld)}.${esc(r.tld)}</span>
        <span class="dresult-price"><span class="badge badge-grey">Taken</span></span>
      </div>`;
    }
    return `<div class="dresult${hero ? ' dresult-hero' : ''}">
      <span class="dresult-name"><b>${esc(r.sld)}</b>.${esc(r.tld)}</span>
      <span class="dresult-price">
        <span class="amt">${esc(r.price_display)}</span>
        <span class="per">first year</span>
      </span>
      <a class="btn btn-sm" href="/cart/add-domain?domain=${encodeURIComponent(r.domain)}">Add</a>
    </div>`;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = (input.value || '').trim();
    if (!q) { input.focus(); return; }

    const label = submit.innerHTML;
    submit.disabled = true;
    submit.innerHTML = '<span class="spinner"></span>';
    results.hidden = false;
    results.innerHTML = skeleton(1);

    // Same guard as the main search: a slow reply from an earlier query must
    // not paint over a newer one.
    const token = (form.dataset.token = String(Date.now()));

    let data;
    try {
      const res = await fetch('/api/domains/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q }),
      });
      data = await res.json();
    } catch (err) {
      if (form.dataset.token === token) {
        results.innerHTML = '<div class="alert alert-warn mb-0">We could not check that just now. Try again in a moment.</div>';
      }
      submit.disabled = false;
      submit.innerHTML = label;
      return;
    }

    if (form.dataset.token !== token) return;
    submit.disabled = false;
    submit.innerHTML = label;

    if (data.error) {
      results.innerHTML = `<div class="alert alert-warn mb-0">${esc(data.error)}</div>`;
      return;
    }

    const suggest = Array.isArray(data.suggest) ? data.suggest : [];
    results.innerHTML =
      row(data.exact, true) +
      (suggest.length ? `<div data-more>${skeleton(Math.min(suggest.length, 4))}</div>` : '');

    if (!suggest.length) return;
    const slot = $('[data-more]', results);
    try {
      const res = await fetch('/api/domains/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sld: data.sld, tlds: suggest.slice(0, 4) }),
      });
      const more = await res.json();
      if (form.dataset.token !== token || !slot) return;
      slot.innerHTML = (more.suggestions || []).filter((s) => s.available).map((s) => row(s, false)).join('');
    } catch (err) {
      if (slot) slot.innerHTML = '';
    }
  });
  }
})();
