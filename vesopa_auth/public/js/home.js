/*
 * The homepage's motion: the sign-in demo in the hero, and sections that rise
 * into place as they scroll in.
 *
 * Everything here is decoration over a page that is complete without it. The
 * demo's markup is its first screen, already filled in; the sections are
 * visible unless this script has started and said it will reveal them.
 *
 * RUN AGAIN BY THE ROUTER. nav.js re-creates every `script[src]` after a
 * no-reload navigation, so this file runs once per visit to `/`. Each run binds
 * to the elements of the page it found, and every timer checks that its demo
 * is still in the document, so a demo left behind by a navigation stops
 * instead of animating a detached node for ever.
 *
 * With `prefers-reduced-motion` nothing moves on its own: the steps still
 * switch the demo when pressed, and every section is simply there.
 */
(function () {
  'use strict';

  var body = document.body;
  if (!body || !body.classList.contains('home')) return;

  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------- sections

  var revealable = document.querySelectorAll(
    '.rise, .band h2, .section-lede, .product, .method-grid li, .control-grid > div, .assurance, .code-card'
  );
  if (!still && 'IntersectionObserver' in window) {
    body.classList.add('motion');
    var seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        seen.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    for (var i = 0; i < revealable.length; i += 1) {
      var el = revealable[i];
      el.classList.add('rise');
      // Siblings in a grid arrive one after another, not all at once.
      var index = Array.prototype.indexOf.call(el.parentNode.children, el);
      el.style.setProperty('--d', Math.min(index, 7) * 70 + 'ms');
      seen.observe(el);
    }
  }

  // ----------------------------------------------------------------- demo

  var demo = document.querySelector('[data-demo]');
  var steps = document.querySelector('[data-demo-steps]');
  if (!demo || demo.hasAttribute('data-bound')) return;
  demo.setAttribute('data-bound', '');

  var typed = demo.querySelector('.demo-typed');
  var address = typed ? typed.getAttribute('data-text') : '';
  var digits = demo.querySelectorAll('.demo-digit');
  var apps = demo.querySelectorAll('.demo-app');
  var buttons = steps ? steps.querySelectorAll('[data-go]') : [];
  var run = 0;

  /** A pause that is abandoned when the demo is restarted or leaves the page. */
  function wait(ms, id) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (id === run && demo.isConnected) resolve();
        else reject(new Error('stopped'));
      }, ms);
    });
  }

  function setStep(n) {
    demo.setAttribute('data-step', String(n));
    for (var i = 0; i < buttons.length; i += 1) {
      var on = buttons[i].getAttribute('data-go') === String(n);
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function press(panel) {
    var button = demo.querySelector('[data-panel="' + panel + '"] [data-press]');
    if (!button) return;
    button.classList.add('pressed');
    setTimeout(function () { button.classList.remove('pressed'); }, 260);
  }

  function fill(list, count) {
    for (var i = 0; i < list.length; i += 1) list[i].classList.toggle('on', i < count);
  }

  /** A step's finished state, for a press on the steps or reduced motion. */
  function show(n) {
    setStep(n);
    if (typed) typed.textContent = address;
    demo.classList.remove('typing');
    demo.classList.toggle('mail-in', n === 2);
    fill(digits, n >= 2 ? digits.length : 0);
    fill(apps, n === 3 ? apps.length : 0);
    demo.style.setProperty('--progress', '0');
  }

  function progress(fraction, ms) {
    demo.style.setProperty('--progress-ms', ms + 'ms');
    demo.style.setProperty('--progress', String(fraction));
  }

  function stepOne(id) {
    setStep(1);
    demo.classList.remove('mail-in');
    fill(digits, 0);
    fill(apps, 0);
    if (typed) typed.textContent = '';
    demo.classList.add('typing');
    progress(0, 0);
    var chain = wait(500, id);
    for (var i = 1; i <= address.length; i += 1) {
      (function (count) {
        chain = chain.then(function () {
          typed.textContent = address.slice(0, count);
          progress(count / address.length / 3, 70);
          return wait(55 + Math.random() * 45, id);
        });
      })(i);
    }
    return chain
      .then(function () { demo.classList.remove('typing'); return wait(450, id); })
      .then(function () { press(1); return wait(420, id); });
  }

  function stepTwo(id) {
    setStep(2);
    var chain = wait(650, id).then(function () {
      demo.classList.add('mail-in');
      return wait(1300, id);
    });
    for (var i = 1; i <= digits.length; i += 1) {
      (function (count) {
        chain = chain.then(function () {
          fill(digits, count);
          progress(1 / 3 + count / digits.length / 3, 160);
          return wait(170, id);
        });
      })(i);
    }
    return chain
      .then(function () { demo.classList.remove('mail-in'); return wait(380, id); })
      .then(function () { press(2); return wait(420, id); });
  }

  function stepThree(id) {
    setStep(3);
    var chain = wait(450, id);
    for (var i = 1; i <= apps.length; i += 1) {
      (function (count) {
        chain = chain.then(function () {
          fill(apps, count);
          progress(2 / 3 + count / apps.length / 3, 130);
          return wait(130, id);
        });
      })(i);
    }
    return chain.then(function () { return wait(2800, id); });
  }

  function play(from) {
    var id = (run += 1);
    var first = from || 1;
    var loop = function () {
      var chain = Promise.resolve();
      if (first <= 1) chain = chain.then(function () { return stepOne(id); });
      if (first <= 2) chain = chain.then(function () { return stepTwo(id); });
      chain = chain.then(function () { return stepThree(id); });
      return chain.then(function () { first = 1; return loop(); });
    };
    loop().catch(function () { /* restarted, or the page moved on */ });
  }

  for (var b = 0; b < buttons.length; b += 1) {
    buttons[b].addEventListener('click', function (event) {
      var n = Number(event.currentTarget.getAttribute('data-go'));
      if (still) {
        show(n);
        return;
      }
      // Start the chosen step from its beginning, then carry on round.
      run += 1;
      if (n === 2) { show(1); }
      if (n === 3) { show(2); demo.classList.remove('mail-in'); }
      play(n);
    });
  }

  if (still) {
    show(1);
  } else {
    demo.classList.add('live');
    play(1);
  }
})();
