/* Vesopa Gift — the door.
 *
 * A phone's camera, a code in a square, and an answer big enough to read from
 * across a doorway at night. The browser's own BarcodeDetector where it really
 * reads QR codes (Chrome on Android); jsQR, bundled, everywhere else -- which
 * is every iPhone and iPad, because WebKit has no detector, and desktop
 * Chrome, whose detector exists but often cannot decode.
 *
 * Three ways in, all answered by the same check():
 *   - the camera, started by a tap (browsers only ask for the camera on a tap)
 *   - a USB or Bluetooth scanner, which types the code like a keyboard and
 *     presses Enter or Tab -- caught whether or not the box has focus
 *   - a code typed by hand
 *
 * A ticket in front of the camera is seen many times a second: it is checked
 * once, and not again until it has left the frame. A beep says yes, a buzz
 * says no, so the person on the door need not look down. */
(function () {
  'use strict';
  var root = document.querySelector('[data-door]');
  if (!root) return;

  var url = root.getAttribute('data-door');
  var csrf = root.getAttribute('data-csrf');
  var cam = root.querySelector('[data-cam]');
  var video = root.querySelector('[data-video]');
  var verdict = root.querySelector('[data-verdict]');
  var say = root.querySelector('[data-say]');
  var detail = root.querySelector('[data-detail]');
  var mark = root.querySelector('[data-mark]');
  var last = root.querySelector('[data-last]');
  var count = root.querySelector('[data-in]');
  var total = root.querySelector('[data-total]');
  var hint = root.querySelector('[data-hint]');
  var startBtn = root.querySelector('[data-camera]');
  var stopBtn = root.querySelector('[data-stop]');
  var switchBtn = root.querySelector('[data-switch]');
  var torchBtn = root.querySelector('[data-torch]');
  var undoBtn = root.querySelector('[data-undo]');
  var soundBtn = root.querySelector('[data-sound]');
  var typeForm = root.querySelector('[data-type]');
  var input = typeForm.querySelector('input');

  var busy = false;
  var lastCode = '';
  var lastAt = 0;
  var previous = null;
  var lastIn = null;

  var ICON = { ok: '<svg class="ico"><use href="#i-tick"/></svg>', no: '<svg class="ico"><use href="#i-cross"/></svg>' };

  // ---- Sound ---------------------------------------------------------------------
  //
  // Made here, not loaded: two notes for yes, one low buzz for no. The audio
  // context is unlocked by the first tap or key, as browsers require.
  var audio = null;
  var soundOn = true;
  try { soundOn = localStorage.getItem('vg_door_sound') !== 'off'; } catch (e) { /* private mode */ }
  function unlockAudio() {
    if (audio || !window.AudioContext && !window.webkitAudioContext) return;
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
  }
  function tone(freq, at, len, type, gain) {
    var o = audio.createOscillator();
    var g = audio.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain || 0.25, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    o.connect(g).connect(audio.destination);
    o.start(at);
    o.stop(at + len + 0.02);
  }
  function beep(ok) {
    if (!soundOn || !audio) return;
    if (audio.state === 'suspended') audio.resume();
    var t = audio.currentTime;
    if (ok) { tone(880, t, 0.09); tone(1320, t + 0.1, 0.16); }
    else { tone(160, t, 0.32, 'square', 0.12); }
  }
  function paintSound() {
    soundBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
    soundBtn.innerHTML = '<svg class="ico"><use href="#i-' + (soundOn ? 'sound' : 'mute') + '"/></svg><span>' + (soundOn ? 'Sound on' : 'Sound off') + '</span>';
  }
  soundBtn.addEventListener('click', function () {
    soundOn = !soundOn;
    try { localStorage.setItem('vg_door_sound', soundOn ? 'on' : 'off'); } catch (e) { /* fine */ }
    paintSound();
    unlockAudio();
    if (soundOn) beep(true);
  });
  paintSound();
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  // ---- Showing an answer ---------------------------------------------------------

  function replay(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function show(r) {
    verdict.classList.remove('ok', 'no');
    verdict.classList.add(r.ok ? 'ok' : 'no');
    mark.innerHTML = r.ok ? ICON.ok : ICON.no;
    say.textContent = r.title;
    detail.textContent = r.detail || '';
    replay(verdict, 'pop');
    cam.classList.remove('hit-ok', 'hit-no');
    replay(cam, r.ok ? 'hit-ok' : 'hit-no');
    setTimeout(function () { cam.classList.remove('hit-ok', 'hit-no'); }, 900);
    if (typeof r.in === 'number') setCount(r.in);
    if (previous) {
      last.hidden = false;
      last.textContent = 'Before: ' + previous;
      replay(last, 'door-last');
    }
    previous = r.title + (r.detail ? ' — ' + r.detail : '');
    if (r.ok && r.code) { lastIn = r.code; undoBtn.hidden = false; }
    if (r.undone) { lastIn = null; undoBtn.hidden = true; }
    beep(r.ok);
    if (navigator.vibrate) navigator.vibrate(r.ok ? 80 : [60, 60, 60]);
  }

  function setCount(n) {
    if (String(n) === count.textContent) return;
    count.textContent = n;
    replay(count, 'bump');
  }

  function post(path, body) {
    return fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    }).then(function (r) { return r.json(); });
  }

  function check(code) {
    code = String(code || '').trim().toUpperCase();
    if (!code || busy) return;
    var now = Date.now();
    if (code === lastCode && now - lastAt < 4000) return;
    lastCode = code;
    lastAt = now;
    busy = true;
    post('/scan', { code: code })
      .then(show)
      .catch(function () { show({ ok: false, title: 'No connection', detail: 'Check the signal and try again.' }); })
      .then(function () { busy = false; });
  }

  undoBtn.addEventListener('click', function () {
    if (!lastIn || busy) return;
    busy = true;
    post('/undo', { code: lastIn })
      .then(show)
      .catch(function () { show({ ok: false, title: 'No connection', detail: 'Check the signal and try again.' }); })
      .then(function () { busy = false; });
  });

  // ---- Reading a code out of anything ----------------------------------------------

  // A ticket code is eight letters and digits, shown as XXXX-XXXX. A QR code
  // carries exactly that; a scanner types it with or without the dash.
  function codeIn(text) {
    var m = /([A-Z2-9]{4})-?([A-Z2-9]{4})/.exec(String(text || '').toUpperCase());
    return m ? m[1] + '-' + m[2] : null;
  }
  function fromScan(text) {
    var c = codeIn(text);
    if (c) check(c);
  }

  // The camera sees the same ticket many times a second. It is checked once,
  // and not again until it has been out of the frame for a moment.
  var seenCode = '';
  var seenAt = 0;
  function fromCamera(text) {
    var c = codeIn(text);
    if (!c) return;
    var now = Date.now();
    var same = c === seenCode && now - seenAt < 1500;
    seenCode = c;
    seenAt = now;
    if (!same) check(c);
  }

  // ---- Typed, or typed by a scanner into the box -----------------------------------

  function submitTyped() {
    var c = codeIn(input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z0-9]{4})/, '$1-'));
    input.value = '';
    if (c) check(c);
  }
  typeForm.addEventListener('submit', function (e) { e.preventDefault(); submitTyped(); });
  // Scanners end with Enter (the form) or Tab; some send nothing, so eight
  // characters in the box is enough on its own.
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Tab') { e.preventDefault(); submitTyped(); }
  });
  input.addEventListener('input', function () {
    if (input.value.replace(/[^A-Za-z0-9]/g, '').length >= 8) submitTyped();
  });

  // ---- A scanner typing while nothing has focus --------------------------------------
  //
  // A keyboard-wedge scanner types a whole code in well under a second. Keys
  // that arrive that fast, outside any field, are collected and checked as one.
  var burst = '';
  var burstAt = 0;
  document.addEventListener('keydown', function (e) {
    if (e.target === input || e.ctrlKey || e.metaKey || e.altKey) return;
    var now = Date.now();
    if (now - burstAt > 400) burst = '';
    burstAt = now;
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (burst.length >= 8) { e.preventDefault(); fromScan(burst); }
      burst = '';
      return;
    }
    if (e.key.length === 1 && /[A-Za-z0-9-]/.test(e.key)) {
      burst += e.key;
      if (burst.replace(/-/g, '').length >= 8) { fromScan(burst); burst = ''; }
    }
  });

  // ---- The camera -------------------------------------------------------------------

  var detector = null;
  var stream = null;
  var scanning = false;
  var devices = [];
  var deviceIndex = -1;
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });

  function scanFrame() {
    if (!scanning) return;
    if (video.readyState < 2) return requestAnimationFrame(scanFrame);
    if (detector) {
      detector.detect(video).then(function (codes) {
        if (codes && codes.length) fromCamera(codes[0].rawValue);
        setTimeout(function () { requestAnimationFrame(scanFrame); }, 120);
      }, function () {
        // A detector that exists but cannot read (desktop Chrome, some
        // Androids): hand over to jsQR for good.
        detector = null;
        requestAnimationFrame(scanFrame);
      });
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
      if (found && found.data) fromCamera(found.data);
    }
    setTimeout(function () { requestAnimationFrame(scanFrame); }, 150);
  }

  function stopStream() {
    scanning = false;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    video.srcObject = null;
    cam.classList.remove('live');
    startBtn.hidden = false;
    stopBtn.hidden = true;
    switchBtn.hidden = true;
    torchBtn.hidden = true;
    torchBtn.setAttribute('aria-pressed', 'false');
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function explain(err) {
    var name = err && err.name ? err.name : 'Error';
    var how;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      how = isIOS()
        ? 'The camera is blocked. On an iPhone or iPad: Settings → ' + (/CriOS/.test(navigator.userAgent) ? 'Chrome' : /FxiOS/.test(navigator.userAgent) ? 'Firefox' : 'Safari') + ' → Camera, switch it on, then come back and tap Start the camera. If the browser asked and you said no: tap the ᴬᴬ or lock symbol in the address bar → Website Settings → Camera → Allow.'
        : 'The camera is blocked for this site. Tap the lock (or tune) symbol in the address bar → Site settings or Permissions → Camera → Allow, then tap Start the camera again.';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      how = 'No camera was found on this device. Type the codes, or plug in a scanner.';
    } else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      how = 'The camera is being used by another app or tab. Close it and tap Start the camera again.';
    } else {
      how = 'The camera could not start (' + name + '). Type the codes, or plug in a scanner.';
    }
    hint.textContent = how;
    stopStream();
  }

  function getMedia(constraints) {
    return navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  }

  /** The back camera if there is one; failing that, any camera at all. */
  function openCamera(preferredDeviceId) {
    var attempts = [];
    if (preferredDeviceId) attempts.push({ deviceId: { exact: preferredDeviceId } });
    attempts.push({ facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } });
    attempts.push({ facingMode: 'environment' });
    attempts.push(true);
    var lastErr = null;
    return attempts.reduce(function (p, c) {
      return p.then(function (s) { return s; }, function (e) {
        // A refusal is a refusal: asking again with looser constraints only
        // pops another prompt, or none at all.
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
        lastErr = e;
        return getMedia(c);
      });
    }, Promise.reject(lastErr)).catch(function (e) { throw e || lastErr || new Error('camera'); });
  }

  function listCameras() {
    if (!navigator.mediaDevices.enumerateDevices) return Promise.resolve([]);
    return navigator.mediaDevices.enumerateDevices().then(function (all) {
      return all.filter(function (d) { return d.kind === 'videoinput'; });
    }, function () { return []; });
  }

  function torchTrack() {
    var t = stream && stream.getVideoTracks()[0];
    if (!t || !t.getCapabilities) return null;
    var caps = t.getCapabilities();
    return caps && caps.torch ? t : null;
  }

  function start(deviceId) {
    if (!window.isSecureContext) {
      hint.textContent = 'The camera only works over https. Type the codes instead.';
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      hint.textContent = 'This browser cannot use the camera. Type the codes, or plug in a scanner.';
      return;
    }
    unlockAudio();
    hint.textContent = 'Starting the camera…';
    startBtn.disabled = true;
    stopStream();
    openCamera(deviceId)
      .then(function (s) {
        stream = s;
        video.setAttribute('playsinline', '');
        video.muted = true;
        video.srcObject = s;
        var p = video.play();
        return p && p.then ? p.catch(function () {}) : null;
      })
      .then(function () {
        cam.classList.add('live');
        startBtn.hidden = true;
        stopBtn.hidden = false;
        hint.textContent = 'Hold the ticket’s code in the square';
        // Chrome on Android reads QR codes natively; anything else says it can
        // and then cannot, so only trust a detector that lists the format.
        detector = null;
        var ready = Promise.resolve(false);
        if ('BarcodeDetector' in window && window.BarcodeDetector.getSupportedFormats) {
          ready = window.BarcodeDetector.getSupportedFormats().then(function (f) { return f.indexOf('qr_code') >= 0; }, function () { return false; });
        }
        return ready.then(function (ok) {
          if (ok) { try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; } }
          scanning = true;
          requestAnimationFrame(scanFrame);
          torchBtn.hidden = !torchTrack();
          keepAwake();
          return listCameras();
        });
      })
      .then(function (list) {
        devices = list;
        var current = stream && stream.getVideoTracks()[0];
        var id = current && current.getSettings && current.getSettings().deviceId;
        deviceIndex = Math.max(0, devices.findIndex(function (d) { return d.deviceId === id; }));
        switchBtn.hidden = devices.length < 2;
      })
      .catch(explain)
      .then(function () { startBtn.disabled = false; });
  }

  startBtn.addEventListener('click', function () { start(null); });
  stopBtn.addEventListener('click', function () {
    stopStream();
    hint.textContent = 'Tap Start the camera, plug in a scanner, or type the code';
  });
  switchBtn.addEventListener('click', function () {
    if (devices.length < 2) return;
    deviceIndex = (deviceIndex + 1) % devices.length;
    start(devices[deviceIndex].deviceId);
  });
  torchBtn.addEventListener('click', function () {
    var t = torchTrack();
    if (!t) return;
    var on = torchBtn.getAttribute('aria-pressed') !== 'true';
    t.applyConstraints({ advanced: [{ torch: on }] }).then(function () {
      torchBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }, function () { torchBtn.hidden = true; });
  });

  // Coming back to the tab: the camera stopped in the background on phones.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && stream) stopStream();
  });

  // ---- Keeping the screen on, and the count fresh --------------------------------------

  var wake = null;
  function keepAwake() {
    if (!navigator.wakeLock || wake) return;
    navigator.wakeLock.request('screen').then(function (w) {
      wake = w;
      w.addEventListener('release', function () { wake = null; });
    }, function () { /* not allowed here; the phone's own timeout applies */ });
  }
  document.addEventListener('pointerdown', keepAwake, { once: true });

  // Another phone on the same door lets people in too: the count follows.
  setInterval(function () {
    if (document.hidden || busy) return;
    fetch(url + '/count', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) {
        if (!c) return;
        setCount(c.in);
        total.textContent = c.total;
      })
      .catch(function () { /* next time */ });
  }, 15000);
})();
