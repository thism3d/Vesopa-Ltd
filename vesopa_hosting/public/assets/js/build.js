/**
 * Vesopa Studio — build a website by talking, and watch it happen.
 *
 * THE LOOP. The customer says (or types) what they want. POST /ai/build/turn
 * answers with a stream of events, and each one is applied the moment it
 * arrives: a theme repaints the page, a section appears and fills in while it
 * is still being written (outlined, and scrolled into view), a removal fades
 * out. The site is plain data -- {name, lang, theme, sections[{id, html}]} --
 * held here and in localStorage, and sent with every turn, so the server keeps
 * nothing and a reload loses nothing.
 *
 * THE PREVIEW is /build/frame: same-origin, no script allowed inside it, so
 * this file writes the site into it and listens for clicks on it. Each section
 * sits in a <div data-sec="id" style="display:contents">, which takes no room
 * in the layout (a sticky nav stays sticky) and gives every section a handle:
 * hover outlines it, a click selects it, and "change this" then means it.
 *
 * VOICE, calm like the orb: nothing listens until the microphone is tapped,
 * and replies are spoken only to somebody who spoke. English is written down
 * by the server's voice model (/ai/hear); Bangla by the browser's own
 * recogniser where there is one, the voice model otherwise.
 *
 * PUBLISHING is the customer's own button: a domain from their own account,
 * a tick to say they understand the current site is replaced (and kept in a
 * backup), then POST /ai/build/publish.
 */
