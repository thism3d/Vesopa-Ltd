/* loughorrfc.site, on top of pages that are already whole: the opening, the
   menu on a phone, the masthead as you scroll, ink settling into place, the
   honours stamped, the members' card turning to the pointer, the kitchen's
   hours, and the club helper. No libraries. */
(function () {
  'use strict';
  var d = document;
  var root = d.documentElement;
  var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- The opening: lifted when it has played, on Skip, or at 3.4s ------- */
  var curtain = d.querySelector('[data-curtain]');
  function lift() { root.classList.remove('curtain-on'); }
  if (root.classList.contains('curtain-on')) {
    setTimeout(lift, 3400);
    if (curtain) {
      curtain.addEventListener('animationend', function (e) { if (e.target === curtain) lift(); });
      var skip = curtain.querySelector('[data-curtain-skip]');
      if (skip) skip.addEventListener('click', lift);
      curtain.addEventListener('click', lift);
    }
    d.addEventListener('keydown', lift, { once: true });
  }

  /* --- Menu on a phone ----------------------------------------------------- */
  var btn = d.querySelector('[data-menu-btn]');
  var nav = d.getElementById('nav');
  if (btn && nav) {
    btn.addEventListener('click', function () {
      var open = !nav.classList.contains('open');
      nav.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('open')) { nav.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
    });
  }

  /* --- The masthead tucks its strip away once the page moves -------------- */
  var head = d.querySelector('[data-head]');
  if (head) {
    var on = false;
    var check = function () {
      var now = window.scrollY > 40;
      if (now !== on) { on = now; head.classList.toggle('is-scrolled', on); }
    };
    window.addEventListener('scroll', check, { passive: true });
    check();
  }

  /* --- Reveals: ink settling, and the honours stamped on -------------------- */
  var items = d.querySelectorAll('[data-reveal], [data-stamp]');
  if (still || !('IntersectionObserver' in window)) {
    items.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var el = e.target;
        // Siblings arrive one after another, not all at once.
        var i = Array.prototype.indexOf.call(el.parentNode.children, el);
        el.style.transitionDelay = el.style.animationDelay = Math.min(i, 6) * 70 + 'ms';
        el.classList.add('in');
        io.unobserve(el);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (el) {
      // Already on screen when the page opens: shown at once, no waiting.
      var r = el.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0 && !el.hasAttribute('data-stamp')) el.classList.add('in');
      else io.observe(el);
    });
  }

  /* --- The members' card turns a little toward the pointer ----------------- */
  if (!still && window.matchMedia && matchMedia('(hover: hover)').matches) {
    d.querySelectorAll('[data-tilt-card]').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width - 0.5;
        var y = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = 'perspective(800px) rotateY(' + (x * 14).toFixed(2) + 'deg) rotateX(' + (-y * 10).toFixed(2) + 'deg)';
      });
      card.addEventListener('pointerleave', function () { card.style.transform = ''; });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* --- Kitchen hours, from the club's menu settings, once they are set ------ */
  d.querySelectorAll('[data-hours]').forEach(function (box) {
    if (!window.fetch) return;
    fetch(box.getAttribute('data-api') + '/api/public/dinein/venue/' + encodeURIComponent(box.getAttribute('data-slug')))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var s = data && data.venue && data.venue.schedule;
        if (!s || !s.enforced || !Array.isArray(s.hours)) return;
        var days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        var today = s.today && s.today.day;
        box.innerHTML = '<h3>Kitchen hours</h3><p class="small muted">' + (s.open ? 'The kitchen is open now.' : 'The kitchen is closed right now.') +
          '</p><table>' + s.hours.map(function (h, i) {
            return '<tr' + (days[i] === today ? ' class="today"' : '') + '><td>' + days[i] + '</td><td>' + (h.closed ? 'Closed' : esc(h.open) + ' to ' + esc(h.close)) + '</td></tr>';
          }).join('') + '</table>';
      })
      .catch(function () {});
  });

  /* Answers come back as text with [label](url) links and **bold**. Escaped
     first; only https and on-site links become links. */
  function md(text) {
    return esc(text).split(/\n{2,}/).map(function (para) {
      return '<p>' + para
        .replace(/\[([^\]]{1,120})\]\(((?:https:\/\/|\/)[^\s)]{0,300})\)/g, function (m, label, url) {
          var external = /^https:/.test(url) && url.indexOf(location.origin) !== 0;
          return '<a href="' + url + '"' + (external ? ' target="_blank" rel="noopener"' : '') + '>' + label + '</a>';
        })
        .replace(/\*\*([^*]{1,200})\*\*/g, '<b>$1</b>')
        .replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  /* --- Ask the club -------------------------------------------------------- */
  var helper = d.querySelector('[data-helper]');
  if (!helper) return;
  var panel = helper.querySelector('.ask-panel');
  var openBtn = helper.querySelector('[data-helper-open]');
  var closeBtn = helper.querySelector('[data-helper-close]');
  var log = helper.querySelector('[data-helper-log]');
  var chips = helper.querySelector('[data-helper-chips]');
  var form = helper.querySelector('[data-helper-form]');
  var input = d.getElementById('helper-q');
  var KEY = 'lrfc-helper';
  var history = [];
  var busy = false;

  function add(kind, text) {
    var el = d.createElement('div');
    el.className = 'msg ' + kind;
    el.innerHTML = kind === 'me' ? '<p>' + esc(text) + '</p>' : md(text);
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  try { history = JSON.parse(sessionStorage.getItem(KEY) || '[]') || []; } catch (e) { history = []; }
  history.forEach(function (t) { add(t.role === 'user' ? 'me' : 'bot', t.content); });
  if (history.length && chips) chips.hidden = true;
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(history.slice(-12))); } catch (e) { /* private window */ } }

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
    fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: q, history: sent }) })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        var answer = data.answer || data.error || 'Sorry, something went wrong. Please call the club.';
        typing.remove();
        add('bot', answer);
        history.push({ role: 'assistant', content: answer });
        save();
      })
      .catch(function () { typing.remove(); add('bot', 'I could not reach the club just now. Please try again, or call the club.'); })
      .then(function () { busy = false; });
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); var q = input.value; input.value = ''; ask(q); });
  if (chips) chips.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) ask(b.textContent); });
})();
