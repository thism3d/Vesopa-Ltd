/* go.vesopa.com sound (2026-11-06), like vesopasoftware.com's: nothing plays
   until asked for (browsers would block it anyway). The music is media/calm-piano.mp3,
   the one the owner chose by ear (tool/make_site_sounds.py), looping quietly;
   the app's own sounds are a soft wooden tap on each step of the sale and a
   gentle chime on the last, made here with Web Audio. */
(function () {
  'use strict';
  var btn = document.querySelector('.sound-btn');
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!btn) return;
  if (!AC) { btn.hidden = true; return; }

  var ctx = null, master = null, fx = null, on = false, stopping = null;
  var LEVEL = 1;        // the file is already mixed quiet
  var music = new Audio('/media/calm-piano.mp3');
  music.loop = true;
  music.preload = 'none';
  music.setAttribute('playsinline', '');

  function build() {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    // Through the graph so it can fade: iPhones ignore an audio element's volume.
    ctx.createMediaElementSource(music).connect(master);
    fx = ctx.createGain();
    fx.gain.value = 1;
    fx.connect(ctx.destination);
  }

  // A soft note: never a click, it swells in and rings away.
  function tone(freq, at, dur, vol, attack) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + (attack || 0.02));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(fx); o.start(at); o.stop(at + dur + 0.05);
  }
  function tap() { var t = ctx.currentTime; tone(523.25, t, 0.32, 0.05, 0.012); tone(784, t, 0.24, 0.018, 0.012); }
  function chime() { var t = ctx.currentTime; tone(659.25, t, 3.2, 0.06, 0.03); tone(987.77, t + 0.22, 3.2, 0.05, 0.03); tone(1318.5, t + 0.44, 3.4, 0.035, 0.03); }

  // iPhone: with the silent switch on, Safari mutes Web Audio unless the page
  // is also playing media. A looping, silent <audio> (and, on newer Safari,
  // the audio session set to playback) lets the sound through, as a video would.
  var keepAlive = null;
  function unmuteIOS() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    if (!keepAlive) {
      var n = 4410, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
      function str(o, x) { for (var i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)); }
      str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
      v.setUint16(22, 1, true); v.setUint32(24, 44100, true); v.setUint32(28, 88200, true); v.setUint16(32, 2, true);
      v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
      keepAlive = new Audio(URL.createObjectURL(new Blob([b], { type: 'audio/wav' })));
      keepAlive.loop = true; keepAlive.setAttribute('playsinline', '');
    }
    keepAlive.play().catch(function () {});
  }

  function set(want) {
    if (!ctx) build();
    on = want;
    if (on) unmuteIOS(); else if (keepAlive) keepAlive.pause();
    if (ctx.state === 'suspended') ctx.resume();
    var t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(on ? LEVEL : 0, t + (on ? 3 : 0.8));
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('on', on);
    btn.querySelector('span').textContent = on ? 'Sound on' : 'Sound';
    clearTimeout(stopping);
    if (on) music.play().catch(function () {});
    else stopping = setTimeout(function () { music.pause(); }, 900);
  }
  btn.addEventListener('click', function () { set(!on); });

  // The app's sounds follow the sale, step by step.
  var steps = Array.prototype.slice.call(document.querySelectorAll('.steps-list .step'));
  var last = -1;
  if (steps.length) {
    new MutationObserver(function () {
      var i = steps.findIndex(function (s) { return s.classList.contains('on'); });
      if (i === last || i < 0) return;
      last = i;
      if (!on) return;
      if (i === steps.length - 1) chime(); else tap();
    }).observe(document.querySelector('.steps-list'), { attributes: true, subtree: true, attributeFilter: ['class'] });
  }

  // Quiet when the tab is hidden.
  document.addEventListener('visibilitychange', function () {
    if (!ctx || !on) return;
    if (document.hidden) { music.pause(); ctx.suspend(); } else { ctx.resume(); music.play().catch(function () {}); }
  });

  // The way in, as vesopasoftware.com does it: once a visit, a short welcome
  // asks for sound, because only a click may start it. Either button lets the
  // page in; the headline rises after, so it isn't spent behind the welcome.
  var asked = false;
  try { asked = sessionStorage.getItem('go-sound-asked') === '1'; } catch (e) {}
  if (asked || !btn.closest('header')) return;
  var root = document.documentElement;
  var w = document.createElement('div');
  w.className = 'welcome';
  w.setAttribute('role', 'dialog');
  w.setAttribute('aria-label', 'Welcome to Vesopa Go');
  w.innerHTML = '<div class="welcome-in">'
    + '<img src="/img/go-mark.png" alt="" width="84" height="84">'
    + '<p class="welcome-name">Vesopa <b>Go</b></p>'
    + '<p class="welcome-t">Best with sound.</p>'
    + '<p class="welcome-s">Soft, calm music plays quietly under this page. Turn it off any time.</p>'
    + '<div class="welcome-go"><button type="button" class="btn primary" data-sound="1">Enter with sound</button>'
    + '<button type="button" class="btn ghost" data-sound="0">Enter quietly</button></div></div>';
  document.body.appendChild(w);
  root.classList.add('welcoming');
  requestAnimationFrame(function () { w.classList.add('shown'); });
  w.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-sound]');
    if (!b) return;
    try { sessionStorage.setItem('go-sound-asked', '1'); } catch (er) {}
    if (b.getAttribute('data-sound') === '1') set(true);
    // replay the headline's rise for the visitor, now that they can see it
    root.classList.add('snap');
    root.classList.remove('ready');
    void root.offsetWidth;
    root.classList.remove('snap', 'welcoming');
    w.classList.remove('shown');
    w.classList.add('gone');
    setTimeout(function () { root.classList.add('ready'); }, 120);
    setTimeout(function () { w.remove(); }, 900);
  });
  w.querySelector('[data-sound="1"]').focus({ preventScroll: true });
})();
