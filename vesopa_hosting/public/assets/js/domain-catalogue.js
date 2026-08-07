/* ===========================================================================
   The domain catalogue browser.
   ---------------------------------------------------------------------------
   Three jobs, and they are separate on purpose:

     1. the name box   — one input that every Check button on the page reads
     2. the filters    — chips and a select that re-query without a reload
     3. the scroll     — the next page of cards, appended as you reach the end

   THE SERVER STILL OWNS THE MARKUP. /api/domains/catalogue returns rendered
   HTML from the same partial the page was built with, so this file appends a
   string and never builds a card. That is what stops the two hundredth card
   from looking different to the first.

   Everything degrades. With no JavaScript the page is a server-rendered first
   page of 60 cards, the category links are real links, and every Check button
   is a real href to /domains?q=<tld>.
   =========================================================================== */
(function () {
  'use strict';

  const grid = document.querySelector('[data-catalogue-grid]');
  if (!grid) return;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const bar = $('[data-catalogue-bar]');
  const more = $('[data-catalogue-more]');
  const endCap = $('[data-catalogue-end]');
  const loadBtn = $('[data-catalogue-load]');
  const sentinel = $('[data-catalogue-sentinel]');
  const countEl = $('[data-catalogue-count]');
  const progressEl = $('[data-catalogue-progress]');
  const nameInput = $('[data-name-input]');
  const nameEcho = $('[data-name-echo]');
  const nameForm = $('[data-name-form]');

  /* ---------------------------------------------------------------------
     State lives in the URL, not in a variable.

     The address bar is the single source of truth for what is being shown,
     which means the back button works, a filtered view can be copied to
     somebody, and a reload lands on the same list. A parallel `state` object
     would be a second copy that goes stale the first time history changes
     underneath it.
     --------------------------------------------------------------------- */
  function readState() {
    const p = new URLSearchParams(window.location.search);
    // The category is a PATH segment on /domains/category/<slug>, not a query
    // param, because those pages are the indexable cut. Read it from wherever
    // it actually is.
    const path = window.location.pathname.match(/^\/domains\/category\/([a-z-]+)/);
    return {
      category: path ? path[1] : (p.get('category') || ''),
      band: p.get('band') || '',
      q: p.get('q') || '',
      sort: p.get('sort') || 'popular',
      promo: p.get('promo') === '1',
      popular: p.get('popular') === '1',
    };
  }

  /** Push the state into the address bar without reloading. */
  function writeState(state) {
    const p = new URLSearchParams();
    if (state.band) p.set('band', state.band);
    if (state.q) p.set('q', state.q);
    if (state.sort && state.sort !== 'popular') p.set('sort', state.sort);
    if (state.promo) p.set('promo', '1');
    if (state.popular) p.set('popular', '1');
    // Stay on the category page if that is where we are; the category is not
    // demoted to a query param just because another filter changed.
    const base = window.location.pathname.startsWith('/domains/category/')
      ? window.location.pathname
      : '/domains/pricing';
    const qs = p.toString();
    window.history.replaceState({}, '', qs ? `${base}?${qs}` : base);
  }

  function queryFor(state, page) {
    const p = new URLSearchParams();
    if (state.category) p.set('category', state.category);
    if (state.band) p.set('band', state.band);
    if (state.q) p.set('q', state.q);
    if (state.sort) p.set('sort', state.sort);
    if (state.promo) p.set('promo', '1');
    if (state.popular) p.set('popular', '1');
    p.set('page', String(page));
    return p.toString();
  }

  let page = 1;
  let hasMore = more && !more.hidden;
  let loading = false;
  let shown = grid.children.length;
  let total = Number((countEl && countEl.querySelector('b') || {}).textContent) || shown;

  /* ---------------------------------------------------------------------
     Fetching
     --------------------------------------------------------------------- */

  /**
   * @param {boolean} replace  true when a filter changed (wipe and redraw),
   *                           false when scrolling (append)
   */
  async function fetchPage(wanted, replace) {
    if (loading) return;
    loading = true;
    if (loadBtn) {
      loadBtn.disabled = true;
      loadBtn.dataset.label = loadBtn.dataset.label || loadBtn.textContent.trim();
      loadBtn.innerHTML = '<span class="spinner"></span>';
    }
    if (replace) grid.setAttribute('aria-busy', 'true');

    const state = readState();
    let data;
    try {
      const res = await fetch(`/api/domains/catalogue?${queryFor(state, wanted)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      loading = false;
      if (loadBtn) {
        loadBtn.disabled = false;
        loadBtn.textContent = 'Try again';
      }
      if (window.vhToast) window.vhToast('Could not load more extensions.', 'error');
      return;
    }

    if (replace) {
      grid.innerHTML = data.html;
      shown = data.count;
      // A new filter starts a new list; the reader should be looking at the
      // top of it and not wherever they happened to be in the old one.
      if (bar) {
        const y = bar.getBoundingClientRect().top + window.scrollY - 8;
        if (window.scrollY > y) window.scrollTo({ top: y, behavior: 'smooth' });
      }
    } else {
      grid.insertAdjacentHTML('beforeend', data.html);
      shown += data.count;
    }
    grid.removeAttribute('aria-busy');

    page = data.page;
    total = data.total;
    hasMore = data.hasMore;
    paintCounts(state);
    applyName();

    loading = false;
    if (loadBtn) {
      loadBtn.disabled = false;
      loadBtn.textContent = loadBtn.dataset.label || 'Show more extensions';
    }
    if (more) more.hidden = !hasMore;
    if (endCap) endCap.hidden = hasMore || !total;
  }

  function paintCounts(state) {
    if (countEl) {
      const bits = [`<b>${total}</b> extension${total === 1 ? '' : 's'}`];
      if (state.q) bits.push(`matching “${escapeHtml(state.q)}”`);
      countEl.innerHTML = bits.join(' ');
    }
    if (progressEl) progressEl.innerHTML = `Showing <b>${shown}</b> of ${total}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ---------------------------------------------------------------------
     Filters
     --------------------------------------------------------------------- */
  function setFilter(key, value) {
    const state = readState();
    // A chip is a toggle: pressing the one already on turns it off rather than
    // doing nothing, which is what a pressed-looking button should do.
    if (key === 'band') state.band = state.band === value ? '' : value;
    else if (key === 'promo') state.promo = !state.promo;
    else if (key === 'popular') state.popular = !state.popular;
    else state[key] = value;

    writeState(state);
    syncChips(state);
    fetchPage(1, true);
  }

  function syncChips(state) {
    $$('[data-filter]').forEach((el) => {
      const key = el.dataset.filter;
      if (el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
      const on = key === 'band' ? state.band === el.dataset.value
        : key === 'promo' ? state.promo
          : key === 'popular' ? state.popular
            : false;
      el.classList.toggle('is-on', Boolean(on));
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  $$('[data-filter]').forEach((el) => {
    const key = el.dataset.filter;
    if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => setFilter(key, el.value));
      return;
    }
    if (el.tagName === 'INPUT') {
      /*
       * Debounced, because this fires per keystroke and "shopping" is eight
       * requests. 260ms is long enough to swallow a word being typed and short
       * enough that the list feels like it is responding to you.
       */
      let timer = null;
      el.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const state = readState();
          state.q = el.value.trim().replace(/^\./, '');
          writeState(state);
          fetchPage(1, true);
        }, 260);
      });
      return;
    }
    el.addEventListener('click', () => setFilter(key, el.dataset.value || ''));
  });

  /* ---------------------------------------------------------------------
     The scroll
     --------------------------------------------------------------------- */
  if (loadBtn) loadBtn.addEventListener('click', () => hasMore && fetchPage(page + 1, false));

  if (sentinel && 'IntersectionObserver' in window) {
    /*
     * `rootMargin` fires the load 600px BEFORE the sentinel is visible, so the
     * next batch is usually already in the DOM by the time the reader gets
     * there and the scroll never actually stops. Waiting for it to be on screen
     * makes every page boundary a visible pause.
     */
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && hasMore && !loading) fetchPage(page + 1, false);
    }, { rootMargin: '600px 0px' });
    io.observe(sentinel);
  }

  /* ---------------------------------------------------------------------
     The name box — what every Check button on the page points at
     --------------------------------------------------------------------- */

  /** Strip anything that is not a legal domain label. */
  function cleanName(raw) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .split('.')[0]
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 63);
  }

  /**
   * Rewrite every Check button to point at the name currently typed.
   *
   * Called after each render too, because the cards appended by the scroll
   * arrive from the server with the placeholder href and have never seen the
   * input. Missing that is how the first 60 buttons work and the rest search
   * for nothing.
   */
  function applyName() {
    const name = cleanName(nameInput ? nameInput.value : '');
    if (nameEcho) nameEcho.textContent = name || 'yourname';

    $$('[data-tld]', grid).forEach((a) => {
      const tld = a.dataset.tld;
      const label = a.querySelector('[data-check-name]');
      if (name) {
        a.href = `/domains?q=${encodeURIComponent(`${name}.${tld}`)}`;
        a.classList.remove('needs-name');
        if (label) label.textContent = `${name}.${tld}`;
      } else {
        // No name yet: the link still goes somewhere useful — the search page
        // with the extension pre-filled — but it is flagged so the click
        // handler below can ask for a name first.
        a.href = `/domains?q=${encodeURIComponent(tld)}`;
        a.classList.add('needs-name');
        if (label) label.textContent = 'a name';
      }
    });
  }

  if (nameInput) {
    nameInput.addEventListener('input', applyName);
    // Remember it across pages. Somebody who typed their name on /domains and
    // clicked through to a category should not have to type it again — and the
    // buttons on the new page are useless until they do.
    try {
      const saved = sessionStorage.getItem('vh_domain_name');
      if (saved && !nameInput.value) nameInput.value = saved;
    } catch (err) { /* private mode; the box just starts empty */ }
    nameInput.addEventListener('change', () => {
      try { sessionStorage.setItem('vh_domain_name', cleanName(nameInput.value)); } catch (err) { /* ignore */ }
    });
  }

  if (nameForm) {
    nameForm.addEventListener('submit', (e) => {
      const name = cleanName(nameInput && nameInput.value);
      if (!name) {
        e.preventDefault();
        nudge();
        return;
      }
      // Let the plain GET to /domains happen — that page runs the real search.
      try { sessionStorage.setItem('vh_domain_name', name); } catch (err) { /* ignore */ }
    });
  }

  /** Ask for a name instead of running a search for nothing. */
  function nudge() {
    if (!nameInput) return;
    nameInput.focus();
    const form = nameInput.closest('.dsearch-form') || nameInput;
    form.classList.remove('shake');
    // Reflow, or the class is removed and re-added inside one frame and the
    // animation never restarts on a second click.
    void form.offsetWidth;
    form.classList.add('shake');
    if (window.vhToast) window.vhToast('Type the name you want first.', 'info');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  grid.addEventListener('click', (e) => {
    const link = e.target.closest('[data-tld]');
    if (link && link.classList.contains('needs-name')) {
      e.preventDefault();
      nudge();
    }
  });

  applyName();
  syncChips(readState());
})();
