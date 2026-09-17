/*
 * Navigation without a full page load.
 *
 * The URL changes, the back button works, and the browser never shows its own
 * loading state — the Vesopa bar (loadbar.js) is the only "wait" on the site,
 * which is what the owner asked for and what auth.vesopa.com already does.
 *
 * WRITTEN DEFENSIVELY, BECAUSE THIS IS A CONTROL PANEL. Anything at all that
 * looks unusual — a cross-origin link, a redirect, a slow response, a document
 * that does not parse, a page that needs its own script — falls back to an
 * ordinary browser navigation. A router that traps somebody halfway through
 * paying for hosting is far worse than no router, so every branch here that is
 * not certain gives up and lets the browser do it.
 *
 * FORMS ARE INTERCEPTED TOO. A link handled here shows nothing in the browser
 * chrome; a form did, because a form is a real navigation — and forms are
 * where every long wait in this panel actually is. The request carries
 * `x-vesopa-nav: 1`, and a redirect from a route that sees that header comes
 * back as `204` with the address in `X-Vesopa-Location` rather than a `303`
 * that `fetch` would follow silently (see src/server.js). So the router always
 * knows where the server sent it, and:
 *
 *   another origin        a real navigation — the payment gateway, Vesopa auth
 *   same origin           fetch, swap, push the URL
 *   HTML back instead     a form that came back with an error; swap in place
 *   anything unexpected   submit the form again, natively, and get out of the way
 *
 * THE SCRIPTS ARE THE PART THAT NEEDS CARE. This site's JavaScript was written
 * for one page per document: app.js and panel.js bind to `document` at the top
 * level, and re-running them would answer every click twice. So:
 *
 *   shared scripts (app.js, panel.js, and these two) run ONCE per document and
 *   are told about each new page through a `vesopa:navigated` event, which is
 *   where they redo whatever decorates a page;
 *
 *   a page's own script (the domain search, the basket) is re-created with the
 *   page, because it guards on a root element and binds only to what it finds;
 *
 *   a page whose script holds state the swap would strand — the file manager,
 *   the terminal, the app-job poller — says so with `data-native-nav` on
 *   <body>, and is always reached and left by a real navigation.
 *
 *   a deploy between two clicks changes the asset stamp on app.js; a page that
 *   arrives asking for a different app.js than the one running is a new
 *   version of the site, and is loaded for real.
 */
