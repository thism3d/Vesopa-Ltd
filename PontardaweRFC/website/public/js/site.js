/* pontardawerfc.com: the header, scroll reveals, counters,
   kitchen hours on the clubhouse page and the club helper. No libraries. */
(function () {
  'use strict';
  var d = document;
  var root = d.documentElement;
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Header: solid once scrolled; the burger opens the menu on phones. */
  var head = d.querySelector('[data-head]');
  var bar = d.querySelector('[data-progress-bar]');
  var onScroll = function () {
    if (head) head.classList.toggle('scrolled', window.scrollY > 10);
    if (bar) {
      var max = d.documentElement.scrollHeight - window.innerHeight;
      bar.style.setProperty('--p', max > 0 ? Math.min(1, window.scrollY / max).toFixed(4) : 0);
    }
  };

  /* A soft spotlight that follows the pointer over cards and tiles. */
  if (!reduced && window.matchMedia && matchMedia('(hover: hover)').matches) {
    d.addEventListener('pointermove', function (e) {
      var el = e.target.closest && e.target.closest('.tile, a.card');
      if (!el) return;
      var r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      el.style.setProperty('--my', (e.clientY - r.top) + 'px');
    }, { passive: true });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  var burger = d.querySelector('[data-burger]');
  var nav = d.getElementById('nav');
  if (burger && nav) {
    var setNav = function (open) {
      nav.classList.toggle('open', open);
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Close the menu' : 'Open the menu');
    };
    burger.addEventListener('click', function () { setNav(!nav.classList.contains('open')); });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setNav(false); });
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape') setNav(false); });
  }

  /* Reveal on scroll, with a small stagger between neighbours. */
  var reveals = d.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduced) {
    // Whatever is already on screen stays exactly as drawn; only what is
    // below it waits to rise in. Nothing is ever hidden before this runs.
    var fold = window.innerHeight;
    reveals = Array.prototype.filter.call(reveals, function (el) {
      if (el.getBoundingClientRect().top < fold) { el.classList.add('in'); return false; }
      return true;
    });
    root.classList.add('reveal-on');
    var io = new IntersectionObserver(function (entries) {
      var n = 0;
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.style.setProperty('--d', (n++ * 0.08) + 's');
        en.target.classList.add('in');
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  /* Counters on the home page. */
  var counters = d.querySelectorAll('[data-count]');
  if (counters.length && 'IntersectionObserver' in window && !reduced) {
    var co = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        co.unobserve(en.target);
        var el = en.target;
        var to = Number(el.getAttribute('data-count')) || 0;
        var from = to > 1000 ? to - 120 : 0;
        var t0 = performance.now();
        var step = function (t) {
          var p = Math.min(1, (t - t0) / 1400);
          var eased = 1 - Math.pow(1 - p, 3);
          el.textContent = String(Math.round(from + (to - from) * eased));
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }, { threshold: 0.4 });
    counters.forEach(function (el) { co.observe(el); });
  }

  /* The next match: days and hours to kick-off (UK time as the WRU gives it). */
  // The big match clock draws its own boxes (motion.js).
  d.querySelectorAll('[data-countdown]:not([data-boxes])').forEach(function (el) {
    var at = new Date(el.getAttribute('data-countdown'));
    var tick = function () {
      var ms = at - new Date();
      if (isNaN(ms) || ms <= 0) { el.textContent = ms > -2 * 3600e3 ? 'Kick-off!' : ''; return; }
      var days = Math.floor(ms / 864e5);
      var hours = Math.floor((ms % 864e5) / 36e5);
      var mins = Math.floor((ms % 36e5) / 6e4);
      el.textContent = (days > 0 ? days + 'd ' + hours + 'h' : hours + 'h ' + mins + 'm') + ' to kick-off';
    };
    tick();
    setInterval(tick, 60000);
  });

  /*
   * The app video (2026-10-25): our own picture until it is tapped, then
   * YouTube's privacy-enhanced player, playing, full screen and turned to
   * landscape where the phone allows it (Android; an iPhone plays it in its
   * own full-screen player, which turns with the phone). Full HD is asked for;
   * YouTube still drops it on a slow connection.
   */
  d.querySelectorAll('[data-yt]').forEach(function (box) {
    var btn = box.querySelector('.app-video-play');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var id = box.getAttribute('data-yt');
      var f = d.createElement('iframe');
      f.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0&modestbranding=1&playsinline=0&fs=1&vq=hd1080&hd=1';
      f.title = box.getAttribute('data-yt-title') || 'Video';
      f.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
      f.allowFullscreen = true;
      f.referrerPolicy = 'strict-origin-when-cross-origin';
      var frame = d.createElement('div');
      frame.className = 'app-video-frame';
      frame.appendChild(f);
      btn.replaceWith(frame);
      box.classList.add('playing');
      var full = frame.requestFullscreen || frame.webkitRequestFullscreen;
      if (full) {
        try {
          var p = full.call(frame);
          var turn = function () { try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {}); } catch (e) {} };
          if (p && p.then) p.then(turn).catch(function () {}); else turn();
        } catch (e) {}
      }
      d.addEventListener('fullscreenchange', function () {
        if (!d.fullscreenElement && screen.orientation && screen.orientation.unlock) { try { screen.orientation.unlock(); } catch (e) {} }
      });
    });
  });

  /* The satellite map: Google's embed, only when the visitor asks for it. */
  d.querySelectorAll('[data-sat-map]').forEach(function (box) {
    var btn = box.querySelector('[data-sat-show]');
    var frame = box.querySelector('[data-sat-frame]');
    if (!btn || !frame) return;
    btn.addEventListener('click', function () {
      var f = d.createElement('iframe');
      f.src = frame.getAttribute('data-src');
      f.title = 'Satellite map of Pontardawe RFC, Ynysderw Road';
      f.loading = 'lazy';
      f.referrerPolicy = 'no-referrer-when-downgrade';
      f.allowFullscreen = true;
      frame.innerHTML = '';
      frame.appendChild(f);
      frame.classList.add('live');
      btn.parentNode.innerHTML = '<span class="small muted">Satellite imagery and map data © Google</span>';
    });
  });

  /* Kitchen hours, from the bar's own menu settings, once the menu is live. */
  var hoursBox = d.querySelector('[data-hours]');
  if (hoursBox && window.fetch) {
    fetch(hoursBox.getAttribute('data-api') + '/api/public/dinein/venue/' + encodeURIComponent(hoursBox.getAttribute('data-slug')))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var s = data && data.venue && data.venue.schedule;
        if (!s || !s.enforced || !Array.isArray(s.hours)) return;
        var days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        var today = s.today && s.today.day;
        var rows = s.hours.map(function (h, i) {
          return '<tr' + (days[i] === today ? ' class="today"' : '') + '><td>' + days[i] + '</td><td>' +
            (h.closed ? 'Closed' : esc(h.open) + ' to ' + esc(h.close)) + '</td></tr>';
        }).join('');
        hoursBox.innerHTML = '<h3>Kitchen hours</h3><p class="small muted">' +
          (s.open ? 'The kitchen is open now.' : 'The kitchen is closed right now.') +
          '</p><table>' + rows + '</table>';
      })
      .catch(function () {});
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Answers come back as plain text with [label](url) links and **bold**.
     Everything is escaped first; only https and on-site links become links. */
  function md(text) {
    return esc(text).split(/\n{2,}/).map(function (para) {
      var html = para
        .replace(/\[([^\]]{1,120})\]\(((?:https:\/\/|\/)[^\s)]{0,300})\)/g, function (m, label, url) {
          var external = /^https:/.test(url) && url.indexOf(location.origin) !== 0;
          return '<a href="' + url + '"' + (external ? ' target="_blank" rel="noopener"' : '') + '>' + label + '</a>';
        })
        .replace(/\*\*([^*]{1,200})\*\*/g, '<b>$1</b>')
        .replace(/\n/g, '<br>');
      return '<p>' + html + '</p>';
    }).join('');
  }

  /* --- The club helper ---------------------------------------------------- */
  var helper = d.querySelector('[data-helper]');
  if (!helper) return;
  var panel = helper.querySelector('.helper-panel');
  var openBtn = helper.querySelector('[data-helper-open]');
  var closeBtn = helper.querySelector('[data-helper-close]');
  var log = helper.querySelector('[data-helper-log]');
  var chips = helper.querySelector('[data-helper-chips]');
  var form = helper.querySelector('[data-helper-form]');
  var input = d.getElementById('helper-q');
  var KEY = 'prfc-helper';
  var history = [];
  var busy = false;

  try { history = JSON.parse(sessionStorage.getItem(KEY) || '[]') || []; } catch (e) { history = []; }
  history.forEach(function (t) { add(t.role === 'user' ? 'me' : 'bot', t.content); });
  if (history.length && chips) chips.hidden = true;

  function save() {
    try { sessionStorage.setItem(KEY, JSON.stringify(history.slice(-12))); } catch (e) { /* private window */ }
  }

  function add(kind, text) {
    var el = d.createElement('div');
    el.className = 'msg ' + kind;
    el.innerHTML = kind === 'me' ? '<p>' + esc(text) + '</p>' : md(text);
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function setOpen(open) {
    panel.hidden = !open;
    openBtn.setAttribute('aria-expanded', String(open));
    if (open) setTimeout(function () { input.focus(); }, 30);
  }
  openBtn.addEventListener('click', function () { setOpen(panel.hidden); });
  closeBtn.addEventListener('click', function () { setOpen(false); openBtn.focus(); });
  d.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) setOpen(false); });

  function ask(q) {
    q = String(q || '').trim();
    if (!q || busy) return;
    busy = true;
    if (chips) chips.hidden = true;
    add('me', q);
    var typing = add('bot typing', '');
    typing.innerHTML = '<span></span><span></span><span></span>';
    var sent = history.slice(-10);
    history.push({ role: 'user', content: q });
    fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: q, history: sent }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        var answer = data.answer || data.error || 'Sorry, something went wrong. Please call the club.';
        typing.remove();
        add('bot', answer);
        history.push({ role: 'assistant', content: answer });
        save();
      })
      .catch(function () {
        typing.remove();
        add('bot', 'I could not reach the club just now. Please try again, or call the club.');
      })
      .then(function () { busy = false; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = input.value;
    input.value = '';
    ask(q);
  });
  if (chips) chips.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b) ask(b.textContent);
  });
})();
