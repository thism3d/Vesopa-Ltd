"use strict";

function _toConsumableArray(r) { return _arrayWithoutHoles(r) || _iterableToArray(r) || _unsupportedIterableToArray(r) || _nonIterableSpread(); }
function _nonIterableSpread() { throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _unsupportedIterableToArray(r, a) { if (r) { if ("string" == typeof r) return _arrayLikeToArray(r, a); var t = {}.toString.call(r).slice(8, -1); return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0; } }
function _iterableToArray(r) { if ("undefined" != typeof Symbol && null != r[Symbol.iterator] || null != r["@@iterator"]) return Array.from(r); }
function _arrayWithoutHoles(r) { if (Array.isArray(r)) return _arrayLikeToArray(r); }
function _arrayLikeToArray(r, a) { (null == a || a > r.length) && (a = r.length); for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e]; return n; }
document.addEventListener("DOMContentLoaded", function () {
  var body = document.querySelector("body");
  /**
   * Slide Up
   */
  var slideUp = function slideUp(target) {
    var duration = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 500;
    target.style.transitionProperty = "height, margin, padding";
    target.style.transitionDuration = duration + "ms";
    target.style.boxSizing = "border-box";
    target.style.height = target.offsetHeight + "px";
    target.offsetHeight;
    target.style.overflow = "hidden";
    target.style.height = 0;
    target.style.paddingTop = 0;
    target.style.paddingBottom = 0;
    target.style.marginTop = 0;
    target.style.marginBottom = 0;
    window.setTimeout(function () {
      target.style.display = "none";
      target.style.removeProperty("height");
      target.style.removeProperty("padding-top");
      target.style.removeProperty("padding-bottom");
      target.style.removeProperty("margin-top");
      target.style.removeProperty("margin-bottom");
      target.style.removeProperty("overflow");
      target.style.removeProperty("transition-duration");
      target.style.removeProperty("transition-property");
    }, duration);
  };

  /**
   * Slide Down
   */
  var slideDown = function slideDown(target) {
    var duration = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 500;
    target.style.removeProperty("display");
    var display = window.getComputedStyle(target).display;
    if (display === "none") display = "block";
    target.style.display = display;
    var height = target.offsetHeight;
    target.style.overflow = "hidden";
    target.style.height = 0;
    target.style.paddingTop = 0;
    target.style.paddingBottom = 0;
    target.style.marginTop = 0;
    target.style.marginBottom = 0;
    target.offsetHeight;
    target.style.boxSizing = "border-box";
    target.style.transitionProperty = "height, margin, padding";
    target.style.transitionDuration = duration + "ms";
    target.style.height = height + "px";
    target.style.removeProperty("padding-top");
    target.style.removeProperty("padding-bottom");
    target.style.removeProperty("margin-top");
    target.style.removeProperty("margin-bottom");
    window.setTimeout(function () {
      target.style.removeProperty("height");
      target.style.removeProperty("overflow");
      target.style.removeProperty("transition-duration");
      target.style.removeProperty("transition-property");
    }, duration);
  };

  /**
   * Slide Toggle
   */
  var slideToggle = function slideToggle(target) {
    var duration = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 500;
    if (target.attributes.style === undefined || target.style.display === "none") {
      return slideDown(target, duration);
    } else {
      return slideUp(target, duration);
    }
  };

  /**
   * Header Crossed
   */
  window.addEventListener("scroll", function () {
    var primaryHeader = document.querySelector(".primary-header");
    if (primaryHeader) {
      var primaryHeaderTop = primaryHeader.offsetHeight / 3;
      var scrolled = window.scrollY;
      var primaryHeaderCrossed = function primaryHeaderCrossed() {
        if (scrolled > primaryHeaderTop) {
          body.classList.add("primary-header-crossed");
        } else if (scrolled < primaryHeaderTop) {
          body.classList.remove("primary-header-crossed");
        } else {
          body.classList.remove("primary-header-crossed");
        }
      };
      setTimeout(primaryHeaderCrossed, 100);
    }
  });

  /**
   * Primary Menu
   */
  var mdScreen = "(max-width: 991px)";
  var mdScreenSize = window.matchMedia(mdScreen);
  var containSub1 = document.querySelectorAll(".has-sub-level-1 > a");
  var containSub2 = document.querySelectorAll(".has-sub-level-2 > a");
  var mdScreenSizeActive = function mdScreenSizeActive(screen) {
    if (screen.matches) {
      // if menu has sub
      containSub1.forEach(function (e) {
        e.addEventListener("click", function (el) {
          el.preventDefault();
          el.stopPropagation();
          el.target.classList.toggle("active");
          var menuSub = e.nextElementSibling;
          if (menuSub) {
            slideToggle(menuSub, 500);
          }
        });
      });
      // if menu has 2nd sub menu
      containSub2.forEach(function (e) {
        e.addEventListener("click", function (el) {
          el.preventDefault();
          el.stopPropagation();
          el.target.classList.toggle("active");
          var menuSub = e.nextElementSibling;
          if (menuSub) {
            slideToggle(menuSub, 500);
          }
        });
      });
    } else {
      containSub1.forEach(function (e) {
        e.addEventListener("click", function (el) {
          el.preventDefault();
        });
      });
      containSub2.forEach(function (e) {
        e.addEventListener("click", function (el) {
          el.preventDefault();
        });
      });
    }
  };
  mdScreenSize.addEventListener("change", function (e) {
    if (e.matches) {
      window.location.reload();
      mdScreenSizeActive(e);
    } else {
      mdScreenSize.removeEventListener("change", function (e) {
        mdScreenSizeActive(e);
      });
      window.location.reload();
    }
  });
  mdScreenSizeActive(mdScreenSize);

  /**
   * Theme Settings (Dark / Light)
   */
  var themeDropdownIcon = document.getElementById("themeDropdownIcon");
  var theme = localStorage.getItem("theme");

  // Set initial theme
  if (theme === "dark") {
    document.documentElement.setAttribute("data-bs-theme", "dark");
    updateThemeIcon("dark");
  } else {
    // Default to light theme if not set
    document.documentElement.setAttribute("data-bs-theme", "light");
    updateThemeIcon("light");
  }

  // Theme change handlers
  var selectLightTheme = document.getElementById("lightTheme");
  if (selectLightTheme) {
    selectLightTheme.addEventListener("click", function () {
      document.documentElement.setAttribute("data-bs-theme", "light");
      localStorage.setItem("theme", "light");
      updateThemeIcon("light");
    });
  }
  var selectDarkTheme = document.getElementById("darkTheme");
  if (selectDarkTheme) {
    selectDarkTheme.addEventListener("click", function () {
      document.documentElement.setAttribute("data-bs-theme", "dark");
      localStorage.setItem("theme", "dark");
      updateThemeIcon("dark");
    });
  }
  function updateThemeIcon(theme) {
    if (!themeDropdownIcon) return;
    themeDropdownIcon.setAttribute("icon", theme === "light" ? "bi:sun" : "bi:moon-stars");
  }

  /**
   * Testimonial Slider 5
   */
  var testimonialSliderFive = document.querySelector(".testimonial-slider-5");
  if (testimonialSliderFive) {
    new Swiper(testimonialSliderFive, {
      loop: true,
      speed: 3000,
      autoplay: true,
      spaceBetween: 16,
      slidesPerView: 1,
      breakpoints: {
        1400: {
          slidesPerView: 2
        },
        1920: {
          slidesPerView: 3
        },
        2500: {
          slidesPerView: 4
        }
      }
    });
  }

  /**
   * Iterate through each tab group
   */
  var tabGroups = document.querySelectorAll(".tab-group");
  tabGroups.forEach(function (group) {
    var tabButtons = group.querySelectorAll(".tab__links");
    var tabContents = group.querySelectorAll(".tab__content");
    if (!tabButtons.length || !tabContents.length) {
      return;
    }

    // Attach event listeners to each tab button
    tabButtons.forEach(function (button, index) {
      button.addEventListener("click", function () {
        // Remove active class from all buttons and contents in this group
        tabButtons.forEach(function (btn) {
          return btn.classList.remove("active");
        });
        tabContents.forEach(function (content) {
          return content.classList.remove("active");
        });

        // Add active class to clicked button and corresponding content
        button.classList.add("active");
        if (tabContents[index]) {
          tabContents[index].classList.add("active");
        } else {
          console.warn("No content found for tab index ".concat(index, " in this group"));
        }
      });
    });

    // Optionally, activate the first tab by default in each group
    if (tabButtons[0]) {
      tabButtons[0].click();
    }
  });

  /**
   * Tooltip Init
   */
  var tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
  var tooltipList = _toConsumableArray(tooltipTriggerList).map(function (tooltipTriggerEl) {
    return new bootstrap.Tooltip(tooltipTriggerEl);
  });

  /**
   * Dropdwon Activate
   */
  var dropdownElementList = document.querySelectorAll('[data-bs-toggle="dropdown"]');
  var dropdownList = _toConsumableArray(dropdownElementList).map(function (dropdownToggleEl) {
    return new bootstrap.Dropdown(dropdownToggleEl);
  });

  /**
   * Duplicate Scroller-X Item
   */
  var scrollerX = document.querySelectorAll(".scroller-x");
  function scrollerXDuplication() {
    scrollerX.forEach(function (scroller) {
      var scrollerInner = scroller.querySelector(".scroller-x__list");
      var scrollerContent = Array.from(scrollerInner.children);
      scrollerContent.forEach(function (item) {
        var duplicateItem = item.cloneNode(true);
        scrollerInner.appendChild(duplicateItem);
      });
    });
  }
  scrollerXDuplication();

  /**
   * Duplicate Scroller-Y Item
   */
  var scrollerY = document.querySelectorAll(".scroller-y");
  function scrollerYDuplication() {
    scrollerY.forEach(function (scroller) {
      var scrollerInner = scroller.querySelector(".scroller-y__list");
      var scrollerContent = Array.from(scrollerInner.children);
      scrollerContent.forEach(function (item) {
        var duplicateItem = item.cloneNode(true);
        scrollerInner.appendChild(duplicateItem);
      });
    });
  }
  scrollerYDuplication();
});

/**
 * Header and Footer Height Calculation
 * This sets CSS variables for header and footer heights
 * to be used in the main body section for proper layout.
 */
document.addEventListener("DOMContentLoaded", function () {
  var header = document.querySelector("#header") || document.querySelector("header");
  var footer = document.querySelector("#footer") || document.querySelector("footer");
  var setHeights = function setHeights() {
    var headerHeight = (header === null || header === void 0 ? void 0 : header.offsetHeight) || 0;

    // Use getBoundingClientRect to be more precise
    var footerHeight = footer ? footer.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty("--whmcs-header-height", "".concat(headerHeight, "px"));
    document.documentElement.style.setProperty("--whmcs-footer-height", "".concat(footerHeight, "px"));
  };

  // Run once after DOM is ready
  setHeights();

  // Run again after all assets are loaded (images, fonts, etc.)
  window.addEventListener("load", setHeights);

  // Keep it updated on resize
  window.addEventListener("resize", setHeights);
});