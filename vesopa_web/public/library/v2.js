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
  var shop = document.querySelector('[data-hw-shop]');
  if (!shop) return;
  var items = Array.prototype.slice.call(shop.querySelectorAll('[data-hw-item]'));
  var qty = {};
  try { qty = JSON.parse(sessionStorage.getItem('v2-hw') || '{}') || {}; } catch (e) { qty = {}; }

  var detail = document.querySelector('[data-hw-detail]');
  var data = {};
  try { data = JSON.parse(document.getElementById('hw-data').textContent); } catch (e) { data = {}; }

  function render() {
    var lines = document.querySelector('[data-hw-lines]');
    var empty = document.querySelector('[data-hw-empty]');
    var total = 0;
    lines.innerHTML = '';
    items.forEach(function (el) {
      var sku = el.getAttribute('data-sku');
      var n = qty[sku] || 0;
      el.querySelector('output').textContent = n;
      if (n > 0) {
        var p = data[sku];
        total += p.price * 100 * n;
        var li = document.createElement('li');
        var a = document.createElement('span'); a.textContent = n + ' × ' + p.name;
        var b = document.createElement('span'); b.textContent = gbp(p.price * 100 * n);
        li.appendChild(a); li.appendChild(b); lines.appendChild(li);
      }
    });
    empty.hidden = total > 0;
    document.querySelector('[data-hw-total]').textContent = gbp(total);
    document.querySelector('[data-hw-vat]').textContent = gbp(Math.round(total * 0.2));
    try { sessionStorage.setItem('v2-hw', JSON.stringify(qty)); } catch (e) { /* private window */ }
  }

  function show(sku) {
    var p = data[sku];
    if (!p || !detail) return;
    detail.hidden = false;
    detail.querySelector('[data-d-name]').textContent = p.name;
    detail.querySelector('[data-d-sku]').textContent = p.sku + ' · runs ' + p.runs;
    detail.querySelector('[data-d-headline]').textContent = p.headline;
    detail.querySelector('[data-d-price]').textContent = '£' + p.price.toLocaleString('en-GB');
    detail.querySelector('[data-d-stock]').textContent = p.stock === 'in' ? 'In stock' : 'Ships in 7-10 days';
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
    if (q) {
      var sku = q.closest('[data-hw-item]').getAttribute('data-sku');
      qty[sku] = Math.max(0, (qty[sku] || 0) + Number(q.getAttribute('data-hw-q')));
      render();
      show(sku);
      return;
    }
    var open = e.target.closest('[data-hw-open]');
    if (open) {
      show(open.closest('[data-hw-item]').getAttribute('data-sku'));
      detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  render();
  var start = (location.hash || '').slice(1);
  show(data[start] ? start : items[0] && items[0].getAttribute('data-sku'));
  if (data[start]) setTimeout(function () { detail.scrollIntoView({ block: 'start' }); }, 50);
})();
