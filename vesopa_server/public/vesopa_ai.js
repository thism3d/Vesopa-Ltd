/**
 * Vesopa AI in the back office (2026-11-16).
 *
 * "A business owner should be able to open Vesopa Go, tap Vesopa AI and
 * immediately understand what is happening in their business." The same here:
 * the page opens on the daily briefing, with Ask one tab away and the four
 * intelligence tabs (Sales, Stock, Profit, Team & sites) after it.
 *
 * Every number on this page comes from the server (src/ai_metrics.js); this
 * file only lays it out. An answer always shows its period, site, what the
 * figure means and how fresh it is, and offers the records behind it.
 *
 * Loaded before app.js like stock.js: app.js's VIEW_LOADERS calls loadVesopaAi();
 * everything here uses app.js's `$`, `api`, `esc` and `toast` only from inside
 * calls. Charts are charts.js's, so they follow Day and Night.
 */

/* global $, api, esc, toast, Charts */

const VAI = {
  me: null,
  tab: 'brief',
  site: '',
  convo: null,
  thread: [],
  busy: false,
  cache: {},
};

const VAI_SUGGESTED = [
  'How much did we make today?',
  'Why did sales drop yesterday?',
  'Which products make the most profit?',
  'What stock should I reorder?',
  'Which site performed best this week?',
  'How is my team performing?',
  'Compare this week with last week',
  'What should I focus on tomorrow?',
];

/** The intelligence tabs: set questions, answered side by side. */
const VAI_TABS = {
  sales: ['Compare this week with last week', 'What were the best sellers this week?', 'What are the slowest sellers this week?'],
  stock: ['What stock should I reorder?'],
  profit: ['Which products make the most profit in the last 7 days?'],
  team: ['How is my team performing this week?', 'Which site performed best this week?'],
};

function vaiFormat(unit) {
  if (unit === 'money') return (v) => (Number(v) < 0 ? '-' : '') + Charts.money(Math.abs(Number(v) || 0));
  if (unit === 'pct' || unit === 'percent') return (v) => `${v}%`;
  return (v) => (Number.isInteger(Number(v)) ? Number(v).toLocaleString('en-GB') : String(v));
}

