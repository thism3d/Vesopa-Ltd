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
})();
