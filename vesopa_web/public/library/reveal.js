/**
 * Scroll-reveal animations.
 *
 * Elements are tagged from this list rather than by editing ten templates, so
 * the animation layer stays in one file and a markup change cannot half-break
 * it. Each entry names a container and the children inside it that should
 * arrive one after another.
 *
 * Three rules the implementation follows:
 *
 *  1. Nothing is hidden until JS confirms it can un-hide it. The `js-reveal`
 *     class is added to <html> first; the CSS that hides things is scoped to
 *     that class. With JS off, or if this file fails to load, the page renders
 *     normally instead of being a blank column of invisible sections.
 *  2. prefers-reduced-motion is honoured by bailing out entirely — no classes
 *     added, no observer created.
 *  3. Elements already on screen at load are revealed immediately and without
 *     a stagger, so the first paint is not a queue of things sliding in.
 */
(function () {
  'use strict';

  var GROUPS = [
    // [container selector, child selector or null for the container itself]
    ['.epos_demo_container', null],
    ['.free_offer_container', '.free_offer_left, .free_offer_middle, .free_offer_right'],
    ['.fast_servers_container', '.fast_server_headline, .flag-carosel, .fast_server_description'],
    ['.container_2', '.continaer_2_left, .container_2_right'],
    ['.money_back_guarantee', '.money_back_left, .money_back_right'],
    ['.short_fetures_top', '.short_ft_heading, .short_ft_description, .vesopa_epos_features_text_keeper'],
    ['.short_feature_middle', '.short_fm_item'],
    ['.short_feature_bottom', '.short_fb_item'],
    ['.vf', '.vf-head'],
    ['.vf', '.vf-tabs'],
    ['.vf-specs', '.vf-spec'],
    ['.pricing_plan', '.pricing_plan_heading'],
    ['.pricing_items_keeper', '.pricing_single_item'],
    ['.customer_support_center', '.customer_support_img, .customer_support_right'],
    ['.users_review_container', '.user_review_headline, .user_review_item'],
    ['.faq_main_container', '.frequently_asked_headline'],
    ['.faq_item_container_inside', '.faq_item'],
    ['.try_vesopa_container', '.try_vesopa_left, .try_vesopa_right'],
    ['.device_download_main_body', '.device_download_left, .device_download_right'],
    ['.support_section_top', '.support_section_heading, .support_section_brief, .support_section_socials'],
    ['.support_section_middle', '.support_section_middle_left, .support_section_middle_right'],
    ['.support_section_bottom', '.support_section_bottom_item'],
    ['.privacy_policy_section_inside', 'h1, h2, h3'],
  ];

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduced.matches) return;

  var root = document.documentElement;
  var targets = [];

  GROUPS.forEach(function (pair) {
    var containers = document.querySelectorAll(pair[0]);
    Array.prototype.forEach.call(containers, function (container) {
      var items = pair[1]
        ? container.querySelectorAll(pair[1])
        : [container];

      Array.prototype.forEach.call(items, function (el, i) {
        // An element caught by two groups would otherwise get two delays.
        if (el.hasAttribute('data-reveal')) return;
        el.setAttribute('data-reveal', '');
        // Capped so a long grid does not leave the last card waiting a second
        // and a half after the first.
        el.style.setProperty('--reveal-delay', Math.min(i, 6) * 70 + 'ms');
        targets.push(el);
      });
    });
  });

  if (!targets.length) return;

  // Only now is it safe to hide anything.
  root.classList.add('js-reveal');

  // The viewport at load: revealed at once, with no stagger, so the fold is
  // never animating while the visitor is already reading it.
  var fold = window.innerHeight;
  targets.forEach(function (el) {
    if (el.getBoundingClientRect().top < fold * 0.9) {
      el.style.setProperty('--reveal-delay', '0ms');
      el.classList.add('is-revealed');
    }
  });

  if (!('IntersectionObserver' in window)) {
    // No observer: show everything rather than leave the page empty.
    targets.forEach(function (el) { el.classList.add('is-revealed'); });
    return;
  }

  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-revealed');
        // Reveal is one-way — re-animating on scroll-up is a distraction.
        io.unobserve(entry.target);
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
  );

  targets.forEach(function (el) {
    if (!el.classList.contains('is-revealed')) io.observe(el);
  });

  // Someone who turns reduced-motion on mid-session should not be left with
  // un-revealed sections below the fold.
  var onChange = function () {
    if (!reduced.matches) return;
    targets.forEach(function (el) { el.classList.add('is-revealed'); });
    io.disconnect();
  };
  if (reduced.addEventListener) reduced.addEventListener('change', onChange);
})();
