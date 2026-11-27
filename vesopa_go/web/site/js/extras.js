/* go.vesopa.com home page extras (no other script needed):
 * - "On your TV": the tabs show each TV screen, and it moves on by itself
 *   every few seconds until a tab is chosen (never with reduced motion).
 * - "Get it": the card for the visitor's own device is outlined, with a line
 *   saying which one it is. */
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tv-tabs [role="tab"]'));
  var shots = Array.prototype.slice.call(document.querySelectorAll('.tv-screen img'));
  if (tabs.length && shots.length === tabs.length) {
    var current = 0, timer = null;
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var show = function (i) {
      current = (i + tabs.length) % tabs.length;
      tabs.forEach(function (t, j) {
        t.setAttribute('aria-selected', j === current ? 'true' : 'false');
        t.tabIndex = j === current ? 0 : -1;
      });
      shots.forEach(function (s, j) { s.classList.toggle('on', j === current); });
    };
    var stop = function () { if (timer) { clearInterval(timer); timer = null; } };
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { stop(); show(i); });
      t.addEventListener('keydown', function (e) {
        var k = e.key;
        if (k === 'ArrowRight' || k === 'ArrowLeft') {
          e.preventDefault(); stop();
          show(current + (k === 'ArrowRight' ? 1 : -1));
          tabs[current].focus();
        }
      });
    });
    show(0);
    var stage = document.querySelector('.tv-stage');
    if (!still && stage && 'IntersectionObserver' in window) {
      var started = false;
      new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting && !started) {
            started = true;
            timer = setInterval(function () { show(current + 1); }, 4200);
          }
        });
      }, { threshold: 0.35 }).observe(stage);
    }
  }

  var ua = navigator.userAgent || '';
  var iPad = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var kind = /Android TV|AFT|BRAVIA|GoogleTV|SMART-TV|SmartTV/i.test(ua) ? 'tv'
    : /iPhone|iPod/.test(ua) || iPad ? 'ios'
    : /Android/.test(ua) ? 'android' : '';
  if (!kind) return;
  var cards = document.querySelectorAll('.get .qr');
  var pick = { ios: 0, android: 1, tv: 2 }[kind];
  if (cards[pick]) cards[pick].classList.add('mine');
  var note = document.querySelector('.your-device');
  if (note) {
    note.textContent = { ios: 'This looks like an iPhone or iPad: tap the first one.', android: 'This looks like an Android device: tap Android.', tv: 'This looks like a TV: choose Android TV.' }[kind];
    note.hidden = false;
  }
})();
