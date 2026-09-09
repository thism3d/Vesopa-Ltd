/*
 * Navigation without a full page load.
 *
 * The URL changes, the back button works, and the page does not flash white
 * between one screen and the next.
 *
 * WRITTEN DEFENSIVELY, BECAUSE THIS IS A SIGN-IN SITE. Anything at all that
 * looks unusual — a cross-origin link, a form, a redirect, a slow response, a
 * document that does not parse — falls back to an ordinary browser navigation.
 * A router that traps somebody halfway through signing in is far worse than no
 * router, so every branch here that is not certain gives up and lets the
 * browser do it.
 *
 * FORMS ARE INTERCEPTED TOO, and that is the change the owner asked for:
 * *"why the browser native loading is showing fix that properly no loading
 * should be on browser only load the Vesopa loading bar"*. A link handled here
 * shows nothing in the browser chrome; a form did, because a form was a real
 * navigation — and forms are where every long wait on this site actually is.
 *
 * WHAT MAKES IT SAFE, given these are the paths where being wrong costs most.
 * The request carries `x-vesopa-nav: 1`, and a redirect from a route that sees
 * that header comes back as `204` with the address in `X-Vesopa-Location`
 * rather than as a `303` that `fetch` would follow silently (see
 * src/middleware.js). So the router always knows where the server sent it, and:
 *
 *   another origin        a real navigation — an OAuth hand-off is leaving
 *   same origin           fetch, swap, push the URL
 *   HTML back instead     a form that came back with an error; swap in place
 *   anything unexpected   submit the form again, natively, and get out of the way
 *
 * A form that another script has already handled is left entirely alone —
 * `defaultPrevented` is checked, and this listener is on the bubble phase so
 * a form's own handler has always run first.
 */
