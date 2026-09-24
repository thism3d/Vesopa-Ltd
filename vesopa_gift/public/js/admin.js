/* Vesopa Gift console — the little it does in the browser. */
(function () {
  'use strict';

  // A form that does something that cannot be taken back asks first. The
  // question is written on the form itself (data-confirm), so the server's
  // template says what is about to happen, not this file.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var q = form.getAttribute && form.getAttribute('data-confirm');
    if (q && !window.confirm(q)) e.preventDefault();
  }, true);

  // Copy the shop's address.
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (b) {
    b.addEventListener('click', function () {
      var text = b.getAttribute('data-copy');
      var done = function () { var was = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = was; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
    });
  });

  // The guest list, narrowed as a name, code or email is typed.
  var search = document.querySelector('[data-guest-search]');
  if (search) {
    var rows = Array.prototype.slice.call(document.querySelectorAll('[data-guest]'));
    var none = document.querySelector('[data-guest-none]');
    search.addEventListener('input', function () {
      var q = search.value.trim().toLowerCase().replace(/-/g, '');
      var shown = 0;
      rows.forEach(function (r) {
        var hit = !q || r.getAttribute('data-guest').replace(/-/g, '').indexOf(q) >= 0;
        r.hidden = !hit;
        if (hit) shown++;
      });
      if (none) none.hidden = shown > 0;
    });
  }
})();
