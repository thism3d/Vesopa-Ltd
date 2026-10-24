/*
 * October 2026 additions: the cashback demo on the home page and the
 * /hardware shop (filter, quantities, setup total, product details).
 * Vanilla JS, no dependencies; every block is skipped when its markup is absent.
 */
(function () {
  'use strict';

  var gbp = function (pence) { return '£' + (pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

  // ---- cashback demo -------------------------------------------------------
  var cb = document.querySelector('[data-v2-cashback]');
  if (cb) {
    var SALE = 860;
    cb.addEventListener('click', function (e) {
      var btn = e.target.closest('.v2-chip');
      if (!btn) return;
      var amount = Number(btn.getAttribute('data-amount')) || 0;
      cb.querySelectorAll('.v2-chip').forEach(function (b) { b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
      cb.querySelectorAll('[data-v2-cash]').forEach(function (n) { n.textContent = gbp(amount); });
      var t = cb.querySelector('[data-v2-total]');
      if (t) t.textContent = gbp(SALE + amount);
    });
  }

  // ---- hardware shop -------------------------------------------------------
  // Quantities live in the shared basket (public/library/cart.js), so what is
  // added here shows in the header, on product pages and at the checkout.
  var shop = document.querySelector('[data-hw-shop]');
  if (!shop) return;
  var items = Array.prototype.slice.call(shop.querySelectorAll('[data-hw-item]'));
  var detail = document.querySelector('[data-hw-detail]');
  var data = {};
  try { data = JSON.parse(document.getElementById('hw-data').textContent); } catch (e) { data = {}; }
  var basket = function () { return window.VesopaCart ? window.VesopaCart.get() : {}; };
  var current = null;

  function render() {
    var qty = basket();
    var lines = document.querySelector('[data-hw-lines]');
    var empty = document.querySelector('[data-hw-empty]');
    var total = 0, lead = false;
    lines.innerHTML = '';
    items.forEach(function (el) {
      var sku = el.getAttribute('data-sku');
      el.querySelector('output').textContent = qty[sku] || 0;
    });
    Object.keys(qty).forEach(function (sku) {
      var p = data[sku], n = qty[sku];
      if (!p || !n) return;
      total += p.price * 100 * n;
      if (p.stock !== 'in') lead = true;
      var li = document.createElement('li');
      var a = document.createElement('span'); a.textContent = n + ' × ' + p.name;
      var b = document.createElement('span'); b.textContent = gbp(p.price * 100 * n);
      li.appendChild(a); li.appendChild(b); lines.appendChild(li);
    });
    empty.hidden = total > 0;
    document.querySelector('[data-hw-total]').textContent = gbp(total);
    document.querySelector('[data-hw-vat]').textContent = gbp(Math.round(total * 0.2));
    var del = document.querySelector('[data-hw-del]');
    if (del) del.textContent = !total ? 'Free from UK stock' : lead ? 'Chosen at checkout' : 'Free';
    var co = document.querySelector('[data-hw-checkout]');
    if (co) { co.classList.toggle('is-empty', !total); co.setAttribute('aria-disabled', total ? 'false' : 'true'); }
  }

  function show(sku) {
    var p = data[sku];
    if (!p || !detail) return;
    current = sku;
    detail.hidden = false;
    detail.querySelector('[data-d-name]').textContent = p.name;
    detail.querySelector('[data-d-sku]').textContent = p.sku + ' · runs ' + p.runs;
    detail.querySelector('[data-d-headline]').textContent = p.headline;
    detail.querySelector('[data-d-price]').textContent = '£' + p.price.toLocaleString('en-GB');
    detail.querySelector('[data-d-stock]').textContent = p.stock === 'in' ? 'In stock in the UK' : 'Ships from our supplier';
    var link = detail.querySelector('[data-d-link]'); if (link) link.href = '/hardware/' + p.slug;
    var img = detail.querySelector('[data-d-img]');
    if (p.img) { img.src = p.img; img.alt = p.name; img.hidden = false; } else { img.hidden = true; }
    var tb = detail.querySelector('tbody');
    tb.innerHTML = '';
    p.specs.forEach(function (row) {
      var tr = document.createElement('tr');
      var th = document.createElement('th'); th.scope = 'row'; th.textContent = row[0];
      var td = document.createElement('td'); td.textContent = row[1];
      tr.appendChild(th); tr.appendChild(td); tb.appendChild(tr);
    });
    var goes = detail.querySelector('[data-d-goes]');
    if (goes) {
      goes.innerHTML = '';
      var with_ = (p.goes || []).map(function (s) { return data[s]; }).filter(Boolean);
      if (with_.length) {
        var h = document.createElement('p'); h.className = 'vh-eyebrow'; h.style.margin = '0 0 10px'; h.textContent = 'Frequently bought together';
        var grid = document.createElement('div'); grid.className = 'fbt';
        with_.forEach(function (g) {
          var card = document.createElement('div'); card.className = 'fbt-card'; card.style.background = '#050604';
          var ph = document.createElement('a'); ph.className = 'ph'; ph.href = '/hardware/' + g.slug;
          var im = document.createElement('img'); im.src = g.img.replace(/\/assets\/v2\/([^/]+)\.jpg$/, '/assets/v2/sm/$1.webp'); im.alt = g.name; im.loading = 'lazy'; ph.appendChild(im);
          var tx = document.createElement('div'); tx.className = 'tx';
          var nm = document.createElement('a'); nm.className = 'nm'; nm.href = '/hardware/' + g.slug; nm.textContent = g.name;
          var pr = document.createElement('span'); pr.className = 'pr'; pr.textContent = '£' + g.price.toLocaleString('en-GB') + ' ex VAT';
          var bt = document.createElement('button'); bt.type = 'button'; bt.className = 'vc-btn sm'; bt.textContent = '+ Add';
          bt.setAttribute('data-add-to-cart', g.sku); bt.setAttribute('data-name', g.name);
          tx.appendChild(nm); tx.appendChild(pr); tx.appendChild(bt);
          card.appendChild(ph); card.appendChild(tx); grid.appendChild(card);
        });
        goes.appendChild(h); goes.appendChild(grid);
      }
    }
    var add = detail.querySelector('[data-d-add]');
    if (add) { add.setAttribute('data-add-to-cart', p.sku); add.setAttribute('data-name', p.name); }
    items.forEach(function (el) { el.classList.toggle('sel', el.getAttribute('data-sku') === sku); });
  }

  shop.addEventListener('click', function (e) {
    var f = e.target.closest('[data-hw-cat]');
    if (f) {
      var cat = f.getAttribute('data-hw-cat');
      shop.querySelectorAll('[data-hw-cat]').forEach(function (b) { b.setAttribute('aria-pressed', b === f ? 'true' : 'false'); });
      items.forEach(function (el) { el.hidden = !(cat === 'all' || el.getAttribute('data-cat') === cat); });
      return;
    }
    var q = e.target.closest('[data-hw-q]');
    if (q && window.VesopaCart) {
      var sku = q.closest('[data-hw-item]').getAttribute('data-sku');
      var n = (basket()[sku] || 0) + Number(q.getAttribute('data-hw-q'));
      window.VesopaCart.set(sku, n);
      show(sku);
      return;
    }
    var co = e.target.closest('[data-hw-checkout]');
    if (co && co.classList.contains('is-empty')) { e.preventDefault(); }
  });

  document.addEventListener('vesopa-cart', render);
  function boot() {
    render();
    var start = (location.hash || '').slice(1);
    show(data[start] ? start : items[0] && items[0].getAttribute('data-sku'));
    if (data[start]) setTimeout(function () { detail.scrollIntoView({ block: 'start' }); }, 50);
  }
  if (window.VesopaCart) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
