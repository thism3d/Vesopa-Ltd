/*
 * The hardware basket, on every page (2026-10-24). No floating button (owner):
 * the header badge is the way to the basket.
 *
 * Kept in localStorage as { SKU: qty } so it follows the visitor from the home
 * page to /hardware, a product page and the checkout. The header badge, the
 * floating basket button and every [data-add-to-cart] button read and write it
 * here. Prices are never stored: the checkout prices the basket on the server
 * from the catalogue, so editing storage can only change what is in it.
 *
 *   <button data-add-to-cart="POS-1566" data-qty="1">Add to basket</button>
 *   window.VesopaCart.add('POS-1566', 1) / .set(sku, n) / .get() / .count() / .checkoutUrl()
 *   document.addEventListener('vesopa-cart', fn)  // fired after every change
 */
(function () {
  'use strict';
  var KEY = 'vesopa-cart';

  function read() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { c = {}; }
    // The first shop kept its quantities in sessionStorage under v2-hw: carried over once.
    try {
      var old = JSON.parse(sessionStorage.getItem('v2-hw') || 'null');
      if (old) { for (var k in old) if (old[k] > 0 && !c[k]) c[k] = old[k]; sessionStorage.removeItem('v2-hw'); }
    } catch (e) { /* private window */ }
    var out = {};
    for (var s in c) { var n = parseInt(c[s], 10); if (/^[A-Z0-9-]{2,24}$/.test(s) && n > 0) out[s] = Math.min(50, n); }
    return out;
  }
  var cart = read();

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch (e) { /* private window: this page only */ }
    paint();
    try { document.dispatchEvent(new CustomEvent('vesopa-cart', { detail: get() })); } catch (e) { /* old browser */ }
  }
  function get() { var o = {}; for (var k in cart) o[k] = cart[k]; return o; }
  function count() { var n = 0; for (var k in cart) n += cart[k]; return n; }
  function set(sku, n) { n = Math.max(0, Math.min(50, parseInt(n, 10) || 0)); if (n) cart[sku] = n; else delete cart[sku]; save(); }
  function add(sku, n) { set(sku, (cart[sku] || 0) + (parseInt(n, 10) || 1)); }
  function clear() { cart = {}; save(); }
  function cartParam() { var p = []; for (var k in cart) p.push(k + ':' + cart[k]); return p.join(','); }
  function checkoutUrl() { var c = cartParam(); return '/hardware/checkout' + (c ? '?c=' + encodeURIComponent(c) : ''); }


  function paint() {
    var n = count();
    document.querySelectorAll('[data-cart-count]').forEach(function (el) { el.textContent = n; el.hidden = n === 0; });
    document.querySelectorAll('[data-cart-link]').forEach(function (el) {
      el.href = checkoutUrl();
      el.setAttribute('aria-label', n ? 'Basket, ' + n + (n === 1 ? ' item' : ' items') : 'Basket, empty');
    });
    document.querySelectorAll('[data-in-cart]').forEach(function (el) {
      var q = cart[el.getAttribute('data-in-cart')] || 0;
      el.textContent = q ? q + ' in basket' : '';
      el.hidden = !q;
    });
    // Add / − n + / Checkout, in place of the Add button once something is in.
    document.querySelectorAll('[data-cart-control]').forEach(function (box) {
      var q = cart[box.getAttribute('data-cart-control')] || 0;
      box.classList.toggle('in', q > 0);
      var out = box.querySelector('[data-cart-qty]');
      if (out) out.textContent = q;
      var less = box.querySelector('[data-cart-step="-1"]');
      if (less) {
        less.innerHTML = q === 1 ? '<i class="fa fa-trash-o" aria-hidden="true"></i>' : '−';
        less.setAttribute('aria-label', q === 1 ? 'Remove from basket' : 'One fewer');
      }
    });
  }

  var toastTimer = null;
  function toast(name) {
    var t = document.querySelector('.vc-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'vc-toast';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    t.innerHTML = '';
    var msg = document.createElement('span');
    msg.textContent = (name ? name + ' added to your basket' : 'Added to your basket');
    var go = document.createElement('a');
    go.href = checkoutUrl();
    go.textContent = 'Checkout';
    t.appendChild(msg); t.appendChild(go);
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 3600);
  }

  document.addEventListener('click', function (e) {
    var st = e.target.closest('[data-cart-step]');
    if (st) {
      e.preventDefault();
      var box = st.closest('[data-cart-control]');
      var sku0 = box.getAttribute('data-cart-control');
      set(sku0, (cart[sku0] || 0) + Number(st.getAttribute('data-cart-step')));
      return;
    }
    var b = e.target.closest('[data-add-to-cart]');
    if (!b) return;
    e.preventDefault();
    var sku = b.getAttribute('data-add-to-cart');
    add(sku, b.getAttribute('data-qty') || 1);
    if (b.hasAttribute('data-go-checkout')) { location.href = checkoutUrl(); return; }
    b.classList.add('vc-added');
    setTimeout(function () { b.classList.remove('vc-added'); }, 900);
    toast(b.getAttribute('data-name'));
  });

  // Another tab changed the basket.
  window.addEventListener('storage', function (e) { if (e.key === KEY) { cart = read(); paint(); try { document.dispatchEvent(new CustomEvent('vesopa-cart', { detail: get() })); } catch (x) { /* old browser */ } } });

  window.VesopaCart = { get: get, set: set, add: add, clear: clear, count: count, checkoutUrl: checkoutUrl, cartParam: cartParam, replace: function (o) { cart = {}; for (var k in o) if (o[k] > 0) cart[k] = Math.min(50, o[k]); save(); } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint); else paint();
})();
