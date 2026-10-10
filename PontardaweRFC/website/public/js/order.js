/* pontardawerfc.com/menu: the clubhouse menu and ordering, live from the
   club's Vesopa EPOS back office (the same menu and order API as
   menu.vesopa.com). Prices are worked out again by the server when the
   order is placed; what this page shows is only a quote.

   Two ways to order:
   - to a table in the clubhouse (from a table code ?table=…, or picked here),
   - for collection, paid at the bar (when the club turns it on).
   Orders land on the till like any other dine-in order. */
(function () {
  'use strict';
  var d = document;
  var app = d.querySelector('[data-order]');
  if (!app || !window.fetch) return;

  var API = app.getAttribute('data-api').replace(/\/+$/, '');
  var SLUG = app.getAttribute('data-slug');
  var PHONE = app.getAttribute('data-phone');
  var TEL = app.getAttribute('data-tel');
  var $ = function (sel) { return app.querySelector(sel); };

  var statusBox = $('[data-order-status]');
  var modesBox = $('[data-modes]');
  var layout = $('[data-layout]');
  var tabs = $('[data-tabs]');
  var search = $('[data-search]');
  var sectionsBox = $('[data-sections]');
  var linesBox = $('[data-basket-lines]');
  var totalsBox = $('[data-totals]');
  var checkout = $('[data-checkout]');
  var whereBox = $('[data-where]');
  var whenWrap = $('[data-when-wrap]');
  var whenSel = $('[data-when]');
  var errorBox = $('[data-error]');
  var placeBtn = $('[data-place]');
  var bar = $('[data-basket-bar]');
  var sheet = $('[data-sheet]');
  var sheetForm = $('[data-sheet-form]');

  var STORE = 'prfc-basket-' + SLUG;
  var LAST = 'prfc-last-order';
  var venue = null;
  var sections = [];
  var items = {};
  var mode = null;
  var table = null;          // { public_id, name, room, fixed }
  var floor = null;
  var basket = [];

  var ICON = {
    plus: '<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    minus: '<svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>',
    check: '<svg class="ic" width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    info: '<svg class="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(minor) { return '£' + (Math.round(Number(minor) || 0) / 100).toFixed(2); }
  function img(url) {
    if (!url) return '';
    if (/^https:\/\//.test(url)) return url;
    if (url.charAt(0) === '/') return API + url;
    return '';
  }
  function getJSON(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
    });
  }
  function load(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function keep(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* private window */ } }

  /* --- Start ------------------------------------------------------------- */
  var params = new URLSearchParams(location.search);
  var tableCode = (params.get('table') || '').replace(/[^A-Za-z0-9_-]/g, '');
  var url = tableCode
    ? API + '/api/public/dinein/table/' + encodeURIComponent(tableCode)
    : API + '/api/public/dinein/venue/' + encodeURIComponent(SLUG);

  showLastOrder();
  getJSON(url).then(function (res) {
    if (!res.ok) {
      if (tableCode && res.status === 404) {
        // A stale or mistyped table code: fall back to the club's own menu.
        tableCode = '';
        return getJSON(API + '/api/public/dinein/venue/' + encodeURIComponent(SLUG)).then(start);
      }
      return start(res);
    }
    return start(res);
  }).catch(function () { comingSoon(true); });

  function start(res) {
    if (!res.ok || !res.body || !res.body.venue) return comingSoon(res.status !== 404);
    venue = res.body.venue;
    sections = (res.body.sections || []).filter(function (s) { return s && (s.items || []).length; });
    sections.forEach(function (s) { s.items.forEach(function (it) { items[it.id] = it; }); });
    if (res.body.table) {
      table = { public_id: res.body.table.public_id, name: res.body.table.name, room: res.body.table.room, fixed: true, ordering: res.body.table.ordering };
    }
    basket = (load(STORE) || []).filter(function (l) { return l && items[l.item_id]; });

    var notes = [];
    var s = venue.schedule;
    var canOrder = venue.ordering_open && !(s && s.enforced && !s.open);
    if (!venue.ordering_open) {
      notes.push('Online ordering is switched off right now. You can still see the menu and order at the bar, or call ' + link() + '.');
    } else if (s && s.enforced && !s.open) {
      notes.push('The kitchen is closed right now' + (s.next ? ', and opens ' + (s.next.today ? 'today' : 'on ' + esc(s.next.day)) + ' at ' + esc(s.next.at) : '') + '. ' + (venue.closed_message ? esc(venue.closed_message) : 'You can still look at the menu.'));
    }
    if (venue.notice) notes.push(esc(venue.notice));
    if (venue.offer) notes.push('<b>' + esc(venue.offer.label || venue.offer.percent + '% off') + '</b>' + (venue.offer.min_spend_minor ? ' on orders over ' + money(venue.offer.min_spend_minor) : '') + '.');
    statusBox.innerHTML = notes.map(function (n) { return '<p class="notice">' + ICON.info + '<span>' + n + '</span></p>'; }).join('');

    app.classList.toggle('can-order', !!canOrder);
    if (canOrder) setupModes();
    renderMenu();
    renderBasket();
    layout.hidden = false;
    if (location.hash) {
      var target = d.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView();
    }
  }

  function link() { return '<a href="tel:' + esc(TEL) + '">' + esc(PHONE) + '</a>'; }

  function comingSoon(failed) {
    statusBox.innerHTML = '<div class="card closed-card"><span class="tile-ic">' + ICON.info + '</span>' +
      '<h2>' + (failed ? 'The menu is not loading' : 'Online menu coming soon') + '</h2>' +
      '<p>' + (failed
        ? 'We could not reach the bar\'s till just now. Please try again in a minute, or order at the bar.'
        : 'Ordering from your phone is nearly ready. Until then, order at the bar or call us.') + '</p>' +
      '<p class="cta-row" style="justify-content:center"><a class="btn btn-glow" href="tel:' + esc(TEL) + '">Call ' + esc(PHONE) + '</a></p></div>';
  }

  /* --- Table or collection ------------------------------------------------ */
  function setupModes() {
    var collect = !!venue.collection_open && !table;
    var buttons = modesBox.querySelectorAll('[data-mode]');
    if (table && table.fixed) {
      setMode('table');
      return;
    }
    if (!collect) {
      setMode('table');
      return;
    }
    modesBox.hidden = false;
    buttons.forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
    });
    var saved = load('prfc-mode');
    setMode(saved === 'collect' || saved === 'table' ? saved : 'collect');
  }

  function setMode(m) {
    mode = m;
    keep('prfc-mode', m);
    modesBox.querySelectorAll('[data-mode]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === m));
    });
    whenWrap.hidden = m !== 'collect';
    if (m === 'collect') fillTimes();
    if (m === 'table' && !table && !floor) loadFloor();
    renderWhere();
    renderBasket();
  }

  function loadFloor() {
    floor = { rooms: [], tables: [], loading: true };
    getJSON(API + '/api/public/dinein/floor/' + encodeURIComponent(SLUG)).then(function (res) {
      floor = res.ok ? res.body : { rooms: [], tables: [] };
      renderWhere();
    }).catch(function () { floor = { rooms: [], tables: [] }; renderWhere(); });
  }

  function renderWhere() {
    if (mode === 'collect') {
      whereBox.innerHTML = '<div class="where">For collection at the bar. Ready in about ' + esc(venue.collection_minutes || 25) + ' minutes; pay when you collect.</div>';
      return;
    }
    if (table) {
      whereBox.innerHTML = '<div class="where">To <b>' + esc(table.name) + '</b>' + (table.room ? ' in ' + esc(table.room) : '') +
        (table.fixed ? '' : ' <button type="button" class="btn btn-sm btn-line" data-change-table>Change</button>') + '</div>';
      var change = whereBox.querySelector('[data-change-table]');
      if (change) change.addEventListener('click', function () { table = null; renderWhere(); renderBasket(); });
      return;
    }
    if (!floor || floor.loading) {
      whereBox.innerHTML = '<div class="where">Finding the tables…</div>';
      return;
    }
    if (!floor.tables || !floor.tables.length) {
      whereBox.innerHTML = '<div class="where">Scan the code on your table to order to it, or order at the bar.</div>';
      return;
    }
    var rooms = {};
    (floor.rooms || []).forEach(function (r) { rooms[r.id] = r.name; });
    var groups = {};
    floor.tables.forEach(function (t) {
      var g = rooms[t.room_id] || 'Clubhouse';
      (groups[g] = groups[g] || []).push(t);
    });
    whereBox.innerHTML = '<label>Which table are you at?<select data-table-pick><option value="">Choose your table</option>' +
      Object.keys(groups).map(function (g) {
        return '<optgroup label="' + esc(g) + '">' + groups[g].map(function (t) {
          return '<option value="' + esc(t.public_id) + '">' + esc(t.name) + (t.seats ? ' (' + t.seats + ' seats)' : '') + (t.busy ? ' · bill open' : '') + '</option>';
        }).join('') + '</optgroup>';
      }).join('') + '</select></label><p class="small muted">The number is on the code on your table.</p>';
    whereBox.querySelector('[data-table-pick]').addEventListener('change', function (e) {
      var t = floor.tables.filter(function (x) { return x.public_id === e.target.value; })[0];
      if (!t) return;
      table = { public_id: t.public_id, name: t.name, room: rooms[t.room_id] || null, fixed: false };
      renderWhere();
      renderBasket();
    });
  }

  /* Collection times: as soon as possible, then every 15 minutes until the
     kitchen closes today. The time goes on the order as a note for the bar. */
  function fillTimes() {
    var mins = Number(venue.collection_minutes) || 25;
    var opts = ['<option value="">As soon as possible (about ' + mins + ' min)</option>'];
    var s = venue.schedule;
    var close = s && s.enforced && s.today && !s.today.closed ? s.today.close : '23:00';
    var cParts = String(close).split(':');
    var closeMin = Number(cParts[0]) * 60 + Number(cParts[1] || 0);
    if (closeMin <= 6 * 60) closeMin += 24 * 60;
    var now = new Date();
    var t = now.getHours() * 60 + now.getMinutes() + mins + 15;
    t = Math.ceil(t / 15) * 15;
    for (var n = 0; t <= closeMin - 15 && n < 40; t += 15, n++) {
      var hh = Math.floor(t / 60) % 24;
      var label = (hh < 10 ? '0' : '') + hh + ':' + ((t % 60) < 10 ? '0' : '') + (t % 60);
      opts.push('<option>' + label + '</option>');
    }
    whenSel.innerHTML = opts.join('');
  }

  /* --- The menu ------------------------------------------------------------ */
  function renderMenu() {
    if (!sections.length) {
      sectionsBox.innerHTML = '<p class="notice">' + ICON.info + '<span>The menu is being updated. Please ask at the bar or call ' + link() + '.</span></p>';
      tabs.hidden = true;
      search.parentNode.hidden = true;
      return;
    }
    tabs.innerHTML = sections.map(function (s, i) {
      return '<a href="#sec-' + s.id + '"' + (i === 0 ? ' class="on"' : '') + '>' + esc(s.name) + '</a>';
    }).join('');
    sectionsBox.innerHTML = sections.map(function (s) {
      return '<section class="menu-sec" id="sec-' + s.id + '" data-sec><h2>' + esc(s.name) + '</h2>' +
        (s.blurb ? '<p>' + esc(s.blurb) + '</p>' : '') +
        s.items.map(dish).join('') + '</section>';
    }).join('');

    sectionsBox.addEventListener('click', function (e) {
      var b = e.target.closest('[data-add]');
      if (!b) return;
      var it = items[b.getAttribute('data-add')];
      if (!it) return;
      if ((it.add_ons || []).length) openSheet(it);
      else addLine(it, [], 1, '');
    });

    if ('IntersectionObserver' in window) {
      var links = tabs.querySelectorAll('a');
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          links.forEach(function (a) {
            var on = a.getAttribute('href') === '#' + en.target.id;
            a.classList.toggle('on', on);
            if (on && a.scrollIntoView && tabs.scrollWidth > tabs.clientWidth) tabs.scrollLeft = a.offsetLeft - 20;
          });
        });
      }, { rootMargin: '-30% 0px -60% 0px' });
      sectionsBox.querySelectorAll('[data-sec]').forEach(function (el) { io.observe(el); });
    }

    search.addEventListener('input', function () {
      var q = search.value.trim().toLowerCase();
      sectionsBox.querySelectorAll('[data-sec]').forEach(function (sec) {
        var any = false;
        sec.querySelectorAll('[data-dish]').forEach(function (el) {
          var hit = !q || el.getAttribute('data-text').indexOf(q) !== -1;
          el.hidden = !hit;
          if (hit) any = true;
        });
        sec.hidden = !any;
      });
    });
  }

  function dish(it) {
    var off = !it.available || it.out_of_stock;
    var pic = img(it.image_url);
    var chips = [];
    if (it.popular) chips.push('<span class="chip hot">Popular</span>');
    (it.diet || []).forEach(function (t) { chips.push('<span class="chip diet">' + esc(t) + '</span>'); });
    if (it.calories) chips.push('<span class="chip">' + esc(it.calories) + ' kcal</span>');
    if (it.allergens && it.allergens.length) chips.push('<span class="chip">Contains: ' + esc(it.allergens.join(', ')) + '</span>');
    if (it.may_contain && it.may_contain.length) chips.push('<span class="chip">May contain: ' + esc(it.may_contain.join(', ')) + '</span>');
    if (it.left != null && it.left > 0 && it.left <= 5 && !off) chips.push('<span class="chip hot">Only ' + it.left + ' left</span>');
    var text = [it.name, it.description].concat(it.diet || []).join(' ').toLowerCase();
    return '<article class="dish' + (pic ? ' has-img' : '') + (off ? ' off' : '') + '" data-dish data-text="' + esc(text) + '">' +
      (pic ? '<img src="' + esc(pic) + '" alt="" loading="lazy" width="96" height="96">' : '') +
      '<div><h3>' + esc(it.name) + '</h3>' + (it.description ? '<p>' + esc(it.description) + '</p>' : '') +
      (chips.length ? '<div class="chips">' + chips.join('') + '</div>' : '') + '</div>' +
      '<div class="center"><div class="price">' + money(it.price_minor) + '</div>' +
      (off ? '<div class="small muted">Sold out</div>'
        : app.classList.contains('can-order') ? '<button type="button" class="btn btn-sm btn-glow add" data-add="' + it.id + '" aria-label="Add ' + esc(it.name) + '">' + ICON.plus + ' Add</button>' : '') +
      '</div></article>';
  }

  /* --- Choices sheet ------------------------------------------------------- */
  function openSheet(it) {
    var qty = 1;
    sheetForm.innerHTML = '<h2 id="sheet-title">' + esc(it.name) + '</h2>' +
      (it.description ? '<p class="muted">' + esc(it.description) + '</p>' : '') +
      it.add_ons.map(function (g, gi) {
        var single = g.max_select === 1;
        var rule = g.min_select > 0
          ? (single ? 'Choose one' : 'Choose ' + g.min_select + (g.max_select ? ' to ' + g.max_select : ' or more'))
          : (g.max_select ? 'Optional, up to ' + g.max_select : 'Optional');
        return '<fieldset data-group="' + gi + '"><legend>' + esc(g.name) + ' <small class="muted">' + rule + '</small></legend>' +
          g.options.map(function (o) {
            return '<label class="opt"><input type="' + (single ? 'radio' : 'checkbox') + '" name="g' + gi + '" value="' + esc(o.plu_id) + '">' +
              '<span>' + esc(o.name) + (o.allergens && o.allergens.length ? ' <small class="muted">(' + esc(o.allergens.join(', ')) + ')</small>' : '') + '</span>' +
              (o.price_minor ? '<b>+' + money(o.price_minor) + '</b>' : '') + '</label>';
          }).join('') + '</fieldset>';
      }).join('') +
      '<label class="opt"><span>Note for the kitchen</span></label><input name="note" maxlength="120" placeholder="Optional" style="padding:10px;border-radius:12px;border:1px solid var(--line);font:inherit">' +
      '<p class="form-error" data-sheet-error role="alert" hidden></p>' +
      '<div class="sheet-actions"><div class="qty"><button type="button" data-q="-1" aria-label="One fewer">' + ICON.minus + '</button><b data-qn>1</b><button type="button" data-q="1" aria-label="One more">' + ICON.plus + '</button></div>' +
      '<button type="button" class="btn btn-line" data-cancel>Cancel</button>' +
      '<button type="submit" class="btn btn-glow" data-ok>Add · <span data-sum></span></button></div>';

    var err = sheetForm.querySelector('[data-sheet-error]');
    var chosen = function () {
      return it.add_ons.map(function (g, gi) {
        return [].slice.call(sheetForm.querySelectorAll('[name="g' + gi + '"]:checked')).map(function (i) { return i.value; });
      });
    };
    var sum = function () {
      var extra = 0;
      chosen().forEach(function (vals, gi) {
        vals.forEach(function (v) {
          var o = it.add_ons[gi].options.filter(function (x) { return String(x.plu_id) === v; })[0];
          if (o) extra += Number(o.price_minor) || 0;
        });
      });
      sheetForm.querySelector('[data-sum]').textContent = money((Number(it.price_minor) + extra) * qty);
    };
    sheetForm.onchange = function (e) {
      var fs = e.target.closest('[data-group]');
      if (fs && e.target.type === 'checkbox') {
        var g = it.add_ons[Number(fs.getAttribute('data-group'))];
        if (g.max_select && fs.querySelectorAll('input:checked').length > g.max_select) e.target.checked = false;
      }
      sum();
    };
    sheetForm.onclick = function (e) {
      var q = e.target.closest('[data-q]');
      if (q) {
        qty = Math.max(1, Math.min(20, qty + Number(q.getAttribute('data-q'))));
        sheetForm.querySelector('[data-qn]').textContent = qty;
        sum();
      }
      if (e.target.closest('[data-cancel]')) sheet.close();
    };
    sheetForm.onsubmit = function (e) {
      e.preventDefault();
      var picks = chosen();
      for (var gi = 0; gi < it.add_ons.length; gi++) {
        var g = it.add_ons[gi];
        if (picks[gi].length < (g.min_select || 0)) {
          err.textContent = 'Please choose ' + (g.min_select === 1 ? 'an option' : g.min_select + ' options') + ' for ' + g.name + '.';
          err.hidden = false;
          return;
        }
      }
      addLine(it, [].concat.apply([], picks), qty, sheetForm.querySelector('[name="note"]').value.trim());
      sheet.close();
    };
    sum();
    if (sheet.showModal) sheet.showModal(); else sheet.setAttribute('open', '');
  }

  /* --- The basket ---------------------------------------------------------- */
  function unitOf(line) {
    var it = items[line.item_id];
    var extra = 0;
    (it.add_ons || []).forEach(function (g) {
      g.options.forEach(function (o) { if (line.add_ons.indexOf(String(o.plu_id)) !== -1) extra += Number(o.price_minor) || 0; });
    });
    return Number(it.price_minor) + extra;
  }
  function choiceNames(line) {
    var it = items[line.item_id];
    var names = [];
    (it.add_ons || []).forEach(function (g) {
      g.options.forEach(function (o) { if (line.add_ons.indexOf(String(o.plu_id)) !== -1) names.push(o.name); });
    });
    return names;
  }

  function addLine(it, addOns, qty, note) {
    addOns = addOns.map(String).sort();
    var key = it.id + '|' + addOns.join(',') + '|' + note;
    var found = basket.filter(function (l) { return l.key === key; })[0];
    if (found) found.qty = Math.min(50, found.qty + qty);
    else basket.push({ key: key, item_id: it.id, add_ons: addOns, qty: qty, note: note });
    keep(STORE, basket);
    renderBasket();
    pulse();
  }

  function pulse() {
    var b = bar.querySelector('button');
    if (b && b.animate) b.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.05)' }, { transform: 'scale(1)' }], { duration: 300 });
  }

  function renderBasket() {
    if (!venue) return;
    var count = 0;
    var subtotal = 0;
    if (!basket.length) {
      linesBox.innerHTML = '<p class="muted">Nothing yet. Tap <b>Add</b> on a dish.</p>';
    } else {
      linesBox.innerHTML = basket.map(function (l, i) {
        var unit = unitOf(l);
        count += l.qty;
        subtotal += unit * l.qty;
        var extra = choiceNames(l);
        return '<div class="bline"><div><b>' + esc(items[l.item_id].name) + '</b>' +
          (extra.length ? '<small>' + esc(extra.join(', ')) + '</small>' : '') +
          (l.note ? '<small>“' + esc(l.note) + '”</small>' : '') +
          '<div class="qty"><button type="button" data-line="' + i + '" data-d="-1" aria-label="One fewer">' + ICON.minus + '</button><b>' + l.qty +
          '</b><button type="button" data-line="' + i + '" data-d="1" aria-label="One more">' + ICON.plus + '</button></div></div>' +
          '<div>' + money(unit * l.qty) + '</div></div>';
      }).join('');
    }
    var discount = 0;
    var o = venue.offer;
    if (o && subtotal >= (o.min_spend_minor || 0)) discount = Math.floor(subtotal * o.percent / 100);
    totalsBox.innerHTML = basket.length
      ? '<div><span>Subtotal</span><span>' + money(subtotal) + '</span></div>' +
        (discount ? '<div><span>' + esc(o.label || o.percent + '% off') + '</span><span>−' + money(discount) + '</span></div>' : '') +
        '<div class="grand"><span>Total</span><span>' + money(subtotal - discount) + '</span></div>'
      : '';
    var orderable = app.classList.contains('can-order');
    checkout.hidden = !basket.length || !orderable || !mode;
    placeBtn.disabled = mode === 'table' && !table;
    placeBtn.textContent = mode === 'collect' ? 'Place order for collection · ' + money(subtotal - discount) : 'Send to my table · ' + money(subtotal - discount);
    bar.hidden = !basket.length;
    bar.querySelector('[data-basket-count]').textContent = count + (count === 1 ? ' item' : ' items');
    bar.querySelector('[data-basket-total]').textContent = money(subtotal - discount);
  }

  linesBox.addEventListener('click', function (e) {
    var b = e.target.closest('[data-line]');
    if (!b) return;
    var l = basket[Number(b.getAttribute('data-line'))];
    if (!l) return;
    l.qty += Number(b.getAttribute('data-d'));
    if (l.qty <= 0) basket.splice(basket.indexOf(l), 1);
    keep(STORE, basket);
    renderBasket();
  });

  bar.querySelector('[data-basket-jump]').addEventListener('click', function () {
    $('[data-basket]').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* --- Placing the order --------------------------------------------------- */
  checkout.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = checkout.elements;
    var name = f.name.value.trim();
    var phone = f.phone.value.trim();
    var fail = function (msg) { errorBox.textContent = msg; errorBox.hidden = false; };
    errorBox.hidden = true;
    if (!basket.length) return fail('Your order is empty.');
    if (mode === 'table' && !table) return fail('Please choose your table.');
    if ((mode === 'collect' || venue.require_name) && !name) return fail('Please leave a name for the order.');
    if ((mode === 'collect' || venue.require_phone) && (phone.replace(/\D/g, '').length < 7)) return fail('Please leave a phone number we can call.');

    var body = {
      name: name,
      phone: phone,
      note: f.note.value.trim(),
      collect_at: mode === 'collect' ? whenSel.value : '',
      lines: basket.map(function (l) { return { item_id: l.item_id, qty: l.qty, note: l.note, add_ons: l.add_ons.map(Number) }; }),
    };
    var target = mode === 'collect'
      ? API + '/api/public/dinein/venue/' + encodeURIComponent(SLUG) + '/order'
      : API + '/api/public/dinein/table/' + encodeURIComponent(table.public_id) + '/order';

    placeBtn.disabled = true;
    placeBtn.textContent = 'Sending…';
    fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok || !res.body.public_id) {
          fail(res.body.error || 'The order did not go through. Please try again or order at the bar.');
          renderBasket();
          return;
        }
        var placed = {
          public_id: res.body.public_id,
          number: res.body.number,
          total_minor: res.body.total_minor,
          mode: mode,
          where: mode === 'collect' ? 'collection at the bar' : table.name,
          at: Date.now(),
        };
        keep(LAST, placed);
        basket = [];
        keep(STORE, basket);
        showDone(placed);
      })
      .catch(function () {
        fail('We could not reach the bar\'s till. Please check your connection and try again.');
        renderBasket();
      });
  });

  var STEPS = [['placed', 'Sent'], ['accepted', 'Accepted'], ['ready', 'Ready'], ['served', 'Served']];
  var pollTimer = null;

  function showDone(o) {
    layout.hidden = true;
    modesBox.hidden = true;
    bar.hidden = true;
    statusBox.innerHTML = '<div class="done"><div class="tick">' + ICON.check + '</div>' +
      '<p class="kicker">Order number</p><div class="num">' + esc(o.number) + '</div>' +
      '<p>' + (o.mode === 'collect'
        ? 'For collection at the bar. Give your name or this number and pay when you collect.'
        : 'Going to <b>' + esc(o.where) + '</b>. Pay at the bar as usual.') + ' Total ' + money(o.total_minor) + '.</p>' +
      '<div class="progress" data-progress>' + STEPS.map(function (s) { return '<span data-step="' + s[0] + '">' + s[1] + '</span>'; }).join('') + '</div>' +
      '<p class="small muted" data-state-note>This page updates by itself.</p>' +
      '<p class="cta-row" style="justify-content:center"><button type="button" class="btn btn-line" data-again>Order something else</button></p></div>';
    statusBox.querySelector('[data-again]').addEventListener('click', function () {
      clearTimeout(pollTimer);
      statusBox.innerHTML = '';
      layout.hidden = false;
      if (venue.collection_open && !(table && table.fixed)) modesBox.hidden = false;
      renderBasket();
    });
    statusBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    poll(o.public_id);
  }

  function poll(publicId) {
    getJSON(API + '/api/public/dinein/order/' + encodeURIComponent(publicId)).then(function (res) {
      if (!res.ok) return;
      var st = res.body.status;
      var idx = STEPS.map(function (s) { return s[0]; }).indexOf(st);
      statusBox.querySelectorAll('[data-step]').forEach(function (el, i) { el.classList.toggle('on', idx >= i); });
      var note = statusBox.querySelector('[data-state-note]');
      if (st === 'rejected' || st === 'cancelled') {
        if (note) note.innerHTML = '<b>The bar could not take this order' + (res.body.status_note ? ': ' + esc(res.body.status_note) : '') + '.</b> Please ask at the bar.';
        return;
      }
      if (st === 'ready' && note) note.innerHTML = '<b>' + (res.body.table_label && /^Collect/.test(res.body.table_label) ? 'Ready to collect at the bar.' : 'On its way to you.') + '</b>';
      if (st === 'served') { if (note) note.textContent = 'Enjoy! Thank you for ordering.'; return; }
      pollTimer = setTimeout(function () { poll(publicId); }, 10000);
    }).catch(function () { pollTimer = setTimeout(function () { poll(publicId); }, 20000); });
  }

  /* An order placed in the last three hours stays one tap away. */
  function showLastOrder() {
    var o = load(LAST);
    if (!o || !o.public_id || Date.now() - o.at > 3 * 3600 * 1000) return;
    var p = d.createElement('p');
    p.className = 'notice';
    p.innerHTML = ICON.info + '<span>Your order <b>' + esc(o.number) + '</b> is in. <button type="button" class="btn btn-sm btn-line">Track it</button></span>';
    p.querySelector('button').addEventListener('click', function () { p.remove(); showDone(o); });
    app.querySelector('.wrap').insertBefore(p, statusBox);
  }
})();
