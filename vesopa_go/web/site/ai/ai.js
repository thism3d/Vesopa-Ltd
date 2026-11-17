/*
 * go.vesopa.com/ai: Vesopa AI on a PC or a laptop. The same answers as the
 * Vesopa AI page in the Go app, from the same back office routes
 * (vesopa_server/src/go_advisor.js), drawn in the site's colours.
 *
 *   Sign in   Continue with Vesopa (PKCE, Go's own Vesopa Auth client); the
 *             back office exchanges the code (/api/go/ai/web/exchange) and
 *             answers with a Vesopa AI session for the venue's owner, or for
 *             somebody a manager invited by email.
 *   Briefing  today so far, yesterday and why, what needs attention, what to do
 *   Ask       questions in plain words, with follow-ups
 *   Sales, Profit, Stock, People   the overviews, by period and by site
 *   Invite    owners invite people by email, and remove them
 *
 * Every figure comes from the server: this page only draws it. Everything the
 * server sends is escaped before it is shown (product and staff names are the
 * venue's own text). The session lives in this tab's sessionStorage; the
 * questions asked are kept in this browser only (localStorage).
 */
(function () {
  'use strict';

  var cfg = window.GO_SIGNUP || {};
  var API = String(cfg.api || 'https://backoffice.vesopaepos.com').replace(/\/+$/, '');
  var REDIRECT = location.origin + '/ai/';
  var app = document.getElementById('app');

  var store = {
    get: function (k) { try { return sessionStorage.getItem('go-ai-' + k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v == null) sessionStorage.removeItem('go-ai-' + k); else sessionStorage.setItem('go-ai-' + k, v); } catch (e) { /* private window */ } },
  };
  var keep = {
    get: function (k) { try { return JSON.parse(localStorage.getItem('go-ai-' + k) || 'null'); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('go-ai-' + k, JSON.stringify(v)); } catch (e) { /* convenience only */ } },
  };

  var state = {
    session: null,
    tab: 'briefing',
    site: null,
    error: null,
    busy: false,
    chat: [],
    periods: { sales: 'today', profit: 'last_30_days', stock: 'last_30_days', people: 'this_week' },
  };

  // ---- helpers ----------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(minor) {
    var n = Math.round(Number(minor) || 0);
    var neg = n < 0;
    var a = Math.abs(n);
    return (neg ? '-' : '') + '£' + Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + String(a % 100).padStart(2, '0');
  }
  function num(v) { return Number(v) === Math.round(Number(v)) ? String(Math.round(Number(v))) : Number(v).toFixed(1); }
  function fmt(v, kind) {
    if (v == null || v === '') return '–';
    if (typeof v !== 'number') return esc(v);
    if (kind === 'money') return money(v);
    if (kind === 'pct') return num(v) + '%';
    if (kind === 'days') return num(v) + ' d';
    return num(v);
  }
  function lc(s) { s = String(s || ''); return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

  function api(method, path, body) {
    var headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    var t = store.get('token');
    if (t) headers['X-Vesopa-AI'] = t;
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .catch(function () { throw new Error('No connection to Vesopa. Check your internet and try again.'); })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if ((r.status === 401 || (r.status === 403 && j.code === 'not_invited')) && t) {
            store.set('token', null);
            store.set('session', null);
            state.session = null;
          }
          if (!r.ok) {
            var e = new Error(j.error || ('Vesopa answered ' + r.status + '.'));
            e.status = r.status;
            throw e;
          }
          return j;
        });
      });
  }

  // ---- signing in ---------------------------------------------------------------

  function random(n) {
    var a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function b64url(buf) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function signIn() {
    state.busy = true;
    render();
    api('GET', '/api/go/vesopa/enabled').then(function (c) {
      if (!c.enabled || !c.clientId) throw new Error('Continue with Vesopa is not switched on yet. Try again later.');
      var verifier = random(32);
      var st = random(16);
      store.set('verifier', verifier);
      store.set('state', st);
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (h) {
        var q = new URLSearchParams({
          response_type: 'code', client_id: c.clientId, redirect_uri: REDIRECT, scope: 'openid profile email',
          state: st, nonce: random(16), code_challenge: b64url(h), code_challenge_method: 'S256',
        });
        location.assign(String(c.issuer || 'https://auth.vesopa.com').replace(/\/+$/, '') + '/oauth/authorize?' + q.toString());
      });
    }).catch(fail);
  }

  function finishSignIn(params) {
    var verifier = store.get('verifier');
    var expected = store.get('state');
    history.replaceState(null, '', REDIRECT);
    store.set('verifier', null);
    store.set('state', null);
    if (params.get('error')) return Promise.reject(new Error(params.get('error_description') || 'Sign-in was cancelled.'));
    if (!verifier || params.get('state') !== expected) return Promise.reject(new Error('That sign-in did not match. Sign in again.'));
    return api('POST', '/api/go/ai/web/exchange', { code: params.get('code'), code_verifier: verifier, redirect_uri: REDIRECT })
      .then(function (s) {
        store.set('token', s.token);
        store.set('session', JSON.stringify(s));
        startSession(s);
      });
  }

  function startSession(s) {
    state.session = s;
    state.site = s.site == null ? null : s.site;
    state.chat = keep.get('chat:' + s.email) || [];
  }

  function signOut() {
    store.set('token', null);
    store.set('session', null);
    state.session = null;
    state.cache = {};
    render();
  }

  function fail(e) {
    state.busy = false;
    state.error = e && e.message ? e.message : String(e);
    render();
  }

  // ---- drawing an answer ------------------------------------------------------------

  function maps(x) { return Array.isArray(x) ? x : []; }

  function kpis(items) {
    return '<div class="ai-kpis">' + maps(items).map(function (k) {
      var ch = k.change_pct;
      var c = '';
      if (ch != null) {
        var up = ch > 0;
        var good = ch === 0 ? null : (up === ((k.good_when || 'up') === 'up'));
        c = '<div class="ai-ch ' + (good == null ? 'flat' : good ? 'good' : 'bad') + '">' + (ch === 0 ? '–' : up ? '▲ ' : '▼ ') + num(Math.abs(ch)) + (k.kind === 'pct' ? ' pts' : '%') + '</div>';
      }
      return '<div class="ai-kpi"><div class="l">' + esc(k.label) + '</div><div class="v">' + fmt(k.value, k.kind) + '</div>' + c + '</div>';
    }).join('') + '</div>';
  }

  function bars(card) {
    var items = maps(card.items);
    if (!items.length) return '<p class="ai-muted">Nothing in this period yet.</p>';
    var kind = card.kind || 'money';
    var hourly = items.length > 1 && items.every(function (i) { return /^\d\d$/.test(String(i.label)); });
    var compare = items.some(function (i) { return i.compare; });
    var top = 0;
    items.forEach(function (i) { top = Math.max(top, Math.abs(i.value || 0), Math.abs(i.compare || 0)); });
    top = top || 1;
    var legend = compare ? '<div class="ai-legend"><span>This period</span><span class="g">' + esc(card.compare_label || 'Before') + '</span></div>' : '';
    if (hourly) {
      var best = items.reduce(function (b, i) { return (i.value || 0) > (b.value || 0) ? i : b; }, items[0]);
      return '<div class="ai-hours" role="img" aria-label="' + esc(card.title || 'Revenue by hour') + '">' + items.map(function (i) {
        return '<div class="col" title="' + esc(i.label) + ':00 ' + fmt(i.value, kind) + (compare ? ' (was ' + fmt(i.compare || 0, kind) + ')' : '') + '">'
          + (compare ? '<i class="ghost" style="height:' + Math.max(2, (i.compare || 0) / top * 100) + '%"></i>' : '')
          + '<i class="' + (i === best ? 'best' : '') + '" style="height:' + Math.max(2, (i.value || 0) / top * 100) + '%"></i></div>';
      }).join('') + '</div><div class="ai-hours-foot"><span>' + esc(items[0].label) + ':00</span><b>Busiest ' + esc(best.label) + ':00 · ' + fmt(best.value, kind)
        + '</b><span>' + esc(items[items.length - 1].label) + ':00</span></div>' + legend;
    }
    return '<div class="ai-bars">' + items.map(function (i) {
      var v = i.value || 0;
      var cls = card.signed ? (v < 0 ? 'neg' : 'pos') : '';
      return '<div class="ai-bar-row"><div class="top"><span class="name">' + esc(i.label) + '</span>'
        + (i.compare ? '<span class="was">was ' + fmt(i.compare, kind) + '</span>' : '')
        + '<span class="val ' + cls + '">' + (card.signed && v > 0 ? '+' : '') + fmt(v, kind) + '</span></div>'
        + '<div class="ai-track">' + (i.compare ? '<i class="ghost" style="width:' + Math.max(1, Math.abs(i.compare) / top * 100) + '%"></i>' : '')
        + '<i class="' + cls + '" style="width:' + Math.max(1, Math.abs(v) / top * 100) + '%"></i></div></div>';
    }).join('') + '</div>' + legend;
  }

  function drivers(card) {
    var row = function (label, detail, v, total) {
      return '<div class="ai-drv' + (total ? ' total' : '') + '"><div><b>' + esc(label) + '</b>' + (detail ? '<small>' + esc(detail) + '</small>' : '')
        + '</div><span class="amt ' + (v < 0 ? 'neg' : v > 0 ? 'pos' : '') + '">' + (v > 0 ? '+' : '') + money(v) + '</span></div>';
    };
    return maps(card.items).map(function (i) { return row(i.label, i.detail, i.value_minor || 0); }).join('') + row('Difference', '', card.total_minor || 0, true);
  }

  function table(columns, rows, limit) {
    rows = maps(rows);
    if (!rows.length) return '<p class="ai-muted">Nothing to show for this period.</p>';
    var shown = limit ? rows.slice(0, limit) : rows;
    return '<div class="ai-table-wrap"><table class="ai-table"><thead><tr>' + maps(columns).map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('')
      + '</tr></thead><tbody>' + shown.map(function (r) {
        return '<tr>' + maps(columns).map(function (c) { return '<td>' + fmt(r[c.key], c.kind) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function alerts(items) {
    return maps(items).map(function (a) {
      return '<div class="ai-alert ' + esc(a.tone) + '"><span class="dot"></span><div><b>' + esc(a.title) + '</b><small>' + esc(a.detail || '') + '</small></div></div>';
    }).join('');
  }

  function card(c, compact) {
    if (c.type === 'kpis') return kpis(c.items);
    var body = c.type === 'bars' ? bars(c) : c.type === 'drivers' ? drivers(c) : c.type === 'table' ? table(c.columns, c.rows, compact ? 8 : 0) : c.type === 'alerts' ? alerts(c.items) : '';
    return '<div class="ai-card"><h3>' + esc(c.title || (c.type === 'alerts' ? 'Needs attention' : '')) + '</h3><div class="sub"></div>' + body + '</div>';
  }

  function meta(m, note) {
    if (!m || !m.period) return '';
    var fresh = m.freshness || {};
    var defs = maps(m.definitions);
    var rec = m.records || {};
    return '<div class="ai-meta">'
      + '<div>📅 ' + esc(m.period.label) + (m.compare ? ' · against ' + esc(lc(m.compare.label)) : '') + '</div>'
      + '<div>🏬 ' + esc((m.site || {}).label || '') + '</div>'
      + '<div>🔄 ' + (fresh.last_sale_at ? 'Latest sale received ' + esc(String(fresh.last_sale_at).slice(0, 16)) + ' · worked out ' + esc(String(fresh.computed_at || '').slice(11, 16)) : 'No sales recorded yet') + '</div>'
      + (note ? '<div>ℹ️ ' + esc(note) + '</div>' : '')
      + '<div class="acts">' + (defs.length ? '<details><summary>Definitions</summary>' + defs.map(function (d) { return '<p>' + esc(d) + '</p>'; }).join('')
        + (fresh.note ? '<p class="ai-muted">' + esc(fresh.note) + '</p>' : '') + '<p class="ai-muted">Every figure is calculated by the Vesopa server from your EPOS records. Vesopa AI only explains it and never changes anything.</p></details>' : '<span></span>')
      + (rec.source ? '<button type="button" class="ai-link" data-records="' + esc(rec.source) + '" data-period="' + esc(rec.period || 'today') + '" data-site="' + (rec.site == null ? '' : esc(rec.site)) + '">View data</button>' : '')
      + '</div></div>';
  }

  function answer(a, opts) {
    opts = opts || {};
    var ai = a.ai || null;
    var why = maps(ai ? ai.why : a.why);
    var next = maps(ai ? ai.next : a.next);
    var h = '<div class="ai-answer">';
    if (a.title) h += '<div class="ai-eyebrow">' + esc(a.title) + '</div>';
    h += ai ? '<p class="ai-say">' + esc(ai.answer) + '</p><p class="ai-plain">' + esc(a.headline) + '</p>' : '<p class="ai-say">' + esc(a.headline) + '</p>';
    if (why.length) h += '<ul class="ai-why">' + why.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
    if (next.length) {
      h += '<div class="ai-card"><h3>What you could do next</h3><div class="sub"></div><div class="ai-next">' + next.map(function (n, i) {
        return '<div class="ai-step"><span class="n">' + (i + 1) + '</span><div><b>' + esc(n.title) + '</b><small>' + esc(n.why || '') + '</small></div></div>';
      }).join('') + '</div></div>';
    }
    maps(a.cards).forEach(function (c) { h += card(c, opts.compact); });
    h += meta(a.meta, a.ai_note);
    if (opts.followUps && maps(a.follow_ups).length) {
      h += '<div class="ai-chips">' + maps(a.follow_ups).map(function (f) { return '<button type="button" class="ai-chip" data-ask="' + esc(f) + '">↳ ' + esc(f) + '</button>'; }).join('') + '</div>';
    }
    return h + '</div>';
  }

  // ---- the views -------------------------------------------------------------------

  var TABS = [['briefing', 'Briefing'], ['ask', 'Ask'], ['sales', 'Sales'], ['profit', 'Profit'], ['stock', 'Stock'], ['people', 'People']];
  var INTENTS = { sales: ['summary', 'why_change', 'hours'], profit: ['profit', 'top_products', 'loss_makers'], stock: ['stock', 'stock_movers'], people: ['staff', 'branches'] };
  var PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['last_week', 'Last week'], ['this_month', 'This month'], ['last_30_days', '30 days']];
  state.cache = {};

  function signedOut() {
    return '<section class="ai-hero"><span class="ai-mark">✦</span><h1>Vesopa AI</h1>'
      + '<p class="lead">Don\'t just see your business. Understand it. A daily briefing and plain-English answers about your sales, profit, stock and team, from your own Vesopa EPOS figures, on your PC or laptop.</p>'
      + (state.error ? '<p class="ai-err">' + esc(state.error) + '</p>' : '')
      + '<div class="cta"><button type="button" class="btn primary" data-act="signin"' + (state.busy ? ' disabled' : '') + '>' + (state.busy ? 'Opening Vesopa…' : 'Sign in with Vesopa') + '</button>'
      + '<a class="btn ghost" href="/get-started/">New to Vesopa?</a></div>'
      + '<div class="ai-points">'
      + '<div><b>For the owner</b>Sign in with the Vesopa account your venue is registered under.</div>'
      + '<div><b>For your team</b>Anyone the owner or a manager invites by email signs in with that email.</div>'
      + '<div><b>Your figures only</b>Worked out by Vesopa from your own sales. Read-only: it never changes anything.</div>'
      + '<div><b>Also in the app</b>The same Vesopa AI is in Vesopa Go on iPhone, iPad and Android.</div>'
      + '</div></section>';
  }

  function bar() {
    var s = state.session;
    var sites = maps(s.sites);
    var picker = '';
    if (sites.length) {
      picker = s.site != null
        ? '<span class="ai-muted">🔒 ' + esc(sites[0] ? sites[0].name : 'One site') + '</span>'
        : '<label class="ai-muted">Site <select data-act="site"><option value="">All sites</option>' + sites.map(function (x) {
          return '<option value="' + esc(x.id) + '"' + (state.site === x.id ? ' selected' : '') + '>' + esc(x.name) + '</option>';
        }).join('') + '</select></label>';
    }
    var tabs = TABS.concat(s.can_invite ? [['invite', 'Invite people']] : []);
    return '<div class="ai-bar"><span class="ai-mark sm">✦</span><div class="who"><b>' + esc(s.venue || 'Vesopa AI') + '</b><span class="ai-muted ai-small">'
      + esc(s.name) + ' · ' + esc(s.role === 'owner' ? 'Owner' : 'Invited') + '</span></div>' + picker
      + '<button type="button" class="btn small ghost" data-act="signout">Sign out</button></div>'
      + '<div class="ai-tabs" role="tablist">' + tabs.map(function (t) {
        return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (state.tab === t[0]) + '">' + esc(t[1]) + '</button>';
      }).join('') + '</div>';
  }

  function loading(label) { return '<p class="ai-muted"><span class="ai-spin"></span>' + esc(label || 'Working it out from your figures…') + '</p>'; }

  function briefingView() {
    var b = state.cache.briefing;
    if (!b) { loadBriefing(); return loading('Reading today\'s figures…'); }
    if (b.error) return '<p class="ai-err">' + esc(b.error) + '</p>';
    var ai = b.ai;
    var y = b.yesterday || {};
    var t = b.today || {};
    var h = '<div class="ai-brief"><div class="hello"><span class="ai-mark sm">✦</span>' + esc(b.greeting) + ', ' + esc(b.name) + '</div>'
      + '<p class="say">' + esc(ai ? ai.answer : b.headline) + '</p>'
      + (ai && maps(ai.why).length ? '<ul class="ai-why">' + maps(ai.why).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '')
      + '<div class="ai-chips">' + ['Why did sales change yesterday?', 'What should I focus on tomorrow?', 'What stock should I reorder?'].map(function (q) {
        return '<button type="button" class="ai-chip" data-ask="' + esc(q) + '">' + esc(q) + '</button>';
      }).join('') + '</div></div>';
    var left = '<div class="ai-card"><h3>Today so far</h3><div class="sub">Against ' + esc(lc(t.compare)) + '</div>'
      + maps(t.cards).map(function (c) { return c.type === 'kpis' ? kpis(c.items) : '<div style="margin-top:14px">' + bars(c) + '</div>'; }).join('') + '</div>';
    var right = '<div class="ai-card"><h3>Yesterday</h3><div class="sub">' + esc(y.label) + '</div><p><b>' + esc(y.headline) + '</b></p>'
      + (maps(y.why).length ? '<ul class="ai-why">' + maps(y.why).slice(0, 3).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '')
      + maps(y.cards).filter(function (c) { return c.type === 'drivers'; }).map(drivers).join('')
      + '<p><button type="button" class="ai-link" data-ask="Why did sales change yesterday?">✦ Explain yesterday</button></p></div>';
    var att = maps(b.alerts).length ? '<div class="ai-card"><h3>Needs attention</h3><div class="sub">Last 7 days and stock</div>' + alerts(b.alerts) + '</div>' : '';
    var acts = '<div class="ai-card"><h3>What you could do</h3><div class="sub">From the last 7 days against the 7 before</div><div class="ai-next">'
      + (maps(b.actions).length ? maps(b.actions).map(function (n, i) {
        return '<div class="ai-step"><span class="n">' + (i + 1) + '</span><div><b>' + esc(n.title) + '</b><small>' + esc(n.why || '') + '</small></div></div>';
      }).join('') : '<p>Nothing stands out: sales, stock and margins look steady.</p>') + '</div></div>';
    return h + '<div class="ai-cols"><div class="ai-stack">' + left + att + '</div><div class="ai-stack">' + right + acts + '</div></div>'
      + '<div style="margin-top:16px">' + meta(b.meta, b.ai_note) + '</div>';
  }

  function askView() {
    var s = state.session;
    var h = '<div class="ai-chat">';
    if (!state.chat.length) {
      h += '<div class="ai-hero" style="margin:10px auto"><span class="ai-mark">✦</span><h2>Ask about your business</h2><p class="ai-muted">Answers come from your own Vesopa EPOS figures, with the charts and the records behind them.</p>'
        + '<div class="ai-chips" style="justify-content:center">' + maps(s.suggestions).map(function (q) { return '<button type="button" class="ai-chip" data-ask="' + esc(q) + '">✦ ' + esc(q) + '</button>'; }).join('') + '</div></div>';
    }
    state.chat.forEach(function (t, i) {
      var last = i === state.chat.length - 1;
      h += '<div class="ai-q">' + esc(t.q) + '</div><div class="ai-a"><span class="ai-mark sm">✦</span><div>'
        + (t.pending ? loading() : t.error ? '<p class="ai-err">' + esc(t.error) + '</p>' : answer(t.a, { followUps: last && !state.busy })) + '</div></div>';
    });
    h += '</div><div class="ai-askbar"><form data-act="ask"><input id="ai-question" name="q" autocomplete="off" placeholder="Ask Vesopa AI about your business…" aria-label="Your question"' + (state.busy ? ' disabled' : '') + '>'
      + '<button class="btn primary" type="submit"' + (state.busy ? ' disabled' : '') + '>Ask</button></form>'
      + (state.chat.length ? '<p class="ai-small ai-muted" style="text-align:center;margin:8px 0 0"><button type="button" class="ai-link" data-act="clear">Clear conversation</button> · kept in this browser only</p>' : '') + '</div>';
    return h;
  }

  function overview(tab) {
    var key = tab + ':' + (state.periods[tab]) + ':' + (state.site == null ? '' : state.site);
    var got = state.cache[key];
    var h = '';
    if (tab !== 'stock') {
      h += '<div class="ai-periods">' + PERIODS.map(function (p) {
        return '<button type="button" class="ai-chip" data-period="' + p[0] + '" aria-pressed="' + (state.periods[tab] === p[0]) + '">' + p[1] + '</button>';
      }).join('') + '</div>';
    }
    if (!got) { loadOverview(tab, key); return h + loading(); }
    if (got.error) return h + '<p class="ai-err">' + esc(got.error) + '</p>';
    var cards = got.map(function (a) { return '<div class="ai-card">' + answer(a, { compact: true }) + '</div>'; });
    var left = cards.filter(function (_, i) { return i % 2 === 0; }).join('');
    var right = cards.filter(function (_, i) { return i % 2 === 1; }).join('');
    return h + '<div class="ai-cols"><div class="ai-stack">' + left + '</div><div class="ai-stack">' + right + '</div></div>';
  }

  function inviteView() {
    var s = state.session;
    var inv = state.cache.invites;
    if (!inv) loadInvites();
    var sites = maps(s.sites);
    return '<div class="ai-cols"><div class="ai-card"><h3>Invite by email</h3><div class="sub">Owners and managers always have access. Invite anyone else who should see the figures.</div>'
      + '<form data-act="invite" style="display:grid;gap:12px">'
      + '<label class="ai-muted">Their email address<br><input class="ai-input" style="width:100%" type="email" name="email" required autocomplete="off"></label>'
      + (sites.length ? '<label class="ai-muted">What they may see<br><select name="site" class="ai-input" style="width:100%"><option value="">Every site</option>' + sites.map(function (x) {
        return '<option value="' + esc(x.id) + '">' + esc(x.name) + ' only</option>';
      }).join('') + '</select></label>' : '')
      + '<button class="btn primary" type="submit">Send invite</button></form>'
      + '<p class="ai-small ai-muted">They get an email. On a PC or laptop they sign in here with that email; in the Vesopa Go app they type the code from the email.</p>'
      + (state.inviteMsg ? '<p><b>' + esc(state.inviteMsg) + '</b></p>' : '') + '</div>'
      + '<div class="ai-card"><h3>Invited</h3><div class="sub"></div>'
      + (!inv ? loading('Loading…') : inv.error ? '<p class="ai-err">' + esc(inv.error) + '</p>' : !inv.length ? '<p>Nobody yet.</p>'
        : inv.map(function (i) {
          var status = { active: 'Has access', pending: 'Invite sent, not used yet', expired: 'Invite expired', revoked: 'Removed' }[i.status] || i.status;
          return '<div class="ai-drv"><div><b>' + esc(i.staff || i.email) + '</b><small>' + (i.staff ? esc(i.email) + ' · ' : '') + esc(status) + ' · '
            + esc(i.site ? i.site.name + ' only' : 'every site') + '</small></div>'
            + (i.status === 'active' || i.status === 'pending' ? '<button type="button" class="btn small ghost" data-revoke="' + esc(i.id) + '">Remove access</button>' : '') + '</div>';
        }).join('')) + '</div></div>';
  }

  function render() {
    if (!state.session) { app.innerHTML = signedOut(); return; }
    var view = state.tab === 'briefing' ? briefingView() : state.tab === 'ask' ? askView() : state.tab === 'invite' ? inviteView() : overview(state.tab);
    var focus = document.activeElement && document.activeElement.id === 'ai-question';
    app.innerHTML = bar() + '<div role="tabpanel">' + view + '</div>';
    if (focus || (state.tab === 'ask' && !state.busy && state.chat.length)) {
      var q = document.getElementById('ai-question');
      if (q && focus) q.focus();
    }
  }

  // ---- loading ---------------------------------------------------------------------

  function siteQuery(prefix) { return state.site == null ? '' : prefix + 'site=' + encodeURIComponent(state.site); }

  function loadBriefing() {
    if (state.loadingBriefing) return;
    state.loadingBriefing = true;
    api('GET', '/api/go/ai/briefing' + siteQuery('?')).then(function (b) { state.cache.briefing = b; }, function (e) { state.cache.briefing = { error: e.message }; })
      .then(function () { state.loadingBriefing = false; render(); });
  }

  function loadOverview(tab, key) {
    if (state.cache['loading:' + key]) return;
    state.cache['loading:' + key] = true;
    Promise.all(INTENTS[tab].map(function (intent) {
      return api('POST', '/api/go/ai/ask', { intent: intent, period: state.periods[tab], site: state.site == null ? undefined : state.site, words: false });
    })).then(function (all) { state.cache[key] = all; }, function (e) { state.cache[key] = { error: e.message }; })
      .then(function () { delete state.cache['loading:' + key]; render(); });
  }

  function loadInvites() {
    if (state.loadingInvites) return;
    state.loadingInvites = true;
    api('GET', '/api/go/ai/invites').then(function (r) { state.cache.invites = maps(r.invites); }, function (e) { state.cache.invites = { error: e.message }; })
      .then(function () { state.loadingInvites = false; render(); });
  }

  function previous() {
    for (var i = state.chat.length - 1; i >= 0; i--) {
      var a = state.chat[i].a;
      if (!a) continue;
      if (!a.intent || a.intent === 'unknown' || a.intent === 'read_only') return null;
      return { intent: a.intent, period: a.meta && a.meta.period ? a.meta.period.key : null };
    }
    return null;
  }

  function ask(q) {
    q = String(q || '').trim();
    if (!q || state.busy) return;
    state.tab = 'ask';
    var turn = { q: q, pending: true };
    var prev = previous();
    state.chat.push(turn);
    state.busy = true;
    render();
    window.scrollTo(0, document.body.scrollHeight);
    api('POST', '/api/go/ai/ask', { question: q, previous: prev || undefined, site: state.site == null ? undefined : state.site })
      .then(function (a) { turn.a = a; }, function (e) { turn.error = e.message; })
      .then(function () {
        turn.pending = false;
        state.busy = false;
        state.chat = state.chat.slice(-30);
        keep.set('chat:' + state.session.email, state.chat.filter(function (t) { return !t.pending; }));
        if (!state.session) { render(); return; }
        render();
        window.scrollTo(0, document.body.scrollHeight);
      });
  }

  function showRecords(source, period, site) {
    var dlg = document.getElementById('records');
    var body = document.getElementById('records-body');
    document.getElementById('records-title').textContent = 'Supporting data';
    document.getElementById('records-sub').textContent = '';
    body.innerHTML = loading('Loading the records…');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    api('GET', '/api/go/ai/records?source=' + encodeURIComponent(source) + '&period=' + encodeURIComponent(period) + (site ? '&site=' + encodeURIComponent(site) : ''))
      .then(function (d) {
        document.getElementById('records-title').textContent = d.title || 'Supporting data';
        document.getElementById('records-sub').textContent = ((d.period || {}).label || '') + ' · ' + ((d.site || {}).label || '');
        body.innerHTML = table(d.columns, d.rows) + (d.note ? '<p class="ai-muted">' + esc(d.note) + '</p>' : '');
      }, function (e) { body.innerHTML = '<p class="ai-err">' + esc(e.message) + '</p>'; });
  }

  // ---- what people press -------------------------------------------------------------

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('button, [data-tab]');
    if (!el) return;
    if (el.hasAttribute('data-close')) { var d = document.getElementById('records'); if (d.close) d.close(); else d.removeAttribute('open'); return; }
    if (el.dataset.act === 'signin') return signIn();
    if (el.dataset.act === 'signout') return signOut();
    if (el.dataset.act === 'clear') { state.chat = []; keep.set('chat:' + state.session.email, []); return render(); }
    if (el.dataset.tab) { state.tab = el.dataset.tab; state.inviteMsg = null; return render(); }
    if (el.dataset.ask) return ask(el.dataset.ask);
    if (el.dataset.records) return showRecords(el.dataset.records, el.dataset.period, el.dataset.site);
    if (el.dataset.period && !el.dataset.records) { state.periods[state.tab] = el.dataset.period; return render(); }
    if (el.dataset.revoke) {
      if (!window.confirm || el.dataset.sure === 'yes') {
        el.disabled = true;
        return api('DELETE', '/api/go/ai/invites/' + encodeURIComponent(el.dataset.revoke)).then(function () { state.cache.invites = null; render(); }, fail);
      }
      el.dataset.sure = 'yes';
      el.textContent = 'Press again to remove';
    }
  });

  document.addEventListener('change', function (ev) {
    if (ev.target.dataset && ev.target.dataset.act === 'site') {
      state.site = ev.target.value === '' ? null : Number(ev.target.value);
      state.cache = { invites: state.cache.invites };
      render();
    }
  });

  document.addEventListener('submit', function (ev) {
    var f = ev.target;
    if (f.dataset.act === 'ask') {
      ev.preventDefault();
      ask(f.elements.q.value);
    } else if (f.dataset.act === 'invite') {
      ev.preventDefault();
      var email = f.elements.email.value.trim();
      var site = f.elements.site && f.elements.site.value !== '' ? Number(f.elements.site.value) : undefined;
      api('POST', '/api/go/ai/invites', { email: email, site_id: site }).then(function (r) {
        state.inviteMsg = r.message;
        state.cache.invites = null;
        render();
      }, function (e) { state.inviteMsg = e.message; render(); });
    }
  });

  // ---- start -------------------------------------------------------------------------

  var params = new URLSearchParams(location.search);
  var saved = store.get('session');
  var start = params.get('code') || params.get('error')
    ? finishSignIn(params)
    : Promise.resolve(saved && store.get('token') ? startSession(JSON.parse(saved)) : null);
  start.then(function () { state.busy = false; render(); }, fail);
})();
