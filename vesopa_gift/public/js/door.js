/* Vesopa Gift — the door.
 *
 * A phone's camera, a code in a square, and an answer big enough to read from
 * across a doorway at night. The browser's own BarcodeDetector where there is
 * one (Chrome on Android); jsQR, bundled, everywhere else -- which is every
 * iPhone, because Safari has no detector.
 *
 * The same code is never sent twice in a row within a few seconds: a ticket
 * held in front of the camera is seen thirty times a second, and the second
 * reading would say "already in" about the person who has just been let in. */
(function () {
  'use strict';
  var root = document.querySelector('[data-door]');
  if (!root) return;

  var url = root.getAttribute('data-door');
  var csrf = root.getAttribute('data-csrf');
  var video = root.querySelector('[data-video]');
  var verdict = root.querySelector('[data-verdict]');
  var say = root.querySelector('[data-say]');
  var detail = root.querySelector('[data-detail]');
  var mark = root.querySelector('[data-mark]');
  var last = root.querySelector('[data-last]');
  var count = root.querySelector('[data-in]');
  var hint = root.querySelector('[data-hint]');
  var startBtn = root.querySelector('[data-camera]');
  var typeForm = root.querySelector('[data-type]');

  var busy = false;
  var lastCode = '';
  var lastAt = 0;
  var previous = null;

  var TICK = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0d1014" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var CROSS = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0d1014" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function show(r) {
    verdict.classList.remove('ok', 'no');
    verdict.classList.add(r.ok ? 'ok' : 'no');
    mark.innerHTML = r.ok ? TICK : CROSS;
    say.textContent = r.title;
    detail.textContent = r.detail || '';
    if (typeof r.in === 'number') count.textContent = r.in;
    if (previous) {
      last.hidden = false;
      last.textContent = 'Before: ' + previous;
    }
    previous = r.title + (r.detail ? ' — ' + r.detail : '');
    if (navigator.vibrate) navigator.vibrate(r.ok ? 80 : [60, 60, 60]);
  }

  function check(code) {
    code = String(code || '').trim().toUpperCase();
    if (!code || busy) return;
    var now = Date.now();
    if (code === lastCode && now - lastAt < 4000) return;
    lastCode = code;
    lastAt = now;
    busy = true;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' },
      body: JSON.stringify({ code: code }),
      credentials: 'same-origin',
    })
      .then(function (r) { return r.json(); })
      .then(show)
      .catch(function () { show({ ok: false, title: 'No connection', detail: 'Check the phone’s signal and try again.' }); })
      .then(function () { busy = false; });
  }

  // A code read off a ticket is the ticket code itself; anything longer is
  // somebody pointing the camera at the wrong thing.
  function fromScan(text) {
    var m = /([A-Z2-9]{4}-?[A-Z2-9]{4})/.exec(String(text || '').toUpperCase());
    if (!m) return;
    var c = m[1].replace('-', '');
    check(c.slice(0, 4) + '-' + c.slice(4));
  }

  typeForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = typeForm.querySelector('input');
    var v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v.length === 8) check(v.slice(0, 4) + '-' + v.slice(4));
    input.value = '';
  });

  var detector = null;
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });

  function scanFrame() {
    if (video.readyState < 2) return requestAnimationFrame(scanFrame);
    if (detector) {
      detector.detect(video).then(function (codes) {
        if (codes && codes.length) fromScan(codes[0].rawValue);
        setTimeout(function () { requestAnimationFrame(scanFrame); }, 120);
      }, function () { requestAnimationFrame(scanFrame); });
      return;
    }
    var w = video.videoWidth;
    var h = video.videoHeight;
    if (w && h && window.jsQR) {
      var s = Math.min(1, 640 / Math.max(w, h));
      canvas.width = Math.round(w * s);
      canvas.height = Math.round(h * s);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var found = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (found && found.data) fromScan(found.data);
    }
    setTimeout(function () { requestAnimationFrame(scanFrame); }, 150);
  }

  function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      hint.textContent = 'This browser cannot use the camera. Type the codes instead.';
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (stream) {
        video.srcObject = stream;
        return video.play();
      })
      .then(function () {
        startBtn.hidden = true;
        if ('BarcodeDetector' in window) {
          try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }
        }
        requestAnimationFrame(scanFrame);
      })
      .catch(function () {
        hint.textContent = 'The camera was not allowed. Type the codes instead, or allow it in the browser’s settings.';
      });
  }

  startBtn.addEventListener('click', start);
})();
