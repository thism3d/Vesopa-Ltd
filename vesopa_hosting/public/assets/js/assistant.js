/**
 * Vesopa AI — the guide that hovers on the right of every page.
 *
 * WHAT IT IS. A customer talks (or types); the assistant answers out loud
 * and, when asked, does the work on the page in front of them: opens the
 * right screen, types the domain into the box, chooses the plan, fills the
 * checkout form from what it knows, and asks before it presses anything
 * that costs money or cannot be undone. The thinking happens on the server
 * (/ai/turn); this file is the ears, the voice and the hands.
 *
 * THREE SHAPES.
 *   the orb      minimised: a lime circle bottom-right whose ring shows the
 *                state — off, idle, listening (grows with the voice),
 *                thinking, working on the page, speaking
 *   the bar      on a phone: a strip along the bottom that listens and
 *                answers out loud, with the last thing said written on it
 *                and a keyboard button that opens the chat
 *   the chat     the transcript and a keyboard: a column down the right on
 *                a tablet or desktop, a sheet from the bottom on a phone
 *
 * VOICE FIRST. The first tap on the orb asks the browser for the microphone
 * straight away — a tap is the gesture browsers need — and explains why
 * while the prompt is up. Allowed: it listens, and answers out loud.
 * Refused: it types instead, and the microphone button offers again.
 *
 * WHERE IT LIVES. On <html>, beside the loading bar, not in <body>: the
 * no-reload router (nav.js) replaces body.innerHTML on every page, and a
 * widget in the body would lose its microphone, its transcript and its
 * half-finished job on every click. nav.js lists this file as SHARED, so it
 * runs once per document and hears about new pages through vesopa:navigated.
 *
 * THE HANDS. Each turn the server is sent a numbered list of the page's
 * controls (e1, e2 ...) and answers with actions on those numbers. The
 * numbers are made here and resolved here, so the server never names a CSS
 * selector and a stale answer can only miss, never hit the wrong thing.
 * Every action is shown as it happens: a pointer moves to the control, it
 * lights up, text is typed a character at a time. A click on a button that
 * pays, orders, deletes or rewires DNS arrives as a question, and is pressed
 * only when the customer says yes.
 *
 * MEMORY. Not signed in: this browser keeps the conversation and what the
 * assistant learned, in localStorage. Signed in: the server keeps both with
 * the account, and the browser's copy is handed over once (POST /ai/import).
 *
 * VOICE. The browser records 16 kHz mono WAV and the server's voice model
 * writes down what was said; the reply is spoken by the browser's own
 * voices. With "listen" on, it listens continuously and sends each
 * utterance when the customer pauses; with it off, the mic button is
 * hold-to-talk. Nothing is recorded while the assistant is speaking.
 */
