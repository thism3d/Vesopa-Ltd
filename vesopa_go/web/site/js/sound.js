/* go.vesopa.com sound (2026-11-06), like vesopasoftware.com's: nothing plays
   until the Sound button is pressed (browsers would block it anyway). Then a
   calm bed (an E major chord of soft detuned tones through a low-pass filter)
   that opens up as you scroll down the page, and the app's own small sounds:
   a soft tap as each step of the sale comes up, a chime on the last one.
   All made here with Web Audio; no files to load. */
(function () {
  'use strict';
  var btn = document.querySelector('.sound-btn');
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!btn) return;
  if (!AC) { btn.hidden = true; return; }

  var ctx = null, master = null, bedGain = null, filter = null, fx = null, on = false;

  function build() {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    // A little room: a short feedback delay, quiet.
    var delay = ctx.createDelay(1), fb = ctx.createGain(), wet = ctx.createGain();
    delay.delayTime.value = 0.32; fb.gain.value = 0.28; wet.gain.value = 0.22;
    delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(master);

    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 1400; filter.Q.value = 0.6;
    bedGain = ctx.createGain(); bedGain.gain.value = 0.32;
    filter.connect(bedGain); bedGain.connect(master); bedGain.connect(delay);
    // E3 B3 E4 G#4 B4: high enough for a phone's speaker (they play little
    // under 200 Hz); two oscillators each, a few cents apart, so it breathes.
    [52, 59, 64, 68, 71].forEach(function (m, i) {
      var f = 440 * Math.pow(2, (m - 69) / 12);
      [-4, 4].forEach(function (cents) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = i < 2 ? 'sine' : 'triangle';
        o.frequency.value = f; o.detune.value = cents;
        g.gain.value = i < 2 ? 0.14 : 0.09;
        var lfo = ctx.createOscillator(), depth = ctx.createGain();
        lfo.frequency.value = 0.05 + i * 0.017; depth.gain.value = g.gain.value * 0.5;
        lfo.connect(depth); depth.connect(g.gain); lfo.start();
        o.connect(g); g.connect(filter); o.start();
      });
    });
    fx = ctx.createGain(); fx.gain.value = 1.0;
    fx.connect(master); fx.connect(delay);
  }

  function tone(freq, at, dur, vol, type) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(vol, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(fx); o.start(at); o.stop(at + dur + 0.05);
  }
  function tap() { var t = ctx.currentTime; tone(1760, t, 0.09, 0.22); tone(880, t, 0.12, 0.14, 'triangle'); }
  function chime() { var t = ctx.currentTime; tone(1318.5, t, 1.3, 0.24); tone(1975.5, t + 0.11, 1.5, 0.2); tone(659.3, t, 1.6, 0.12, 'triangle'); }

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
    master.gain.linearRampToValueAtTime(on ? 1.0 : 0, t + (on ? 1.2 : 0.5));
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('on', on);
    btn.querySelector('span').textContent = on ? 'Sound on' : 'Sound';
    if (on) { brighten(); tap(); }
  }
  btn.addEventListener('click', function () { set(!on); });

  // The bed opens up as you go down the page.
  function brighten() {
    if (!ctx) return;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var k = max > 0 ? Math.min(1, window.scrollY / max) : 0;
    filter.frequency.setTargetAtTime(1400 + k * 2600, ctx.currentTime, 0.4);
  }
  window.addEventListener('scroll', function () { if (on) brighten(); }, { passive: true });

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
    if (document.hidden) ctx.suspend(); else ctx.resume();
  });
})();