(function () {
  'use strict';

  /*
   * ONCE PER DOCUMENT, NOT ONCE PER NAVIGATION.
   *
   * The no-reload router replaces the body and re-creates every
   * `script[src]` in it, because a script inserted with innerHTML never
   * runs. That is correct for a page's own setup and wrong for anything
   * that binds to `document`: without this flag a listener here is added
   * again on every navigation, and after five links a single click is
   * handled five times — five fetches, five copies, five bars.
   */
  if (window.__vesopaNavReady) return;
  window.__vesopaNavReady = true;

  if (!window.fetch || !window.history || !window.DOMParser) return;

  var current = window.location.href;

  /*
   * The progress bar, if it loaded.
   *
   * A no-reload navigation is the one case where the browser shows NOTHING at
   * all — no spinner in the tab, no dimmed page — so without this the site is
   * silent for as long as the fetch takes and the person presses again. It is
   * optional in the strictest sense: these two calls are no-ops if the script
   * was blocked.
   */
  var bar = window.VesopaLoadbar || { start: function () {}, done: function () {} };

  /** Should this click be handled here, or left to the browser? */
  function shouldIntercept(link, event) {
    if (event.defaultPrevented) return false;
    // A modified click means "open somewhere else" and is never ours.
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

    // A link to the same page with only a fragment is the browser's job.
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) {
      return false;
    }

    /*
     * Paths that must never be fetched in the background.
     *
     * /auth/* and /oauth/* redirect off this origin to Google, Apple, Microsoft
     * or GitHub — following that with fetch() would either be blocked or, worse,
     * quietly succeed and leave the person on a page that is not the one the
     * provider meant to show them. /logout is a form post. Downloads are not
     * documents.
     */
    if (/^\/(auth|oauth|webauthn|api|health|jwks|\.well-known)(\/|$)/.test(url.pathname)) {
      return false;
    }

    return true;
  }

  /**
   * Bring the stylesheets in line with the incoming page.
   *
   * Pages here load different sheets — the landing page and the docs carry
   * their own, the sign-in form deliberately does not. Swapping the body
   * without swapping these leaves the new page unstyled, which is the most
   * obvious way a router of this kind goes wrong.
   *
   * New sheets are added and awaited BEFORE the swap, so the page never appears
   * for a frame without its CSS.
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
          // Resolve either way: a stylesheet that 404s must not hang navigation.
          link.onload = resolve;
          link.onerror = resolve;
          document.head.appendChild(link);
        })
      );
    });

    // Anything left in `have` is no longer wanted — but remove it only after
    // the swap, or the outgoing page loses its styling mid-transition.
    return { pending: Promise.all(pending), stale: Object.keys(have).map(function (k) { return have[k]; }) };
  }

  /**
   * Re-run the page's own scripts.
   *
   * A script element inserted with innerHTML never executes — that is a
   * deliberate browser rule and the reason a naive router leaves the new page
   * inert. Each one is recreated so the browser treats it as new.
   *
   * The `nonce` is dropped on purpose: it belonged to the response that was
   * fetched, not to this document. The policy on this origin also allows
   * `'self'` for scripts, so a same-origin `src` is permitted without one.
   * Inline scripts are NOT re-run, because those genuinely would need this
   * document's nonce — and the only inline script here is the theme setter in
   * the head, which has already done its job.
   */
  function runScripts(container) {
    var scripts = container.querySelectorAll('script[src]');
    for (var i = 0; i < scripts.length; i += 1) {
      var old = scripts[i];
      var fresh = document.createElement('script');
      fresh.src = old.src;
      if (old.type) fresh.type = old.type;
      fresh.async = false;
      old.parentNode.replaceChild(fresh, old);
    }
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

    var sheets = syncStylesheets(incoming);

    sheets.pending.then(function () {
      var apply = function () {
        document.title = incoming.title || document.title;
        document.body.className = incoming.body.className;

        // Carry over anything the server put on <body> — the passkey feature
        // flag lives there, and the sign-in script reads it.
        var incomingAttributes = incoming.body.attributes;
        for (var i = 0; i < incomingAttributes.length; i += 1) {
          document.body.setAttribute(incomingAttributes[i].name, incomingAttributes[i].value);
        }

        document.body.innerHTML = incoming.body.innerHTML;
        runScripts(document.body);

        sheets.stale.forEach(function (link) {
          if (link.parentNode) link.parentNode.removeChild(link);
        });
      };

      // A crossfade where the browser supports it; an instant swap where it
      // does not. Never a reason to fail.
      if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        document.startViewTransition(apply);
      } else {
        apply();
      }

      if (push) window.history.pushState({ vesopa: true }, '', url);
      current = url;

      window.scrollTo(0, 0);

      /*
       * Tell somebody using a screen reader that the page changed.
       *
       * A router that only swaps the DOM is silent to assistive technology:
       * the browser announces a real navigation, and a fake one announces
       * nothing at all. Moving focus to the new heading is what restores it.
       */
      var heading = document.querySelector('h1');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }

      // The new page is on screen: the bar has something to finish against.
      bar.done();
    });
  }

  function go(url, push) {
    bar.start();
    fetch(url, {
      headers: { 'x-requested-with': 'vesopa-nav' },
      credentials: 'same-origin',
      redirect: 'follow',
    })
      .then(function (response) {
        /*
         * A redirect that landed somewhere else — a session expiring and
         * bouncing to /login, say — is handed to the browser rather than
         * swapped in, so the address bar tells the truth about where the person
         * actually is.
         */
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
    /*
     * The bar is NOT finished here. Every branch above either swaps the page in
     * — and `swap` finishes it once the new content is on screen — or hands the
     * URL to the browser, where the bar should keep running through the real
     * navigation that follows. Finishing it in a `.finally` would blink it off
     * a moment before the page it is describing actually arrives.
     */
  }

  // -------------------------------------------------------------------------
  // Forms
  // -------------------------------------------------------------------------

  /** Should this submission be handled here, or left to the browser? */
  function shouldSubmit(form, event) {
    if (event.defaultPrevented) return false;
    if (!form || form.hasAttribute('data-no-router')) return false;
    // A GET form is a search box; letting it through would need the query
    // string assembled by hand, and there is one on this site.
    if ((form.getAttribute('method') || 'get').toLowerCase() !== 'post') return false;

    var action;
    try {
      action = new URL(form.getAttribute('action') || window.location.href, window.location.href);
    } catch (e) {
      return false;
    }
    if (action.origin !== window.location.origin) return false;
    // The same refusals as a link: these paths hand off to a provider or are
    // not documents at all.
    if (/^\/(auth|webauthn|api|health|jwks|\.well-known)(\/|$)/.test(action.pathname)) return false;
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
    var action = new URL(form.getAttribute('action') || window.location.href, window.location.href);

    var fields;
    try {
      fields = new FormData(form);
    } catch (e) {
      return;
    }
    /*
     * The button that was pressed travels with the form.
     *
     * FormData does not include it — the browser adds it during a real
     * submission — and the consent screen's two buttons are the same form with
     * `decision=allow` and `decision=deny`. Losing it there would turn every
     * Allow into neither.
     */
    if (submitter && submitter.name) fields.append(submitter.name, submitter.value || '');

    /*
     * THE ENCODING HAS TO MATCH WHAT THE SERVER PARSES, and posting a FormData
     * silently does not.
     *
     * `fetch` sends a FormData as `multipart/form-data`. The server parses
     * multipart only where a route asks it to — the avatar upload — so
     * everywhere else `req.body` came back empty, `_csrf` with it, and every
     * form on the site answered **403**. It looked exactly like the router
     * working: no reload, no error page, and the same page again.
     *
     * So a form with no file in it is sent url-encoded, which is what it would
     * have sent as a real submission. `URLSearchParams` built from the
     * FormData does that and sets the header itself. A form that DOES carry a
     * file keeps its FormData — the boundary is the point there, and the one
     * route that receives one is set up for it.
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
          if (next.origin !== window.location.origin) {
            // Leaving. The browser does this one, and should.
            window.location.assign(next.href);
            return null;
          }
          go(next.href, true);
          return null;
        }

        /*
         * `response.redirected` means a redirect was followed without the
         * header — a route that answered before requestContext ran, or a
         * version of the server that predates it. The address is still known,
         * so this is recoverable rather than a reason to reload.
         */
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
          /*
           * The form came back — a wrong code, a password that is not right, a
           * validation message. The address does not change, because it did not
           * change for a real submission either: a 400 renders in place.
           */
          swap(html, window.location.href, false);
          return null;
        });
      })
      .catch(function () {
        // Offline, or the request never left. Let the browser do it, so the
        // person sees the browser's own error rather than a page that quietly
        // did nothing.
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
    var url = window.location.href;
    if (url === current) return;
    go(url, false);
  });

  // Mark the first entry so a Back from the first navigation behaves.
  window.history.replaceState({ vesopa: true }, '', window.location.href);
})();