async function loadVesopaAi() {
  const root = $('vai-root');
  if (!root) return;
  try {
    VAI.me = await api('/ai/me');
  } catch (e) {
    root.innerHTML = `<div class="card panel vai-locked"><h3>Vesopa AI</h3><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  vaiChrome();
  vaiShowTab(VAI.tab);
}

/** The page's fixed parts: tabs, the site picker, invite. */
function vaiChrome() {
  const me = VAI.me;
  $('vai-sub').textContent = `${me.venue} · answers from your own sales · read-only`;
  const sites = me.sites || [];
  const sel = $('vai-site');
  sel.hidden = sites.length < 2 && me.all_sites;
  sel.innerHTML = (me.all_sites ? '<option value="">All sites</option>' : '<option value="">All your sites</option>')
    + sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  sel.value = VAI.site;
  sel.onchange = () => { VAI.site = sel.value; VAI.cache = {}; vaiShowTab(VAI.tab); };
  $('vai-invite').hidden = !me.can.invite;
  $('vai-invite').onclick = vaiInvites;
  document.querySelectorAll('#vai-tabs .seg-btn').forEach((b) => {
    b.hidden = (b.dataset.tab === 'profit' && !me.can.profit);
    b.onclick = () => vaiShowTab(b.dataset.tab);
  });
}

function vaiShowTab(tab) {
  VAI.tab = tab;
  document.querySelectorAll('#vai-tabs .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const body = $('vai-body');
  if (tab === 'brief') return vaiBriefing(body);
  if (tab === 'ask') return vaiAsk(body);
  return vaiSection(body, tab);
}

const vaiQuery = () => (VAI.site ? `?site=${encodeURIComponent(VAI.site)}` : '');

// ---- briefing ------------------------------------------------------------------

async function vaiBriefing(body) {
  body.innerHTML = '<div class="card panel vai-loading"><div class="vai-spark"></div><p class="muted">Reading today\'s figures…</p></div>';
  let b;
  try {
    b = VAI.cache.brief || (VAI.cache.brief = await api(`/ai/briefing${vaiQuery()}`));
  } catch (e) {
    body.innerHTML = `<div class="card panel"><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  body.innerHTML = `
    <div class="vai-brief">
      <div class="card panel vai-hero">
        <span class="vai-kicker">${esc(vaiGreeting())}, ${esc((VAI.me.name || '').split(' ')[0] || 'there')}</span>
        <h3 class="vai-headline">${esc(b.headline)}</h3>
        ${b.why.length ? `<ul class="vai-why">${b.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="grid-cards vai-tiles">${b.tiles.map((t, i) => `
        <div class="card stat-card ${['primary', 'blue', 'amber', 'green'][i] || ''}">
          <span class="stat-label">${esc(t.label)}</span>
          <span class="stat-value">${esc(Charts.money(t.value))}</span>
          ${t.change == null ? '<span class="stat-hint">no comparison</span>' : `<span class="stat-delta ${t.change >= 0 ? 'up' : 'down'}">${t.change >= 0 ? '▲' : '▼'} ${Math.abs(t.change)}%</span>`}
          <span class="stat-hint">${esc(t.sub)}</span>
        </div>`).join('')}
      </div>
      <div class="vai-two">
        <div class="card panel">
          <div class="panel-head"><h3>Needs your attention</h3></div>
          ${b.alerts.length ? `<div class="vai-alerts">${b.alerts.map((a) => `
            <button type="button" class="vai-alert ${esc(a.level)}" data-ask="${esc(a.ask)}">
              <span class="vai-alert-dot"></span>
              <span><strong>${esc(a.title)}</strong><span class="muted small">${esc(a.body)}</span></span>
              <span class="vai-alert-go">Ask why ›</span>
            </button>`).join('')}</div>` : '<p class="muted">Nothing needs you right now.</p>'}
          ${b.next.length ? `<h4 class="vai-h4">What you could do</h4><ol class="vai-next">${b.next.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>` : ''}
        </div>
        <div class="card panel">
          <div class="panel-head"><h3>${esc(b.charts[0] ? b.charts[0].title : 'Best sellers')}</h3></div>
          <div class="vai-chart" id="vai-brief-chart"></div>
        </div>
      </div>
      ${vaiMetaHtml(b)}
      <div class="card panel vai-askbar-card">
        <div class="panel-head"><h3>Ask Vesopa AI</h3><span class="muted small">In your own words</span></div>
        ${vaiAskBar()}
        <div class="vai-chips">${b.follow_ups.map((q) => `<button type="button" class="chip vai-chip" data-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      </div>
    </div>`;
  if (b.charts[0]) vaiChart($('vai-brief-chart'), b.charts[0]);
  vaiWire(body, b);
}

function vaiGreeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// ---- ask ---------------------------------------------------------------------------

function vaiAskBar() {
  return `<form class="vai-askbar" autocomplete="off">
      <input type="text" name="q" maxlength="500" placeholder="Why did sales drop yesterday?" aria-label="Ask Vesopa AI" />
      <button type="submit" class="btn primary">Ask</button>
    </form>`;
}

async function vaiAsk(body) {
  body.innerHTML = `
    <div class="vai-ask">
      <aside class="card panel vai-history">
        <div class="panel-head"><h3>Conversations</h3><button type="button" class="btn ghost small" id="vai-new">New</button></div>
        <div id="vai-convos" class="vai-convos"><p class="muted small">Loading…</p></div>
      </aside>
      <section class="vai-chat">
        <div id="vai-thread" class="vai-thread"></div>
        <div class="card panel vai-composer">
          ${vaiAskBar()}
          <div class="vai-chips" id="vai-suggest"></div>
        </div>
      </section>
    </div>`;
  $('vai-new').onclick = () => { VAI.convo = null; VAI.thread = []; vaiRenderThread(); vaiConvos(); };
  vaiWire(body);
  vaiRenderThread();
  vaiConvos();
}

async function vaiConvos() {
  const host = $('vai-convos');
  if (!host) return;
  try {
    const list = await api('/ai/conversations');
    host.innerHTML = list.length ? list.map((c) => `
      <button type="button" class="vai-convo ${c.id === VAI.convo ? 'active' : ''}" data-id="${c.id}">
        <span>${esc(c.title)}</span><span class="muted small">${esc(c.updated_at.slice(0, 16))} · ${c.messages}</span>
      </button>`).join('') : '<p class="muted small">Your questions are kept here, for you only.</p>';
    host.querySelectorAll('.vai-convo').forEach((b) => {
      b.onclick = async () => {
        const c = await api(`/ai/conversations/${b.dataset.id}`);
        VAI.convo = c.id;
        VAI.thread = c.messages;
        vaiRenderThread();
        vaiConvos();
      };
    });
  } catch (e) {
    host.innerHTML = `<p class="muted small">${esc(e.message)}</p>`;
  }
}

function vaiRenderThread() {
  const host = $('vai-thread');
  if (!host) return;
  if (!VAI.thread.length) {
    host.innerHTML = `<div class="card panel vai-empty">
        <div class="vai-mark" aria-hidden="true">AI</div>
        <h3>Ask about your business</h3>
        <p class="muted">Every answer is worked out from your own sales, with the period, the site and the records behind it.</p>
      </div>`;
  } else {
    host.innerHTML = VAI.thread.map((a, i) => `
      <div class="vai-q"><span>${esc(a.question || '')}</span></div>
      <div class="vai-a" id="vai-a-${i}">${vaiAnswerHtml(a, i)}</div>`).join('');
    VAI.thread.forEach((a, i) => vaiDrawCharts(a, `vai-a-${i}`));
    vaiWire(host);
  }
  const last = VAI.thread[VAI.thread.length - 1];
  const sug = $('vai-suggest');
  if (sug) {
    const qs = last && last.follow_ups && last.follow_ups.length ? last.follow_ups : VAI_SUGGESTED;
    sug.innerHTML = qs.map((q) => `<button type="button" class="chip vai-chip" data-ask="${esc(q)}">${esc(q)}</button>`).join('');
    vaiWire(sug);
  }
  host.lastElementChild?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function vaiSend(question) {
  question = String(question || '').trim();
  if (!question || VAI.busy) return;
  if (VAI.tab !== 'ask') {
    VAI.tab = 'ask';
    document.querySelectorAll('#vai-tabs .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'ask'));
    await vaiAsk($('vai-body'));
  }
  VAI.busy = true;
  VAI.thread.push({ question, pending: true });
  vaiRenderThread();
  try {
    const a = await api('/ai/ask', { method: 'POST', body: JSON.stringify({ question, conversation_id: VAI.convo, site: VAI.site || null }) });
    VAI.convo = a.conversation_id;
    VAI.thread[VAI.thread.length - 1] = a;
    vaiConvos();
  } catch (e) {
    VAI.thread[VAI.thread.length - 1] = { question, headline: 'That did not work.', why: [e.message], next: [], facts: [], charts: [], records: [], follow_ups: [] };
  } finally {
    VAI.busy = false;
    vaiRenderThread();
  }
}

// ---- intelligence tabs ---------------------------------------------------------

async function vaiSection(body, tab) {
  const questions = VAI_TABS[tab].filter((q) => !(/team|staff/i.test(q) && !VAI.me.can.staff));
  body.innerHTML = `<div class="vai-section">${questions.map((q, i) => `
      <div class="card panel vai-a" id="vai-s-${i}"><div class="vai-loading"><div class="vai-spark"></div><p class="muted">${esc(q)}</p></div></div>`).join('')}</div>`;
  await Promise.all(questions.map(async (q, i) => {
    const key = `${tab}:${q}:${VAI.site}`;
    try {
      const a = VAI.cache[key] || (VAI.cache[key] = await api('/ai/ask', { method: 'POST', body: JSON.stringify({ question: q, site: VAI.site || null, save: false }) }));
      const el = $(`vai-s-${i}`);
      if (!el) return;
      el.innerHTML = vaiAnswerHtml(a, `s${i}`, true);
      vaiDrawCharts(a, `vai-s-${i}`);
      vaiWire(el, a);
    } catch (e) {
      const el = $(`vai-s-${i}`);
      if (el) el.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    }
  }));
}

// ---- one answer ------------------------------------------------------------------

function vaiAnswerHtml(a, key, titled) {
  if (a.pending) return '<div class="vai-typing"><span></span><span></span><span></span></div>';
  return `
    ${titled ? `<span class="vai-kicker">${esc(a.question || '')}</span>` : ''}
    <h3 class="vai-headline">${esc(a.headline || '')}</h3>
    ${(a.why || []).length ? `<ul class="vai-why">${a.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${(a.charts || []).map((c, i) => `<div class="vai-chartbox"><div class="vai-chart-title">${esc(c.title)}</div><div class="vai-chart" data-chart="${i}"></div></div>`).join('')}
    ${(a.next || []).length ? `<div class="vai-nextbox"><h4 class="vai-h4">What you could do</h4><ol class="vai-next">${a.next.map((n) => `<li>${esc(n)}</li>`).join('')}</ol></div>` : ''}
    ${vaiMetaHtml(a)}
    ${!titled && (a.follow_ups || []).length ? '' : ''}`;
}

/** Period · site · definition · freshness, the source, and the records. */
function vaiMetaHtml(a) {
  if (!a.meta) return '';
  const m = a.meta;
  const source = a.source === 'ai'
    ? `Explained by ${esc((VAI.me && VAI.me.model) || 'DeepSeek')}, every figure checked against your sales`
    : (a.checked ? esc(a.checked) + ' Written from your figures.' : 'Written from your figures');
  return `<details class="vai-meta">
      <summary>
        <span class="pill">${esc(m.period || '')}</span>
        ${m.compare ? `<span class="pill">vs ${esc(m.compare)}</span>` : ''}
        <span class="pill">${esc(m.site || '')}</span>
        <span class="vai-meta-more">How this was worked out</span>
      </summary>
      <dl>
        <dt>Period</dt><dd>${esc(m.period || '')}${m.from ? ` <span class="muted">(${esc(m.from.slice(0, 16))} to ${esc(m.to.slice(0, 16))})</span>` : ''}</dd>
        ${m.compare ? `<dt>Compared with</dt><dd>${esc(m.compare)}</dd>` : ''}
        <dt>Site</dt><dd>${esc(m.site || '')}</dd>
        <dt>Definition</dt><dd>${esc(m.definition || '')}</dd>
        <dt>Data freshness</dt><dd>${esc(m.freshness || '')}</dd>
        ${m.notice ? `<dt>Missing data</dt><dd>${esc(m.notice)}</dd>` : ''}
        <dt>Wording</dt><dd>${source}</dd>
      </dl>
      ${(a.records || []).length ? `<div class="vai-records">${a.records.map((r, i) => `<button type="button" class="btn ghost small" data-record="${i}">See the records: ${esc(r.label)}</button>`).join('')}</div>` : ''}
    </details>`;
}

function vaiDrawCharts(a, hostId) {
  const host = $(hostId);
  if (!host) return;
  (a.charts || []).forEach((c, i) => {
    const el = host.querySelector(`[data-chart="${i}"]`);
    if (el) vaiChart(el, c);
  });
}

function vaiChart(el, c) {
  const format = vaiFormat(c.unit);
  if (!c.rows || !c.rows.length) { el.innerHTML = '<p class="muted small">No sales to draw.</p>'; return; }
  if (c.type === 'ranked') return Charts.ranked(el, c.rows, { format });
  if (c.type === 'bar') return Charts.bar(el, c.rows, { format });
  if (c.type === 'pair' || c.type === 'pairbars') {
    const max = Math.max(1, ...c.rows.flatMap((r) => [Number(r.value) || 0, Number(r.compare) || 0]));
    el.innerHTML = `<div class="vai-legend"><span class="vai-key now"></span>${esc((c.legend || [])[0] || 'This period')}<span class="vai-key before"></span>${esc((c.legend || [])[1] || 'Compared with')}</div>
      <div class="vai-pairs ${c.type === 'pairbars' ? 'rows' : ''}">${c.rows.map((r) => `
        <div class="vai-pair" title="${esc(r.label)}: ${esc(format(r.value))} against ${esc(format(r.compare))}">
          <div class="vai-pair-bars">
            <span class="now" style="--h:${Math.round(((Number(r.value) || 0) / max) * 100)}%"></span>
            <span class="before" style="--h:${Math.round(((Number(r.compare) || 0) / max) * 100)}%"></span>
          </div>
          <span class="vai-pair-label">${esc(r.label)}</span>
        </div>`).join('')}</div>`;
    return;
  }
  if (c.type === 'diverging') {
    const max = Math.max(1, ...c.rows.map((r) => Math.abs(Number(r.value) || 0)));
    el.innerHTML = `<div class="vai-div">${c.rows.map((r) => {
      const v = Number(r.value) || 0;
      const w = Math.round((Math.abs(v) / max) * 50);
      return `<div class="vai-div-row"><span class="vai-div-label" title="${esc(r.label)}">${esc(r.label)}</span>
        <span class="vai-div-track"><span class="${v < 0 ? 'neg' : 'pos'}" style="width:${w}%"></span></span>
        <span class="vai-div-value ${v < 0 ? 'neg' : 'pos'}">${v > 0 ? '+' : ''}${esc(format(v))}</span></div>`;
    }).join('')}</div>`;
    return;
  }
  if (c.type === 'table') {
    el.innerHTML = `<div class="vai-table-wrap"><table class="vai-table"><thead><tr>${c.columns.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${c.rows.map((r) => `<tr><td>${esc(r.label)}</td>${r.cells.map((x) => `<td class="num">${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
}

/** Buttons inside an answer: ask chips, records, the ask bar. */
function vaiWire(scope, answer) {
  scope.querySelectorAll('[data-ask]').forEach((b) => { b.onclick = () => vaiSend(b.dataset.ask); });
  scope.querySelectorAll('form.vai-askbar').forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      const input = f.elements.q;
      const q = input.value;
      input.value = '';
      vaiSend(q);
    };
  });
  scope.querySelectorAll('[data-record]').forEach((b) => {
    b.onclick = () => {
      const host = b.closest('.vai-a, .vai-brief');
      const a = answer || VAI.thread[Number((host && host.id || '').replace('vai-a-', ''))];
      const rec = a && a.records && a.records[Number(b.dataset.record)];
      if (rec) vaiRecords(rec);
    };
  });
}

// ---- records ---------------------------------------------------------------------

async function vaiRecords(rec) {
  const back = vaiModal(`<h3>${esc(rec.label)}</h3><p class="muted small" id="vai-rec-sub">Loading…</p><div class="vai-table-wrap" id="vai-rec-body"></div>
    <div class="modal-actions"><button type="button" class="btn primary" data-close>Close</button></div>`, true);
  const params = new URLSearchParams({ kind: rec.kind });
  if (rec.from) { params.set('from', rec.from); params.set('to', rec.to); }
  if (VAI.site) params.set('site', VAI.site);
  try {
    const r = await api(`/ai/records?${params}`);
    back.querySelector('#vai-rec-sub').textContent = `${r.rows.length} row${r.rows.length === 1 ? '' : 's'} · ${r.site}${r.truncated ? ' · the latest 300' : ''} · straight from your sales, nothing recalculated by AI`;
    back.querySelector('#vai-rec-body').innerHTML = `<table class="vai-table"><thead><tr>${r.columns.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${r.rows.map((row) => `<tr>${row.map((x, i) => `<td class="${i ? 'num' : ''}">${esc(x)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${r.columns.length}" class="muted">No records.</td></tr>`}</tbody></table>`;
  } catch (e) {
    back.querySelector('#vai-rec-sub').textContent = e.message;
  }
}

function vaiModal(html, wide) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''} vai-modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', function esc1(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc1); } });
  document.body.appendChild(back);
  return back;
}

// ---- invitations -------------------------------------------------------------------

async function vaiInvites() {
  const sites = VAI.me.sites || [];
  const back = vaiModal(`
    <h3>Invite people to Vesopa AI</h3>
    <p class="muted small">They get an email from info@vesopasoftware.com, choose a password, and see Vesopa AI only: read-only answers, nothing else in the back office.</p>
    <form id="vai-inv-form" class="vai-inv-form">
      <label>Email<input type="email" name="email" required maxlength="190" placeholder="accountant@example.com" /></label>
      <label>Name<input type="text" name="name" maxlength="120" placeholder="Optional" /></label>
      ${sites.length > 1 ? `<fieldset><legend>Sites they can see</legend>${sites.map((s) => `<label class="vai-check"><input type="checkbox" name="site" value="${s.id}" checked /> ${esc(s.name)}</label>`).join('')}</fieldset>` : ''}
      <fieldset><legend>Also share</legend>
        ${VAI.me.can.profit ? '<label class="vai-check"><input type="checkbox" name="profit" /> Profit and margins</label>' : ''}
        ${VAI.me.can.staff ? '<label class="vai-check"><input type="checkbox" name="staff" /> Staff performance</label>' : ''}
        <span class="muted small">Sales, products and stock are always included.</span>
      </fieldset>
      <div class="modal-actions"><button type="button" class="btn ghost" data-close>Close</button><button type="submit" class="btn primary">Send invitation</button></div>
    </form>
    <h4 class="vai-h4">Invited</h4>
    <div id="vai-inv-list" class="mini-list"><span class="muted small">Loading…</span></div>`);
  const list = async () => {
    const host = back.querySelector('#vai-inv-list');
    try {
      const rows = await api('/ai/invites');
      host.innerHTML = rows.length ? rows.map((r) => `<div><span><b>${esc(r.name || r.email)}</b> <span class="muted small">${esc(r.email)} · ${esc(r.status)}${r.profit ? ' · profit' : ''}${r.staff ? ' · staff' : ''}${r.sites.length ? ` · ${esc(sites.filter((s) => r.sites.includes(s.id)).map((s) => s.name).join(', '))}` : ''}</span></span>
        <button type="button" class="btn ghost small" data-remove="${r.id}">Take away</button></div>`).join('') : '<span class="muted small">Nobody yet.</span>';
      host.querySelectorAll('[data-remove]').forEach((b) => {
        b.onclick = async () => {
          if (!confirm('Take Vesopa AI away from this person? Their sign-in stops working.')) return;
          try { await api(`/ai/invites/${b.dataset.remove}`, { method: 'DELETE' }); list(); } catch (e) { toast(e.message, 'error'); }
        };
      });
    } catch (e) { host.textContent = e.message; }
  };
  back.querySelector('#vai-inv-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      email: f.elements.email.value, name: f.elements.name.value,
      sites: [...f.querySelectorAll('input[name=site]:checked')].map((x) => Number(x.value)),
      profit: !!(f.elements.profit && f.elements.profit.checked), staff: !!(f.elements.staff && f.elements.staff.checked),
    };
    if (sites.length > 1 && body.sites.length === sites.length) body.sites = [];
    try {
      const r = await api('/ai/invites', { method: 'POST', body: JSON.stringify(body) });
      toast(r.sent ? `Invitation sent to ${body.email}` : `The email did not send. Give them this link: ${r.link}`, r.sent ? 'ok' : 'error');
      f.reset();
      list();
    } catch (err) { toast(err.message, 'error'); }
  };
  list();
}

/**
 * The accept page: /vesopa-ai/invite?token=... opens before sign-in, over the
 * sign-in screen, and hands back to it with the email filled in.
 */
async function vaiInvitePage() {
  if (location.pathname.replace(/\/$/, '') !== '/vesopa-ai/invite') return;
  const token = new URLSearchParams(location.search).get('token') || '';
  const back = document.createElement('div');
  back.className = 'vai-accept';
  back.innerHTML = '<div class="vai-accept-card"><div class="vai-mark">AI</div><p class="muted">Opening your invitation…</p></div>';
  document.body.appendChild(back);
  const card = back.firstElementChild;
  let inv;
  try {
    const r = await fetch(`/api/ai/invite/${encodeURIComponent(token)}`);
    inv = await r.json();
    if (!r.ok) throw new Error(inv.error || 'This invitation is not valid.');
  } catch (e) {
    card.innerHTML = `<div class="vai-mark">AI</div><h2>Vesopa AI</h2><p class="muted">${esc(e.message)}</p><button class="btn primary" type="button" id="vai-acc-close">Go to sign in</button>`;
    card.querySelector('#vai-acc-close').onclick = () => { back.remove(); history.replaceState({}, '', '/'); };
    return;
  }
  card.innerHTML = `<div class="vai-mark">AI</div>
    <h2>Join Vesopa AI for ${esc(inv.venue)}</h2>
    <p class="muted">${esc(inv.invited_by || 'The owner')} invited ${esc(inv.email)}. Choose a password to sign in.</p>
    <form id="vai-acc">
      <label>Your name<input name="name" required maxlength="120" value="${esc(inv.name || '')}" /></label>
      <label>Password<input name="password" type="password" required minlength="10" autocomplete="new-password" /></label>
      <p class="muted small">10 characters or more.</p>
      <button type="submit" class="btn primary">Accept and continue</button>
      <p class="muted small" id="vai-acc-msg"></p>
    </form>`;
  card.querySelector('#vai-acc').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const r = await fetch(`/api/ai/invite/${encodeURIComponent(token)}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.elements.name.value, password: f.elements.password.value }) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) { card.querySelector('#vai-acc-msg').textContent = out.error || 'That did not work.'; return; }
    back.remove();
    history.replaceState({}, '', '/vesopa-ai');
    const email = document.getElementById('email');
    if (email) email.value = out.email;
    toast('Done. Sign in with your new password.', 'ok');
  };
}

document.addEventListener('DOMContentLoaded', vaiInvitePage);
