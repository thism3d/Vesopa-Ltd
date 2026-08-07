/* ===========================================================================
   The per-extension page.
   ---------------------------------------------------------------------------
   Two small jobs:

     1. the locked-extension search box — the visitor types "yourbusiness" and
        the form submits "yourbusiness.agency"
     2. the related-extension cards below, whose Check buttons need the same
        name applied to them as on the browser page

   The search itself happens on /domains. This page never calls the registrar;
   it is a price page that hands off.
   =========================================================================== */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const form = $('[data-tld-check]');
  const nameInput = $('[data-tld-name]');
  const qField = $('[data-tld-q]');
  const suffix = $('.dtldp-suffix');
  const tld = suffix ? suffix.textContent.trim().replace(/^\./, '') : '';

  function clean(raw) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .split('.')[0]
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 63);
  }

  if (form && nameInput && qField) {
    /*
     * The hidden `q` is rewritten on input rather than only on submit.
     *
     * A form can be submitted by Enter, by the button, or by the browser
     * restoring and re-submitting it, and only one of those reliably runs a
     * submit handler first. Keeping `q` correct at all times means the field is
     * right whichever way the form leaves.
     */
    const sync = () => {
      const name = clean(nameInput.value);
      qField.value = name ? `${name}.${tld}` : tld;
    };
    nameInput.addEventListener('input', sync);

    form.addEventListener('submit', (e) => {
      const name = clean(nameInput.value);
      if (!name) {
        e.preventDefault();
        nameInput.focus();
        form.classList.remove('shake');
        void form.offsetWidth;
        form.classList.add('shake');
        return;
      }
      sync();
      // Carried to the browser page, so clicking through to a category does not
      // ask for the name a second time.
      try { sessionStorage.setItem('vh_domain_name', name); } catch (err) { /* private mode */ }
    });

    // Pre-fill from an earlier search in this session.
    try {
      const saved = sessionStorage.getItem('vh_domain_name');
      if (saved) nameInput.value = saved;
    } catch (err) { /* private mode */ }
    sync();
  }

  /* --- Related cards ----------------------------------------------------- */
  // Same behaviour as the catalogue browser: buttons point at the typed name.
  // Duplicated deliberately rather than loading the whole browser script — this
  // page has no filters, no paging and no sentinel, and pulling in that file to
  // reuse forty lines would ship all of it.
  function applyName() {
    const name = clean(nameInput ? nameInput.value : '');
    $$('[data-tld]').forEach((a) => {
      const other = a.dataset.tld;
      const label = a.querySelector('[data-check-name]');
      a.href = `/domains?q=${encodeURIComponent(name ? `${name}.${other}` : other)}`;
      if (label) label.textContent = name ? `${name}.${other}` : 'a name';
    });
  }

  if (nameInput) nameInput.addEventListener('input', applyName);
  applyName();
})();
