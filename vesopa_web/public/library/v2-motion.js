/*
 * 24 Oct 2026, round 2: photo loading, zoom lightbox (tap, pinch, drag,
 * double-tap, wheel, swipe, Esc), rotating typed words and testimonial
 * motion. Vanilla JS, loaded on every page; each part is skipped when its
 * markup is not on the page. Honours prefers-reduced-motion.
 */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.add('js-img');

  // ---- photos fade in once loaded (and never stay hidden) --------------------
  function watch(img) {
    var box = img.closest('.ph, .pic');
    if (!box) return;
    var done = function () { box.classList.add('is-loaded'); };
    if (img.complete && img.naturalWidth) done();
    img.addEventListener('load', done);
    img.addEventListener('error', done);
  }
  document.querySelectorAll('.v2-item .ph img, .hw-detail .pic img').forEach(watch);
  // the details panel swaps its picture: show the shimmer until the new one is in
  var detailImg = document.querySelector('[data-d-img]');
  if (detailImg && window.MutationObserver) {
    new MutationObserver(function () {
      var box = detailImg.closest('.pic');
      if (box && !(detailImg.complete && detailImg.naturalWidth)) box.classList.remove('is-loaded');
    }).observe(detailImg, { attributes: true, attributeFilter: ['src'] });
    watch(detailImg);
  }
  setTimeout(function () { document.querySelectorAll('.ph, .pic').forEach(function (b) { b.classList.add('is-loaded'); }); }, 8000);

  // ---- rotating typed words -------------------------------------------------
  document.querySelectorAll('[data-tr-rotate]').forEach(function (el) {
    var words; try { words = JSON.parse(el.getAttribute('data-words')); } catch (e) { return; }
    if (!words || words.length < 2 || reduce) return;
    var w = 0, i = words[0].length, del = true;
    (function tick() {
      var word = words[w];
      if (del) { i--; el.textContent = word.slice(0, i); if (i <= 0) { del = false; w = (w + 1) % words.length; } setTimeout(tick, 35); }
      else { i++; el.textContent = words[w].slice(0, i); if (i >= words[w].length) { del = true; setTimeout(tick, 2200); } else setTimeout(tick, 60); }
    })();
  });

  // ---- testimonials: stars, progress bar, animated change ---------------------
  var review = document.getElementById('user_review_dom');
  if (review) {
    var keeper = review.closest('.user_review_text_keeper') || review.parentNode;
    var stars = document.createElement('div');
    stars.className = 'v2-stars'; stars.setAttribute('aria-label', 'Rated 5 out of 5');
    stars.innerHTML = '<span>★</span><span>★</span><span>★</span><span>★</span><span>★</span>';
    keeper.appendChild(stars);
    var bar = document.createElement('div'); bar.className = 'v2-review-bar'; bar.setAttribute('aria-hidden', 'true');
    bar.innerHTML = '<i class="run"></i>';
    keeper.appendChild(bar);
    var restart = function (el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
    var who = [document.getElementById('user_name_dom'), document.getElementById('user_extra_data_dom')].filter(Boolean);
    new MutationObserver(function () {
      if (reduce) return;
      restart(review, 'v2-swap'); who.forEach(function (n) { restart(n, 'v2-swap'); });
      stars.querySelectorAll('span').forEach(function (s) { restart(s, 'v2-pop'); });
      restart(bar.firstChild, 'run');
    }).observe(review, { childList: true, characterData: true, subtree: true });
  }

  // ---- lightbox ---------------------------------------------------------------
  var SEL = '.v2-item .ph img, .hw-detail .pic img, .v2-phone img, .epos_demo_item_img, .vs-shot img, .vs-offline-img';
  var lb, stage, pic, cap, list = [], at = 0, s = 1, tx = 0, ty = 0, base = { w: 0, h: 0 };
  var fullSrc = function (img) {
    var src = img.getAttribute('data-full') || img.currentSrc || img.src;
    return src.replace(/\/assets\/v2\/sm\/([^/?]+)\.webp(\?.*)?$/, function (_m, n) { return '/assets/v2/' + (/^(epos-|kitchen-|display-|express-|loyalty-|table-)/.test(n) ? 'screens/' : '') + n + '.jpg'; });
  };
  function build() {
    lb = document.createElement('div');
    lb.className = 'v2-lb'; lb.hidden = true; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', 'Picture');
    lb.innerHTML = '<div class="v2-lb-cap"></div><div class="v2-lb-hint">Pinch or scroll to zoom · drag to move · double-tap</div>'
      + '<div class="v2-lb-stage"><img class="v2-lb-img" alt=""></div>'
      + '<button type="button" class="v2-lb-btn v2-lb-close" aria-label="Close">✕</button>'
      + '<button type="button" class="v2-lb-btn v2-lb-prev" aria-label="Previous picture">‹</button>'
      + '<button type="button" class="v2-lb-btn v2-lb-next" aria-label="Next picture">›</button>'
      + '<div class="v2-lb-bar"><button type="button" class="v2-lb-btn" data-z="-1" aria-label="Zoom out">−</button>'
      + '<button type="button" class="v2-lb-btn" data-z="0" aria-label="Fit to screen">⤢</button>'
      + '<button type="button" class="v2-lb-btn" data-z="1" aria-label="Zoom in">+</button></div>';
    document.body.appendChild(lb);
    stage = lb.querySelector('.v2-lb-stage'); pic = lb.querySelector('.v2-lb-img'); cap = lb.querySelector('.v2-lb-cap');
    lb.querySelector('.v2-lb-close').onclick = close;
    lb.querySelector('.v2-lb-prev').onclick = function () { show(at - 1); };
    lb.querySelector('.v2-lb-next').onclick = function () { show(at + 1); };
    lb.querySelector('.v2-lb-bar').onclick = function (e) {
      var b = e.target.closest('[data-z]'); if (!b) return;
      var z = +b.getAttribute('data-z'), r = stage.getBoundingClientRect();
      if (z === 0) fit(true); else zoomAt(r.width / 2, r.height / 2, z > 0 ? 1.6 : 1 / 1.6, true);
    };
    lb.addEventListener('click', function (e) { if (e.target === lb || e.target === stage) close(); });
    pic.addEventListener('load', function () { fit(false); });
    stage.addEventListener('wheel', function (e) { e.preventDefault(); var r = stage.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15, false); }, { passive: false });
    gestures();
  }
  function apply(anim) { pic.classList.toggle('anim', !!anim); pic.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')'; }
  function fit(anim) {
    var r = stage.getBoundingClientRect(), w = pic.naturalWidth || 1, h = pic.naturalHeight || 1;
    var k = Math.min(r.width / w, r.height / h, 1.5);
    base = { w: w, h: h, k: k }; s = k; tx = (r.width - w * k) / 2; ty = (r.height - h * k) / 2; apply(anim);
  }
  function clamp() {
    var r = stage.getBoundingClientRect(), w = base.w * s, h = base.h * s;
    tx = w <= r.width ? (r.width - w) / 2 : Math.min(0, Math.max(r.width - w, tx));
    ty = h <= r.height ? (r.height - h) / 2 : Math.min(0, Math.max(r.height - h, ty));
  }
  function zoomAt(x, y, f, anim) {
    var ns = Math.max(base.k, Math.min(base.k * 6, s * f)); f = ns / s;
    tx = x - (x - tx) * f; ty = y - (y - ty) * f; s = ns; clamp(); apply(anim);
  }
  function gestures() {
    var pts = {}, startDist = 0, startS = 1, last = null, lastTap = 0, swipeX = null;
    var mid = function () { var p = Object.values(pts); return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; };
    var dist = function () { var p = Object.values(pts); return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };
    stage.addEventListener('pointerdown', function (e) {
      var r = stage.getBoundingClientRect();
      stage.setPointerCapture(e.pointerId);
      pts[e.pointerId] = { x: e.clientX - r.left, y: e.clientY - r.top };
      var n = Object.keys(pts).length;
      if (n === 2) { startDist = dist(); startS = s; last = mid(); }
      else { last = pts[e.pointerId]; swipeX = e.clientX; pic.classList.add('dragging');
        var now = Date.now(); if (now - lastTap < 300) { var at2 = pts[e.pointerId]; zoomAt(at2.x, at2.y, s > base.k * 1.05 ? base.k / s : 2.5, true); } lastTap = now; }
    });
    stage.addEventListener('pointermove', function (e) {
      if (!pts[e.pointerId]) return;
      var r = stage.getBoundingClientRect(); pts[e.pointerId] = { x: e.clientX - r.left, y: e.clientY - r.top };
      var n = Object.keys(pts).length;
      if (n === 2) { var m = mid(); var f = (startS * dist() / startDist) / s; tx += m.x - last.x; ty += m.y - last.y; zoomAt(m.x, m.y, f, false); last = m; }
      else if (n === 1 && s > base.k * 1.02) { var p = pts[e.pointerId]; tx += p.x - last.x; ty += p.y - last.y; last = p; clamp(); apply(false); }
    });
    var up = function (e) {
      if (!pts[e.pointerId]) return;
      delete pts[e.pointerId]; pic.classList.remove('dragging');
      if (Object.keys(pts).length === 0 && swipeX !== null && s <= base.k * 1.02) {
        var dx = e.clientX - swipeX; if (Math.abs(dx) > 60) show(at + (dx < 0 ? 1 : -1));
      }
      if (Object.keys(pts).length === 1) { last = Object.values(pts)[0]; }
      swipeX = null;
    };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  }
  function show(i) {
    if (!list.length) return;
    at = (i + list.length) % list.length;
    var img = list[at];
    pic.src = fullSrc(img); pic.alt = img.alt || '';
    cap.textContent = img.alt || '';
    var many = list.length > 1;
    lb.querySelector('.v2-lb-prev').hidden = !many; lb.querySelector('.v2-lb-next').hidden = !many;
  }
  var opener = null;
  function open(img) {
    if (!lb) build();
    var group = img.closest('section, .owl-carousel, [data-hw-shop]') || document.body;
    list = Array.prototype.filter.call(group.querySelectorAll(SEL), function (x) { return !x.closest('.owl-item.cloned') && x.offsetParent !== null; });
    if (list.indexOf(img) < 0) list = [img];
    opener = document.activeElement;
    lb.hidden = false;
    // a timer, not requestAnimationFrame: rAF never fires in a background tab
    setTimeout(function () { lb.classList.add('open'); fit(false); }, 16);
    document.documentElement.style.overflow = 'hidden';
    show(list.indexOf(img));
    lb.querySelector('.v2-lb-close').focus();
  }
  function close() {
    if (!lb || lb.hidden) return;
    lb.classList.remove('open'); document.documentElement.style.overflow = '';
    setTimeout(function () { lb.hidden = true; pic.removeAttribute('src'); }, 200);
    if (opener && opener.focus) opener.focus();
  }
  document.addEventListener('keydown', function (e) {
    if (!lb || lb.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') show(at + 1);
    else if (e.key === 'ArrowLeft') show(at - 1);
    else if (e.key === '+' || e.key === '=') { var r = stage.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.4, true); }
    else if (e.key === '-') { var r2 = stage.getBoundingClientRect(); zoomAt(r2.width / 2, r2.height / 2, 1 / 1.4, true); }
  });
  window.addEventListener('resize', function () { if (lb && !lb.hidden) fit(false); });
  // A tap on a picture zooms it, even where the picture sits inside a link.
  document.addEventListener('click', function (e) {
    var img = e.target.closest && e.target.closest(SEL);
    if (!img) return;
    e.preventDefault(); e.stopPropagation();
    open(img);
  }, true);
  document.querySelectorAll(SEL).forEach(function (img) { img.classList.add('v2-zoomable'); });
})();
