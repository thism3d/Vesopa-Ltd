/*
 * admin.vesopa.com/ai: Vesopa AI for the owner of Vesopa (owner, 2026-11-21).
 *
 * Draws what the back office works out (vesopa_server/src/owner_ai.js) through
 * this console's own routes (/ai/api/*): the briefing, questions in plain
 * words with follow-ups, and four overviews (takings, income, devices,
 * sign-ups). Everything the server sends is escaped before it is shown.
 * Questions asked are kept in this browser only.
 */
(function () {
  'use strict';

  var app = document.getElementById('ai-app');
  if (!app) return;
  var CSRF = (document.querySelector('meta[name="csrf"]') || {}).content || '';
  var ME = app.dataset.me || 'you';
  var keep = {
    get: function (k) { try { return JSON.parse(localStorage.getItem('vesopa-ai-' + k) || 'null'); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('vesopa-ai-' + k, JSON.stringify(v)); } catch (e) { /* convenience only */ } },
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
    if (body) { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = CSRF; }
    return fetch(path, { method: method, headers: headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined })
      .catch(function () { throw new Error('No connection. Check your internet and try again.'); })
      .then(function (r) {
        if (r.redirected && /\/signin/.test(r.url)) { location.href = '/signin'; throw new Error('Signed out.'); }
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || ('admin.vesopa.com answered ' + r.status + '.'));
          return j;
        });
      });
  }

  var state = {
    tab: 'briefing',
    busy: false,
    chat: keep.get('chat:' + ME) || [],
    cache: {},
    periods: { takings: 'today', income: 'this_month', devices: 'today', signups: 'this_month' },
  };

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


  // ---- the views ---------------------------------------------------------------------

  var TABS = [['briefing', 'Briefing'], ['ask', 'Ask'], ['takings', 'Takings'], ['income', 'Income'], ['devices', 'Devices'], ['signups', 'Sign-ups']];
  var INTENTS = { takings: ['summary', 'why_change', 'venues'], income: ['revenue', 'licences'], devices: ['devices'], signups: ['signups', 'payments'] };
  var PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['last_week', 'Last week'], ['this_month', 'This month'], ['last_month', 'Last month'], ['last_30_days', '30 days']];

  function loading(label) { return '<p class="ai-muted"><span class="ai-spin"></span>' + esc(label || 'Working it out from Vesopa\'s figures…') + '</p>'; }

  function tabs() {
    return '<div class="ai-tabs" role="tablist">' + TABS.map(function (t) {
      return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (state.tab === t[0]) + '">' + esc(t[1]) + '</button>';
    }).join('') + '</div>';
  }

  function briefingView() {
    var b = state.cache.briefing;
    if (!b) { loadBriefing(); return loading('Reading every venue\'s figures…'); }
    if (b.error) return '<p class="ai-err">' + esc(b.error) + '</p>';
    var ai = b.ai;
    var t = b.today || {};
    var inc = b.income || {};
    var h = '<div class="ai-brief"><div class="hello"><span class="ai-mark sm">✦</span>' + esc(b.greeting) + ', ' + esc(b.name) + '</div>'
      + '<p class="say">' + esc(ai ? ai.answer : b.headline) + '</p>'
      + (ai && maps(ai.why).length ? '<ul class="ai-why">' + maps(ai.why).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '')
      + '<div class="ai-chips">' + ['Who owes us money?', 'Which venues are doing best this week?', 'What should I focus on this week?'].map(function (q) {
        return '<button type="button" class="ai-chip" data-ask="' + esc(q) + '">' + esc(q) + '</button>';
      }).join('') + '</div></div>';
    var left = '<div class="ai-card"><h3>Every venue today</h3><div class="sub">Against ' + esc(lc(t.compare)) + '</div>'
      + maps(t.cards).map(function (c) { return c.type === 'kpis' ? kpis(c.items) : '<div style="margin-top:14px">' + bars(c) + '</div>'; }).join('') + '</div>';
    var right = '<div class="ai-card"><h3>Vesopa income</h3><div class="sub">Subscriptions and invoices</div><p><b>' + esc(inc.headline) + '</b></p>'
      + maps(inc.cards).map(function (c) { return c.type === 'kpis' ? kpis(c.items) : ''; }).join('')
      + '<p class="ai-small ai-muted" style="margin-top:12px">' + esc((b.signups || {}).headline || '') + '</p></div>';
    var att = maps(b.alerts).length ? '<div class="ai-card"><h3>Needs you</h3><div class="sub">Last 7 days, invoices and devices</div>' + alerts(b.alerts) + '</div>' : '';
    var acts = '<div class="ai-card"><h3>What you could do</h3><div class="sub">From the figures above</div><div class="ai-next">'
      + (maps(b.actions).length ? maps(b.actions).map(function (n, i) {
        return '<div class="ai-step"><span class="n">' + (i + 1) + '</span><div><b>' + esc(n.title) + '</b><small>' + esc(n.why || '') + '</small></div></div>';
      }).join('') : '<p>Nothing stands out: takings, payments and devices look steady.</p>') + '</div></div>';
    return h + '<div class="ai-cols"><div class="ai-stack">' + left + att + '</div><div class="ai-stack">' + right + acts + '</div></div>'
      + '<div style="margin-top:16px">' + meta(b.meta, b.ai_note) + '</div>';
  }

  var SUGGESTIONS = ['How much did all venues take today?', 'Which venues are doing best this week?', 'Why did takings change this week?', 'How much is Vesopa earning each month?', 'Who owes us money?', 'Which venues have devices offline?', 'How many new venues signed up this month?', 'What should I focus on this week?'];

  function askView() {
    var h = '<div class="ai-chat">';
    if (!state.chat.length) {
      h += '<div class="ai-hero"><span class="ai-mark">✦</span><h2>Ask about the business</h2><p class="ai-muted">Answers come from every venue\'s figures and Vesopa\'s own billing, with the charts and the records behind them.</p>'
        + '<div class="ai-chips" style="justify-content:center">' + SUGGESTIONS.map(function (q) { return '<button type="button" class="ai-chip" data-ask="' + esc(q) + '">✦ ' + esc(q) + '</button>'; }).join('') + '</div></div>';
    }
    state.chat.forEach(function (t, i) {
      var last = i === state.chat.length - 1;
      h += '<div class="ai-q">' + esc(t.q) + '</div><div class="ai-a"><span class="ai-mark sm">✦</span><div>'
        + (t.pending ? loading() : t.error ? '<p class="ai-err">' + esc(t.error) + '</p>' : answer(t.a, { followUps: last && !state.busy })) + '</div></div>';
    });
    h += '</div><div class="ai-askbar"><form data-act="ask"><input id="ai-question" name="q" autocomplete="off" placeholder="Ask Vesopa AI about the business…" aria-label="Your question"' + (state.busy ? ' disabled' : '') + '>'
      + '<button class="btn primary" type="submit"' + (state.busy ? ' disabled' : '') + '>Ask</button></form>'
      + (state.chat.length ? '<p class="ai-small ai-muted" style="text-align:center;margin:8px 0 0"><button type="button" class="link" data-act="clear">Clear conversation</button> · kept in this browser only</p>' : '') + '</div>';
    return h;
  }

  function overview(tab) {
    var key = tab + ':' + state.periods[tab];
    var got = state.cache[key];
    var h = '';
    if (tab !== 'devices') {
      h += '<div class="ai-periods">' + PERIODS.map(function (p) {
        return '<button type="button" class="ai-chip" data-period="' + p[0] + '" aria-pressed="' + (state.periods[tab] === p[0]) + '">' + p[1] + '</button>';
      }).join('') + '</div>';
    }
    if (!got) { loadOverview(tab, key); return h + loading(); }
    if (got.error) return h + '<p class="ai-err">' + esc(got.error) + '</p>';
    var cards = got.map(function (a) { return '<div class="ai-card">' + answer(a, { compact: true }) + '</div>'; });
    if (cards.length === 1) return h + cards[0];
    return h + '<div class="ai-cols"><div class="ai-stack">' + cards.filter(function (_, i) { return i % 2 === 0; }).join('') + '</div><div class="ai-stack">'
      + cards.filter(function (_, i) { return i % 2 === 1; }).join('') + '</div></div>';
  }

  function render() {
    var view = state.tab === 'briefing' ? briefingView() : state.tab === 'ask' ? askView() : overview(state.tab);
    var focus = document.activeElement && document.activeElement.id === 'ai-question';
    app.innerHTML = tabs() + '<div role="tabpanel">' + view + '</div>';
    if (focus) { var q = document.getElementById('ai-question'); if (q) q.focus(); }
  }

  // ---- loading ---------------------------------------------------------------------

  function loadBriefing() {
    if (state.loadingBriefing) return;
    state.loadingBriefing = true;
    api('GET', '/ai/api/briefing').then(function (b) { state.cache.briefing = b; }, function (e) { state.cache.briefing = { error: e.message }; })
      .then(function () { state.loadingBriefing = false; render(); });
  }

  function loadOverview(tab, key) {
    if (state.cache['loading:' + key]) return;
    state.cache['loading:' + key] = true;
    Promise.all(INTENTS[tab].map(function (intent) {
      return api('POST', '/ai/api/ask', { intent: intent, period: state.periods[tab], words: false });
    })).then(function (all) { state.cache[key] = all; }, function (e) { state.cache[key] = { error: e.message }; })
      .then(function () { delete state.cache['loading:' + key]; render(); });
  }

  function previous() {
    for (var i = state.chat.length - 1; i >= 0; i--) {
      var a = state.chat[i].a;
      if (!a) continue;
      if (!a.intent || a.intent === 'unknown') return null;
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
    api('POST', '/ai/api/ask', { question: q, previous: prev || undefined })
      .then(function (a) { turn.a = a; }, function (e) { turn.error = e.message; })
      .then(function () {
        turn.pending = false;
        state.busy = false;
        state.chat = state.chat.slice(-30);
        keep.set('chat:' + ME, state.chat.filter(function (t) { return !t.pending; }));
        render();
        window.scrollTo(0, document.body.scrollHeight);
      });
  }

  function showRecords(source, period) {
    var dlg = document.getElementById('records');
    var body = document.getElementById('records-body');
    document.getElementById('records-title').textContent = 'Supporting data';
    document.getElementById('records-sub').textContent = '';
    body.innerHTML = loading('Loading the records…');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    api('GET', '/ai/api/records?source=' + encodeURIComponent(source) + '&period=' + encodeURIComponent(period))
      .then(function (d) {
        document.getElementById('records-title').textContent = d.title || 'Supporting data';
        document.getElementById('records-sub').textContent = ((d.period || {}).label || '') + ' · ' + ((d.site || {}).label || '');
        body.innerHTML = table(d.columns, d.rows) + (d.note ? '<p class="ai-muted">' + esc(d.note) + '</p>' : '');
      }, function (e) { body.innerHTML = '<p class="ai-err">' + esc(e.message) + '</p>'; });
  }

  // ---- what people press -------------------------------------------------------------

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('button');
    if (!el || !app.parentNode.contains(el)) return;
    if (el.hasAttribute('data-close')) { var d = document.getElementById('records'); if (d.close) d.close(); else d.removeAttribute('open'); return; }
    if (el.dataset.act === 'clear') { state.chat = []; keep.set('chat:' + ME, []); return render(); }
    if (el.dataset.tab) { state.tab = el.dataset.tab; return render(); }
    if (el.dataset.ask) return ask(el.dataset.ask);
    if (el.dataset.records) return showRecords(el.dataset.records, el.dataset.period);
    if (el.dataset.period) { state.periods[state.tab] = el.dataset.period; return render(); }
  });

  document.addEventListener('submit', function (ev) {
    var f = ev.target;
    if (f.dataset.act !== 'ask') return;
    ev.preventDefault();
    ask(f.elements.q.value);
  });

  render();
})();
