/* Vesopa Gift — the little the shop does in the browser.
 *
 * Everything works without this file: the choices are real radio buttons and
 * the server decides every price. This only makes the form tidier while it is
 * being filled in -- the total follows the amount, fields that do not apply
 * step out of the way, a message counts its characters. */
(function () {
  'use strict';

  function money(minor) {
    var pence = Math.round(minor) % 100;
    return '£' + Math.floor(minor / 100).toLocaleString('en-GB') + '.' + (pence < 10 ? '0' : '') + pence;
  }

  // ---- Buying a voucher -----------------------------------------------------
  var form = document.querySelector('[data-buy]');
  if (form) {
    var custom = form.querySelector('[data-custom]');
    var chips = form.querySelectorAll('input[name="amount"]');
    var sumValue = form.querySelector('[data-sum-value]');
    var sumTotal = form.querySelector('[data-sum-total]');
    var payLabel = form.querySelector('[data-pay-label]');
    var fixed = !chips.length;

    function amount() {
      if (custom && custom.value.trim()) {
        var v = custom.value.trim().replace(/^£/, '').replace(/,/g, '');
        if (/^[0-9]{1,6}(\.[0-9]{1,2})?$/.test(v)) return Math.round(parseFloat(v) * 100);
        return null;
      }
      for (var i = 0; i < chips.length; i++) if (chips[i].checked) return Number(chips[i].value);
      return null;
    }

    function update() {
      if (fixed) return;
      var a = amount();
      var text = a ? money(a) : '';
      if (sumValue) sumValue.textContent = text;
      if (sumTotal) sumTotal.textContent = text;
      if (payLabel) payLabel.textContent = a ? 'Pay ' + money(a) : 'Pay';
    }

    if (custom) {
      custom.addEventListener('input', function () {
        if (custom.value.trim()) for (var i = 0; i < chips.length; i++) chips[i].checked = false;
        update();
      });
    }
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('change', function () { if (custom) custom.value = ''; update(); });
    }
    update();

    // Straight to them, or to me.
    var recipient = form.querySelector('[data-recipient]');
    var whenGroup = form.querySelector('[data-when-group]');
    function sendTo() {
      var toBuyer = form.querySelector('input[name="send_to"][value="buyer"]');
      var mine = toBuyer && toBuyer.checked;
      if (recipient) recipient.hidden = mine;
      if (whenGroup) whenGroup.hidden = mine;
    }
    Array.prototype.forEach.call(form.querySelectorAll('[data-send]'), function (r) { r.addEventListener('change', sendTo); });
    sendTo();

    // Which picture, named in the summary.
    var sumDesign = form.querySelector('[data-sum-design]');
    function designChanged() {
      var d = form.querySelector('input[name="design"]:checked');
      var name = d && d.parentNode.querySelector('span:last-child');
      if (sumDesign) sumDesign.textContent = name ? ' · ' + name.textContent.trim() : '';
    }
    Array.prototype.forEach.call(form.querySelectorAll('input[name="design"]'), function (r) { r.addEventListener('change', designChanged); });
    designChanged();

    // Now, or on a day -- and the day, in the summary.
    var later = form.querySelector('[data-later]');
    var arrives = form.querySelector('[data-sum-arrives]');
    var day = form.querySelector('input[name="deliver_date"]');
    var time = form.querySelector('input[name="deliver_time"]');
    function whenChanged() {
      var l = form.querySelector('input[name="when"][value="later"]');
      var on = !!(l && l.checked);
      if (later) later.hidden = !on;
      if (!arrives) return;
      var toBuyer = form.querySelector('input[name="send_to"][value="buyer"]');
      var show = on && !(toBuyer && toBuyer.checked) && day && /^\d{4}-\d{2}-\d{2}$/.test(day.value);
      arrives.hidden = !show;
      if (!show) return;
      // The date as typed, shown as typed: read and printed in UTC so the
      // browser's own zone cannot move it a day.
      var p = day.value.split('-');
      var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
      var hm = (time && /^\d{2}:\d{2}$/.test(time.value) ? time.value : '09:00').split(':');
      var h = +hm[0];
      arrives.lastChild.textContent = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) +
        ', ' + ((h % 12) || 12) + ':' + hm[1] + (h < 12 ? 'am' : 'pm');
    }
    Array.prototype.forEach.call(form.querySelectorAll('[data-when], [data-send]'), function (r) { r.addEventListener('change', whenChanged); });
    if (day) day.addEventListener('input', whenChanged);
    if (time) time.addEventListener('input', whenChanged);
    whenChanged();

    // The message's length.
    var msg = form.querySelector('[data-message]');
    var count = form.querySelector('[data-count]');
    function counted() { if (msg && count) count.textContent = msg.value.length + ' / 300'; }
    if (msg) msg.addEventListener('input', counted);
    counted();

    form.addEventListener('submit', function () {
      var b = form.querySelector('button[type="submit"]');
      if (b) { b.disabled = true; b.setAttribute('aria-busy', 'true'); }
    });
  }

  // ---- Tickets ---------------------------------------------------------------
  var tform = document.querySelector('[data-tickets]');
  if (tform) {
    var total = tform.querySelector('[data-ticket-total]');
    var pay = tform.querySelector('[data-ticket-pay]');
    function sum() {
      var t = 0;
      Array.prototype.forEach.call(tform.querySelectorAll('.stepper'), function (s) {
        var input = s.querySelector('input');
        t += (Number(input.value) || 0) * Number(s.getAttribute('data-price'));
      });
      if (total) total.textContent = money(t);
      if (pay) pay.textContent = t ? 'Pay ' + money(t) : 'Pay';
    }
    Array.prototype.forEach.call(tform.querySelectorAll('.stepper'), function (s) {
      var input = s.querySelector('input');
      Array.prototype.forEach.call(s.querySelectorAll('[data-step]'), function (b) {
        b.addEventListener('click', function () {
          var max = Number(input.getAttribute('max')) || 0;
          var next = (Number(input.value) || 0) + Number(b.getAttribute('data-step'));
          input.value = Math.max(0, Math.min(max, next));
          sum();
        });
      });
      input.addEventListener('input', sum);
    });
    sum();
    tform.addEventListener('submit', function () {
      var b = tform.querySelector('button[type="submit"]');
      if (b) b.disabled = true;
    });
  }

  // ---- Waiting for a payment -------------------------------------------------
  var pending = document.querySelector('[data-pending]');
  if (pending) {
    var url = pending.getAttribute('data-pending');
    var tries = 0;
    (function poll() {
      tries++;
      fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (s) {
          if (s.status === 'paid' || s.status === 'cancelled' || s.status === 'refunded') {
            window.location.reload();
          } else if (tries < 40) {
            setTimeout(poll, tries < 10 ? 3000 : 6000);
          }
        })
        .catch(function () { if (tries < 40) setTimeout(poll, 6000); });
    })();
  }
})();