(function () {
  'use strict';

  if (window.__vesopaAI) return;
  window.__vesopaAI = true;

  var STORE_KEY = 'vesopa_ai_v1';
  var MAX_AUTO_HOPS = 6;
  var NEVER = /^\/(auth|admin\/auth|pay|api|webmail|panel\/terminal|panel\/files)(\/|$)/;

  // ---- State ------------------------------------------------------------
  var store = load();
  var session = { enabled: false, signedIn: false, name: '', token: '' };
  var state = 'off';
  var shape = 'orb';        // orb | bar | chat
  var busy = false;
  var autoHops = 0;
  var pending = null;       // {ref, label, question}
  var refs = new Map();     // ref -> element, for the snapshot last sent
  var ui = {};
  var audio = { ctx: null, stream: null, node: null, src: null, chunks: [], speaking: false, above: 0, below: 0, floor: 0.004, ptt: false, talking: false };
  var voices = [];

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var s = raw ? JSON.parse(raw) : {};
      return {
        consent: s.consent || null,       // 'voice' | 'text' | 'no'
        voice: s.voice !== false,          // speak replies
        listen: s.listen !== false,        // always listening
        shape: s.shape || 'orb',           // what was open last
        memory: Array.isArray(s.memory) ? s.memory.slice(-40) : [],
        history: Array.isArray(s.history) ? s.history.slice(-40) : [],
        seen: Boolean(s.seen),
        cont: Number(s.cont) || 0,         // a job in progress across a full page load
        hops: Number(s.hops) || 0,         // how many automatic turns that job has taken
      };
    } catch (e) {
      return { consent: null, voice: true, listen: true, shape: 'orb', memory: [], history: [], seen: false, cont: 0, hops: 0 };
    }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* private mode */ }
  }
  function csrf() {
    var m = document.cookie.match(/(?:^|; )vh_csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function isPhone() { return window.matchMedia('(max-width: 700px)').matches; }
  function voiceOn() { return store.consent === 'voice'; }
  function restState() { return voiceOn() && store.listen && audio.node ? 'listening' : (store.consent && store.consent !== 'no' ? 'idle' : 'off'); }
  function enabledOnThisPage() {
    var b = document.body;
    if (!b || b.getAttribute('data-ai') !== '1') return false;
    return !/^\/admin(\/|$)/.test(window.location.pathname);
  }

  // ---- UI ---------------------------------------------------------------
  var ICON = {
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
    min: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12L20 4l-4 16-4-7z"/></svg>',
    ear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10a6 6 0 0 1 12 0c0 3-2 4-3 6s-1 5-4 5"/><path d="M9.5 10a2.5 2.5 0 0 1 5 0"/></svg>',
    keyboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/></svg>',
    voice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 10v4M9 6v12M13 9v6M17 4v16M21 10v4"/></svg>',
  };

  function build() {
    var root = document.createElement('div');
    root.id = 'vai';
    root.innerHTML =
      '<button class="vai-orb" type="button" data-state="off" aria-label="Vesopa AI"><span class="vai-ring"></span><span class="vai-ring2"></span>' + ICON.spark + '<span class="vai-badge"></span></button>' +
      '<div class="vai-bar" hidden data-state="off">' +
        '<span class="vai-bar-mark"><span class="vai-ring"></span>' + ICON.spark + '</span>' +
        '<div class="vai-bar-text"><small class="vai-bar-status">Ready</small><span class="vai-bar-line"></span></div>' +
        '<button class="vai-bar-btn vai-bar-kb" type="button" aria-label="Type instead" title="Type">' + ICON.keyboard + '</button>' +
        '<button class="vai-bar-btn vai-bar-min" type="button" aria-label="Minimise" title="Minimise">' + ICON.min + '</button>' +
      '</div>' +
      '<div class="vai-cursor" aria-hidden="true"><i></i><span>AI</span></div>';
    document.documentElement.appendChild(root);
    ui.root = root;
    ui.orb = root.querySelector('.vai-orb');
    ui.bar = root.querySelector('.vai-bar');
    ui.barStatus = root.querySelector('.vai-bar-status');
    ui.barLine = root.querySelector('.vai-bar-line');
    ui.cursor = root.querySelector('.vai-cursor');
    ui.orb.addEventListener('click', onOrbTap);
    root.querySelector('.vai-bar-kb').addEventListener('click', function () { showChat(); });
    root.querySelector('.vai-bar-min').addEventListener('click', minimise);
    ui.bar.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      unlockSpeech(); resumeAudio();
    });
  }

  function buildChat() {
    if (ui.panel) return;
    var p = document.createElement('div');
    p.className = 'vai-panel';
    p.hidden = true;
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'Vesopa AI');
    p.innerHTML =
      '<div class="vai-grab" aria-hidden="true"></div>' +
      '<div class="vai-head">' +
        '<span class="vai-mark">' + ICON.spark + '</span>' +
        '<div class="vai-title"><b>Vesopa AI</b><span class="vai-status">Ready</span></div>' +
        '<button class="vai-ic vai-t-listen" type="button" title="Always listening" aria-label="Always listening" aria-pressed="false">' + ICON.ear + '</button>' +
        '<button class="vai-ic vai-t-voice" type="button" title="Speak replies" aria-label="Speak replies" aria-pressed="false">' + ICON.speaker + '</button>' +
        '<button class="vai-ic vai-t-bar" type="button" title="Voice only" aria-label="Back to voice">' + ICON.voice + '</button>' +
        '<button class="vai-ic vai-t-min" type="button" title="Minimise" aria-label="Minimise">' + ICON.min + '</button>' +
      '</div>' +
      '<div class="vai-body"></div>' +
      '<div class="vai-hint"></div>' +
      '<div class="vai-foot">' +
        '<textarea class="vai-input" rows="1" placeholder="Ask, or say what you want done…" aria-label="Message Vesopa AI"></textarea>' +
        '<button class="vai-mic" type="button" title="Hold to talk" aria-label="Hold to talk">' + ICON.mic + '</button>' +
        '<button class="vai-send" type="button" aria-label="Send">' + ICON.send + '</button>' +
      '</div>';
    ui.root.appendChild(p);
    ui.panel = p;
    ui.body = p.querySelector('.vai-body');
    ui.status = p.querySelector('.vai-status');
    ui.hint = p.querySelector('.vai-hint');
    ui.input = p.querySelector('.vai-input');
    ui.send = p.querySelector('.vai-send');
    ui.mic = p.querySelector('.vai-mic');
    ui.tListen = p.querySelector('.vai-t-listen');
    ui.tVoice = p.querySelector('.vai-t-voice');
    ui.tBar = p.querySelector('.vai-t-bar');

    p.querySelector('.vai-t-min').addEventListener('click', minimise);
    ui.tBar.addEventListener('click', function () { if (voiceOn()) showBar(); else enableVoice(false, true); });
    ui.send.addEventListener('click', sendTyped);
    ui.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTyped(); }
      if (e.key === 'Escape') minimise();
    });
    ui.input.addEventListener('input', function () {
      ui.input.style.height = 'auto';
      ui.input.style.height = Math.min(120, ui.input.scrollHeight) + 'px';
    });
    ui.tVoice.addEventListener('click', function () {
      store.voice = !store.voice; save(); syncToggles();
      if (!store.voice) stopSpeaking();
    });
    ui.tListen.addEventListener('click', function () {
      if (!voiceOn()) { enableVoice(false, true); return; }
      store.listen = !store.listen; save(); syncToggles();
      if (store.listen) startListening(); else stopListening();
    });
    // Hold to talk, for people who keep the ear off.
    var down = function (e) { e.preventDefault(); if (!voiceOn()) { enableVoice(false, true); return; } pttStart(); };
    var up = function (e) { e.preventDefault(); pttStop(); };
    ui.mic.addEventListener('pointerdown', down);
    ui.mic.addEventListener('pointerup', up);
    ui.mic.addEventListener('pointercancel', up);
    ui.mic.addEventListener('pointerleave', function () { if (audio.ptt) pttStop(); });

    // The transcript so far.
    var hist = session.signedIn && session.history ? session.history : store.history;
    hist.slice(-16).forEach(function (m) { bubble(m.role === 'user' ? 'user' : 'ai', m.content, true); });
    syncToggles();
  }

  function syncToggles() {
    if (!ui.panel) return;
    ui.tVoice.setAttribute('aria-pressed', store.voice ? 'true' : 'false');
    ui.tVoice.classList.toggle('is-off', !store.voice);
    var listening = voiceOn() && store.listen;
    ui.tListen.setAttribute('aria-pressed', listening ? 'true' : 'false');
    ui.tListen.classList.toggle('is-off', !listening);
    ui.tBar.hidden = !isPhone();
    ui.hint.textContent = voiceOn()
      ? (store.listen ? 'Listening whenever you pause. Hold the microphone to talk instead.' : 'Hold the microphone to talk, or type.')
      : 'Type below, or press the microphone to switch voice on.';
  }

  var LABEL = { off: 'Off', idle: 'Ready', listening: 'Listening…', thinking: 'Thinking…', working: 'Working on the page…', speaking: 'Speaking' };
  function setState(next, label) {
    state = next;
    ui.orb.setAttribute('data-state', next);
    ui.bar.setAttribute('data-state', next);
    ui.barStatus.textContent = label || LABEL[next] || '';
    if (ui.panel) {
      ui.panel.setAttribute('data-state', next);
      ui.status.textContent = label || LABEL[next] || '';
    }
  }
  function barLine(text) { ui.barLine.textContent = text || ''; }

  // ---- Shapes ---------------------------------------------------------------
  function setShape(next) {
    shape = next;
    store.shape = next; save();
    ui.orb.hidden = next !== 'orb';
    ui.bar.hidden = next !== 'bar';
    if (ui.panel) ui.panel.hidden = next !== 'chat';
    if (ui.hello) { ui.hello.remove(); ui.hello = null; }
    if (next !== 'orb') ui.orb.classList.remove('has-news');
  }
  function showBar() { setShape('bar'); }
  function showChat() {
    buildChat();
    setShape('chat');
    scrollBody();
    if (!voiceOn()) setTimeout(function () { ui.input.focus(); }, 60);
  }
  function minimise() { setShape('orb'); }

  /** The orb was tapped: the first time, that tap is what lets the mic in. */
  function onOrbTap() {
    unlockSpeech();
    if (!store.consent) { firstRun(); return; }
    if (voiceOn()) {
      if (!audio.stream) enableVoice(false, false); else resumeAudio();
      if (isPhone()) showBar(); else showChat();
    } else {
      showChat();
    }
  }

  function firstRun() {
    // Ask for the microphone NOW, inside the tap, and explain while the
    // browser's prompt is up. Whatever they choose, they get an assistant.
    if (isPhone()) {
      showBar();
      barLine('I can listen and talk you through it. Allow the microphone, or tap the keyboard to type.');
    } else {
      showChat();
      explainerCard();
    }
    setState('idle', 'Asking for the microphone…');
    enableVoice(true, false);
  }

  function explainerCard() {
    var c = document.createElement('div');
    c.className = 'vai-card vai-explainer';
    c.innerHTML =
      '<h3>Hello, I’m Vesopa AI.</h3>' +
      '<p>I can walk you through a domain, hosting, email and your website — and do the clicking and typing for you. I only see this page and, once you sign in, your own account. I ask before anything is paid for or deleted.</p>' +
      '<p class="small">Allow the microphone and we can talk; what you say is sent to our AI service to be understood and is not kept as audio. Or <button class="vai-link" type="button" data-c="text">type instead</button>.</p>';
    ui.body.appendChild(c);
    c.addEventListener('click', function (e) {
      if (!e.target.closest('[data-c="text"]')) return;
      c.remove();
      store.consent = 'text'; save(); setState('idle'); syncToggles(); greet();
    });
    scrollBody();
  }
  function clearExplainer() { var c = ui.body && ui.body.querySelector('.vai-explainer'); if (c) c.remove(); }

  function greet() {
    if (busy) return;
    var hist = session.signedIn && session.history ? session.history : store.history;
    if (hist.length) return;
    turn({ greet: true });
  }

  // ---- Transcript -----------------------------------------------------------
  function bubble(kind, text, quiet) {
    buildChat();
    var el = document.createElement('div');
    el.className = 'vai-msg ' + kind;
    el.textContent = text;
    ui.body.appendChild(el);
    if (!quiet) scrollBody();
    if (shape === 'orb' && kind === 'ai') ui.orb.classList.add('has-news');
    if (kind === 'ai') barLine(text);
    if (kind === 'err') barLine(text);
    return el;
  }
  function note(text) {
    var el = bubble('note', text);
    if (shape === 'bar') barLine(text);
    return el;
  }
  function typing(on) {
    if (!ui.body) return;
    var t = ui.body.querySelector('.vai-typing-row');
    if (on && !t) {
      t = document.createElement('div');
      t.className = 'vai-msg ai vai-typing-row';
      t.innerHTML = '<span class="vai-typing"><i></i><i></i><i></i></span>';
      ui.body.appendChild(t); scrollBody();
    } else if (!on && t) t.remove();
  }
  function scrollBody() { if (ui.body) ui.body.scrollTop = ui.body.scrollHeight + 400; }
  function remember(role, content) {
    if (!content || session.signedIn) return;
    store.history.push({ role: role, content: String(content).slice(0, 1500) });
    store.history = store.history.slice(-40);
    save();
  }

  // ---- Voice: hearing -------------------------------------------------------
  function enableVoice(firstTime, thenGreet) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fallBackToText(firstTime, 'This browser cannot use the microphone here, so I will read and type instead.');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (stream) {
      audio.stream = stream;
      store.consent = 'voice'; store.listen = true; save();
      clearExplainer();
      syncToggles();
      startListening();
      setState(restState());
      if (shape === 'bar') barLine('I’m listening. Say what you would like to do.');
      if (firstTime || thenGreet) greet();
    }).catch(function () {
      fallBackToText(firstTime, 'The microphone was not allowed, so I will read and type instead. The microphone button offers again.');
    });
  }
  function fallBackToText(firstTime, why) {
    if (store.consent !== 'voice') { store.consent = 'text'; save(); }
    clearExplainer();
    showChat();
    setState('idle'); syncToggles();
    bubble('err', why);
    if (firstTime) greet();
  }
  function resumeAudio() {
    if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
    if (audio.stream && !audio.node && store.listen) startListening();
  }

  function startListening() {
    if (!audio.stream || audio.node) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audio.ctx = audio.ctx || new Ctx();
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
    audio.src = audio.ctx.createMediaStreamSource(audio.stream);
    audio.node = audio.ctx.createScriptProcessor(4096, 1, 1);
    audio.rate = audio.ctx.sampleRate;
    audio.chunks = []; audio.above = 0; audio.below = 0; audio.talking = false; audio.started = 0;
    audio.node.onaudioprocess = onAudio;
    audio.src.connect(audio.node);
    audio.node.connect(audio.ctx.destination);
    if (!busy && !audio.speaking) setState('listening');
  }
  function stopListening() {
    if (audio.node) { try { audio.node.disconnect(); audio.src.disconnect(); } catch (e) {} }
    audio.node = null; audio.src = null; audio.chunks = []; audio.talking = false;
    if (state === 'listening') setState('idle');
  }

  /** Voice activity: talk when it is clearly louder than the room, send on a pause. */
  function onAudio(e) {
    var input = e.inputBuffer.getChannelData(0);
    var sum = 0;
    for (var i = 0; i < input.length; i += 1) sum += input[i] * input[i];
    var rms = Math.sqrt(sum / input.length);
    var frameMs = (input.length / audio.rate) * 1000;

    var canHear = audio.ptt || (store.listen && !busy && !audio.speaking && state !== 'thinking' && state !== 'working');
    if (!canHear) { audio.chunks = []; audio.talking = false; return; }

    if (!audio.talking) audio.floor = audio.floor * 0.95 + rms * 0.05;
    var threshold = Math.max(0.012, audio.floor * 3.5);
    var loud = rms > threshold;
    var level = Math.min(1, rms / 0.12).toFixed(2);
    ui.orb.style.setProperty('--vai-level', level);
    ui.bar.style.setProperty('--vai-level', level);
    if (state === 'idle' && store.listen && !audio.ptt) setState('listening');

    if (audio.ptt) { audio.chunks.push(new Float32Array(input)); return; }

    if (!audio.talking) {
      if (loud) { audio.above += frameMs; if (audio.above > 120) { audio.talking = true; audio.started = Date.now(); audio.below = 0; setState('listening', 'Listening…'); } }
      else audio.above = 0;
      audio.chunks.push(new Float32Array(input));
      if (audio.chunks.length > 4 && !audio.talking) audio.chunks.shift();
      return;
    }
    audio.chunks.push(new Float32Array(input));
    if (loud) audio.below = 0; else audio.below += frameMs;
    var length = Date.now() - audio.started;
    if ((audio.below > 900 && length > 350) || length > 20000) {
      var chunks = audio.chunks; audio.chunks = []; audio.talking = false; audio.above = 0; audio.below = 0;
      if (length < 350) return;
      sendClip(chunks);
    }
  }

  function pttStart() {
    if (!audio.stream) return;
    if (!audio.node) startListening();
    stopSpeaking();
    audio.ptt = true; audio.chunks = []; audio.started = Date.now();
    ui.mic.classList.add('is-live'); setState('listening', 'Listening… let go to send');
  }
  function pttStop() {
    if (!audio.ptt) return;
    audio.ptt = false; ui.mic.classList.remove('is-live');
    var chunks = audio.chunks; audio.chunks = [];
    if (Date.now() - audio.started < 300) { setState(restState()); return; }
    sendClip(chunks);
    if (!store.listen) stopListening();
  }
  function sendClip(chunks) {
    var wav = toWav16k(chunks, audio.rate);
    if (!wav) return;
    turn({ audio: { data: wav, format: 'wav' } });
  }

  /** Float32 chunks at the device rate -> 16 kHz mono 16-bit WAV, base64. */
  function toWav16k(chunks, rate) {
    var total = 0;
    for (var i = 0; i < chunks.length; i += 1) total += chunks[i].length;
    if (!total) return null;
    var joined = new Float32Array(total), off = 0;
    for (var j = 0; j < chunks.length; j += 1) { joined.set(chunks[j], off); off += chunks[j].length; }
    var ratio = rate / 16000;
    var outLen = Math.floor(joined.length / ratio);
    var pcm = new Int16Array(outLen);
    for (var k = 0; k < outLen; k += 1) {
      var start = Math.floor(k * ratio), end = Math.min(joined.length, Math.floor((k + 1) * ratio)), s = 0, n = 0;
      for (var m = start; m < end; m += 1) { s += joined[m]; n += 1; }
      var v = n ? s / n : 0;
      pcm[k] = Math.max(-1, Math.min(1, v)) * 0x7fff;
    }
    var buf = new ArrayBuffer(44 + pcm.length * 2);
    var dv = new DataView(buf);
    var w = function (o, str) { for (var q = 0; q < str.length; q += 1) dv.setUint8(o + q, str.charCodeAt(q)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true);
    dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    var bytes = new Uint8Array(buf), bin = '';
    for (var b = 0; b < bytes.length; b += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(b, b + 0x8000));
    return btoa(bin);
  }

  // ---- Voice: speaking --------------------------------------------------------
  var unlocked = false;
  /** iOS lets speech start only from a tap; an empty utterance in the tap opens the door. */
  function unlockSpeech() {
    if (unlocked || !window.speechSynthesis) return;
    try { var u = new SpeechSynthesisUtterance(''); u.volume = 0; speechSynthesis.speak(u); unlocked = true; } catch (e) {}
  }
  function pickVoice() {
    if (!window.speechSynthesis) return null;
    voices = speechSynthesis.getVoices() || [];
    var prefer = ['Google UK English Female', 'Microsoft Libby Online (Natural) - English (United Kingdom)', 'Microsoft Sonia Online (Natural) - English (United Kingdom)', 'Microsoft Hazel', 'Daniel', 'Kate', 'Serena'];
    for (var i = 0; i < prefer.length; i += 1) {
      for (var j = 0; j < voices.length; j += 1) if (voices[j].name.indexOf(prefer[i]) === 0) return voices[j];
    }
    for (var k = 0; k < voices.length; k += 1) if (/en-GB/i.test(voices[k].lang)) return voices[k];
    for (var l = 0; l < voices.length; l += 1) if (/^en/i.test(voices[l].lang)) return voices[l];
    return null;
  }
  if (window.speechSynthesis) { speechSynthesis.onvoiceschanged = function () { voices = speechSynthesis.getVoices(); }; }

  function speak(text) {
    return new Promise(function (resolve) {
      if (!store.voice || !window.speechSynthesis || !text) return resolve();
      stopSpeaking();
      var u = new SpeechSynthesisUtterance(text.replace(/https?:\/\/\S+/g, 'the link').replace(/\bns([12])\.vesopa\.com\b/g, 'N S $1 dot vesopa dot com'));
      var v = pickVoice();
      if (v) u.voice = v;
      u.lang = (v && v.lang) || 'en-GB';
      u.rate = 1.02; u.pitch = 1;
      var done = false;
      var finish = function () { if (done) return; done = true; audio.speaking = false; setState(restState()); resolve(); };
      u.onstart = function () { audio.speaking = true; setState('speaking'); };
      u.onend = function () { setTimeout(finish, 250); };
      u.onerror = finish;
      audio.speaking = true; setState('speaking');
      speechSynthesis.speak(u);
      setTimeout(finish, Math.min(30000, 2000 + text.length * 70));
    });
  }
  function stopSpeaking() {
    if (window.speechSynthesis && speechSynthesis.speaking) speechSynthesis.cancel();
    audio.speaking = false;
  }

  // ---- The page, as numbers -----------------------------------------------------
  function visible(el) {
    if (!el || el.closest('#vai')) return false;
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function labelFor(el) {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.id) { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.textContent.trim().replace(/\s+/g, ' ').slice(0, 80); }
    var wrap = el.closest('label');
    if (wrap) return wrap.textContent.trim().replace(/\s+/g, ' ').slice(0, 80);
    var lab = el.getAttribute('aria-labelledby');
    if (lab) { var t = document.getElementById(lab); if (t) return t.textContent.trim(); }
    return '';
  }
  function snapshot() {
    refs = new Map();
    var els = [];
    var main = document.querySelector('main') || document.body;
    var pool = Array.prototype.slice.call(main.querySelectorAll('input, textarea, select, button, a[href], [role="button"]'));
    var nav = Array.prototype.slice.call(document.querySelectorAll('header a[href], .rail a[href], nav a[href]')).filter(function (a) { return pool.indexOf(a) === -1; });
    pool = pool.concat(nav);
    var n = 0;
    for (var i = 0; i < pool.length && n < 90; i += 1) {
      var el = pool[i];
      if (!visible(el) || el.disabled && el.tagName !== 'BUTTON') continue;
      var tag = el.tagName.toLowerCase();
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && (type === 'hidden' || type === 'submit' && !el.value && !el.textContent)) continue;
      var item = { ref: 'e' + (++n) };
      if (tag === 'input') {
        item.kind = type || 'text';
        item.name = el.name || '';
        item.placeholder = el.placeholder || '';
        item.label = labelFor(el);
        if (type === 'checkbox' || type === 'radio') { item.checked = el.checked; item.value = el.value; }
        else if (type === 'password') item.value = el.value ? '(filled)' : '';
        else if (type === 'submit' || type === 'button') { item.kind = 'button'; item.text = el.value; }
        else item.value = String(el.value || '').slice(0, 80);
      } else if (tag === 'textarea') {
        item.kind = 'textarea'; item.name = el.name || ''; item.label = labelFor(el); item.placeholder = el.placeholder || ''; item.value = String(el.value || '').slice(0, 80);
      } else if (tag === 'select') {
        item.kind = 'select'; item.name = el.name || ''; item.label = labelFor(el);
        item.value = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '';
        item.options = Array.prototype.slice.call(el.options, 0, 14).map(function (o) { return o.text; });
        if (el.options.length > 14) item.options.push('… ' + (el.options.length - 14) + ' more');
      } else if (tag === 'a') {
        item.kind = 'link'; item.text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) || el.getAttribute('aria-label') || '';
        item.href = el.getAttribute('href');
        if (!item.text) continue;
      } else {
        item.kind = 'button'; item.text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) || el.getAttribute('aria-label') || '';
        if (el.disabled) item.disabled = true;
        if (!item.text) continue;
      }
      refs.set(item.ref, el);
      els.push(item);
    }
    var headings = Array.prototype.slice.call(main.querySelectorAll('h1, h2')).filter(visible).slice(0, 12).map(function (h) { return h.textContent.trim().replace(/\s+/g, ' '); });
    var alerts = Array.prototype.slice.call(document.querySelectorAll('[role="alert"], .alert, .flash, .notice, .error, .field-error, .warning, .toast, [data-flash]')).filter(function (a) { return visible(a) || a.hasAttribute('data-flash'); }).map(function (a) { return (a.getAttribute('data-flash') || a.textContent).trim().replace(/\s+/g, ' ').slice(0, 300); }).filter(Boolean).slice(0, 6);
    var text = (main.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1800);
    return { url: window.location.pathname + window.location.search, title: document.title, headings: headings, alerts: alerts, text: text, elements: els };
  }

  // ---- Doing things on the page ---------------------------------------------------
  function pointAt(el) {
    var r = el.getBoundingClientRect();
    ui.cursor.style.transform = 'translate(' + Math.round(r.left + Math.min(r.width - 10, 24)) + 'px, ' + Math.round(r.top + r.height - 6) + 'px)';
    ui.cursor.classList.add('is-on');
  }
  function unpoint() { ui.cursor.classList.remove('is-on'); }
  function focusRing(el, on) { el.classList.toggle('vai-focus', on); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }

  function waitForPage(ms) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (done) return; done = true; window.removeEventListener('vesopa:navigated', finish); resolve(); };
      window.addEventListener('vesopa:navigated', finish);
      setTimeout(finish, ms || 6000);
    });
  }

  function typeInto(el, value) {
    return new Promise(function (resolve) {
      el.focus();
      try { el.setSelectionRange(0, el.value.length); } catch (e) {}
      el.value = '';
      fire(el, 'input');
      var i = 0;
      var step = value.length > 40 ? 8 : 26;
      var tick = function () {
        if (i >= value.length) { fire(el, 'input'); fire(el, 'change'); resolve(); return; }
        el.value += value.charAt(i); i += 1; fire(el, 'input');
        setTimeout(tick, step);
      };
      tick();
    });
  }

  /** A job carries on across a full page load, for a little while. */
  function markContinuing() { store.cont = Date.now(); save(); }
  function clearContinuing() { if (store.cont || store.hops) { store.cont = 0; store.hops = 0; save(); } }

  async function act(action) {
    if (action.type === 'navigate') {
      note('Opening ' + action.url);
      markContinuing();
      if (NEVER.test(action.url) || !window.VesopaNav) { window.location.assign(action.url); return sleep(1500); }
      window.VesopaNav.go(action.url, true);
      await waitForPage(8000);
      return sleep(300);
    }
    var el = refs.get(action.ref);
    if (!el || !document.contains(el)) { note('Could not find ' + (action.label || action.ref) + ' on this page any more.'); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(250);
    pointAt(el); focusRing(el, true);
    await sleep(350);
    try {
      if (action.type === 'fill') {
        note('Typing “' + action.value + '” into ' + (action.label || 'the field'));
        await typeInto(el, action.value);
      } else if (action.type === 'select') {
        note('Choosing ' + action.value + ' for ' + (action.label || 'the list'));
        var want = String(action.value).toLowerCase();
        var found = false;
        for (var i = 0; i < el.options.length; i += 1) {
          var o = el.options[i];
          if (o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) { el.selectedIndex = i; found = true; break; }
        }
        if (!found) for (var j = 0; j < el.options.length; j += 1) { if (el.options[j].text.toLowerCase().indexOf(want) !== -1) { el.selectedIndex = j; found = true; break; } }
        fire(el, 'input'); fire(el, 'change');
        if (!found) note('That option is not in the list.');
      } else if (action.type === 'check') {
        note((action.checked ? 'Ticking ' : 'Unticking ') + (action.label || 'the box'));
        if (el.checked !== action.checked) el.click();
      } else if (action.type === 'click') {
        note('Pressing ' + (action.label || 'the button'));
        var navigates = el.tagName === 'A' || el.type === 'submit' || el.closest('form');
        if (navigates) markContinuing();
        el.click();
        if (navigates) await waitForPage(6000);
        await sleep(300);
      }
    } finally {
      await sleep(200);
      focusRing(el, false); unpoint();
    }
  }

  async function perform(actions) {
    if (!actions || !actions.length) return;
    setState('working');
    for (var i = 0; i < actions.length; i += 1) {
      var a = actions[i];
      if (a.type === 'click' && a.confirm) { askConfirm(a); return; }
      try { await act(a); } catch (e) { note('That did not work: ' + (e && e.message ? e.message : e)); }
    }
  }

  function askConfirm(action) {
    pending = { ref: action.ref, label: action.label, question: action.confirm };
    buildChat();
    var c = document.createElement('div');
    c.className = 'vai-card vai-confirm';
    c.innerHTML = '<p></p><div class="vai-row"><button class="vai-btn lime" type="button" data-y="1">Yes, go ahead</button><button class="vai-btn" type="button" data-y="0">No</button></div>';
    c.querySelector('p').textContent = action.confirm;
    ui.body.appendChild(c); scrollBody();
    barLine(action.confirm + ' Say yes or no.');
    if (shape === 'orb') ui.orb.classList.add('has-news');
    c.addEventListener('click', function (e) {
      var b = e.target.closest('[data-y]');
      if (!b) return;
      c.remove();
      if (b.getAttribute('data-y') === '1') confirmYes(); else confirmNo();
    });
    speak(action.confirm).then(function () { setState(restState()); });
  }
  async function confirmYes() {
    if (!pending) return;
    var p = pending; pending = null;
    bubble('user', 'Yes, go ahead.');
    remember('user', 'Yes, go ahead.');
    setState('working');
    await act({ type: 'click', ref: p.ref, label: p.label });
    autoHops = 0;
    turn({ auto: true });
  }
  function confirmNo() {
    if (!pending) return;
    pending = null;
    turn({ text: 'No, don’t do that.' });
  }

  // ---- A turn ---------------------------------------------------------------------
  function sendTyped() {
    var text = (ui.input.value || '').trim();
    if (!text) return;
    ui.input.value = ''; ui.input.style.height = 'auto';
    turn({ text: text });
  }

  async function post(path, body) {
    var res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf(), 'x-ai-token': session.token || '' }, credentials: 'same-origin', body: JSON.stringify(body) });
    var data = null;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (res.status === 401 && data && data.reload) {
      // The widget token aged out; fetch a fresh one and go again, once.
      await refreshSession();
      res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf(), 'x-ai-token': session.token || '' }, credentials: 'same-origin', body: JSON.stringify(body) });
      try { data = await res.json(); } catch (e) { data = {}; }
    }
    return { res: res, data: data || {} };
  }

  async function turn(o) {
    if (busy || !session.enabled) return;
    busy = true;
    stopSpeaking();
    var wasPending = pending;
    if (o.text || o.audio) {
      pending = null;
      autoHops = 0; store.hops = 0;
      var card = ui.body && ui.body.querySelector('.vai-confirm');
      if (card) card.remove();
    }
    // Automatic turns are counted across page loads too, so a job that keeps
    // navigating cannot go round for ever after a reload resets autoHops.
    if (o.auto) {
      store.hops = (store.hops || 0) + 1; save();
      if (store.hops > MAX_AUTO_HOPS) { busy = false; clearContinuing(); setState(restState()); return; }
    }
    if (o.text) { bubble('user', o.text); remember('user', o.text); }
    setState('thinking');
    typing(true);
    if (o.audio) barLine('…');
    var payload = {
      text: o.text || '',
      audio: o.audio || null,
      auto: Boolean(o.auto),
      greet: Boolean(o.greet),
      voice: store.voice,
      page: snapshot(),
      pending: (o.text || o.audio) && wasPending ? { ref: wasPending.ref, label: wasPending.label, question: wasPending.question } : null,
      local: session.signedIn ? null : { memory: store.memory, history: store.history.slice(-24) },
    };
    var out;
    try {
      out = await post('/ai/turn', payload);
    } catch (e) {
      out = { res: null, data: { error: 'I lost the connection for a moment. Try again.' } };
    }
    typing(false);
    var res = out.res, data = out.data;
    if (!res || !res.ok || data.error) {
      bubble('err', data && data.error ? data.error : 'Something went wrong.');
      busy = false; clearContinuing(); setState(restState());
      return;
    }
    if (data.silence) { busy = false; setState(restState()); return; }
    if (data.heard) { bubble('user', data.heard); remember('user', data.heard); }
    if (Array.isArray(data.memory) && !session.signedIn) { store.memory = data.memory; save(); }
    if (data.say) { bubble('ai', data.say); remember('assistant', data.say); }

    var spoken = data.say ? speak(data.say) : Promise.resolve();
    busy = false;
    await perform(data.actions || []);
    await spoken;
    if (data.pending) { setState(restState()); return; }
    if (data.done === false && autoHops < MAX_AUTO_HOPS) {
      autoHops += 1;
      await sleep(400);
      return turn({ auto: true });
    }
    autoHops = 0;
    clearContinuing();
    setState(restState());
  }

  // ---- Session --------------------------------------------------------------------
  async function refreshSession() {
    var res = await fetch('/ai/session', { credentials: 'same-origin' });
    var data = await res.json();
    session.enabled = Boolean(data.enabled);
    session.signedIn = Boolean(data.signed_in);
    session.name = data.name || '';
    session.token = data.token || '';
    session.history = data.history || session.history || [];
    session.memory = data.memory || session.memory || [];
  }
  async function importLocal() {
    if (!session.signedIn) return;
    if (!store.memory.length && !store.history.length) return;
    try { await post('/ai/import', { memory: store.memory, history: store.history.slice(-16) }); } catch (e) { /* next time */ }
    store.memory = []; store.history = []; save();
  }

  // ---- Boot ---------------------------------------------------------------------------
  async function init() {
    if (!enabledOnThisPage()) return;
    build();
    try { await refreshSession(); } catch (e) { session.enabled = false; }
    if (!session.enabled) { ui.root.hidden = true; return; }
    if (session.signedIn) await importLocal();

    if (voiceOn()) {
      setState('idle');
      // Granted before, so no prompt; most browsers still want a gesture for
      // the AudioContext, which the first tap on the orb or the bar supplies.
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (s) {
        audio.stream = s; if (store.listen) startListening();
      }).catch(function () { /* they will press the mic */ });
    } else if (store.consent === 'text') {
      setState('idle');
    } else {
      setState('off');
      if (!store.seen) {
        store.seen = true; save();
        setTimeout(function () {
          if (shape !== 'orb') return;
          var h = document.createElement('div');
          h.className = 'vai-hello';
          h.innerHTML = '<b>Vesopa AI</b> — want a hand with a domain, hosting or your website? Tap me and we can talk.';
          h.addEventListener('click', onOrbTap);
          ui.root.appendChild(h); ui.hello = h;
          setTimeout(function () { if (ui.hello) { ui.hello.remove(); ui.hello = null; } }, 14000);
        }, 1800);
      }
    }

    // Back where they were: the bar or the chat, and a job that was mid-way.
    if (store.consent && store.consent !== 'no' && store.shape !== 'orb') {
      if (store.shape === 'bar' && isPhone()) showBar(); else if (store.shape === 'bar' && !isPhone()) showChat(); else showChat();
    }
    if (store.cont && Date.now() - store.cont < 45000) {
      store.cont = 0; save();
      setTimeout(function () { turn({ auto: true }); }, 900);
    }

    window.addEventListener('vesopa:navigated', function () {
      if (!enabledOnThisPage()) { ui.root.hidden = true; return; }
      ui.root.hidden = false;
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && shape === 'chat') minimise(); });
    window.addEventListener('resize', function () { if (ui.panel) syncToggles(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