(function () {
  'use strict';

  if (window.__vesopaNavReady) return;
  window.__vesopaNavReady = true;

  if (!window.fetch || !window.history || !window.DOMParser) return;

  var current = window.location.href;

  var bar = window.VesopaLoadbar || { start: function () {}, done: function () {} };

  /* Scripts that must not run twice. Matched on path, ignoring the ?v= stamp. */
  var SHARED = /\/assets\/js\/(app|panel|loadbar|nav|assistant)\.js$/;

  function isShared(src) {
    try {
      return SHARED.test(new URL(src, window.location.href).pathname);
    } catch (e) {
      return false;
    }
  }

  /** The shared scripts this document is running, stamp and all. */
  function sharedScripts(root) {
    var out = {};
    var scripts = root.querySelectorAll('script[src]');
    for (var i = 0; i < scripts.length; i += 1) {
      var src = scripts[i].getAttribute('src') || '';
      if (isShared(src)) out[src.replace(/\?.*$/, '')] = src;
    }
    return out;
  }

  var running = sharedScripts(document);

  /** Is this document one the router must leave to the browser? */
  function nativePage() {
    return document.body && document.body.hasAttribute('data-native-nav');
  }

  /*
   * Paths that must never be fetched in the background.
   *
   * /auth/* hands off to auth.vesopa.com, /pay/* to a gateway, and the
   * terminal and file manager hold websockets. /webmail is a different app.
   */
  var NEVER = /^\/(auth|admin\/auth|pay|api|webmail|panel\/terminal|panel\/files)(\/|$)/;

  /** Should this click be handled here, or left to the browser? */
  function shouldIntercept(link, event) {
    if (event.defaultPrevented) return false;
    if (nativePage()) return false;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return false;
    }
    if (!link || !link.href) return false;
    if (link.target && link.target !== '_self') return false;
    if (link.hasAttribute('download')) return false;
    if (link.getAttribute('rel') === 'external') return false;
    if (link.hasAttribute('data-no-router')) return false;

    var url;
    try {
      url = new URL(link.href, window.location.href);
    } catch (e) {
      return false;
    }
    if (url.origin !== window.location.origin) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) {
      return false;
    }
    if (NEVER.test(url.pathname)) return false;
    return true;
  }

  /**
   * Bring the stylesheets in line with the incoming page.
   *
   * The public pages carry sections.css, the panel carries panel.css, the
   * onboarding page its own. New sheets are added and awaited BEFORE the swap,
   * so the page never appears for a frame without its CSS; stale ones come off
   * after it.
   */
  function syncStylesheets(incoming) {
    var wanted = [];
    var links = incoming.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < links.length; i += 1) {
      wanted.push(new URL(links[i].getAttribute('href'), window.location.origin).href);
    }

    var have = {};
    var existing = document.head.querySelectorAll('link[rel="stylesheet"]');
    for (var j = 0; j < existing.length; j += 1) {
      have[existing[j].href] = existing[j];
    }

    var pending = [];
    wanted.forEach(function (href) {
      if (have[href]) {
        delete have[href];
        return;
      }
      pending.push(
        new Promise(function (resolve) {
          var link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = href;
          link.onload = resolve;
          link.onerror = resolve;
          document.head.appendChild(link);
        })
      );
    });

    return { pending: Promise.all(pending), stale: Object.keys(have).map(function (k) { return have[k]; }) };
  }

  /**
   * Re-run the page's OWN scripts, and only those.
   *
   * A script element inserted with innerHTML never executes — that is a
   * deliberate browser rule — so each page script is re-created. The shared
   * ones are left as inert elements: they are already running in this
   * document and hear about the new page through the event below.
   */
  function runScripts(container) {
    var scripts = container.querySelectorAll('script[src]');
    for (var i = 0; i < scripts.length; i += 1) {
      var old = scripts[i];
      var src = old.getAttribute('src') || '';
      if (isShared(src)) {
        // Already running here — a click from the panel to the panel. A click
        // from the public site INTO the panel brings panel.js for the first
        // time, and that one does have to run.
        var key = src.replace(/\?.*$/, '');
        if (running[key]) continue;
        running[key] = src;
      }
      var fresh = document.createElement('script');
      fresh.src = old.src;
      if (old.type) fresh.type = old.type;
      fresh.async = false;
      old.parentNode.replaceChild(fresh, old);
    }
  }

  /** Does the incoming page want a version of a shared script we are not running? */
  function siteChanged(incoming) {
    var theirs = sharedScripts(incoming);
    var keys = Object.keys(theirs);
    for (var i = 0; i < keys.length; i += 1) {
      if (running[keys[i]] && running[keys[i]] !== theirs[keys[i]]) return true;
    }
    return false;
  }

  function swap(html, url, push) {
    var incoming;
    try {
      incoming = new DOMParser().parseFromString(html, 'text/html');
    } catch (e) {
      window.location.assign(url);
      return;
    }
    if (!incoming || !incoming.body) {
      window.location.assign(url);
      return;
    }
    // A page that must own its document, or a newer build of the site.
    if (incoming.body.hasAttribute('data-native-nav') || siteChanged(incoming)) {
      window.location.assign(url);
      return;
    }

    var sheets = syncStylesheets(incoming);

    sheets.pending.then(function () {
      var settled = function () {
        window.scrollTo(0, 0);

        // Tell somebody using a screen reader that the page changed: a fake
        // navigation announces nothing, and moving focus to the heading is
        // what restores that.
        var heading = document.querySelector('h1');
        if (heading) {
          heading.setAttribute('tabindex', '-1');
          heading.focus({ preventScroll: true });
        }

        try {
          window.dispatchEvent(new CustomEvent('vesopa:navigated', { detail: { url: url } }));
        } catch (e) {
          /* An old browser without CustomEvent still gets a working page. */
        }

        bar.done();
      };

      var apply = function () {
        document.title = incoming.title || document.title;

        // <body> carries what the server decided for this page — the currency,
        // the shell's class. Everything the old page had and the new one does
        // not is taken off, or `is-admin` would follow a person out of /admin.
        var old = Array.prototype.slice.call(document.body.attributes);
        for (var k = 0; k < old.length; k += 1) {
          if (!incoming.body.hasAttribute(old[k].name)) document.body.removeAttribute(old[k].name);
        }
        var incomingAttributes = incoming.body.attributes;
        for (var i = 0; i < incomingAttributes.length; i += 1) {
          document.body.setAttribute(incomingAttributes[i].name, incomingAttributes[i].value);
        }

        document.body.innerHTML = incoming.body.innerHTML;
        runScripts(document.body);

        sheets.stale.forEach(function (link) {
          if (link.parentNode) link.parentNode.removeChild(link);
        });

        settled();
      };

      try {
        window.dispatchEvent(new CustomEvent('vesopa:navigating', { detail: { url: url } }));
      } catch (e) {
        /* nothing to tear down on a browser this old */
      }

      if (push) window.history.pushState({ vesopa: true }, '', url);
      current = url;

      if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        document.startViewTransition(apply);
      } else {
        apply();
      }
    });
  }

  function go(url, push) {
    bar.start();
    fetch(url, {
      headers: { 'x-vesopa-nav': '1', 'x-requested-with': 'vesopa-nav' },
      credentials: 'same-origin',
      redirect: 'follow',
    })
      .then(function (response) {
        // A GET that redirects — "add to basket" links, a plan's order link —
        // answers 204 with the destination in a header, the same as a form
        // post (below); the router goes there itself rather than reloading.
        var moved = response.headers.get('x-vesopa-location');
        if (moved) {
          var next;
          try {
            next = new URL(moved, window.location.href);
          } catch (e) {
            window.location.assign(moved);
            return null;
          }
          if (next.origin !== window.location.origin || NEVER.test(next.pathname)) {
            window.location.assign(next.href);
            return null;
          }
          go(next.href, push);
          return null;
        }
        // A redirect that landed somewhere else — a session expiring and
        // bouncing to /login, say — is handed to the browser, so the address
        // bar tells the truth about where the person actually is.
        if (response.redirected && response.url !== url) {
          window.location.assign(response.url);
          return null;
        }
        if (!response.ok && response.status !== 404) {
          window.location.assign(url);
          return null;
        }
        var type = response.headers.get('content-type') || '';
        if (type.indexOf('text/html') === -1) {
          window.location.assign(url);
          return null;
        }
        return response.text();
      })
      .then(function (html) {
        if (html === null || html === undefined) return;
        swap(html, url, push);
      })
      .catch(function () {
        window.location.assign(url);
      });
    // The bar is NOT finished here: every branch either swaps the page in —
    // and swap() finishes it once the content is on screen — or hands the URL
    // to the browser, where the bar keeps running through the real navigation.
  }

  // -------------------------------------------------------------------------
  // Forms
  // -------------------------------------------------------------------------

  /*
   * Where a submission goes — which the BUTTON may decide, not just the form.
   * The checkout's coupon box is a `formaction` button inside the checkout
   * form; posting it to the form's action would try to pay.
   */
  function actionOf(form, submitter) {
    var raw = (submitter && submitter.getAttribute('formaction')) || form.getAttribute('action') || window.location.href;
    return new URL(raw, window.location.href);
  }

  function shouldSubmit(form, event) {
    if (event.defaultPrevented) return false;
    if (nativePage()) return false;
    if (!form || form.hasAttribute('data-no-router')) return false;
    var submitter = event.submitter || null;
    var method = (submitter && submitter.getAttribute('formmethod')) || form.getAttribute('method') || 'get';
    if (method.toLowerCase() !== 'post') return false;

    var action;
    try {
      action = actionOf(form, submitter);
    } catch (e) {
      return false;
    }
    if (action.origin !== window.location.origin) return false;
    if (NEVER.test(action.pathname)) return false;
    return true;
  }

  function submitNatively(form, submitter) {
    form.setAttribute('data-no-router', '');
    if (form.requestSubmit) form.requestSubmit(submitter || undefined);
    else form.submit();
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!shouldSubmit(form, event)) return;

    var submitter = event.submitter || null;
    var action = actionOf(form, submitter);

    var fields;
    try {
      fields = new FormData(form);
    } catch (e) {
      return;
    }
    // The button that was pressed travels with the form. FormData does not
    // include it, and a two-action form ("Renew" / "Cancel") needs it.
    if (submitter && submitter.name) fields.append(submitter.name, submitter.value || '');

    /*
     * THE ENCODING HAS TO MATCH WHAT THE SERVER PARSES. `fetch` sends a
     * FormData as multipart, and this server parses url-encoded bodies
     * everywhere but the upload routes — so a form with no file in it is
     * sent url-encoded, exactly as a real submission would have sent it.
     */
    var hasFile = false;
    fields.forEach(function (value) {
      if (typeof File !== 'undefined' && value instanceof File) hasFile = true;
    });
    var multipart =
      hasFile ||
      String(form.getAttribute('enctype') || '').toLowerCase() === 'multipart/form-data';
    var body = multipart ? fields : new URLSearchParams(fields);

    event.preventDefault();
    bar.start();

    fetch(action.href, {
      method: 'POST',
      body: body,
      credentials: 'same-origin',
      headers: { 'x-vesopa-nav': '1', 'x-requested-with': 'vesopa-nav' },
      redirect: 'follow',
    })
      .then(function (response) {
        var moved = response.headers.get('x-vesopa-location');
        if (moved) {
          var next;
          try {
            next = new URL(moved, window.location.href);
          } catch (e) {
            window.location.assign(moved);
            return null;
          }
          if (next.origin !== window.location.origin || NEVER.test(next.pathname)) {
            // Leaving — for the gateway, or for Vesopa. The browser does this one.
            window.location.assign(next.href);
            return null;
          }
          go(next.href, true);
          return null;
        }

        if (response.redirected) {
          var landed = new URL(response.url, window.location.href);
          if (landed.origin !== window.location.origin) {
            window.location.assign(landed.href);
            return null;
          }
          return response.text().then(function (html) {
            swap(html, landed.href, true);
            return null;
          });
        }

        var type = response.headers.get('content-type') || '';
        if (type.indexOf('text/html') === -1) {
          submitNatively(form, submitter);
          return null;
        }
        return response.text().then(function (html) {
          // The form came back — a validation message. The address does not
          // change, because it did not change for a real submission either.
          swap(html, window.location.href, false);
          return null;
        });
      })
      .catch(function () {
        bar.done();
        submitNatively(form, submitter);
      });
  });

  document.addEventListener('click', function (event) {
    var link = event.target.closest ? event.target.closest('a') : null;
    if (!shouldIntercept(link, event)) return;
    event.preventDefault();
    var url = new URL(link.href, window.location.href).href;
    if (url === current) return;
    go(url, true);
  });

  window.addEventListener('popstate', function () {
    // The file manager pushes its own history entries for folders; on a page
    // like that the router has pushed nothing and has nothing to say.
    if (nativePage()) return;
    var url = window.location.href;
    if (url === current) return;
    go(url, false);
  });

  if (!nativePage()) window.history.replaceState({ vesopa: true }, '', window.location.href);

  /*
   * For a page script that needs the page fetched again without a reload —
   * the domain setup card, once its job has finished and the rest of the page
   * is out of date. `go(href, false)` re-fetches and swaps in place, adding no
   * history entry.
   */
  window.VesopaNav = { go: go };
})();