(function () {
  'use strict';

  var root = document.querySelector('[data-studio]');
  if (!root) return;

  var STORE = 'vesopa_studio_v1';
  var DEVICE_WIDTH = { desktop: 1280, tablet: 820, phone: 390 };
  var $ = function (sel) { return root.querySelector(sel); };

  // ---- Words ----------------------------------------------------------------
  var WORDS = {
    en: {
      placeholder: 'Describe your website…', ready: 'Ready', listening: 'Listening…', hearing: 'Writing down what you said…', thinking: 'Thinking…', building: 'Building', speaking: 'Speaking',
      publish: 'Publish', editing: 'Editing', heroA: 'Say what you want.', heroB: 'Watch it build.', heroP: 'Tell us about your business in a sentence, out loud or typed. Your website appears here as it is written, and you change anything just by saying so.',
      untitled: 'Untitled website', savedHere: 'Saved in this browser', langBtn: 'বাংলা',
      stepTheme: 'Colours and fonts', stepSection: '{v}', stepRemove: 'Removed {v}', stepMove: 'Moved {v}', stepName: 'Named “{v}”',
      micDenied: 'The microphone was not allowed. You can type instead.', noMic: 'This browser cannot use the microphone here. You can type instead.',
      lost: 'The connection dropped while building. What was finished is kept: say it again to carry on.',
      newConfirm: 'Start a new website? This one stays in your undo history until you close the page.',
      suggestNew: ['Make it darker', 'Add opening hours', 'Add customer reviews', 'Change the colours to green', 'Add a photo gallery'],
      suggestStart: ['A bakery in Swansea', 'A barber shop, dark and modern', 'A photographer’s portfolio', 'A restaurant with a menu and booking form', 'A one-page site for my plumbing business'],
      hint: 'Tip: click any part of the preview, then say what to change about it.',
      pubTitle: 'Publish your website', pubSignIn: 'Sign in with your Vesopa account to publish. Your design is saved in this browser and will be here when you come back.', signIn: 'Sign in or create account', download: 'Download the page instead',
      pubNoHosting: 'Publishing needs a hosting plan with a website on it. Your design is saved here while you choose one.', seePlans: 'See hosting plans',
      pubNoDomains: 'There is no website on your account yet. Add a domain with hosting first, then publish from here.', addDomain: 'Add a domain',
      pubChoose: 'Choose where it goes live.', pubReplace: 'I understand this replaces what {v} shows now. The current website is moved to a backup folder, not deleted.', pubGo: 'Publish now', publishing: 'Publishing…',
      pubDone: 'Your website is live', open: 'Open it', close: 'Close', pubEmpty: 'Build something first — say what your business does.',
      openTitle: 'Open a published website', openNone: 'None of your websites were built here yet.', openBtn: 'Open', loading: 'Loading…',
      signInOpen: 'Sign in with your Vesopa account to open a website you have published.',
    },
    bn: {
      placeholder: 'আপনার ওয়েবসাইটের কথা বলুন…', ready: 'প্রস্তুত', listening: 'শুনছি…', hearing: 'আপনার কথা লিখে নিচ্ছি…', thinking: 'ভাবছি…', building: 'বানাচ্ছি', speaking: 'বলছি',
      publish: 'প্রকাশ করুন', editing: 'এডিট করছেন', heroA: 'যা চান বলুন।', heroB: 'চোখের সামনে তৈরি হবে।', heroP: 'এক বাক্যে আপনার ব্যবসার কথা বলুন — মুখে বা লিখে। লেখা হতে হতেই ওয়েবসাইটটা এখানে দেখা যাবে, আর যা বদলাতে চান শুধু বললেই হবে।',
      untitled: 'নামহীন ওয়েবসাইট', savedHere: 'এই ব্রাউজারে সেভ করা', langBtn: 'English',
      stepTheme: 'রং আর ফন্ট', stepSection: '{v}', stepRemove: '{v} সরানো হয়েছে', stepMove: '{v} সরিয়ে রাখা হয়েছে', stepName: 'নাম “{v}”',
      micDenied: 'মাইক্রোফোনের অনুমতি দেওয়া হয়নি। লিখেও বলতে পারেন।', noMic: 'এই ব্রাউজারে মাইক্রোফোন চলে না। লিখেও বলতে পারেন।',
      lost: 'বানানোর সময় সংযোগ চলে গেছে। যা শেষ হয়েছে তা রাখা আছে — আবার বললেই বাকিটা হবে।',
      newConfirm: 'নতুন ওয়েবসাইট শুরু করবেন? পেজ বন্ধ না করা পর্যন্ত এটা আনডু করে ফিরিয়ে আনা যাবে।',
      suggestNew: ['আরেকটু গাঢ় রং করুন', 'খোলার সময় যোগ করুন', 'রিভিউ সেকশন যোগ করুন', 'রং সবুজ করে দিন', 'ছবির গ্যালারি যোগ করুন'],
      suggestStart: ['ঢাকার একটি রেস্টুরেন্ট', 'একটি বেকারি, উজ্জ্বল রঙে', 'ফটোগ্রাফারের পোর্টফোলিও', 'মেনু আর বুকিং ফর্মসহ রেস্টুরেন্ট', 'আমার ব্যবসার এক পাতার ওয়েবসাইট'],
      hint: 'টিপস: প্রিভিউয়ের যেকোনো অংশে ক্লিক করুন, তারপর বলুন কী বদলাতে চান।',
      pubTitle: 'ওয়েবসাইট প্রকাশ করুন', pubSignIn: 'প্রকাশ করতে আপনার Vesopa অ্যাকাউন্টে সাইন ইন করুন। ডিজাইনটা এই ব্রাউজারে সেভ করা আছে, ফিরে এলেই পাবেন।', signIn: 'সাইন ইন করুন বা অ্যাকাউন্ট খুলুন', download: 'বরং পেজটা ডাউনলোড করুন',
      pubNoHosting: 'প্রকাশ করতে একটা হোস্টিং প্ল্যান লাগবে। প্ল্যান বাছাই করার সময় ডিজাইনটা এখানে সেভ থাকবে।', seePlans: 'হোস্টিং প্ল্যান দেখুন',
      pubNoDomains: 'আপনার অ্যাকাউন্টে এখনো কোনো ওয়েবসাইট নেই। আগে হোস্টিং সহ একটা ডোমেইন যোগ করুন।', addDomain: 'ডোমেইন যোগ করুন',
      pubChoose: 'কোথায় লাইভ হবে বেছে নিন।', pubReplace: 'আমি বুঝেছি, এটা {v}-এ এখন যা আছে তার জায়গা নেবে। আগের ওয়েবসাইট মুছে না গিয়ে একটা ব্যাকআপ ফোল্ডারে থাকবে।', pubGo: 'এখনই প্রকাশ করুন', publishing: 'প্রকাশ হচ্ছে…',
      pubDone: 'আপনার ওয়েবসাইট লাইভ', open: 'খুলে দেখুন', close: 'বন্ধ করুন', pubEmpty: 'আগে কিছু বানান — আপনার ব্যবসা কী করে বলুন।',
      openTitle: 'প্রকাশিত ওয়েবসাইট খুলুন', openNone: 'আপনার কোনো ওয়েবসাইট এখনো এখানে বানানো হয়নি।', openBtn: 'খুলুন', loading: 'লোড হচ্ছে…',
      signInOpen: 'প্রকাশিত ওয়েবসাইট খুলতে আপনার Vesopa অ্যাকাউন্টে সাইন ইন করুন।',
    },
  };
  function T(key, v) {
    var t = (WORDS[state.lang] || WORDS.en)[key];
    if (t == null) t = WORDS.en[key];
    return typeof t === 'string' ? t.replace('{v}', function () { return v == null ? '' : String(v); }) : t;
  }

  // ---- State ------------------------------------------------------------------------
  function blankSite() { return { v: 1, name: '', description: '', lang: 'en', theme: null, sections: [] }; }
  var saved = (function () {
    var s;
    try { s = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; }
    /*
     * HEAL A SITE THAT WAS SAVED HALF-WRITTEN.
     *
     * Filtering on the way out is not enough: somebody whose turn was cut off
     * already HAS the broken state in their browser, and without this they
     * would open Studio to a blank preview and no empty state for ever —
     * their own localStorage is not something they can be asked to clear.
     * Anything with no HTML is dropped as it comes back in, and if that
     * leaves nothing the site is simply new again, which is a screen they can
     * act on.
     */
    if (s.site && Array.isArray(s.site.sections)) {
      s.site.sections = s.site.sections.filter(function (sec) {
        return sec && typeof sec.html === 'string' && sec.html.trim() !== '';
      });
    }
    return s;
  }());
  var state = {
    site: saved.site && Array.isArray(saved.site.sections) ? saved.site : blankSite(),
    history: Array.isArray(saved.history) ? saved.history.slice(-30) : [],
    /*
     * Which language the studio opens in.
     *
     * Their own choice first -- the switch in the header writes `saved.lang`
     * and must outrank everything. Then the language the SITE is being read
     * in, which is the whole point of /bn: somebody who has chosen Bangla and
     * is reading a Bangla page should not be handed an English studio with
     * English example prompts. The browser's own language is the last resort,
     * for a visitor who has expressed no preference at all.
     */
    lang: (function () {
      if (saved.lang === 'bn' || saved.lang === 'en') return saved.lang;
      var site = root && root.getAttribute('data-site-lang');
      if (site === 'bn' || site === 'en') return site;
      return /^bn/i.test(navigator.language || '') ? 'bn' : 'en';
    }()),
    device: window.matchMedia('(max-width: 760px)').matches ? 'phone' : 'desktop',
    selected: null,
    busy: false,
    undo: [], redo: [],
    token: '', voice: false,
  };
  var frameDoc = null;
  var html = {};          // id -> the last finished html of that section
  var turn = null;        // the turn in flight: {partial: {id: previousHtml|null}, removed: {id: index}, steps}

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ site: state.site, history: state.history.slice(-30), lang: state.lang })); } catch (e) { /* private mode */ }
    $('[data-saved]').textContent = state.site.sections.length ? T('savedHere') : '';
  }
  function csrf() { var m = document.cookie.match(/(?:^|; )vh_csrf=([^;]*)/); return m ? decodeURIComponent(m[1]) : ''; }
  function headers() { return { 'content-type': 'application/json', 'x-csrf-token': csrf(), 'x-ai-token': state.token }; }
  async function refreshToken() {
    try { var r = await fetch('/ai/session', { credentials: 'same-origin' }); var d = await r.json(); state.token = d.token || ''; } catch (e) { /* the next call says so */ }
  }
  async function postJSON(path, body) {
    var res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: headers(), body: JSON.stringify(body) });
    if (res.status === 401) { await refreshToken(); res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: headers(), body: JSON.stringify(body) }); }
    return res;
  }

  // ---- The preview frame -----------------------------------------------------------------
  var iframe = $('[data-frame]');
  var viewport = $('[data-viewport]');
  var browser = $('[data-browser]');

  /*
   * The preview's own document, once it is really there.
   *
   * An iframe starts out holding an empty about:blank document that already
   * says readyState "complete" and has a body. Accepting that one drew the
   * whole site into a document /build/frame replaced a moment later: after a
   * reload the preview came up blank, and clicking it did nothing because the
   * handlers were on the discarded document too. Three reloads in five here,
   * with the sections and photos safely saved the whole time.
   */
  function frameReady() {
    return new Promise(function (resolve) {
      var check = function () {
        var d = iframe.contentDocument;
        if (d && d.URL !== 'about:blank' && d.readyState !== 'loading' && d.body) { frameDoc = d; resolve(d); return true; }
        return false;
      };
      if (check()) return;
      iframe.addEventListener('load', function onLoad() { if (check()) iframe.removeEventListener('load', onLoad); });
    });
  }

  function fontsHref(theme, lang) {
    var fams = [theme.fonts.heading, theme.fonts.body];
    if (lang === 'bn') fams.push('Noto Serif Bengali', 'Hind Siliguri');
    var seen = {};
    return 'https://fonts.googleapis.com/css2?' + fams.filter(function (f) { if (seen[f]) return false; seen[f] = 1; return true; })
      .map(function (f) { return 'family=' + encodeURIComponent(f).replace(/%20/g, '+') + ':wght@400;500;600;700'; }).join('&') + '&display=swap';
  }
  function applyTheme() {
    if (!frameDoc || !state.site.theme) return;
    var t = state.site.theme, c = t.colors, bn = state.site.lang === 'bn';
    var face = function (n, fb) { return '"' + n + '"' + (bn ? ', "' + fb + '"' : ''); };
    frameDoc.getElementById('vs-theme').textContent = ':root{--bg:' + c.bg + ';--surface:' + c.surface + ';--ink:' + c.ink + ';--muted:' + c.muted + ';--accent:' + c.accent + ';--accent-ink:' + c.accentInk + ';--soft:' + c.soft + ';--radius:' + t.radius + 'px;--font-h:' + face(t.fonts.heading, 'Noto Serif Bengali') + ';--font-b:' + face(t.fonts.body, 'Hind Siliguri') + '}';
    var link = frameDoc.getElementById('vs-fonts');
    var href = fontsHref(t, state.site.lang);
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    frameDoc.documentElement.setAttribute('lang', bn ? 'bn' : 'en-GB');
  }

  function wrapper(id) { return frameDoc ? frameDoc.body.querySelector(':scope > [data-sec="' + id + '"]') : null; }
  function makeWrapper(id) {
    var el = frameDoc.createElement('div');
    el.setAttribute('data-sec', id);
    el.style.display = 'contents';
    return el;
  }
  function sectionIndex(id) { for (var i = 0; i < state.site.sections.length; i += 1) if (state.site.sections[i].id === id) return i; return -1; }

  /** Where a section that is not on the page yet belongs. */
  function place(el, id, where) {
    var body = frameDoc.body;
    var m = /^(before|after):(.+)$/.exec(where || '');
    if (m) {
      var ref = wrapper(m[2]);
      if (ref) { if (m[1] === 'before') ref.before(el); else ref.after(el); return; }
    }
    if (where === 'start') { body.prepend(el); return; }
    // A replace of something removed earlier in this turn goes back where it was.
    if (turn && turn.removed[id] != null) {
      var kids = body.querySelectorAll(':scope > [data-sec]');
      var at = kids[turn.removed[id]];
      if (at) at.before(el); else body.appendChild(el);
      return;
    }
    if (id === 'nav') { body.prepend(el); return; }
    if (id === 'hero') { var nav = wrapper('nav'); if (nav) nav.after(el); else body.prepend(el); return; }
    var footer = wrapper('footer');
    if (id !== 'footer' && footer && where !== 'end') { footer.before(el); return; }
    body.appendChild(el);
  }

  function renderAll() {
    if (!frameDoc) return;
    applyTheme();
    frameDoc.body.innerHTML = '';
    html = {};
    state.site.sections.forEach(function (s) {
      var el = makeWrapper(s.id);
      el.innerHTML = s.html;
      frameDoc.body.appendChild(el);
      html[s.id] = s.html;
    });
    markSelected();
    syncChrome();
  }

  /**
   * A section that has an id but no HTML is not a section.
   *
   * `html[id] != null` used to be the whole test, and an empty string passes
   * it. A turn interrupted between `@section hero` and the HTML that follows
   * — a refresh, a dropped connection, a closed tab — therefore saved
   * `{id:'hero', html:''}` to localStorage. On the next load that section was
   * restored, drawn as an empty wrapper, and counted: the preview was blank
   * white, and because `sections.length` was 2 the "say what you want" empty
   * state stayed hidden. No content, no prompts, no way to begin again.
   * Reproduced on 2026-09-18 with exactly that saved state.
   *
   * So emptiness is the test, here and on restore, in both directions.
   */
  function isRealSection(h) { return typeof h === 'string' && h.trim() !== ''; }

  function syncOrder() {
    var order = Array.prototype.map.call(frameDoc.body.querySelectorAll(':scope > [data-sec]'), function (el) { return el.getAttribute('data-sec'); });
    state.site.sections = order
      .filter(function (id) { return isRealSection(html[id]); })
      .map(function (id) { return { id: id, html: html[id] }; });
  }

  function scrollToSection(el) {
    var first = el && el.firstElementChild;
    if (!first) return;
    var top = first.getBoundingClientRect().top + frameDoc.defaultView.scrollY - (id(el) === 'nav' ? 0 : 60);
    frameDoc.defaultView.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
  function id(el) { return el && el.getAttribute('data-sec'); }

  // ---- Fitting the frame to the device -------------------------------------------------------
  function fit() {
    var box = viewport.getBoundingClientRect();
    var phoneScreen = window.matchMedia('(max-width: 760px)').matches;
    var w = phoneScreen ? box.width : DEVICE_WIDTH[state.device];
    var scale = phoneScreen ? 1 : Math.min(1, box.width / w);
    iframe.style.width = w + 'px';
    iframe.style.height = Math.ceil(box.height / scale) + 'px';
    iframe.style.transform = scale < 1 ? 'scale(' + scale + ')' : '';
  }
  function setDevice(d) {
    state.device = d;
    browser.setAttribute('data-device', d);
    root.querySelectorAll('[data-device]').forEach(function (b) { if (b.tagName === 'BUTTON') b.setAttribute('aria-pressed', b.getAttribute('data-device') === d ? 'true' : 'false'); });
    setTimeout(fit, 20); setTimeout(fit, 480);
  }

  // ---- Selecting a section in the preview -----------------------------------------------------
  function bindFrame() {
    var hovered = null;
    frameDoc.addEventListener('mouseover', function (e) {
      if (state.busy) return;
      var w = e.target.closest && e.target.closest('[data-sec]');
      var el = w && w.firstElementChild;
      if (hovered && hovered !== el) hovered.classList.remove('vs-hover');
      hovered = el;
      if (el && !el.classList.contains('vs-selected')) el.classList.add('vs-hover');
    });
    frameDoc.addEventListener('mouseleave', function () { if (hovered) hovered.classList.remove('vs-hover'); hovered = null; });
    frameDoc.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a');
      if (a) e.preventDefault(); // the preview is for looking, not leaving
      var w = e.target.closest && e.target.closest('[data-sec]');
      if (!w || state.busy) return;
      select(id(w) === state.selected ? null : id(w));
    });
  }
  function select(sec) {
    state.selected = sec;
    markSelected();
    var box = $('[data-selected]');
    box.hidden = !sec;
    if (sec) { $('[data-selected-name]').textContent = sec; $('[data-input]').focus(); }
  }
  function markSelected() {
    if (!frameDoc) return;
    frameDoc.querySelectorAll('.vs-selected, .vs-hover').forEach(function (el) { el.classList.remove('vs-selected', 'vs-hover'); });
    var w = state.selected && wrapper(state.selected);
    if (w && w.firstElementChild) w.firstElementChild.classList.add('vs-selected');
    if (state.selected && !w) select(null);
  }

  // ---- The conversation rail --------------------------------------------------------------------
  var log = $('[data-log]');
  function bubble(kind, text) {
    var el = document.createElement('div');
    el.className = 'st-msg ' + kind;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function status(key, raw) {
    $('[data-status]').textContent = raw || T(key);
    $('.st-ai-mark').setAttribute('data-state', key === 'ready' ? 'idle' : key);
  }
  function stepsBox() {
    if (turn.stepsEl) return turn.stepsEl;
    turn.stepsEl = document.createElement('div');
    turn.stepsEl.className = 'st-steps';
    log.appendChild(turn.stepsEl);
    return turn.stepsEl;
  }
  function step(key, label, done, extra) {
    var box = stepsBox();
    var row = turn.steps[key];
    if (!row) {
      row = document.createElement('div');
      row.className = 'st-step';
      row.innerHTML = '<i></i><span></span>';
      box.appendChild(row);
      turn.steps[key] = row;
    }
    row.querySelector('span').textContent = label;
    if (extra) row.appendChild(extra);
    if (done === true) row.classList.add('is-done');
    if (done === 'gone') row.classList.add('is-gone');
    log.scrollTop = log.scrollHeight;
  }
  function prettyId(sid) { return sid.charAt(0).toUpperCase() + sid.slice(1).replace(/-/g, ' '); }

  /**
   * The chips under the conversation.
   *
   * WITH NOTHING BUILT YET they are examples of what to ask for, because an
   * empty rail beside an empty canvas gives a person nothing to push against
   * -- the owner's words were "no questions and answers". Once sections exist
   * they become the things worth changing next.
   */
  function suggestions() {
    var box = $('[data-suggest]');
    box.innerHTML = '';
    var list = state.site.sections.length ? T('suggestNew') : T('suggestStart');
    if (!list || !list.length) return;
    list.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = s;
      b.addEventListener('click', function () { send(s, false); });
      box.appendChild(b);
    });
  }

  function syncChrome() {
    var s = state.site;
    var empty = !s.sections.length;
    if (!state.busy) $('[data-empty]').hidden = !empty;
    $('[data-site-name]').textContent = s.name || T('untitled');
    var slug = (s.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 30);
    $('[data-url]').textContent = (slug || 'your-website') + '.co.uk';
    $('[data-undo]').disabled = !state.undo.length || state.busy;
    $('[data-redo]').disabled = !state.redo.length || state.busy;
    suggestions();
    save();
  }

  function syncLang() {
    root.setAttribute('lang', state.lang);
    $('[data-input]').placeholder = T('placeholder');
    $('[data-lang]').textContent = T('langBtn');
    root.querySelectorAll('[data-t]').forEach(function (el) { el.textContent = T(el.getAttribute('data-t')); });
    if (!state.busy) status('ready');
    syncChrome();
  }

  // ---- A turn -------------------------------------------------------------------------------------
  function snapshot() { return JSON.stringify(state.site); }

  async function send(text, spoken) {
    text = String(text || '').trim();
    if (!text || state.busy) return;
    if (/[ঀ-৿]/.test(text) && state.lang !== 'bn') { state.lang = 'bn'; syncLang(); }
    await frameReady();
    state.busy = true;
    state.voice = Boolean(spoken);
    stopSpeaking();
    bubble('user', text);
    state.history.push({ role: 'user', text: text });
    $('[data-input]').value = ''; autosize();
    $('[data-send]').disabled = true;
    status('thinking');
    state.undo.push(snapshot()); state.redo = [];
    if (state.undo.length > 40) state.undo.shift();
    turn = { partial: {}, removed: {}, steps: {}, stepsEl: null, say: '', ask: '', started: {}, completed: 0 };
    syncChrome();
    openSheet(false); // on a phone, get out of the way of the preview

    var body = {
      text: text, spoken: Boolean(spoken), lang: state.lang, selected: state.selected,
      site: state.site, history: state.history.slice(-11, -1),
    };
    var failed = null;
    try {
      var res = await postJSON('/ai/build/turn', body);
      if (!res.ok || !res.body) {
        var err = {}; try { err = await res.json(); } catch (e) {}
        failed = err.error || T('lost');
      } else {
        browser.classList.add('is-building');
        $('[data-live]').hidden = false;
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        for (;;) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          var i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            var block = buf.slice(0, i); buf = buf.slice(i + 2);
            var line = block.split('\n').filter(function (l) { return l.indexOf('data:') === 0; })[0];
            if (!line) continue;
            var ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
            if (ev.op === 'error') failed = ev.error;
            else enqueue(ev);
          }
        }
      }
    } catch (e) {
      failed = T('lost');
    }
    // The model finishes writing long before the page finishes showing it.
    await drained();
    finishTurn(failed);
  }

  /* ---- Pacing -------------------------------------------------------------
   * SECTIONS ARRIVE FASTER THAN ANYONE CAN WATCH THEM.
   *
   * The designer writes about 690 characters a second, so a whole site — nav,
   * hero, four or five bands, contact, footer — lands in a few seconds and the
   * customer sees a finished page appear more or less at once. The thing they
   * were promised is watching it being built, and the thing they need is a
   * moment to read each part and say "no, not that". Both were lost to raw
   * speed.
   *
   * So the stream is received as fast as it comes and APPLIED on a queue, with
   * a beat before each new section starts. The same reasoning as the setup
   * wizard's MIN_STEP_MS in provisioning.js: a checklist where every row
   * finishes in the same frame reads as "nothing happened".
   *
   * The pause is before a NEW section, never after the last one, so a
   * one-section edit — "make the hero green" — is as immediate as it ever was.
   * Nothing waits on a timer that the customer is not watching.
   */
  var SECTION_DWELL = 650;
  var queue = [];
  var draining = false;
  var drainWaiters = [];

  function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function enqueue(ev) { queue.push(ev); drain(); }

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      var ev = queue[0];
      var startsNewSection = ev.op === 'section' && !turn.started[ev.id];
      if (startsNewSection && turn.completed > 0) await pause(SECTION_DWELL);
      queue.shift();
      handle(ev);
    }
    draining = false;
    drainWaiters.splice(0).forEach(function (r) { r(); });
  }

  /** Resolves once everything received has actually been put on the page. */
  function drained() {
    if (!draining && !queue.length) return Promise.resolve();
    return new Promise(function (r) { drainWaiters.push(r); });
  }

  /* ---- Photographs --------------------------------------------------------
   * The designer marks a tile `data-photo="what is in the picture"`; this asks
   * /ai/build/photos for one and puts it in. The tile's emoji is what shows
   * until then and what stays if nothing comes back, so a section is never
   * blank while it waits and never broken if the library is down.
   *
   * The picture becomes part of the section's HTML — `html[id]` is read back
   * after it goes in — so it is saved, survives a reload, and is what gets
   * published. The URL is the library's own: hotlinking is a condition of the
   * Unsplash licence, and the credit link is the other one.
   */
  var photoRequests = {};   // section id -> true while its photos are on the way

  function orientationOf(tile) {
    if (tile.classList.contains('v-wide')) return 'landscape';
    if (tile.classList.contains('v-square')) return 'square';
    return tile.classList.contains('v-art') ? 'portrait' : 'landscape';
  }

  function plainText(node) {
    return String((node && node.textContent) || '').replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * What to search for when the designer did not say. It is told to mark every
   * tile, and mostly does, but it copies its templates closely: on the first
   * live florist every tile had a photograph except the "Our story" square,
   * whose template carried no data-photo, and that one kept its emoji. The
   * tile's own caption says best what is in it; failing that, the heading of
   * the section it illustrates.
   */
  function photoQueryOf(tile, wrap) {
    var own = (tile.getAttribute('data-photo') || '').trim();
    if (/\p{L}{3}/u.test(own)) return own;
    return plainText(tile.querySelector('figcaption'))
      || plainText(wrap.querySelector('h1, h2'))
      || plainText(tile.querySelector('.v-tag'));
  }

  async function resolvePhotos(sid) {
    if (!frameDoc || photoRequests[sid]) return;
    var wrap = wrapper(sid);
    if (!wrap) return;
    // Every art and photo tile, marked or not — but never one already holding
    // a picture, whether ours or an address the customer gave.
    var tiles = Array.prototype.filter.call(
      wrap.querySelectorAll('.v-art:not(.has-photo), .v-ph:not(.has-photo), [data-photo]:not(.has-photo)'),
      function (t) { return !t.querySelector('img'); });
    tiles.forEach(function (t) { t.setAttribute('data-photo', photoQueryOf(t, wrap)); });
    tiles = tiles.filter(function (t) { return t.getAttribute('data-photo'); });
    if (!tiles.length) return;
    // Nothing already on the page is offered twice.
    var exclude = Array.prototype.map.call(frameDoc.querySelectorAll('[data-photo-id]'), function (n) { return n.getAttribute('data-photo-id'); });
    photoRequests[sid] = true;
    var data = null;
    try {
      var res = await postJSON('/ai/build/photos', {
        wanted: tiles.map(function (t) { return { query: t.getAttribute('data-photo'), orientation: orientationOf(t) }; }),
        exclude: exclude,
      });
      data = res.ok ? await res.json() : null;
    } catch (e) { /* the emoji stays, which is a finished-looking tile */ }
    photoRequests[sid] = false;
    if (!data || !Array.isArray(data.photos)) return;

    // The section may have been rewritten or removed while we waited.
    wrap = wrapper(sid);
    if (!wrap) return;
    var placed = 0;
    data.photos.forEach(function (p, i) {
      var tile = tiles[i];
      if (!p || !tile || !wrap.contains(tile)) return;
      var img = frameDoc.createElement('img');
      img.src = p.url;
      img.alt = p.alt || '';
      img.loading = 'lazy';
      tile.insertBefore(img, tile.firstChild);
      tile.classList.add('has-photo');
      tile.setAttribute('data-photo-id', p.id);
      var credit = frameDoc.createElement('a');
      credit.className = 'v-credit';
      credit.href = p.creditUrl;
      credit.target = '_blank';
      credit.rel = 'noopener';
      credit.textContent = 'Photo: ' + p.credit + ' · ' + p.source;
      tile.appendChild(credit);
      placed += 1;
    });
    if (!placed) return;
    html[sid] = wrap.innerHTML;
    syncOrder();
    save();
  }

  /** Every section still waiting for a picture — after a reload, or after a library was busy. */
  function resolveAllPhotos() {
    state.site.sections.forEach(function (s) { resolvePhotos(s.id); });
  }

  function handle(ev) {
    if (ev.op === 'say') { turn.say = turn.say ? turn.say + ' ' + ev.text : ev.text; bubble('ai', ev.text); status('building', T('building') + '…'); return; }
    if (ev.op === 'ask') { turn.ask = ev.text; return; }
    if (ev.op === 'name') { state.site.name = ev.name; step('name', T('stepName', ev.name), true); syncChrome(); return; }
    if (ev.op === 'lang') { state.site.lang = ev.lang; applyTheme(); return; }
    if (ev.op === 'theme') {
      var first = !state.site.theme;
      state.site.theme = ev.theme;
      applyTheme();
      var sw = document.createElement('span'); sw.className = 'st-swatches';
      ['bg', 'accent', 'ink'].forEach(function (k) { var b = document.createElement('b'); b.style.background = ev.theme.colors[k]; sw.appendChild(b); });
      if (turn.steps.theme) turn.steps.theme.querySelectorAll('.st-swatches').forEach(function (x) { x.remove(); });
      step('theme', T('stepTheme'), true, sw);
      if (first) $('[data-empty]').hidden = true;
      return;
    }
    if (ev.op === 'remove') {
      var w = wrapper(ev.id);
      if (w) {
        turn.removed[ev.id] = Array.prototype.indexOf.call(frameDoc.body.querySelectorAll(':scope > [data-sec]'), w);
        w.remove();
        delete html[ev.id];
        syncOrder();
        step('rm-' + ev.id, T('stepRemove', prettyId(ev.id)), 'gone');
      }
      return;
    }
    if (ev.op === 'move') {
      var mv = wrapper(ev.id);
      if (!mv) return;
      mv.remove();
      place(mv, ev.id, ev.where);
      syncOrder();
      step('mv-' + ev.id, T('stepMove', prettyId(ev.id)), true);
      scrollToSection(mv);
      return;
    }
    if (ev.op === 'section') {
      var el = wrapper(ev.id);
      if (!turn.started[ev.id]) {
        turn.started[ev.id] = true;
        if (!(ev.id in turn.partial)) turn.partial[ev.id] = html[ev.id] != null ? html[ev.id] : null;
        if (el && ev.where !== 'replace') { el.remove(); place(el, ev.id, ev.where); }
        if (!el) { el = makeWrapper(ev.id); place(el, ev.id, ev.where); }
        $('[data-empty]').hidden = true; // the building is the thing to watch
        step('s-' + ev.id, prettyId(ev.id), false);
        status('building', T('building') + ' ' + prettyId(ev.id).toLowerCase() + '…');
      }
      if (ev.html || ev.final) el.innerHTML = ev.html;
      var node = el.firstElementChild;
      if (node && !ev.final) {
        node.classList.add('vs-writing');
        if (!turn.scrolled || turn.scrolled !== ev.id) { turn.scrolled = ev.id; scrollToSection(el); }
      }
      if (ev.final) {
        html[ev.id] = ev.html;
        turn.completed += 1;
        delete turn.partial[ev.id];
        if (node) { node.classList.remove('vs-writing'); node.classList.add('vs-born'); }
        syncOrder();
        step('s-' + ev.id, prettyId(ev.id), true);
        syncChrome();
        resolvePhotos(ev.id);
      }
    }
  }

  function finishTurn(failed) {
    // A section cut off half-way goes back to how it was.
    Object.keys(turn.partial || {}).forEach(function (sid) {
      var w = wrapper(sid), prev = turn.partial[sid];
      if (prev == null) { if (w) w.remove(); }
      else if (w) w.innerHTML = prev;
    });
    if (frameDoc) frameDoc.querySelectorAll('.vs-writing').forEach(function (n) { n.classList.remove('vs-writing'); });
    syncOrder();
    browser.classList.remove('is-building');
    $('[data-live]').hidden = true;
    if (failed) bubble('err', failed);
    if (turn.ask) bubble('ai', turn.ask);
    var said = [turn.say, turn.ask].filter(Boolean).join(' ');
    if (said) state.history.push({ role: 'ai', text: said });
    if (snapshot() === state.undo[state.undo.length - 1]) state.undo.pop();
    state.busy = false;
    $('[data-send]').disabled = false;
    markSelected();
    syncChrome();
    status('ready');
    if (state.voice && said) speak(said);
    if (!failed && state.site.sections.length && firstTime('hint')) bubble('hint', T('hint'));
    turn = null;
  }
  /** True the first time `what` is asked about in this browser. */
  function firstTime(what) {
    try {
      if (localStorage.getItem(STORE + '_' + what)) return false;
      localStorage.setItem(STORE + '_' + what, '1');
      return true;
    } catch (e) { return false; }
  }

  function undo() {
    if (!state.undo.length || state.busy) return;
    state.redo.push(snapshot());
    state.site = JSON.parse(state.undo.pop());
    renderAll();
  }
  function redo() {
    if (!state.redo.length || state.busy) return;
    state.undo.push(snapshot());
    state.site = JSON.parse(state.redo.pop());
    renderAll();
  }

  // ---- Voice: hearing -------------------------------------------------------------------------------
  var mic = { stream: null, ctx: null, node: null, src: null, chunks: [], rate: 48000, talking: false, above: 0, below: 0, floor: 0.004, started: 0, rec: null, on: false };
  var micBtn = $('[data-mic]');
  var bigMic = $('[data-bigmic]');

  function setMicUi(on) {
    mic.on = on;
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    bigMic.classList.toggle('is-live', on);
    if (on) status('listening'); else if (!state.busy) status('ready');
  }
  function Recogniser() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }

  function toggleMic() {
    if (state.busy) return;
    unlockSpeech();
    if (mic.on) { stopMic(true); return; }
    if (state.lang === 'bn' && Recogniser() && !mic.srBroken) { startRecogniser(); return; }
    startRecorder();
  }

  function startRecogniser() {
    var rec;
    try { rec = new (Recogniser())(); } catch (e) { mic.srBroken = true; startRecorder(); return; }
    rec.lang = 'bn-BD'; rec.interimResults = true; rec.continuous = false;
    var heard = '';
    var input = $('[data-input]');
    rec.onresult = function (e) {
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i += 1) {
        if (e.results[i].isFinal) heard += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
      }
      input.value = (heard + ' ' + interim).trim(); autosize();
    };
    rec.onerror = function (e) { if (/^(not-allowed|service-not-allowed|language-not-supported|network|audio-capture)$/.test(e.error)) mic.srBroken = true; };
    rec.onend = function () {
      mic.rec = null;
      setMicUi(false);
      if (heard.trim()) { send(heard, true); return; }
      if (mic.srBroken) startRecorder();
    };
    mic.rec = rec;
    try { rec.start(); setMicUi(true); } catch (e) { mic.rec = null; mic.srBroken = true; startRecorder(); }
  }

  function startRecorder() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { bubble('err', T('noMic')); return; }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (stream) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      mic.stream = stream;
      mic.ctx = mic.ctx || new Ctx();
      if (mic.ctx.state === 'suspended') mic.ctx.resume();
      mic.src = mic.ctx.createMediaStreamSource(stream);
      mic.node = mic.ctx.createScriptProcessor(4096, 1, 1);
      mic.rate = mic.ctx.sampleRate;
      mic.chunks = []; mic.talking = false; mic.above = 0; mic.below = 0; mic.started = Date.now();
      mic.node.onaudioprocess = onAudio;
      mic.src.connect(mic.node); mic.node.connect(mic.ctx.destination);
      setMicUi(true);
    }).catch(function () { bubble('err', T('micDenied')); setMicUi(false); });
  }

  /** Listen until they pause after speaking, or 25 seconds. */
  function onAudio(e) {
    var input = e.inputBuffer.getChannelData(0);
    var sum = 0;
    for (var i = 0; i < input.length; i += 1) sum += input[i] * input[i];
    var rms = Math.sqrt(sum / input.length);
    var ms = (input.length / mic.rate) * 1000;
    micBtn.style.setProperty('--st-level', Math.min(1, rms / 0.1).toFixed(2));
    if (!mic.talking) mic.floor = mic.floor * 0.95 + rms * 0.05;
    var loud = rms > Math.max(0.012, mic.floor * 3.5);
    mic.chunks.push(new Float32Array(input));
    if (!mic.talking) {
      if (loud) { mic.above += ms; if (mic.above > 120) mic.talking = true; } else { mic.above = 0; if (mic.chunks.length > 6) mic.chunks.shift(); }
      if (Date.now() - mic.started > 12000) stopMic(false); // nothing said
      return;
    }
    if (loud) mic.below = 0; else mic.below += ms;
    if (mic.below > 1100 || Date.now() - mic.started > 25000) stopMic(true);
  }

  function stopMic(sendIt) {
    if (mic.rec) { try { if (sendIt) mic.rec.stop(); else mic.rec.abort(); } catch (e) {} return; }
    var chunks = mic.chunks, talked = mic.talking;
    if (mic.node) { try { mic.node.disconnect(); mic.src.disconnect(); } catch (e) {} }
    if (mic.stream) mic.stream.getTracks().forEach(function (t) { t.stop(); });
    mic.node = null; mic.src = null; mic.stream = null; mic.chunks = []; mic.talking = false;
    micBtn.style.setProperty('--st-level', 0);
    setMicUi(false);
    if (sendIt && talked && chunks.length) hear(chunks);
  }

  async function hear(chunks) {
    var wav = toWav16k(chunks, mic.rate);
    if (!wav) return;
    status('hearing');
    try {
      var res = await postJSON('/ai/hear', { audio: { data: wav, format: 'wav' }, lang: state.lang });
      var data = await res.json();
      if (!res.ok) { bubble('err', data.error || T('lost')); status('ready'); return; }
      if (data.text) send(data.text, true); else status('ready');
    } catch (e) { bubble('err', T('lost')); status('ready'); }
  }

  function toWav16k(chunks, rate) {
    var total = 0, i;
    for (i = 0; i < chunks.length; i += 1) total += chunks[i].length;
    if (!total) return null;
    var joined = new Float32Array(total), off = 0;
    for (i = 0; i < chunks.length; i += 1) { joined.set(chunks[i], off); off += chunks[i].length; }
    var ratio = rate / 16000, outLen = Math.floor(joined.length / ratio), pcm = new Int16Array(outLen);
    for (var k = 0; k < outLen; k += 1) {
      var a = Math.floor(k * ratio), b = Math.min(joined.length, Math.floor((k + 1) * ratio)), s = 0, n = 0;
      for (var m = a; m < b; m += 1) { s += joined[m]; n += 1; }
      pcm[k] = Math.max(-1, Math.min(1, n ? s / n : 0)) * 0x7fff;
    }
    var buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
    var w = function (o, str) { for (var q = 0; q < str.length; q += 1) dv.setUint8(o + q, str.charCodeAt(q)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true);
    dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    var bytes = new Uint8Array(buf), bin = '';
    for (var x = 0; x < bytes.length; x += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(x, x + 0x8000));
    return btoa(bin);
  }

  // ---- Voice: speaking, only to somebody who spoke ------------------------------------------------------
  var unlocked = false;
  function unlockSpeech() {
    if (unlocked || !window.speechSynthesis) return;
    try { var u = new SpeechSynthesisUtterance(''); u.volume = 0; speechSynthesis.speak(u); unlocked = true; } catch (e) {}
  }
  function pickVoice(lang) {
    var list = (window.speechSynthesis && speechSynthesis.getVoices()) || [], best = null, bestScore = -1e9;
    list.forEach(function (v) {
      var tag = String(v.lang || '').replace('_', '-'), name = String(v.name || '');
      if (lang === 'bn' ? !/^bn\b/i.test(tag) : !/^en\b/i.test(tag)) return;
      var sc = 0;
      if (/natural|neural|online|enhanced|premium|siri/i.test(name)) sc += 60;
      if (/^google/i.test(name)) sc += 30;
      if (/desktop|espeak|compact/i.test(name)) sc -= 40;
      if (lang === 'bn' ? /^bn-BD$/i.test(tag) : /^en-GB$/i.test(tag)) sc += 20;
      if (sc > bestScore) { best = v; bestScore = sc; }
    });
    return best;
  }
  function speak(text) {
    if (!window.speechSynthesis) return;
    var lang = /[ঀ-৿]/.test(text) ? 'bn' : 'en';
    var v = pickVoice(lang);
    if (!v && lang === 'bn') return;
    stopSpeaking();
    status('speaking');
    var parts = text.replace(/([.!?।])\s+/g, '$1\n').split('\n').filter(Boolean), left = parts.length;
    parts.forEach(function (p) {
      var u = new SpeechSynthesisUtterance(p);
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = lang === 'bn' ? 0.95 : 1;
      u.onend = u.onerror = function () { left -= 1; if (left <= 0 && !state.busy && !mic.on) status('ready'); };
      speechSynthesis.speak(u);
    });
  }
  function stopSpeaking() { if (window.speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel(); }

  // ---- Publishing, opening, downloading ------------------------------------------------------------------
  var modal = $('[data-modal]');
  function openModal(markup) {
    $('[data-modal-body]').innerHTML = markup;
    modal.hidden = false;
    var focus = modal.querySelector('input, .st-btn.lime, .st-btn');
    if (focus) setTimeout(function () { focus.focus(); }, 30);
  }
  function closeModal() { modal.hidden = true; $('[data-modal-body]').innerHTML = ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  async function download() {
    if (!state.site.sections.length) { openModal('<h2>' + esc(T('pubTitle')) + '</h2><p>' + esc(T('pubEmpty')) + '</p>'); return; }
    var res = await postJSON('/ai/build/render', { site: state.site });
    if (!res.ok) return;
    var blob = new Blob([await res.text()], { type: 'text/html' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ((state.site.name || 'website').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'website') + '.html';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  async function publishFlow() {
    if (!state.site.sections.length) { openModal('<h2>' + esc(T('pubTitle')) + '</h2><p>' + esc(T('pubEmpty')) + '</p>'); return; }
    openModal('<h2>' + esc(T('pubTitle')) + '</h2><p>' + esc(T('loading')) + '</p>');
    var data = {};
    try { data = await (await fetch('/ai/build/domains', { credentials: 'same-origin' })).json(); } catch (e) {}
    var head = '<h2>' + esc(T('pubTitle')) + '</h2>';
    var dl = '<button type="button" class="st-btn" data-dl>' + esc(T('download')) + '</button>';
    if (!data.signedIn) {
      openModal(head + '<p>' + esc(T('pubSignIn')) + '</p><div class="st-row"><a class="st-btn lime" href="/login?next=%2Fbuild">' + esc(T('signIn')) + '</a>' + dl + '</div>');
    } else if (!data.hosting) {
      openModal(head + '<p>' + esc(T('pubNoHosting')) + '</p><div class="st-row"><a class="st-btn lime" href="/hosting">' + esc(T('seePlans')) + '</a>' + dl + '</div>');
    } else if (!data.domains.length) {
      openModal(head + '<p>' + esc(T('pubNoDomains')) + '</p><div class="st-row"><a class="st-btn lime" href="/panel/domains/add">' + esc(T('addDomain')) + '</a>' + dl + '</div>');
    } else {
      var list = data.domains.map(function (d, i) {
        return '<label class="st-domain"><input type="radio" name="st-domain" value="' + esc(d.domain) + '"' + (i === 0 ? ' checked' : '') + '><span><b>' + esc(d.domain) + '</b><small>https://' + esc(d.domain) + '</small></span></label>';
      }).join('');
      openModal(head + '<p>' + esc(T('pubChoose')) + '</p><div class="st-domains">' + list + '</div>' +
        '<label class="st-check"><input type="checkbox" data-agree><span data-agree-text></span></label>' +
        '<div class="st-row"><button type="button" class="st-btn lime" data-go disabled>' + esc(T('pubGo')) + '</button>' + dl + '</div>');
      var agreeText = function () {
        var d = modal.querySelector('input[name="st-domain"]:checked');
        modal.querySelector('[data-agree-text]').textContent = T('pubReplace', d ? d.value : '');
      };
      agreeText();
      modal.querySelectorAll('input[name="st-domain"]').forEach(function (r) { r.addEventListener('change', function () { agreeText(); modal.querySelector('[data-agree]').checked = false; modal.querySelector('[data-go]').disabled = true; }); });
      modal.querySelector('[data-agree]').addEventListener('change', function (e) { modal.querySelector('[data-go]').disabled = !e.target.checked; });
      modal.querySelector('[data-go]').addEventListener('click', doPublish);
    }
    var dlb = modal.querySelector('[data-dl]');
    if (dlb) dlb.addEventListener('click', download);
  }

  async function doPublish() {
    var go = modal.querySelector('[data-go]');
    var picked = modal.querySelector('input[name="st-domain"]:checked');
    if (!picked || !modal.querySelector('[data-agree]').checked) return;
    go.disabled = true; go.textContent = T('publishing');
    var res, data = {};
    try { res = await postJSON('/ai/build/publish', { domain: picked.value, site: state.site, confirm: true, lang: state.lang }); data = await res.json(); } catch (e) { data = { error: T('lost') }; }
    if (!res || !res.ok) {
      go.disabled = false; go.textContent = T('pubGo');
      var p = modal.querySelector('.st-msg.err') || document.createElement('p');
      p.className = 'st-msg err'; p.textContent = data.error || T('lost');
      modal.querySelector('.st-row').before(p);
      return;
    }
    openModal('<div class="st-done"><div class="st-big"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg></div>' +
      '<h2>' + esc(T('pubDone')) + '</h2><a class="st-liveurl" href="' + esc(data.url) + '" target="_blank" rel="noopener">' + esc(data.url) + '</a>' +
      '<div class="st-row" style="justify-content:center"><a class="st-btn lime" href="' + esc(data.url) + '" target="_blank" rel="noopener">' + esc(T('open')) + '</a><button type="button" class="st-btn" data-modal-close>' + esc(T('close')) + '</button></div></div>');
    state.site.publishedTo = data.domain;
    save();
  }

  async function openFlow() {
    var head = '<h2>' + esc(T('openTitle')) + '</h2>';
    openModal(head + '<p>' + esc(T('loading')) + '</p>');
    var data = {};
    try { data = await (await fetch('/ai/build/domains', { credentials: 'same-origin' })).json(); } catch (e) {}
    if (!data.signedIn) { openModal(head + '<p>' + esc(T('signInOpen')) + '</p><div class="st-row"><a class="st-btn lime" href="/login?next=%2Fbuild">' + esc(T('signIn')) + '</a></div>'); return; }
    var found = [];
    await Promise.all((data.domains || []).map(async function (d) {
      try {
        var r = await fetch('/ai/build/source?domain=' + encodeURIComponent(d.domain), { credentials: 'same-origin' });
        if (r.ok) found.push({ domain: d.domain, site: (await r.json()).site });
      } catch (e) {}
    }));
    if (!found.length) { openModal(head + '<p>' + esc(T('openNone')) + '</p>'); return; }
    openModal(head + '<div class="st-domains">' + found.map(function (f, i) {
      return '<div class="st-domain"><span style="flex:1"><b>' + esc(f.site.name || f.domain) + '</b><small>' + esc(f.domain) + '</small></span><button type="button" class="st-btn" data-open="' + i + '">' + esc(T('openBtn')) + '</button></div>';
    }).join('') + '</div>');
    modal.querySelectorAll('[data-open]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.undo.push(snapshot()); state.redo = [];
        state.site = found[Number(b.getAttribute('data-open'))].site;
        closeModal(); renderAll();
      });
    });
  }

  // ---- The phone's sheet ------------------------------------------------------------------------------------
  var rail = $('[data-rail]');
  function openSheet(open) {
    if (!window.matchMedia('(max-width: 760px)').matches) return;
    rail.classList.toggle('is-open', open);
  }

  // ---- Wiring ---------------------------------------------------------------------------------------------------
  var input = $('[data-input]');
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value, false); } });
  input.addEventListener('focus', function () { openSheet(true); });
  $('[data-send]').addEventListener('click', function () { send(input.value, false); });
  micBtn.addEventListener('click', toggleMic);
  bigMic.addEventListener('click', toggleMic);
  $('[data-ideas]').addEventListener('click', function (e) { var b = e.target.closest('[data-idea]'); if (b) send(b.getAttribute('data-idea'), false); });
  $('[data-unselect]').addEventListener('click', function () { select(null); });
  $('[data-undo]').addEventListener('click', undo);
  $('[data-redo]').addEventListener('click', redo);
  $('[data-publish]').addEventListener('click', publishFlow);
  $('[data-lang]').addEventListener('click', function () { state.lang = state.lang === 'bn' ? 'en' : 'bn'; syncLang(); });
  $('[data-grab]').addEventListener('click', function () { openSheet(!rail.classList.contains('is-open')); });
  root.querySelectorAll('button[data-device]').forEach(function (b) { b.addEventListener('click', function () { setDevice(b.getAttribute('data-device')); }); });
  var menuBtn = $('[data-menu]'), menuList = $('[data-menu-list]');
  menuBtn.addEventListener('click', function () { menuList.hidden = !menuList.hidden; menuBtn.setAttribute('aria-expanded', String(!menuList.hidden)); });
  document.addEventListener('click', function (e) { if (!e.target.closest('.st-menu-wrap')) { menuList.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); } });
  menuList.addEventListener('click', function (e) {
    var b = e.target.closest('[data-action]'); if (!b) return;
    menuList.hidden = true;
    var a = b.getAttribute('data-action');
    if (a === 'new' && state.site.sections.length && window.confirm(T('newConfirm'))) { state.undo.push(snapshot()); state.site = blankSite(); select(null); renderAll(); }
    if (a === 'open') openFlow();
    if (a === 'download') download();
  });
  modal.addEventListener('click', function (e) { if (e.target === modal || e.target.closest('[data-modal-close]')) closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (!modal.hidden) closeModal(); else if (state.selected) select(null); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && document.activeElement !== input) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  });
  window.addEventListener('resize', fit);

  // ---- Boot ---------------------------------------------------------------------------------------------------------
  (async function boot() {
    syncLang();
    setDevice(state.device);
    var token = refreshToken();
    await frameReady();
    bindFrame();
    renderAll();
    // After the token, not before: sent without one, every section's request
    // came back 401 and went again, two round trips each on every reload.
    token.then(resolveAllPhotos);
    // If the frame's document is ever swapped for another, draw into the new
    // one rather than leave the customer looking at an empty page.
    iframe.addEventListener('load', function () {
      var d = iframe.contentDocument;
      if (!d || d === frameDoc || d.URL === 'about:blank' || !d.body) return;
      frameDoc = d;
      bindFrame();
      renderAll();
      resolveAllPhotos();
    });
    state.history.slice(-8).forEach(function (h) { bubble(h.role === 'user' ? 'user' : 'ai', h.text); });
    fit();
    root.classList.add('is-ready');
  }());
}());
