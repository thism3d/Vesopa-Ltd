/* pontardawerfc.com/tickets: match tickets, from the club's own menu.
   Tickets are products on the bar's till like anything else; when the club
   puts them in a "Tickets" section of its online menu they are listed here and
   bought through the same order (collect at the gate). Until then the page
   says to pay on the gate. */
(function () {
  'use strict';
  var box = document.querySelector('[data-tickets]');
  if (!box || !window.fetch) return;
  var api = box.getAttribute('data-api');
  var slug = box.getAttribute('data-slug');
  var list = box.querySelector('[data-ticket-items]');
  var text = box.querySelector('[data-ticket-text]');
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(minor) { return '£' + (Number(minor || 0) / 100).toFixed(2); }
  fetch(api + '/api/public/dinein/venue/' + encodeURIComponent(slug))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      var sections = (data && data.sections) || [];
      var sec = sections.filter(function (s) { return /ticket/i.test(s.name || ''); })[0];
      if (!sec || !sec.items || !sec.items.length) return;
      text.textContent = 'Buy online, then collect at the gate and pay if you have not already. Or pay on the gate on the day.';
      list.innerHTML = '<ul class="ticket-list">' + sec.items.map(function (it) {
        var price = money(it.price_minor);
        return '<li><span>' + esc(it.name) + '</span><b>' + esc(price) + '</b></li>';
      }).join('') + '</ul><a class="btn btn-glow btn-block" href="/menu#sec-' + encodeURIComponent(sec.id) + '">Buy tickets</a>';
    })
    .catch(function () {});
})();
