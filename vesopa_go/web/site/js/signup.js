/*
 * go.vesopa.com/signup: a venue signs up for Vesopa Go in the browser, the
 * same steps as the app (owner, 2026-11-17):
 *
 *   0. Continue with Vesopa (PKCE, Go's own Vesopa Auth client); the code is
 *      exchanged by the back office, never here (go_onboarding.js /web/exchange)
 *   1. the venue (new accounts only) and the business
 *   2. the owner's identity: Stripe Identity's own modal (ID and live selfie)
 *   3. the business, its people and its bank: Stripe Connect's embedded
 *      onboarding
 *   4. the licence card: Stripe's Payment Element on the SetupIntent
 *
 * Nothing secret lives here: the back office makes every Stripe session, and
 * the page keeps only its own onboarding token, in this tab's sessionStorage.
 */
(function () {
  'use strict';

  var cfg = window.GO_SIGNUP || {};
  var API = String(cfg.api || 'https://backoffice.vesopaepos.com').replace(/\/+$/, '');
  // Where Vesopa Auth sends the browser back: this page. Vesopa Passport
  // (passport.vesopa.com/flow/, owner 2026-11-26) sets its own in its config.
  var REDIRECT = location.origin + (cfg.redirect || '/signup/');
  var INSTALL = cfg.install || '/install/';
  var PASSPORT = !!cfg.passport;
  var app = document.getElementById('app');

  var store = {
    get: function (k) { try { return sessionStorage.getItem('go-signup-' + k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v == null) sessionStorage.removeItem('go-signup-' + k); else sessionStorage.setItem('go-signup-' + k, v); } catch (e) { /* private window */ } },
  };

  var state = { status: null, error: null, busy: null, signupToken: store.get('signup'), email: store.get('email') };

  // ---- Talking to the back office ----

  function api(method, path, body, token) {
    var headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    var t = token === undefined ? store.get('token') : token;
    if (t) headers.Authorization = 'Bearer ' + t;
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .catch(function () { throw new Error('No connection to Vesopa. Check your internet and try again.'); })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.status === 401 && store.get('token')) {
            store.set('token', null);
          }
          if (!r.ok) throw new Error(j.error || ('Vesopa answered ' + r.status + '.'));
          return j;
        });
      });
  }

  // ---- 0. Continue with Vesopa ----

  function random(n) {
    var a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function b64url(buf) {
    var s = String.fromCharCode.apply(null, new Uint8Array(buf));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function signIn(create) {
    state.busy = 'signin';
    render();
    api('GET', '/api/go/vesopa/enabled', null, null).then(function (c) {
      if (!c.enabled || !c.clientId) throw new Error('Continue with Vesopa is not switched on yet. Try again later.');
      var verifier = random(32);
      var st = random(16);
      store.set('verifier', verifier);
      store.set('state', st);
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (h) {
        var q = new URLSearchParams({
          response_type: 'code',
          client_id: c.clientId,
          redirect_uri: REDIRECT,
          scope: 'openid profile email',
          state: st,
          nonce: random(16),
          code_challenge: b64url(h),
          code_challenge_method: 'S256',
        });
        if (create) q.set('prompt', 'create');
        location.assign(String(c.issuer || 'https://auth.vesopa.com').replace(/\/+$/, '') + '/oauth/authorize?' + q.toString());
      });
    }).catch(fail);
  }

  /** Back from Vesopa Auth with ?code=&state=. */
  function finishSignIn(params) {
    var verifier = store.get('verifier');
    var expected = store.get('state');
    history.replaceState(null, '', REDIRECT);
    store.set('verifier', null);
    store.set('state', null);
    if (params.get('error')) return Promise.reject(new Error(params.get('error_description') || 'Sign-in was cancelled.'));
    if (!verifier || params.get('state') !== expected) return Promise.reject(new Error('That sign-in did not match. Sign in again.'));
    return api('POST', '/api/go/onboarding/web/exchange', {
      code: params.get('code'), code_verifier: verifier, redirect_uri: REDIRECT,
    }, null).then(function (j) {
      if (j.token) {
        store.set('token', j.token);
        store.set('signup', null);
        state.signupToken = null;
      } else {
        store.set('signup', j.signup_token);
        state.signupToken = j.signup_token;
      }
      store.set('email', j.email || '');
      state.email = j.email || '';
    });
  }

  // ---- Status ----

  function load(refresh) {
    if (!store.get('token')) { render(); return Promise.resolve(); }
    return api('GET', '/api/go/onboarding' + (refresh ? '?refresh=1' : '')).then(function (s) {
      state.status = s;
      // After a step's own screen (or Check again): on to wherever the account now is.
      if (refresh) state.page = null;
      state.error = null;
      render();
      schedulePoll();
    }).catch(fail);
  }

  var poll = null;
  function schedulePoll() {
    clearTimeout(poll);
    var s = state.status;
    if (!s) return;
    var waiting = s.steps.identity === 'processing' || s.steps.stripe === 'in_review';
    if (waiting) poll = setTimeout(function () { load(true); }, 15000);
  }

  function fail(e) {
    state.error = (e && e.message) || String(e);
    state.busy = null;
    render();
  }

  function stripeFor(pk) {
    if (!window.Stripe) throw new Error('Stripe did not load. Check your connection, or switch off an ad blocker for this page.');
    return window.Stripe(pk);
  }

  // ---- 1. The venue and the business ----

  function registerVenue(form) {
    state.busy = 'venue';
    render();
    var d = new FormData(form);
    api('POST', '/api/go/onboarding/web/register', {
      signup_token: state.signupToken,
      venue_name: d.get('venue_name'),
      business_type: d.get('venue_type'),
      postcode: String(d.get('postcode') || '').toUpperCase(),
    }, null).then(function (j) {
      store.set('token', j.token);
      store.set('signup', null);
      state.signupToken = null;
      state.busy = null;
      return load(true);
    }).catch(fail);
  }

  function pence(v) {
    var n = parseFloat(String(v || '').replace(/[£,\s]/g, ''));
    return isFinite(n) ? Math.round(n * 100) : 0;
  }

  function saveBusiness(form) {
    state.busy = 'business';
    render();
    var d = new FormData(form);
    api('PUT', '/api/go/onboarding/business', {
      business_type: d.get('business_type'),
      legal_name: d.get('legal_name'),
      expected_monthly_minor: pence(d.get('monthly')),
      average_sale_minor: pence(d.get('average')),
    }).then(function (s) {
      state.status = s;
      state.busy = null;
      state.editing = false;
      render();
    }).catch(fail);
  }

  // ---- 2. Identity: Stripe's own modal ----

  function verifyIdentity() {
    state.busy = 'identity';
    state.error = null;
    render();
    api('POST', '/api/go/onboarding/identity', { return_url: REDIRECT }).then(function (s) {
      // Stripe will not run Identity for Vesopa's account: the ID is checked
      // in step 3 with the business and bank checks, and the sign-up goes on.
      if (s.via_connect) return null;
      return stripeFor(s.publishable_key).verifyIdentity(s.client_secret);
    }).then(function (r) {
      state.busy = null;
      if (r && r.error && r.error.code !== 'session_cancelled') state.error = r.error.message;
      return load(true);
    }).catch(fail);
  }

  // ---- 3. Stripe Connect's embedded onboarding ----

  function whenConnectLoaded() {
    return new Promise(function (resolve, reject) {
      if (window.StripeConnect && window.StripeConnect.init) return resolve(window.StripeConnect);
      var waited = 0;
      var t = setInterval(function () {
        waited += 200;
        if (window.StripeConnect && window.StripeConnect.init) { clearInterval(t); resolve(window.StripeConnect); }
        else if (waited > 15000) { clearInterval(t); reject(new Error('Stripe did not load. Check your connection, or switch off an ad blocker for this page.')); }
      }, 200);
    });
  }

  function startStripe() {
    state.busy = 'stripe';
    state.error = null;
    render();
    var first = null;
    api('POST', '/api/go/onboarding/stripe').then(function (s) {
      first = s;
      return whenConnectLoaded();
    }).then(function (SC) {
      var handed = false;
      var instance = SC.init({
        publishableKey: first.publishable_key,
        fetchClientSecret: function () {
          if (!handed) { handed = true; return Promise.resolve(first.client_secret); }
          return api('POST', '/api/go/onboarding/stripe').then(function (s) { return s.client_secret; });
        },
        appearance: { variables: { colorPrimary: '#6E8A0E', borderRadius: '10px', fontFamily: 'inherit' } },
      });
      var el = instance.create('account-onboarding');
      el.setFullTermsOfServiceUrl && el.setFullTermsOfServiceUrl(location.origin + '/terms');
      el.setPrivacyPolicyUrl && el.setPrivacyPolicyUrl(location.origin + '/privacy');
      el.setCollectionOptions && el.setCollectionOptions({ fields: 'eventually_due', futureRequirements: 'include' });
      el.setOnExit(function () {
        state.busy = null;
        state.pane = null;
        load(true);
      });
      el.setOnLoadError && el.setOnLoadError(function (e) {
        state.pane = null;
        fail(new Error((e && e.error && e.error.message) || 'Stripe\'s checks could not load. Try again.'));
      });
      state.busy = null;
      state.pane = { kind: 'stripe', el: el };
      render();
    }).catch(fail);
  }

  // ---- 4. The licence card: the Payment Element ----

  function startLicence() {
    state.busy = 'licence';
    state.error = null;
    render();
    api('POST', '/api/go/onboarding/licence').then(function (s) {
      if (s.done) { state.busy = null; return load(true); }
      var stripe = stripeFor(s.publishable_key);
      var elements = stripe.elements({ clientSecret: s.setup_intent_client_secret, appearance: { theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'stripe', variables: { colorPrimary: '#6E8A0E', borderRadius: '10px' } } });
      var payment = elements.create('payment', { layout: 'tabs' });
      state.busy = null;
      state.pane = { kind: 'licence', stripe: stripe, elements: elements, payment: payment };
      render();
    }).catch(fail);
  }

  function confirmLicence() {
    var p = state.pane;
    if (!p || p.kind !== 'licence') return;
    state.busy = 'licence-confirm';
    render();
    p.stripe.confirmSetup({ elements: p.elements, redirect: 'if_required', confirmParams: { return_url: REDIRECT } }).then(function (r) {
      state.busy = null;
      if (r.error) { state.error = r.error.message; render(); return; }
      state.pane = null;
      return load(true);
    }).catch(fail);
  }

  // ---- Drawing the page ----

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  function pounds(minor) {
    var p = (minor || 0) / 100;
    return '£' + p.toLocaleString('en-GB', { minimumFractionDigits: p % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  }

  function dateOf(iso) {
    var d = new Date(iso);
    return isNaN(d) ? 'the trial ends' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  }

  function step(n, title, tag, tagText, body, actions, current) {
    return '<section class="su-step' + (current ? ' current' : '') + '"><header><h3>' + n + '. ' + esc(title) + '</h3>'
      + '<span class="tag ' + tag + '">' + esc(tagText) + '</span></header>' + body
      + (actions ? '<div class="act">' + actions + '</div>' : '') + '</section>';
  }

  // -*-*-*-*-: one segment a step (owner, 2026-11-18), as in the app.
  function progress(s, cur) {
    var st = s.steps, lic = s.licence || {}, sk = s.skipped || [];
    var idOk = st.identity === 'verified' || (st.identity === 'via_connect' && st.stripe === 'complete');
    var parts = [
      ['Business', st.business ? 'done' : 'todo'],
      ['Identity', idOk ? 'done' : (st.identity === 'processing' || st.identity === 'via_connect' || sk.indexOf('identity') >= 0) ? 'waiting' : s.identity_error ? 'problem' : 'todo'],
      ['Checks', st.stripe === 'complete' ? 'done' : (sk.indexOf('stripe') >= 0 || (st.stripe === 'in_review' && !s.requirements_due)) ? 'waiting' : st.stripe === 'more_needed' ? 'problem' : 'todo'],
      ['Trial', (lic.status === 'trialing' || lic.status === 'active') ? 'done' : 'todo'],
      ['PIN', s.owner_pin_set ? 'done' : 'todo'],
    ];
    var done = parts.filter(function (p) { return p[1] === 'done'; }).length;
    return '<div class="su-progress" role="list" aria-label="' + done + ' of 5 steps done">'
      + parts.map(function (p, i) { return '<a href="#" class="seg ' + p[1] + (i === cur ? ' cur' : '') + '" role="listitem" data-do="page-' + i + '"><span></span><small>' + p[0] + '</small></a>'; }).join('')
      + '</div><p class="su-count">' + done + ' of 5 done</p>';
  }

  // Only what is still needed, and one line for what is done.
  function checklist(c) {
    if (!c || !c.rows) return '';
    var open = c.rows.filter(function (r) { return !r.done; });
    var done = c.rows.length - open.length;
    var items = open.map(function (r) {
      return '<li class="due"><i aria-hidden="true"></i>' + esc(r.label) + '<em>' + (r.due ? 'Needed' : 'Waiting') + '</em></li>';
    });
    if (c.other_due) items.push('<li class="due"><i aria-hidden="true"></i>' + c.other_due + ' more detail' + (c.other_due === 1 ? '' : 's') + '<em>Needed</em></li>');
    if (done) items.push('<li class="ok"><i aria-hidden="true">✓</i>' + (items.length ? done + ' of ' + c.rows.length + ' done' : 'All done') + '</li>');
    return '<ul class="su-check">' + items.join('') + '</ul>';
  }

  function skip(step) {
    state.busy = 'skip';
    render();
    return api('POST', '/api/go/onboarding/skip', { step: step }).then(function (s) { state.status = s; state.busy = null; state.page = null; render(); }).catch(fail);
  }

  function unskip(step) {
    return api('POST', '/api/go/onboarding/unskip', { step: step }).then(function (s) { state.status = s; render(); }).catch(fail);
  }

  function btn(id, text, primary, disabled) {
    return '<button type="button" class="btn ' + (primary ? 'primary' : 'ghost') + ' small" data-do="' + id + '"' + (disabled ? ' disabled' : '') + '>' + esc(text) + '</button>';
  }

  function render() {
    // While one of Stripe's forms is open it is never drawn again (that would
    // reload it and lose what was typed): only its button and error change.
    if (state.pane && state.pane.rendered) {
      var pe = document.getElementById('pane-error');
      if (pe) pe.textContent = state.error || '';
      var cb = app.querySelector('[data-do="licence-confirm"]');
      if (cb) {
        cb.disabled = !!state.busy;
        cb.textContent = state.busy === 'licence-confirm' ? 'Saving…' : 'Save card and start free trial';
      }
      return;
    }
    var h = '';
    if (state.error) h += '<p class="err" role="alert">' + esc(state.error) + '</p>';

    // Not signed in.
    if (!store.get('token') && !state.signupToken) {
      h += step(0, 'Your Vesopa account', 'todo', 'To do',
        '<p>Sign in with Vesopa, or create a Vesopa account. Already have Vesopa Go? Sign in to finish your checks.</p>',
        (PASSPORT
          // Vesopa Passport: Connect with Vesopa first; a new account is a tap away.
          ? btn('signin', state.busy === 'signin' ? 'Opening Vesopa…' : 'Connect with Vesopa', true, state.busy === 'signin')
            + btn('signup', 'Create a Vesopa account', false, state.busy === 'signin')
          : btn('signup', state.busy === 'signin' ? 'Opening Vesopa…' : 'Create a Vesopa account', true, state.busy === 'signin')
            + btn('signin', 'I already have one', false, state.busy === 'signin')), true);
      app.innerHTML = h;
      return bind();
    }

    // Signed in, no venue yet.
    if (!store.get('token')) {
      h += step(1, 'Your venue', 'todo', 'To do',
        '<p>Signed in as ' + esc(state.email) + '.</p>'
        + '<form class="f" id="venue-form">'
        + '<label>Venue name<input name="venue_name" required minlength="2" maxlength="120" autocomplete="organization"></label>'
        + '<label>Type of venue<select name="venue_type">'
        + ['Pub or bar', 'Restaurant', 'Café', 'Club', 'Market stall or pop-up', 'Events'].map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('')
        + '</select></label>'
        + '<label>Postcode<input name="postcode" required pattern="[A-Za-z]{1,2}[0-9][A-Za-z0-9]? ?[0-9][A-Za-z]{2}" autocomplete="postal-code" placeholder="SA8 4EG"></label>'
        + '<div class="act"><button class="btn primary small" type="submit"' + (state.busy ? ' disabled' : '') + '>' + (state.busy === 'venue' ? 'Setting up…' : 'Create my venue') + '</button></div>'
        + '</form>', '', true);
      app.innerHTML = h;
      return bind();
    }

    var s = state.status;
    if (!s) { app.innerHTML = h + '<p>Loading your checks…</p>'; return bind(); }
    var st = s.steps;
    var modeText = {
      test: ['Test mode', 'Everything works, but card payments are pretend until your business is checked.'],
      capped: ['Live, with limits', 'Up to ' + pounds(s.limits && s.limits.per_payment_minor) + ' a payment and ' + pounds(s.limits && s.limits.per_day_minor) + ' a day until every check below has passed.'],
      live: ['Live', 'Every check has passed. Card payments have no Vesopa limits.'],
    }[s.mode] || ['', ''];
    if (s.ready_to_use) {
      var lic0 = s.licence || {};
      h += '<section class="su-done"><div class="burst" aria-hidden="true">' + new Array(28).join('<i></i>') + '</div>'
        + '<div class="tick" aria-hidden="true">✓</div><h2>You\'re all set!</h2>'
        + '<p>' + (lic0.trial_end ? 'Your 14 days free run until ' + esc(dateOf(lic0.trial_end)) + '. We\'ve emailed you the details.' : 'Your venue is ready on Vesopa Go.') + '</p>'
        + '<div class="open"><span>EPOS</span><span>Kitchen</span><span>Display</span><span>Card terminal</span></div>'
        + ((s.pending || []).length ? '<p class="later">Still to finish: ' + (s.pending || []).map(function (p) { return p === 'identity' ? 'your identity' : 'the business and bank checks'; }).join(' and ') + '. Card payments stay limited until then.</p>' : '')
        + '<p><a class="btn primary" href="' + INSTALL + '">Get Vesopa Go on your phone</a> <a class="btn ghost" href="https://backoffice.vesopaepos.com">Open the back office</a></p></section>';
    }
    // One step at a time (owner, 2026-11-18: "only show specific tasks to each
    // progress screen so that users don't see it as heavy tasks"). The page
    // follows the server's next step until a segment above is chosen.
    var order = ['business', 'identity', 'stripe', 'licence', 'pin'];
    var cur = state.page != null ? state.page : (s.next ? Math.max(0, order.indexOf(s.next)) : 4);
    if (state.pane) cur = state.pane.kind === 'stripe' ? 2 : 3;
    var steps = [];
    h += progress(s, s.ready_to_use ? -1 : cur);
    if (!s.ready_to_use) h += '<div class="mode ' + esc(s.mode) + '"><span class="dot"></span><div><b>' + esc(modeText[0]) + '</b>' + esc(modeText[1]) + '</div></div>';

    // 1. Business
    var b = s.business || {};
    var typeLabel = (s.business_types || []).filter(function (t) { return t.id === b.type; }).map(function (t) { return t.label; })[0] || '';
    var bizBody;
    if (!st.business || state.editing) {
      bizBody = '<form class="f" id="business-form"><div class="types">'
        + (s.business_types || []).map(function (t) {
          return '<label><input type="radio" name="business_type" value="' + esc(t.id) + '" required' + (t.id === b.type ? ' checked' : '') + '>' + esc(t.label) + '</label>';
        }).join('')
        + '</div>'
        + '<label>Legal name<span class="hint">Your full name as on your ID for a sole trader; otherwise as registered (Companies House, the Charity Commission or your club\'s rules)</span><input name="legal_name" required minlength="2" maxlength="190" value="' + esc(b.legal_name || '') + '"></label>'
        + '<label>Card takings you expect a month (£)<input name="monthly" required inputmode="decimal" value="' + (b.expected_monthly_minor ? b.expected_monthly_minor / 100 : '') + '"></label>'
        + '<label>Average sale (£)<input name="average" required inputmode="decimal" value="' + (b.average_sale_minor ? b.average_sale_minor / 100 : '') + '"></label>'
        + '<div class="act"><button class="btn primary small" type="submit"' + (state.busy ? ' disabled' : '') + '>' + (state.busy === 'business' ? 'Saving…' : 'Save') + '</button></div></form>';
    } else {
      bizBody = '<p>' + esc(typeLabel) + ' · ' + esc(b.legal_name) + ' · about ' + pounds(b.expected_monthly_minor) + ' a month, ' + pounds(b.average_sale_minor) + ' average sale</p>';
    }
    steps.push(step(1, 'Your business', st.business ? 'done' : 'todo', st.business ? 'Done' : 'To do', bizBody,
      st.business && !state.editing && st.stripe === 'not_started' ? btn('edit-business', 'Change', false) : '', s.next === 'business'));

    // 2. Identity
    var viaConnect = st.identity === 'via_connect';
    var idTag = st.identity === 'verified' || (viaConnect && st.stripe === 'complete') ? ['done', 'Done']
      : viaConnect ? ['waiting', 'In step 3'] : st.identity === 'processing' ? ['waiting', 'Being checked'] : s.identity_error ? ['problem', 'Needs you'] : ['todo', 'To do'];
    var skippedId = (s.skipped || []).indexOf('identity') >= 0;
    if (skippedId && idTag[0] === 'todo') idTag = ['waiting', 'Left for later'];
    var idBody = st.identity === 'verified' ? '<p>Verified.</p>'
      : viaConnect ? '<p>' + (st.stripe === 'complete' ? 'Checked with the business and bank checks.' : 'Your photo ID is checked in the next step, with the business and bank checks.') + '</p>'
      : st.identity === 'processing' ? '<p>Your ID is being checked. This usually takes a minute or two; this page updates by itself.</p>'
        : skippedId ? '<p>Left for later. Card payments stay limited until your identity is verified.</p>'
        : '<p>' + esc(s.identity_error || 'A photo of your passport, driving licence or ID card and a live selfie, taken with your camera. On a computer without a camera, you can continue on your phone.') + '</p>';
    steps.push(step(2, 'Your identity', idTag[0], idTag[1], idBody,
      st.business && st.identity !== 'verified' && st.identity !== 'processing' && !viaConnect
        ? btn('identity', state.busy === 'identity' ? 'Opening the secure check…' : (s.identity_error ? 'Try again' : 'Verify my identity'), s.next === 'identity', !!state.busy)
          + (skippedId ? '' : btn('skip-identity', 'Skip for now', false, !!state.busy)) : '',
      s.next === 'identity'));

    // 3. Stripe
    var stTag = st.stripe === 'complete' ? ['done', 'Done'] : st.stripe === 'more_needed' ? ['problem', 'Needs you'] : st.stripe === 'in_review' && !s.requirements_due ? ['waiting', 'Being checked'] : ['todo', 'To do'];
    var skippedSt = (s.skipped || []).indexOf('stripe') >= 0;
    if (skippedSt && stTag[0] === 'todo') stTag = ['waiting', 'Left for later'];
    var stBody = ({
      complete: '<p>Your business and the bank account your takings are paid into are verified.</p>',
      in_review: '<p>Everything you sent is being reviewed. We\'ll show here if anything else is needed.</p>',
      more_needed: '<p>A little more information is needed before every limit comes off.</p>',
    }[st.stripe] || (skippedSt ? '<p>Left for later. Card payments stay limited until these checks are done.</p>' : '<p>Your business details, its directors and owners, and the bank account your takings are paid into.</p>'))
      + (st.stripe !== 'not_started' ? checklist(s.checklist) : '');
    if (state.pane && state.pane.kind === 'stripe') stBody += '<p class="err" id="pane-error" role="alert"></p><div class="pane" id="connect-onboarding"></div>';
    steps.push(step(3, 'Business and bank checks', stTag[0], stTag[1], stBody,
      st.business && st.stripe !== 'complete' && !(state.pane && state.pane.kind === 'stripe')
        ? btn('stripe', state.busy === 'stripe' ? 'Opening the secure checks…' : (st.stripe === 'not_started' ? 'Start the checks' : 'Continue the checks'), s.next === 'stripe', !!state.busy)
          + (st.stripe !== 'not_started' ? btn('refresh', 'Check again', false, !!state.busy) : '')
          + (skippedSt ? '' : btn('skip-stripe', 'Skip for now', false, !!state.busy)) : '',
      s.next === 'stripe'));

    // 4. Licence
    var lic = s.licence || {};
    var licOk = lic.status === 'trialing' || lic.status === 'active';
    var licBody = lic.status === 'trialing' ? '<p>Free until ' + esc(dateOf(lic.trial_end)) + ', then ' + pounds(lic.amount_minor) + ' a month. Cancel any time.</p>'
      : lic.status === 'active' ? '<p>' + pounds(lic.amount_minor) + ' a month.</p>'
        : '<p>' + (lic.trial_days || 14) + ' days free, then ' + pounds(lic.amount_minor || 2900) + ' a month. Add a card now; nothing is taken until the free days end.</p>';
    if (state.pane && state.pane.kind === 'licence') licBody += '<div class="pane" id="payment-element"></div><p class="err" id="pane-error" role="alert"></p>';
    var licAct = '';
    if (st.business && !licOk) {
      licAct = state.pane && state.pane.kind === 'licence'
        ? btn('licence-confirm', state.busy === 'licence-confirm' ? 'Saving…' : 'Save card and start free trial', true, !!state.busy)
        : btn('licence', state.busy === 'licence' ? 'Opening…' : 'Add a card or wallet', s.next === 'licence', !!state.busy);
    }
    steps.push(step(4, 'Start your free trial', licOk ? 'done' : (lic.status === 'past_due' || lic.status === 'unpaid') ? 'problem' : 'todo', licOk ? 'Done' : 'To do', licBody, licAct, s.next === 'licence'));

    // 5. The owner's manager PIN, once everything else is done.
    var pinBody = s.owner_pin_set
      ? '<p>Set. Staff sign in to EPOS with their own PIN; add them in the back office, Staff.</p>'
      : s.complete
        ? '<p>Choose the PIN you will sign in to EPOS with. You become the venue\'s first manager.</p>'
          + '<form class="f" id="pin-form">'
          + '<label>Your name, as staff will see it<input name="name" required minlength="2" maxlength="60" autocomplete="name"></label>'
          + '<label>PIN (4 to 6 digits)<input name="pin" required inputmode="numeric" pattern="[0-9]{4,6}" type="password" autocomplete="new-password"></label>'
          + '<label>The same PIN again<input name="again" required inputmode="numeric" pattern="[0-9]{4,6}" type="password" autocomplete="new-password"></label>'
          + '<div class="act"><button class="btn primary small" type="submit"' + (state.busy ? ' disabled' : '') + '>' + (state.busy === 'pin' ? 'Saving…' : 'Set my PIN') + '</button></div></form>'
        : '<p>Once the steps above are done, choose the PIN you sign in to EPOS with.</p>';
    steps.push(step(5, 'Your manager PIN', s.owner_pin_set ? 'done' : 'todo', s.owner_pin_set ? 'Done' : 'To do', pinBody, '', s.complete && !s.owner_pin_set));

    if (!s.ready_to_use) {
      h += steps[cur];
      var nav = '';
      if (cur > 0) nav += '<a href="#" class="su-nav" data-do="page-' + (cur - 1) + '">← Back</a>';
      if (cur < 4 && st.business) nav += '<a href="#" class="su-nav next" data-do="page-' + (cur + 1) + '">Next step →</a>';
      if (nav) h += '<div class="su-navs">' + nav + '</div>';
    }
    if (!s.ready_to_use) {
      h += '<p class="small">You can stop at any point and come back here, or finish in the Vesopa Go app (More, Account checks).</p>';
    }
    h += '<p class="small">Signed in as ' + esc(state.email || '') + ' · <a href="#" data-do="signout">Sign out</a></p>';

    app.innerHTML = h;
    if (state.pane && state.pane.kind === 'stripe') document.getElementById('connect-onboarding').appendChild(state.pane.el);
    if (state.pane && state.pane.kind === 'licence') state.pane.payment.mount('#payment-element');
    if (state.pane) {
      state.pane.rendered = true;
      var top = document.getElementById(state.pane.kind === 'stripe' ? 'connect-onboarding' : 'payment-element');
      if (top && top.scrollIntoView) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    bind();
  }

  function bind() {
    app.querySelectorAll('[data-do]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        var what = el.getAttribute('data-do');
        state.error = null;
        if (what === 'signup') signIn(true);
        else if (what === 'signin') signIn(false);
        else if (what === 'edit-business') { state.editing = true; render(); }
        else if (what === 'skip-identity') skip('identity');
        else if (what === 'skip-stripe') skip('stripe');
        else if (what === 'unskip-identity') unskip('identity');
        else if (what === 'unskip-stripe') unskip('stripe');
        else if (what === 'refresh') load(true);
        else if (what.indexOf('page-') === 0) { state.page = +what.slice(5); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
        else if (what === 'identity') verifyIdentity();
        else if (what === 'stripe') startStripe();
        else if (what === 'licence') startLicence();
        else if (what === 'licence-confirm') confirmLicence();
        else if (what === 'signout') {
          ['token', 'signup', 'email'].forEach(function (k) { store.set(k, null); });
          state.status = null; state.signupToken = null; state.pane = null;
          render();
        }
      });
    });
    var vf = document.getElementById('venue-form');
    if (vf) vf.addEventListener('submit', function (e) { e.preventDefault(); registerVenue(vf); });
    var pf = document.getElementById('pin-form');
    if (pf) pf.addEventListener('submit', function (e) {
      e.preventDefault();
      var el = pf.elements, pin = el['pin'].value;
      if (pin !== el['again'].value) return fail(new Error('The two PINs are different.'));
      if (/^(\d)\1+$/.test(pin) || '0123456789'.indexOf(pin) >= 0 || '9876543210'.indexOf(pin) >= 0) return fail(new Error('Choose a PIN that is harder to guess.'));
      state.busy = 'pin';
      render();
      api('POST', '/api/go/onboarding/owner-pin', { name: el['name'].value, pin: pin }).then(function (st) {
        state.status = st;
        state.busy = null;
        render();
      }).catch(fail);
    });
    var bf = document.getElementById('business-form');
    if (bf) bf.addEventListener('submit', function (e) {
      e.preventDefault();
      var m = pence(bf.monthly.value);
      var a = pence(bf.average.value);
      if (m < 100) return fail(new Error('Give the card takings you expect in a month.'));
      if (a < 50 || a > m) return fail(new Error('Give your average sale; it can\'t be more than a month\'s takings.'));
      saveBusiness(bf);
    });
  }

  // ---- Start ----

  var params = new URLSearchParams(location.search);
  var start = params.get('code') || params.get('error') ? finishSignIn(params) : Promise.resolve();
  // Back from a bank's card check (3-D Secure) on the licence card.
  if (params.get('setup_intent')) history.replaceState(null, '', REDIRECT);
  start.then(function () { return load(true); }).catch(fail);
  // Vesopa Passport's "Open a new account": straight to making one.
  if (PASSPORT && params.get('new') && !store.get('token') && !state.signupToken) {
    history.replaceState(null, '', REDIRECT);
    signIn(true);
  }
}());
