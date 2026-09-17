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
 * TWO SHAPES, ONE BUTTON. The same on a phone and a computer.
 *   the orb      a lime circle bottom-right, calm and silent. Once a visit
 *                it introduces itself in a bubble, then says nothing.
 *                TAP: voice on -- the microphone is asked for inside that
 *                tap, the ring moves with the customer's voice, replies are
 *                spoken and written in a caption beside the orb.
 *                TAP AGAIN: voice off, and the microphone is handed back.
 *                PRESS AND HOLD (or right-click, or the menu key): the chat.
 *   the chat     the transcript and a keyboard: a column down the right on
 *                a tablet or desktop, a sheet from the bottom on a phone
 *
 * NOTHING UNTIL ASKED. The first version asked for the microphone on the
 * first tap, and once it was allowed switched it on by itself on every later
 * page load, with a listening bar across the bottom of a phone. The ask was
 * the opposite: stay silent, introduce yourself, then wait to be tapped. So
 * voice is never on when a page loads, and nothing is spoken unless voice is.
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
 * writes down what was said. The reply is spoken by the assistant's own
 * voice (/ai/speak, a text-to-speech model) when the server has one, and by
 * the most natural voice this browser has when it does not -- the first
 * version always used the browser's default, and it was called "a robot".
 * While voice is on it listens continuously and sends each utterance when
 * the customer pauses; in the chat the microphone button is hold-to-talk.
 * Nothing is recorded while the assistant is speaking.
 *
 * LANGUAGE. English or Bangla: a switch in the chat head and on the
 * introduction, and
 * speaking or typing Bengali script switches it by itself. In Bangla the
 * browser's own speech recogniser hears the customer where there is one
 * (Chrome, Edge, Android) -- the server's voice model, measured on Bengali
 * clips, gets everyday sentences right but garbles short technical ones --
 * and the voice model is the fallback wherever that recogniser is missing
 * or fails.
 */
(function () {
  'use strict';

  if (window.__vesopaAI) return;
  window.__vesopaAI = true;

  var STORE_KEY = 'vesopa_ai_v1';
  var MAX_AUTO_HOPS = 6;
  var HOLD_MS = 520;                 // press and hold this long to open the chat
  var HELLO_KEY = 'vesopa_ai_hello'; // sessionStorage: introduced this visit
  var NEVER = /^\/(auth|admin\/auth|pay|api|webmail|panel\/terminal|panel\/files)(\/|$)/;

  // ---- State ------------------------------------------------------------
  var store = load();
  var session = { enabled: false, signedIn: false, name: '', token: '' };
  var state = 'idle';
  var shape = 'orb';        // orb | chat
  var live = false;         // voice on: listening, and replies spoken. Never on at load.
  var busy = false;
  var autoHops = 0;
  var pending = null;       // {ref, label, question}
  var refs = new Map();     // ref -> element, for the snapshot last sent
  var ui = {};
  var audio = { ctx: null, stream: null, node: null, src: null, chunks: [], speaking: false, above: 0, below: 0, floor: 0.004, ptt: false, talking: false };
  var voices = [];
  var speech = { gen: 0, source: null, current: null, noVoiceSaid: false };
  var ears = { rec: null, broken: false, misses: 0 };
  var MIC = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var s = raw ? JSON.parse(raw) : {};
      return {
        voice: s.voice !== false,          // speak replies while voice is on
        shape: s.shape === 'chat' ? 'chat' : 'orb',
        lang: s.lang === 'bn' || s.lang === 'en' ? s.lang : browserLang(),
        memory: Array.isArray(s.memory) ? s.memory.slice(-40) : [],
        history: Array.isArray(s.history) ? s.history.slice(-40) : [],
        seen: Boolean(s.seen),
        cont: Number(s.cont) || 0,         // a job in progress across a full page load
        hops: Number(s.hops) || 0,         // how many automatic turns that job has taken
      };
    } catch (e) {
      return { voice: true, shape: 'orb', lang: browserLang(), memory: [], history: [], seen: false, cont: 0, hops: 0 };
    }
  }
  function browserLang() { return /^bn/i.test(navigator.language || '') ? 'bn' : 'en'; }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* private mode */ }
  }
  function csrf() {
    var m = document.cookie.match(/(?:^|; )vh_csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function restState() { return live && (audio.node || ears.rec) ? 'listening' : 'idle'; }
  function enabledOnThisPage() {
    var b = document.body;
    if (!b || b.getAttribute('data-ai') !== '1') return false;
    return !/^\/admin(\/|$)/.test(window.location.pathname);
  }

  // ---- Words, in English and Bangla -------------------------------------------
  var WORDS = {
    en: {
      idle: 'Ready', listening: 'Listening…', hearing: 'Hearing you…', thinking: 'Thinking…', working: 'Working on the page…', speaking: 'Speaking',
      askingMic: 'Asking for the microphone…', letGo: 'Listening… let go to send',
      placeholder: 'Ask, or say what you want done…',
      hintVoice: 'Voice is on: talk whenever you like. Tap the ear to stop.',
      hintText: 'Type below, hold the microphone to talk, or tap the ear for voice. What you say goes to our AI service to be understood; the audio isn’t kept.',
      listeningNow: 'I’m listening. Tell me what you need, and tap me again to stop.',
      voiceOff: 'Voice off.',
      voicePaused: 'I’ve stopped listening. Tap me when you want to talk.',
      noMic: 'This browser can’t use the microphone here. Press and hold me to type instead.',
      micRefused: 'The microphone wasn’t allowed. Press and hold me to type instead, or allow it and tap me again.',
      noVoice: 'This browser has no Bangla voice, so I’ll write my answers here.',
      opening: 'Opening {v}', typing: 'Typing “{v}” into {l}', choosing: 'Choosing {v} for {l}', ticking: 'Ticking {l}', unticking: 'Unticking {l}', pressing: 'Pressing {l}',
      field: 'the field', list: 'the list', box: 'the box', button: 'the button',
      missing: 'Could not find {l} on this page any more.', noOption: 'That option is not in the list.', failed: 'That did not work: ',
      yes: 'Yes, go ahead', no: 'No', yesSaid: 'Yes, go ahead.', noSaid: 'No, don’t do that.', sayYesNo: ' Say yes or no.',
      lost: 'I lost the connection for a moment. Try again.', wrong: 'Something went wrong.',
      switched: 'Okay, I’ll speak English from now on.',
      langLabel: 'EN', langTitle: 'বাংলায় কথা বলুন — switch to Bangla', langAria: 'Language: English. Switch to Bangla',
      orbLabel: 'Vesopa AI. Tap to talk, tap again to stop. Press and hold to open the chat.',
      voiceToggle: 'Voice on or off',
      helloTitle: 'Hello, I’m Vesopa AI', helloTitleName: 'Hello {v}, I’m Vesopa AI',
      helloBody: 'I can help with domains, hosting, email and your website. Tap me to talk, tap again to stop, or press and hold to open the chat.',
      helloAgain: 'Hello again{v}', helloAgainBody: 'Tap me to talk, or press and hold to open the chat.',
      otherLang: 'বাংলা', openChat: 'Open chat', close: 'Close',
      chatHello: 'Hi, I’m Vesopa AI. Ask me about domains, hosting, email or your website — or tell me what you’d like done and I’ll do the clicking for you.',
    },
    bn: {
      idle: 'প্রস্তুত', listening: 'শুনছি…', hearing: 'শুনতে পাচ্ছি…', thinking: 'ভাবছি…', working: 'পেজে কাজ করছি…', speaking: 'বলছি',
      askingMic: 'মাইক্রোফোনের অনুমতি চাইছি…', letGo: 'শুনছি… ছেড়ে দিলে পাঠাব',
      placeholder: 'জিজ্ঞেস করুন, বা বলুন কী করতে চান…',
      hintVoice: 'ভয়েস চালু: যখন খুশি কথা বলুন। থামাতে কানের আইকনে চাপুন।',
      hintText: 'নিচে লিখুন, কথা বলতে মাইক্রোফোন চেপে ধরুন, বা ভয়েসের জন্য কানের আইকনে চাপুন। আপনি যা বলেন তা বোঝার জন্য আমাদের AI সার্ভিসে যায়; অডিও রাখা হয় না।',
      listeningNow: 'শুনছি। কী লাগবে বলুন — থামাতে আবার চাপুন।',
      voiceOff: 'ভয়েস বন্ধ।',
      voicePaused: 'আর শুনছি না। কথা বলতে চাইলে আমাকে চাপুন।',
      noMic: 'এই ব্রাউজারে মাইক্রোফোন চলে না। লিখতে চাইলে আমাকে চেপে ধরে রাখুন।',
      micRefused: 'মাইক্রোফোনের অনুমতি দেওয়া হয়নি। লিখতে চাইলে আমাকে চেপে ধরে রাখুন, অথবা অনুমতি দিয়ে আবার চাপুন।',
      noVoice: 'এই ব্রাউজারে বাংলা ভয়েস নেই, তাই উত্তরগুলো এখানে লিখে দিচ্ছি।',
      opening: '{v} খুলছি', typing: '{l}-এ “{v}” লিখছি', choosing: '{l}-এ {v} বেছে নিচ্ছি', ticking: '{l} টিক দিচ্ছি', unticking: '{l} থেকে টিক সরাচ্ছি', pressing: '{l} চাপছি',
      field: 'ঘরটি', list: 'তালিকা', box: 'বক্স', button: 'বোতাম',
      missing: 'এই পেজে {l} আর খুঁজে পাচ্ছি না।', noOption: 'এই অপশনটা তালিকায় নেই।', failed: 'এটা কাজ করেনি: ',
      yes: 'হ্যাঁ, করুন', no: 'না', yesSaid: 'হ্যাঁ, করুন।', noSaid: 'না, এটা করবেন না।', sayYesNo: ' হ্যাঁ বা না বলুন।',
      lost: 'এক মুহূর্তের জন্য সংযোগ চলে গিয়েছিল। আবার বলুন।', wrong: 'কিছু একটা সমস্যা হয়েছে।',
      switched: 'ঠিক আছে, এখন থেকে বাংলায় কথা বলব।',
      langLabel: 'বাং', langTitle: 'Switch to English — ইংরেজিতে কথা বলুন', langAria: 'ভাষা: বাংলা। Switch to English',
      orbLabel: 'Vesopa AI। কথা বলতে চাপুন, থামাতে আবার চাপুন। চ্যাট খুলতে চেপে ধরে রাখুন।',
      voiceToggle: 'ভয়েস চালু বা বন্ধ',
      helloTitle: 'হ্যালো, আমি Vesopa AI', helloTitleName: 'হ্যালো {v}, আমি Vesopa AI',
      helloBody: 'ডোমেইন, হোস্টিং, ইমেইল আর ওয়েবসাইট নিয়ে সাহায্য করতে পারি। কথা বলতে আমাকে চাপুন, থামাতে আবার চাপুন, আর চ্যাট খুলতে চেপে ধরে রাখুন।',
      helloAgain: 'আবার স্বাগতম{v}', helloAgainBody: 'কথা বলতে আমাকে চাপুন, চ্যাট খুলতে চেপে ধরে রাখুন।',
      otherLang: 'English', openChat: 'চ্যাট খুলুন', close: 'বন্ধ করুন',
      chatHello: 'হ্যালো, আমি Vesopa AI। ডোমেইন, হোস্টিং, ইমেইল বা ওয়েবসাইট নিয়ে জিজ্ঞেস করুন — অথবা কী করতে চান বলুন, ক্লিকের কাজগুলো আমি করে দেব।',
    },
  };
  /** A phrase in the current language; {v} is a value, {l} a label. */
  function T(key, v, l) {
    var table = WORDS[store.lang] || WORDS.en;
    var text = table[key] != null ? table[key] : WORDS.en[key];
    return String(text)
      .replace('{v}', function () { return v == null ? '' : String(v); })
      .replace('{l}', function () { return l == null ? '' : String(l); });
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
  };

  function build() {
    var root = document.createElement('div');
    root.id = 'vai';
    root.innerHTML =
      '<button class="vai-orb" type="button" data-state="idle" aria-pressed="false"><span class="vai-ring"></span><span class="vai-ring2"></span>' + ICON.spark + '<span class="vai-badge"></span></button>' +
      '<div class="vai-say" role="status" aria-live="polite" hidden><p class="vai-say-text"></p><div class="vai-say-row" hidden></div></div>' +
      '<div class="vai-cursor" aria-hidden="true"><i></i><span>AI</span></div>';
    document.documentElement.appendChild(root);
    ui.root = root;
    ui.orb = root.querySelector('.vai-orb');
    ui.say = root.querySelector('.vai-say');
    ui.sayText = root.querySelector('.vai-say-text');
    ui.sayRow = root.querySelector('.vai-say-row');
    ui.cursor = root.querySelector('.vai-cursor');
    orbGestures();
    ui.say.addEventListener('click', function (e) {
      var b = e.target.closest('[data-y]');
      if (b) { answerConfirm(b.getAttribute('data-y') === '1'); return; }
      expand(); // the caption opens the conversation it came from
    });
    syncLang();
  }

  /** Tap: voice on or off. Press and hold, right-click or the menu key: the chat. */
  function orbGestures() {
    var timer = null, down = false, held = false;
    var cancel = function () { clearTimeout(timer); timer = null; down = false; ui.orb.classList.remove('is-pressing'); };
    ui.orb.addEventListener('pointerdown', function (e) {
      if (e.button) return;
      held = false; down = true;
      ui.orb.classList.add('is-pressing');
      timer = setTimeout(function () {
        timer = null; held = true;
        ui.orb.classList.remove('is-pressing');
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (x) {} }
        expand();
      }, HOLD_MS);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (t) { ui.orb.addEventListener(t, cancel); });
    ui.orb.addEventListener('click', function (e) {
      if (held) { held = false; e.preventDefault(); return; }
      toggleVoice();
    });
    ui.orb.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (down) held = true; // a long touch on Android arrives as a context menu
      cancel();
      expand();
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
        '<button class="vai-ic vai-lang" type="button"></button>' +
        '<button class="vai-ic vai-t-live" type="button" aria-pressed="false">' + ICON.ear + '</button>' +
        '<button class="vai-ic vai-t-voice" type="button" title="Speak replies" aria-label="Speak replies" aria-pressed="false">' + ICON.speaker + '</button>' +
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
    ui.tLive = p.querySelector('.vai-t-live');
    ui.tVoice = p.querySelector('.vai-t-voice');
    ui.headLang = p.querySelector('.vai-lang');
    ui.headLang.addEventListener('click', toggleLang);

    p.querySelector('.vai-t-min').addEventListener('click', minimise);
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
    ui.tLive.addEventListener('click', toggleVoice);
    // Hold to talk, with or without voice on.
    var down = function (e) { e.preventDefault(); unlockSpeech(); pttStart(); };
    var up = function (e) { e.preventDefault(); pttStop(); };
    ui.mic.addEventListener('pointerdown', down);
    ui.mic.addEventListener('pointerup', up);
    ui.mic.addEventListener('pointercancel', up);
    ui.mic.addEventListener('pointerleave', function () { if (audio.ptt) pttStop(); });

    // The transcript so far.
    var hist = session.signedIn && session.history ? session.history : store.history;
    hist.slice(-16).forEach(function (m) { bubble(m.role === 'user' ? 'user' : 'ai', m.content, true); });
    syncLang();
  }

  function syncToggles() {
    if (ui.orb) {
      ui.orb.setAttribute('aria-pressed', live ? 'true' : 'false');
      ui.orb.setAttribute('aria-label', T('orbLabel'));
      ui.orb.title = T('orbLabel');
    }
    if (!ui.panel) return;
    ui.tVoice.setAttribute('aria-pressed', store.voice ? 'true' : 'false');
    ui.tVoice.classList.toggle('is-off', !store.voice);
    ui.tLive.setAttribute('aria-pressed', live ? 'true' : 'false');
    ui.tLive.classList.toggle('is-off', !live);
    ui.tLive.title = T('voiceToggle');
    ui.tLive.setAttribute('aria-label', T('voiceToggle'));
    ui.hint.textContent = live ? T('hintVoice') : T('hintText');
  }

  /** Everything that says which language it is in. */
  function syncLang() {
    if (ui.headLang) {
      ui.headLang.textContent = T('langLabel');
      ui.headLang.title = T('langTitle');
      ui.headLang.setAttribute('aria-label', T('langAria'));
    }
    ui.root.setAttribute('lang', store.lang === 'bn' ? 'bn' : 'en');
    if (ui.input) ui.input.placeholder = T('placeholder');
    syncToggles();
    fillHello();
    if (ui.orb) setState(state);
  }
  function toggleLang() {
    unlockSpeech();
    setLang(store.lang === 'bn' ? 'en' : 'bn', true);
  }
  /** Switch language; `announce` says so in the new one (out loud only while voice is on). */
  function setLang(next, announce) {
    next = next === 'bn' ? 'bn' : 'en';
    if (store.lang === next) return;
    store.lang = next; save();
    syncLang();
    // The other language may hear through the other ears.
    earsStop(true);
    if (live && !busy) startListening();
    if (announce) {
      var phrase = session.phrases && session.phrases[next];
      var line = phrase ? phrase.text : T('switched');
      bubble('ai', line); remember('assistant', line);
      speak(line, phrase ? [phrase] : null);
    }
  }

  function setState(next, label) {
    state = next;
    ui.orb.setAttribute('data-state', next);
    if (ui.panel) {
      ui.panel.setAttribute('data-state', next);
      ui.status.textContent = label || T(next) || '';
    }
  }

  // ---- Beside the orb: the introduction, and the caption -----------------------------
  /** Once a visit: hello and what the orb does, then quiet. */
  function introduce() {
    try {
      if (sessionStorage.getItem(HELLO_KEY)) return;
      sessionStorage.setItem(HELLO_KEY, '1');
    } catch (e) { /* no storage: introduce anyway */ }
    var first = !store.seen;
    store.seen = true; save();
    setTimeout(function () {
      if (shape !== 'orb' || live || busy || ui.hello) return;
      var h = document.createElement('div');
      h.className = 'vai-hello';
      h.setAttribute('role', 'status');
      h.innerHTML = '<button class="vai-hello-x" type="button">×</button><b class="vai-hello-title"></b><p class="vai-hello-text"></p>' +
        '<div class="vai-hello-row"><button class="vai-chip" type="button" data-h="lang"></button><button class="vai-chip" type="button" data-h="chat"></button></div>';
      h.vaiFirst = first;
      ui.root.appendChild(h);
      ui.hello = h;
      fillHello();
      h.addEventListener('click', function (e) {
        if (e.target.closest('.vai-hello-x')) { hideHello(); return; }
        var b = e.target.closest('[data-h]');
        if (!b) return;
        if (b.getAttribute('data-h') === 'lang') { setLang(store.lang === 'bn' ? 'en' : 'bn', false); holdHello(); return; }
        expand();
      });
      h.addEventListener('mouseenter', function () { clearTimeout(ui.helloTimer); });
      h.addEventListener('mouseleave', holdHello);
      holdHello();
    }, 1200);
  }
  function holdHello() {
    if (!ui.hello) return;
    clearTimeout(ui.helloTimer);
    ui.helloTimer = setTimeout(hideHello, ui.hello.vaiFirst ? 12000 : 7000);
  }
  function fillHello() {
    var h = ui.hello;
    if (!h) return;
    var name = session.name ? String(session.name).trim().split(/\s+/)[0] : '';
    h.querySelector('.vai-hello-title').textContent = h.vaiFirst
      ? (name ? T('helloTitleName', name) : T('helloTitle'))
      : T('helloAgain', name ? ', ' + name : '');
    h.querySelector('.vai-hello-text').textContent = h.vaiFirst ? T('helloBody') : T('helloAgainBody');
    h.querySelector('[data-h="lang"]').textContent = T('otherLang');
    h.querySelector('[data-h="chat"]').textContent = T('openChat');
    h.querySelector('.vai-hello-x').setAttribute('aria-label', T('close'));
  }
  function hideHello() {
    if (!ui.hello) return;
    clearTimeout(ui.helloTimer);
    var h = ui.hello;
    ui.hello = null;
    h.classList.add('is-leaving');
    setTimeout(function () { h.remove(); }, 260);
  }

  /** The caption beside the orb: what was heard, what it said, what it is doing. */
  function caption(text, ms) {
    if (!ui.say) return;
    if (!ui.sayRow.hidden) return; // a question is waiting for its answer
    clearTimeout(ui.sayTimer);
    if (!text || shape !== 'orb') { ui.say.hidden = true; return; }
    hideHello();
    ui.sayText.textContent = text;
    ui.say.hidden = false;
    ui.sayTimer = setTimeout(function () { ui.say.hidden = true; }, ms || Math.min(15000, 4000 + text.length * 60));
  }
  function captionAsk(question) {
    clearTimeout(ui.sayTimer);
    ui.sayText.textContent = question;
    ui.sayRow.innerHTML = '<button class="vai-btn lime" type="button" data-y="1"></button><button class="vai-btn" type="button" data-y="0"></button>';
    ui.sayRow.querySelector('[data-y="1"]').textContent = T('yes');
    ui.sayRow.querySelector('[data-y="0"]').textContent = T('no');
    ui.sayRow.hidden = false;
    ui.say.hidden = shape !== 'orb';
    if (shape === 'orb') hideHello();
  }
  function clearAsk() {
    ui.sayRow.hidden = true;
    ui.sayRow.innerHTML = '';
    var card = ui.body && ui.body.querySelector('.vai-confirm');
    if (card) card.remove();
  }
  function answerConfirm(yes) {
    clearAsk();
    ui.say.hidden = true;
    if (yes) confirmYes(); else confirmNo();
  }

  // ---- Shapes and voice -------------------------------------------------------------------
  function setShape(next) {
    shape = next;
    store.shape = next; save();
    ui.orb.hidden = next !== 'orb';
    if (ui.panel) ui.panel.hidden = next !== 'chat';
    if (next !== 'orb') { hideHello(); ui.say.hidden = true; ui.orb.classList.remove('has-news'); }
    else if (!ui.sayRow.hidden) ui.say.hidden = false;
  }
  function expand() {
    buildChat();
    setShape('chat');
    if (!ui.body.querySelector('.vai-msg')) bubble('ai', T('chatHello'), true);
    scrollBody();
    if (!live && !isTouch()) setTimeout(function () { ui.input.focus(); }, 60);
  }
  function minimise() { setShape('orb'); }

  function toggleVoice() {
    unlockSpeech();
    hideHello();
    if (live) { stopVoice(); caption(T('voiceOff'), 2200); return; }
    startVoice();
  }
  /** Voice on, from a tap: the tap is what lets the browser ask for the microphone. */
  function startVoice() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { caption(T('noMic'), 9000); return; }
    setState('idle', T('askingMic'));
    caption(T('askingMic'), 30000);
    navigator.mediaDevices.getUserMedia(MIC).then(function (stream) {
      live = true;
      audio.stream = stream;
      syncToggles();
      caption(T('listeningNow'));
      startListening();
      setState(restState());
    }).catch(function () {
      live = false;
      syncToggles();
      setState('idle');
      caption(T('micRefused'), 9000);
    });
  }
  /** Voice off: stop talking, stop listening, and give the microphone back. */
  function stopVoice() {
    live = false;
    stopSpeaking();
    earsStop(true);
    audio.ptt = false;
    releaseMic();
    audio.chunks = []; audio.talking = false;
    syncToggles();
    if (!busy) setState('idle');
  }

  // ---- Transcript -----------------------------------------------------------
  function bubble(kind, text, quiet) {
    buildChat();
    var el = document.createElement('div');
    el.className = 'vai-msg ' + kind;
    el.textContent = text;
    ui.body.appendChild(el);
    if (!quiet) scrollBody();
    if (quiet) return el;
    if (shape === 'orb' && kind === 'ai' && !live) ui.orb.classList.add('has-news');
    if (kind === 'ai' || kind === 'err' || kind === 'user') caption(text);
    return el;
  }
  function note(text) {
    var el = bubble('note', text, false);
    caption(text, 2600);
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
  function resumeAudio() {
    if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
    if (!live) return;
    if (usingBrowserEars()) { ears.misses = 0; resumeEars(); } else if (!audio.node) startListening();
  }

  /** Listening, through whichever ears this language uses. */
  function startListening() {
    if (!live && !audio.ptt) return;
    if (usingBrowserEars()) { releaseMic(); if (live) resumeEars(); return; }
    if (!audio.stream) { reacquireMic(); return; }
    if (audio.node) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audio.ctx = audio.ctx || new Ctx();
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
    audio.src = audio.ctx.createMediaStreamSource(audio.stream);
    audio.node = audio.ctx.createScriptProcessor(4096, 1, 1);
    audio.rate = audio.ctx.sampleRate;
    audio.chunks = []; audio.above = 0; audio.below = 0; audio.talking = false; audio.started = audio.ptt ? Date.now() : 0;
    audio.node.onaudioprocess = onAudio;
    audio.src.connect(audio.node);
    audio.node.connect(audio.ctx.destination);
    if (!busy && !audio.speaking) setState('listening');
  }
  function stopListening() {
    earsStop(true);
    if (audio.node) { try { audio.node.disconnect(); audio.src.disconnect(); } catch (e) {} }
    audio.node = null; audio.src = null; audio.chunks = []; audio.talking = false;
    if (state === 'listening') setState('idle');
  }
  /** Give the microphone back: on Android the browser's recogniser cannot have it while a stream holds it. */
  function releaseMic() {
    if (audio.node) { try { audio.node.disconnect(); audio.src.disconnect(); } catch (e) {} audio.node = null; audio.src = null; }
    if (audio.stream) { audio.stream.getTracks().forEach(function (t) { t.stop(); }); audio.stream = null; }
  }
  /** Take it again (already allowed, so no prompt), after Bangla gave it up. */
  function reacquireMic() {
    if (audio.acquiring || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    audio.acquiring = true;
    navigator.mediaDevices.getUserMedia(MIC).then(function (stream) {
      audio.acquiring = false;
      if (usingBrowserEars() || (!live && !audio.ptt)) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      audio.stream = stream;
      startListening();
    }, function () { audio.acquiring = false; });
  }

  // ---- Voice: hearing Bangla through the browser's own recogniser -----------------
  function Recogniser() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }
  function usingBrowserEars() { return (live || audio.ptt) && store.lang === 'bn' && !ears.broken && Boolean(Recogniser()); }
  function isTouch() { return window.matchMedia('(pointer: coarse)').matches; }

  /** One utterance: listen, show the words as they come, send when it ends. */
  function earsStart() {
    if (ears.rec || busy || audio.speaking || !usingBrowserEars()) return;
    var rec;
    try { rec = new (Recogniser())(); } catch (e) { ears.broken = true; startListening(); return; }
    rec.lang = 'bn-BD';
    rec.interimResults = true;
    rec.continuous = Boolean(audio.ptt);
    rec.maxAlternatives = 1;
    var heard = '';
    rec.onresult = function (e) {
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i += 1) {
        if (e.results[i].isFinal) heard += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
      }
      var line = (heard + ' ' + interim).trim();
      if (line) { caption(line); setState('listening', T('hearing')); }
    };
    rec.onerror = function (e) {
      // No Bangla here, no speech service, no microphone: the voice model hears instead.
      if (/^(not-allowed|service-not-allowed|language-not-supported|network|audio-capture|bad-grammar)$/.test(e.error)) ears.broken = true;
    };
    rec.onend = function () {
      if (ears.rec === rec) ears.rec = null;
      if (rec.vaiQuiet) return;
      var text = heard.trim();
      if (text) { ears.misses = 0; audio.ptt = false; if (ui.mic) ui.mic.classList.remove('is-live'); turn({ text: text, spoken: true }); return; }
      if (ears.broken) { startListening(); return; }
      ears.misses += 1;
      if (audio.ptt) return;
      // Every start can chime on a phone, so after a quiet spell voice goes
      // off and waits for the next tap.
      if (live && (!isTouch() || ears.misses < 2)) { setTimeout(earsStart, 250); return; }
      setState(restState());
      if (live) { stopVoice(); caption(T('voicePaused')); }
    };
    ears.rec = rec;
    try { rec.start(); setState('listening'); } catch (e) { ears.rec = null; }
  }
  /** Stop listening: `quiet` throws away what was heard, otherwise it is sent. */
  function earsStop(quiet) {
    var rec = ears.rec;
    if (!rec) return;
    ears.rec = null;
    rec.vaiQuiet = Boolean(quiet);
    try { if (quiet) rec.abort(); else rec.stop(); } catch (e) {}
  }
  /** Listening again after a reply, when nothing else is going on. */
  function resumeEars() {
    if (!live || busy || audio.speaking || state === 'working' || state === 'thinking') return;
    if (usingBrowserEars()) { releaseMic(); if (!ears.rec) earsStart(); }
    else if (!audio.node) startListening();
  }

  /** Voice activity: talk when it is clearly louder than the room, send on a pause. */
  function onAudio(e) {
    if (usingBrowserEars()) { audio.chunks = []; return; }
    var input = e.inputBuffer.getChannelData(0);
    var sum = 0;
    for (var i = 0; i < input.length; i += 1) sum += input[i] * input[i];
    var rms = Math.sqrt(sum / input.length);
    var frameMs = (input.length / audio.rate) * 1000;

    var canHear = audio.ptt || (live && !busy && !audio.speaking && state !== 'thinking' && state !== 'working');
    if (!canHear) { audio.chunks = []; audio.talking = false; return; }

    if (!audio.talking) audio.floor = audio.floor * 0.95 + rms * 0.05;
    var threshold = Math.max(0.012, audio.floor * 3.5);
    var loud = rms > threshold;
    var level = Math.min(1, rms / 0.12).toFixed(2);
    ui.orb.style.setProperty('--vai-level', level);
    if (state === 'idle' && live && !audio.ptt) setState('listening');

    if (audio.ptt) { audio.chunks.push(new Float32Array(input)); return; }

    if (!audio.talking) {
      if (loud) { audio.above += frameMs; if (audio.above > 120) { audio.talking = true; audio.started = Date.now(); audio.below = 0; setState('listening', T('hearing')); } }
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
    stopSpeaking();
    audio.ptt = true;
    ui.mic.classList.add('is-live');
    setState('listening', T('letGo'));
    if (usingBrowserEars()) { earsStop(true); earsStart(); return; }
    // No microphone yet: it is asked for now, and listens if still held when it arrives.
    if (!audio.stream) { reacquireMic(); return; }
    if (!audio.node) startListening();
    audio.chunks = []; audio.started = Date.now();
  }
  function pttStop() {
    if (!audio.ptt) return;
    ui.mic.classList.remove('is-live');
    if (usingBrowserEars()) { earsStop(false); audio.ptt = false; return; }
    audio.ptt = false;
    var chunks = audio.chunks; audio.chunks = [];
    if (Date.now() - audio.started >= 300) sendClip(chunks);
    else setState(restState());
    if (!live) releaseMic();
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
  /**
   * Inside a tap: wake the AudioContext the assistant's own voice plays
   * through, and (iOS) open the door for the browser's voices with an empty
   * utterance. Both only work from a gesture.
   */
  function unlockSpeech() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) { try { audio.ctx = audio.ctx || new Ctx(); if (audio.ctx.state === 'suspended') audio.ctx.resume(); } catch (e) {} }
    if (unlocked || !window.speechSynthesis) return;
    try { var u = new SpeechSynthesisUtterance(''); u.volume = 0; speechSynthesis.speak(u); unlocked = true; } catch (e) {}
  }

  /**
   * The most natural voice this browser has for a language. Names with
   * Natural, Neural, Online, Enhanced or Premium are the recorded-sounding
   * ones (Edge, Safari, Android); "Desktop" voices are the old robotic ones,
   * and the first version could land on those.
   */
  function pickVoice(lang) {
    if (!window.speechSynthesis) return null;
    voices = speechSynthesis.getVoices() || [];
    var best = null, bestScore = -1e9;
    for (var i = 0; i < voices.length; i += 1) {
      var v = voices[i], tag = String(v.lang || '').replace('_', '-'), name = String(v.name || '');
      if (lang === 'bn' ? !/^bn\b/i.test(tag) : !/^en\b/i.test(tag)) continue;
      var score = 0;
      if (/natural|neural|online|enhanced|premium|wavenet|studio|siri/i.test(name)) score += 60;
      if (/^google/i.test(name)) score += 30;
      if (/desktop|espeak|compact/i.test(name)) score -= 40;
      if (lang === 'bn' ? /^bn-BD$/i.test(tag) : /^en-GB$/i.test(tag)) score += 20;
      if (/Sonia|Libby|Maisie|Nabanita|Tanishaa|Serena|Kate|UK English Female/i.test(name)) score += 8;
      if (!v.localService) score += 3;
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }
  if (window.speechSynthesis) { speechSynthesis.onvoiceschanged = function () { voices = speechSynthesis.getVoices(); }; }

  /** The browser speaks it, a sentence at a time: natural pauses, and no cut-off on a long reply. */
  function speakBrowser(text, gen) {
    return new Promise(function (resolve) {
      if (!window.speechSynthesis || gen !== speech.gen) return resolve();
      var lang = /[\u0980-\u09FF]/.test(text) ? 'bn' : 'en';
      var v = pickVoice(lang);
      if (!v && lang === 'bn') {
        // An English voice reading Bengali script is noise, not speech.
        if (!speech.noVoiceSaid) { speech.noVoiceSaid = true; note(T('noVoice')); }
        return resolve();
      }
      var clean = text.replace(/https?:\/\/\S+/g, lang === 'bn' ? 'লিংক' : 'the link').replace(/\bns([12])\.vesopa\.com\b/g, 'N S $1 dot vesopa dot com');
      // Split after a full stop that ends a sentence, never inside example.co.uk.
      var parts = clean.replace(/([.!?।])\s+/g, '$1\n').split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      if (!parts.length) return resolve();
      var left = parts.length, done = false;
      var finish = function () { if (done) return; done = true; clearTimeout(guard); resolve(); };
      var guard = setTimeout(finish, Math.min(60000, 3000 + clean.length * 90));
      parts.forEach(function (part) {
        var u = new SpeechSynthesisUtterance(part);
        if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-GB';
        u.rate = lang === 'bn' ? 0.95 : 1;
        u.pitch = 1;
        u.onend = u.onerror = function () { left -= 1; if (left <= 0) setTimeout(finish, 150); };
        speechSynthesis.speak(u);
      });
    });
  }

  /** One signed line in the assistant's own voice, decoded and ready to play. */
  function fetchLine(line) {
    return fetch('/ai/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf(), 'x-ai-token': session.token || '' },
      credentials: 'same-origin',
      body: JSON.stringify({ text: line.text, lang: line.lang, sig: line.sig }),
    }).then(function (res) {
      if (!res.ok) throw new Error('voice ' + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      return new Promise(function (resolve, reject) {
        // Older Safari has only the callback form.
        var p = audio.ctx.decodeAudioData(buf, resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
    });
  }
  function playBuffer(buffer, gen) {
    return new Promise(function (resolve) {
      if (gen !== speech.gen) return resolve();
      var src = audio.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(audio.ctx.destination);
      speech.source = src;
      var over = false;
      var end = function () { if (over) return; over = true; if (speech.source === src) speech.source = null; resolve(); };
      src.onended = end;
      // A context that stalls never says it ended; the assistant must not stay deaf.
      setTimeout(end, buffer.duration * 1000 + 1500);
      src.start();
    });
  }
  /** Every line is fetched at once and played in order as it arrives, so the first sentence starts early. */
  async function speakServer(lines, gen) {
    var coming = lines.map(function (l) { return fetchLine(l).then(function (b) { return b; }, function () { return null; }); });
    for (var i = 0; i < lines.length; i += 1) {
      var buffer = await coming[i];
      if (gen !== speech.gen) return;
      if (buffer) { await playBuffer(buffer, gen); continue; }
      if (i === 0) throw new Error('no voice');
      await speakBrowser(lines.slice(i).map(function (l) { return l.text; }).join(' '), gen);
      return;
    }
  }
  function contextRunning() {
    if (!audio.ctx) return Promise.resolve(false);
    if (audio.ctx.state === 'running') return Promise.resolve(true);
    return Promise.race([
      audio.ctx.resume().then(function () { return audio.ctx.state === 'running'; }, function () { return false; }),
      sleep(300).then(function () { return false; }),
    ]);
  }

  /**
   * Say something. `lines` are the server's signed lines for the assistant's
   * own voice; without them, or if that voice fails, the browser says it.
   */
  function speak(text, lines) {
    stopSpeaking();
    if (!live || !store.voice || !text) return Promise.resolve();
    var gen = speech.gen;
    earsStop(true);
    audio.speaking = true; setState('speaking');
    var own = lines && lines.length && session.voice ? contextRunning() : Promise.resolve(false);
    speech.current = own.then(function (ready) {
      if (!ready) return speakBrowser(text, gen);
      return speakServer(lines, gen).catch(function () { return speakBrowser(text, gen); });
    }).then(function () {
      if (gen !== speech.gen) return;
      audio.speaking = false;
      if (state === 'speaking') setState(restState());
      resumeEars();
    });
    return speech.current;
  }
  function stopSpeaking() {
    speech.gen += 1;
    if (speech.source) { try { speech.source.stop(); } catch (e) {} speech.source = null; }
    if (window.speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
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
      if (!visible(el) || el.disabled && el.tagName !== 'BUTTON' || el.closest('[data-ai-private]')) continue;
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
    // A box marked data-ai-private (a database password shown once) is never
    // sent: the live evaluation found that page text would carry it to the model.
    var text = main.innerText || '';
    Array.prototype.forEach.call(main.querySelectorAll('[data-ai-private]'), function (box) {
      var secret = box.innerText || '';
      if (secret) text = text.split(secret).join(' [private] ');
    });
    text = text.replace(/\s+/g, ' ').trim().slice(0, 1800);
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
    if (action.type === 'open_site') {
      note(T('opening', action.url));
      // A reply arrives seconds after the tap, so a popup blocker may say no:
      // then the link is put in the chat for one tap.
      var tab = window.open(action.url, '_blank', 'noopener');
      if (!tab) {
        var row = bubble('ai', '', true);
        var a = document.createElement('a');
        a.href = action.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = action.url;
        row.appendChild(a);
        caption(action.url);
      }
      return sleep(300);
    }
    if (action.type === 'navigate') {
      note(T('opening', action.url));
      markContinuing();
      if (NEVER.test(action.url) || !window.VesopaNav) { window.location.assign(action.url); return sleep(1500); }
      window.VesopaNav.go(action.url, true);
      await waitForPage(8000);
      return sleep(300);
    }
    var el = refs.get(action.ref);
    if (!el || !document.contains(el)) { note(T('missing', null, action.label || action.ref)); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(250);
    pointAt(el); focusRing(el, true);
    await sleep(350);
    try {
      if (action.type === 'fill') {
        note(T('typing', action.value, action.label || T('field')));
        await typeInto(el, action.value);
      } else if (action.type === 'select') {
        note(T('choosing', action.value, action.label || T('list')));
        var want = String(action.value).toLowerCase();
        var found = false;
        for (var i = 0; i < el.options.length; i += 1) {
          var o = el.options[i];
          if (o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) { el.selectedIndex = i; found = true; break; }
        }
        if (!found) for (var j = 0; j < el.options.length; j += 1) { if (el.options[j].text.toLowerCase().indexOf(want) !== -1) { el.selectedIndex = j; found = true; break; } }
        fire(el, 'input'); fire(el, 'change');
        if (!found) note(T('noOption'));
      } else if (action.type === 'check') {
        note(T(action.checked ? 'ticking' : 'unticking', null, action.label || T('box')));
        if (el.checked !== action.checked) el.click();
      } else if (action.type === 'click') {
        note(T('pressing', null, action.label || T('button')));
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

  /** `ask` is how to put a confirmation: {said: the reply already asked it, text: that reply, lines: its signed voice lines}. */
  async function perform(actions, ask) {
    if (!actions || !actions.length) return;
    setState('working');
    for (var i = 0; i < actions.length; i += 1) {
      var a = actions[i];
      if (a.type === 'click' && a.confirm) { askConfirm(a, ask || {}); return; }
      try { await act(a); } catch (e) { note(T('failed') + (e && e.message ? e.message : e)); }
    }
  }

  function askConfirm(action, ask) {
    pending = { ref: action.ref, label: action.label, question: action.confirm };
    buildChat();
    var c = document.createElement('div');
    c.className = 'vai-card vai-confirm';
    c.innerHTML = '<p></p><div class="vai-row"><button class="vai-btn lime" type="button" data-y="1"></button><button class="vai-btn" type="button" data-y="0"></button></div>';
    c.querySelector('p').textContent = action.confirm;
    c.querySelector('[data-y="1"]').textContent = T('yes');
    c.querySelector('[data-y="0"]').textContent = T('no');
    ui.body.appendChild(c); scrollBody();
    captionAsk(ask.said && ask.text ? ask.text : action.confirm);
    c.addEventListener('click', function (e) {
      var b = e.target.closest('[data-y]');
      if (b) answerConfirm(b.getAttribute('data-y') === '1');
    });
    if (ask.said) { setState(restState()); return; }
    // After the reply has finished, not over the top of it.
    (speech.current || Promise.resolve()).then(function () { return speak(action.confirm, ask.lines); }).then(function () { if (state !== 'working') setState(restState()); });
  }
  async function confirmYes() {
    if (!pending) return;
    var p = pending; pending = null;
    bubble('user', T('yesSaid'));
    remember('user', T('yesSaid'));
    setState('working');
    await act({ type: 'click', ref: p.ref, label: p.label });
    autoHops = 0;
    turn({ auto: true });
  }
  function confirmNo() {
    if (!pending) return;
    pending = null;
    turn({ text: T('noSaid') });
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
    earsStop(true);
    var wasPending = pending;
    if (o.text || o.audio) {
      pending = null;
      autoHops = 0; store.hops = 0;
      clearAsk();
    }
    // Automatic turns are counted across page loads too, so a job that keeps
    // navigating cannot go round for ever after a reload resets autoHops.
    if (o.auto) {
      store.hops = (store.hops || 0) + 1; save();
      if (store.hops > MAX_AUTO_HOPS) { busy = false; clearContinuing(); setState(restState()); return; }
    }
    if (o.text) { bubble('user', o.text); remember('user', o.text); }
    if (o.text && /[\u0980-\u09FF]/.test(o.text)) setLang('bn', false);
    setState('thinking');
    typing(true);
    if (o.audio) caption('…', 30000);
    var payload = {
      text: o.text || '',
      audio: o.audio || null,
      auto: Boolean(o.auto),
      greet: Boolean(o.greet),
      voice: live && store.voice,
      lang: store.lang,
      spoken: Boolean(o.spoken),
      page: snapshot(),
      pending: (o.text || o.audio) && wasPending ? { ref: wasPending.ref, label: wasPending.label, question: wasPending.question } : null,
      local: session.signedIn ? null : { memory: store.memory, history: store.history.slice(-24) },
    };
    var out;
    try {
      out = await post('/ai/turn', payload);
    } catch (e) {
      out = { res: null, data: { error: T('lost') } };
    }
    typing(false);
    var res = out.res, data = out.data;
    if (!res || !res.ok || data.error) {
      bubble('err', data && data.error ? data.error : T('wrong'));
      busy = false; clearContinuing(); setState(restState()); resumeEars();
      return;
    }
    if (data.silence) { busy = false; setState(restState()); resumeEars(); return; }
    // The server heard or read Bengali: the switch follows it.
    if (data.lang) setLang(data.lang, false);
    if (data.heard) { bubble('user', data.heard); remember('user', data.heard); }
    if (Array.isArray(data.memory) && !session.signedIn) { store.memory = data.memory; save(); }
    if (data.say) { bubble('ai', data.say); remember('assistant', data.say); }

    var voiceLines = data.speak || {};
    var spoken = data.say ? speak(data.say, voiceLines.say) : Promise.resolve();
    busy = false;
    await perform(data.actions || [], { said: /[?？]\s*$/.test(data.say || ''), text: data.say, lines: voiceLines.ask });
    await spoken;
    if (data.pending) { if (state !== 'speaking') setState(restState()); resumeEars(); return; }
    if (data.done === false && autoHops < MAX_AUTO_HOPS) {
      autoHops += 1;
      await sleep(400);
      return turn({ auto: true });
    }
    autoHops = 0;
    clearContinuing();
    setState(restState());
    resumeEars();
  }

  // ---- Session --------------------------------------------------------------------
  async function refreshSession() {
    var res = await fetch('/ai/session', { credentials: 'same-origin' });
    var data = await res.json();
    session.enabled = Boolean(data.enabled);
    session.signedIn = Boolean(data.signed_in);
    session.name = data.name || '';
    session.token = data.token || '';
    session.voice = Boolean(data.voice);
    session.phrases = data.phrases || null;
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

    // Calm: no microphone, nothing spoken. A job that was mid-way across a
    // full page load carries on; otherwise it says hello once and waits.
    setState('idle');
    syncLang();
    if (store.cont && Date.now() - store.cont < 45000) {
      store.cont = 0; save();
      if (store.shape === 'chat') expand();
      setTimeout(function () { turn({ auto: true }); }, 900);
    } else {
      introduce();
    }

    window.addEventListener('vesopa:navigated', function () {
      if (!enabledOnThisPage()) { ui.root.hidden = true; return; }
      ui.root.hidden = false;
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && shape === 'chat') minimise(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
