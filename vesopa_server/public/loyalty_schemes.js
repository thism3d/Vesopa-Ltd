/**
 * Loyalty Schemes: groups of customers, each with its own rewards (2026-10-02).
 *
 * "Can we take a look at the Newbridge back office, specifically under
 * Customers & Loyalty, to see how they handle Loyalty Schemes? We would need
 * something similar." Newbridge has one long form; this is the same set of
 * questions in five steps, in the style of the product wizard, with a live
 * preview of what the till will show and a sentence that says what the scheme
 * does. The server side is src/loyalty_schemes.js and the routes in
 * src/commerce.js.
 *
 * Loaded before app.js, like stock.js: app.js's view map names loadSchemes,
 * and this file uses app.js's `$`, `api`, `esc`, `confirmDialog`, `toast` and
 * `iconBtn` only from inside a call, which is always after everything parsed.
 */

/* global $, api, esc, confirmDialog, toast, iconBtn */

const LS_STEPS = [
  { key: 'basics', label: 'Basics' },
  { key: 'discount', label: 'Discount' },
  { key: 'points', label: 'Points' },
  { key: 'card', label: 'Card and membership' },
  { key: 'review', label: 'Review' },
];

const LS_COLOURS = ['#a5c715', '#7c5cd6', '#d9860a', '#0d8f8f', '#3b7ddd', '#d33b41', '#5b7186', '#96701a'];
const LS_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let lsList = [];
let lsDepartments = [];
let lsLevelNames = {};
let lsEdit = null; // the scheme being edited, or null on the list
let lsStep = 0;
let lsBound = false;

const lsPounds = (minor) => `£${((Number(minor) || 0) / 100).toFixed(2)}`;

function lsBlank() {
  return {
    id: null,
    name: '',
    colour: LS_COLOURS[lsList.length % LS_COLOURS.length],
    reward_type: 'none',
    discount_value: 0,
    price_level: 2,
    discount_departments: [],
    start_time: '00:00',
    end_time: '23:59',
    days_of_week: '1111111',
    min_points_for_discount: 0,
    earn_points: 0,
    points_per_pound: null,
    point_value_minor: null,
    min_spend_minor: null,
    welcome_points: 0,
    earn_departments: [],
    card_prefix: '',
    membership_fee_minor: null,
    membership_term_months: null,
    is_default: lsList.length ? 0 : 1,
    offer_at_till: 1,
    active: 1,
    notes: '',
  };
}

async function loadSchemes() {
  const [list, departments, till] = await Promise.all([
    api('/loyalty/schemes'),
    api('/departments').catch(() => []),
    api('/till-settings').catch(() => null),
  ]);
  lsList = Array.isArray(list) ? list : [];
  lsDepartments = (Array.isArray(departments) ? departments : [])
    .map((d) => d.department_name)
    .filter(Boolean);
  try {
    const raw = till && till.price_level_names;
    lsLevelNames = (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
  } catch {
    lsLevelNames = {};
  }
  bindSchemes();
  lsEdit = null;
  renderSchemes();
}

function lsLevelName(level) {
  return (lsLevelNames && lsLevelNames[level]) || `Price ${level}`;
}

/** What a scheme gives, as chips for the list. */
function lsChips(s) {
  const chips = [];
  const where = s.discount_departments && s.discount_departments.length
    ? ` ${s.discount_departments.length === 1 ? s.discount_departments[0] : `${s.discount_departments.length} departments`}`
    : '';
  if (s.reward_type === 'percent') chips.push(['disc', `${s.discount_value}% off${where}`]);
  if (s.reward_type === 'amount') chips.push(['disc', `${lsPounds(s.discount_value)} off${where}`]);
  if (s.reward_type === 'price_level') chips.push(['lvl', `${lsLevelName(s.price_level)}${where}`]);
  if (s.earn_points) {
    chips.push(['pts', s.points_per_pound != null
      ? `${s.points_per_pound} pt${s.points_per_pound === 1 ? '' : 's'} per £1`
      : 'Earns points']);
  }
  if (s.welcome_points) chips.push(['pts', `${s.welcome_points} welcome pts`]);
  if (!chips.length) chips.push(['', 'No rewards']);
  return chips.map(([k, t]) => `<span class="ls-chip ${k}">${esc(t)}</span>`).join('');
}

/** When the discount runs, in words. */
function lsWhen(s) {
  if (s.reward_type === 'none') return s.earn_points ? 'Always' : 'Group only';
  const days = s.days_of_week || '1111111';
  let dayText;
  if (days === '1111111') dayText = 'Every day';
  else if (days === '1111100') dayText = 'Mon to Fri';
  else if (days === '0000011') dayText = 'Sat and Sun';
  else dayText = LS_DAYS.filter((_, i) => days[i] === '1').join(', ');
  const allDay = s.start_time === '00:00' && s.end_time === '23:59';
  return `${dayText}${allDay ? ', all day' : `, ${s.start_time} to ${s.end_time}`}`;
}

function renderSchemes() {
  const view = $('view-loyalty_schemes');
  if (!view) return;
  $('ls-list-wrap').hidden = Boolean(lsEdit);
  $('ls-editor').hidden = !lsEdit;
  $('ls-new').hidden = Boolean(lsEdit);
  if (lsEdit) return renderSchemeEditor();

  const members = lsList.reduce((n, s) => n + (Number(s.members) || 0), 0);
  $('ls-stats').innerHTML = [
    ['Schemes', String(lsList.length)],
    ['Customers in a scheme', members.toLocaleString('en-GB')],
    ['With a discount', String(lsList.filter((s) => s.reward_type !== 'none').length)],
    ['Earning points', String(lsList.filter((s) => s.earn_points).length)],
  ].map(([label, value]) => `<div class="ls-stat"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('');

  $('ls-rows').innerHTML = lsList.map((s) => `
    <tr data-ls-id="${s.id}" class="${s.active ? '' : 'ls-off'}">
      <td><span class="ls-dot" style="background:${esc(s.colour)}"></span><b>${esc(s.name)}</b>
        ${s.is_default ? '<span class="ls-default">Default</span>' : ''}
        ${s.active ? '' : '<span class="ls-chip">Off</span>'}
        ${s.offer_at_till ? '' : '<span class="ls-chip" title="Not offered on the till\'s new-customer form">Back office only</span>'}</td>
      <td>${lsChips(s)}</td>
      <td class="muted small">${esc(lsWhen(s))}</td>
      <td>${s.card_prefix ? `<code>${esc(s.card_prefix)}</code>` : '<span class="muted small">none</span>'}</td>
      <td class="right">${Number(s.members) || 0}</td>
      <td class="right nowrap">
        ${iconBtn('edit', 'Edit', `data-ls-edit="${s.id}"`)}
        ${iconBtn('del', 'Delete', `data-ls-del="${s.id}"`, 'danger')}
      </td>
    </tr>`).join('') || `<tr><td colspan="6" class="empty">
      No schemes yet. Without one, every customer earns by your <a href="/loyalty" data-goto="loyalty">Loyalty settings</a>.
      Add VIP, Member, Committee and the rest here, and the till will ask which one when it adds a customer.
    </td></tr>`;
}

// ---- The editor ------------------------------------------------------------

function lsField(label, inner, hint) {
  return `<label class="ls-field">${esc(label)}${inner}${hint ? `<span class="muted small">${esc(hint)}</span>` : ''}</label>`;
}

function lsNum(key, value, attrs = '') {
  return `<input type="number" data-ls="${key}" value="${value == null ? '' : esc(String(value))}" ${attrs}>`;
}

function lsDeptPicker(key, chosen) {
  if (!lsDepartments.length) {
    return '<p class="muted small">No departments yet, so this applies to everything.</p>';
  }
  const all = !chosen.length;
  return `<div class="ls-tags" data-ls-depts="${key}">
    <button type="button" class="ls-tag ${all ? 'on' : ''}" data-ls-dept-all="${key}">Everything</button>
    ${lsDepartments.map((d) => `<button type="button" class="ls-tag ${!all && chosen.includes(d) ? 'on' : ''}"
      data-ls-dept="${esc(d)}" data-ls-dept-key="${key}">${esc(d)}</button>`).join('')}
  </div>`;
}

function lsStepBody(s) {
  switch (LS_STEPS[lsStep].key) {
    case 'basics':
      return `
        <div><h3>Name and colour</h3><p class="muted small">The name is what staff pick on the till and what the customer sees on their card.</p></div>
        <div class="ls-grid2">
          ${lsField('Scheme name', `<input data-ls="name" maxlength="80" value="${esc(s.name)}" placeholder="e.g. VIP, Member, Committee" autofocus>`)}
          <div class="ls-field">Colour<div class="ls-swatches">${LS_COLOURS.map((c) => `
            <button type="button" class="ls-swatch ${c === s.colour ? 'on' : ''}" style="background:${c}" data-ls-colour="${c}" aria-label="Colour ${c}"></button>`).join('')}</div></div>
        </div>
        <label class="check"><input type="checkbox" data-ls="is_default" ${s.is_default ? 'checked' : ''}> Default for new customers (already picked on the till)</label>
        <label class="check"><input type="checkbox" data-ls="offer_at_till" ${s.offer_at_till ? 'checked' : ''}> Offer it on the till when adding a customer</label>
        <label class="check"><input type="checkbox" data-ls="active" ${s.active ? 'checked' : ''}> Scheme is on</label>
        ${lsField('Notes for staff', `<input data-ls="notes" maxlength="255" value="${esc(s.notes || '')}" placeholder="Optional">`)}`;
    case 'discount': {
      const types = [
        ['none', 'No discount', 'Group or points only'],
        ['percent', 'Percentage off', 'e.g. 10% off'],
        ['amount', 'Fixed amount off', 'e.g. £5 off the bill'],
        ['price_level', 'Price level', 'Charge Price 2 to 6'],
      ];
      return `
        <div><h3>What do members get off?</h3><p class="muted small">Applied by itself the moment a member is put on a bill.</p></div>
        <div class="ls-seg">${types.map(([v, t, sub]) => `
          <button type="button" class="ls-opt ${s.reward_type === v ? 'on' : ''}" data-ls-reward="${v}"><b>${t}</b><span>${sub}</span></button>`).join('')}</div>
        ${s.reward_type === 'none' ? '' : `
        <div class="ls-grid3">
          ${s.reward_type === 'percent' ? lsField('Discount (%)', lsNum('discount_value', s.discount_value, 'min="0" max="100" step="1"')) : ''}
          ${s.reward_type === 'amount' ? lsField('Amount off (£)', `<input type="number" min="0" step="0.01" data-ls-pounds="discount_value" value="${(Number(s.discount_value) / 100).toFixed(2)}">`) : ''}
          ${s.reward_type === 'price_level' ? lsField('Price level', `<select data-ls="price_level">${[2, 3, 4, 5, 6].map((l) => `<option value="${l}" ${Number(s.price_level) === l ? 'selected' : ''}>${esc(lsLevelName(l))}</option>`).join('')}</select>`) : ''}
          ${lsField('From', `<input type="time" data-ls="start_time" value="${esc(s.start_time)}">`)}
          ${lsField('Until', `<input type="time" data-ls="end_time" value="${esc(s.end_time)}">`)}
        </div>
        <div><h4>On which days</h4><div class="ls-days">${LS_DAYS.map((d, i) => `
          <button type="button" class="ls-day ${s.days_of_week[i] === '1' ? 'on' : ''}" data-ls-day="${i}">${d}</button>`).join('')}</div></div>
        <div><h4>On which products</h4><p class="muted small">Pick departments, or leave it on everything.</p>${lsDeptPicker('discount_departments', s.discount_departments)}</div>
        ${lsField('Points needed before the discount applies', lsNum('min_points_for_discount', s.min_points_for_discount, 'min="0" step="1"'), '0 means the discount always applies.')}`}`;
    }
    case 'points':
      return `
        <div><h3>Do members earn points?</h3><p class="muted small">Blank boxes use your <a href="/loyalty" data-goto="loyalty">Loyalty settings</a>.</p></div>
        <div class="ls-seg ls-seg2">
          <button type="button" class="ls-opt ${s.earn_points ? '' : 'on'}" data-ls-earn="0"><b>No</b><span>This scheme earns nothing</span></button>
          <button type="button" class="ls-opt ${s.earn_points ? 'on' : ''}" data-ls-earn="1"><b>Yes</b><span>Points on every sale</span></button>
        </div>
        ${s.earn_points ? `
        <div class="ls-grid2">
          ${lsField('Points per £1 spent', lsNum('points_per_pound', s.points_per_pound, 'min="0" step="1" placeholder="Your setting"'))}
          ${lsField('Value of 1 point (pence)', lsNum('point_value_minor', s.point_value_minor, 'min="0" step="1" placeholder="Your setting"'))}
          ${lsField('Minimum spend to earn (£)', `<input type="number" min="0" step="0.01" data-ls-pounds="min_spend_minor" value="${s.min_spend_minor == null ? '' : (s.min_spend_minor / 100).toFixed(2)}" placeholder="Your setting">`)}
          ${lsField('Welcome points', lsNum('welcome_points', s.welcome_points, 'min="0" step="1"'), 'Given once, when somebody joins this scheme.')}
        </div>
        <div><h4>Which products earn points</h4>${lsDeptPicker('earn_departments', s.earn_departments)}</div>` : ''}`;
    case 'card':
      return `
        <div><h3>Cards and membership</h3><p class="muted small">Give this scheme its own card prefix and a card swiped on it joins the scheme by itself.</p></div>
        <div class="ls-grid2">
          ${lsField('Card prefix', `<input data-ls="card_prefix" inputmode="numeric" maxlength="8" value="${esc(s.card_prefix)}" placeholder="e.g. 9997">`,
            'The digits on the front of the card. The rest is the membership number: 9997 00012 is member 00012.')}
          <div class="ls-cardpv"><span class="muted small">A card on this scheme</span>
            <b>${esc(s.card_prefix || '9998')}<u>00012</u></b>
            <span class="small">Shown as member <b>00012</b></span></div>
        </div>
        <div class="ls-grid2">
          ${lsField('Membership fee (£)', `<input type="number" min="0" step="0.01" data-ls-pounds="membership_fee_minor" value="${s.membership_fee_minor == null ? '' : (s.membership_fee_minor / 100).toFixed(2)}" placeholder="Your setting">`)}
          ${lsField('Membership runs for (months)', lsNum('membership_term_months', s.membership_term_months, 'min="1" max="60" step="1" placeholder="Your setting"'))}
        </div>`;
    default:
      return `
        <div><h3>Check and save</h3></div>
        <div class="ls-review">${lsSentence(s)}</div>
        <dl class="ls-facts">
          <dt>Discount</dt><dd>${lsChips({ ...s, earn_points: 0, welcome_points: 0 })}</dd>
          <dt>When</dt><dd>${esc(lsWhen(s))}</dd>
          <dt>Points</dt><dd>${s.earn_points ? esc(`${s.points_per_pound ?? 'Venue rate'} per £1, worth ${s.point_value_minor ?? 'the venue rate'}p each${s.welcome_points ? `, ${s.welcome_points} on joining` : ''}`) : 'No points'}</dd>
          <dt>Card prefix</dt><dd>${esc(s.card_prefix || 'None')}</dd>
          <dt>On the till</dt><dd>${s.offer_at_till ? (s.is_default ? 'Offered, and picked by default' : 'Offered') : 'Back office only'}</dd>
        </dl>`;
  }
}

/** What the scheme does, in one sentence a manager can check. */
function lsSentence(s) {
  const who = `<b>${esc(s.name || 'Members of this scheme')}</b>`;
  const where = s.discount_departments.length ? ` on ${esc(s.discount_departments.join(', '))}` : '';
  let get = '';
  if (s.reward_type === 'percent') get = `get <b>${Number(s.discount_value) || 0}% off</b>${where}, <b>${esc(lsWhen(s).toLowerCase())}</b>`;
  if (s.reward_type === 'amount') get = `get <b>${lsPounds(s.discount_value)} off</b> the bill${where}, <b>${esc(lsWhen(s).toLowerCase())}</b>`;
  if (s.reward_type === 'price_level') get = `are charged <b>${esc(lsLevelName(s.price_level))}</b>${where}, <b>${esc(lsWhen(s).toLowerCase())}</b>`;
  if (get && s.min_points_for_discount) get += ` once they hold ${s.min_points_for_discount} points`;
  const earn = s.earn_points
    ? `earn <b>${s.points_per_pound ?? 'your usual'} point${s.points_per_pound === 1 ? '' : 's'} per £1</b>${s.earn_departments.length ? ` on ${esc(s.earn_departments.join(', '))}` : ''}`
    : '';
  const parts = [get, earn].filter(Boolean);
  const body = parts.length ? parts.join(' and ') : 'are a group with no rewards';
  return `${who} ${body}.${s.card_prefix ? ` Their cards start <b>${esc(s.card_prefix)}</b>.` : ''}`;
}

/** A pretend bill: what the till shows with a member of this scheme on it. */
function lsPreview(s) {
  const lines = [
    { name: '2 Pint Lager', dept: 'Beers and Ciders', minor: 1040 },
    { name: '1 Burger', dept: 'Food', minor: 1250 },
  ];
  const eligible = (l) => !s.discount_departments.length || s.discount_departments.includes(l.dept)
    || !lsDepartments.includes(l.dept);
  const base = lines.reduce((n, l) => n + l.minor, 0);
  const onEligible = lines.filter(eligible).reduce((n, l) => n + l.minor, 0);
  let off = 0;
  let label = '';
  if (s.reward_type === 'percent') { off = Math.round(onEligible * (Number(s.discount_value) || 0) / 100); label = `${s.name || 'Scheme'} ${s.discount_value}% off`; }
  if (s.reward_type === 'amount') { off = Math.min(Number(s.discount_value) || 0, onEligible); label = `${s.name || 'Scheme'} ${lsPounds(s.discount_value)} off`; }
  if (s.reward_type === 'price_level') label = `Charged at ${lsLevelName(s.price_level)}`;
  const initials = 'SJ';
  return `
    <div class="ls-pv-lab">On the till</div>
    <div class="ls-pv-mem"><span class="ls-pv-face" style="background:${esc(s.colour)}">${initials}</span>
      <div><b>Sarah Jones</b><span>Member 00012</span><span class="ls-pv-pill" style="background:${esc(s.colour)}">${esc(s.name || 'Scheme')}</span></div></div>
    <div class="ls-pv-lines">
      ${lines.map((l) => `<div><span>${esc(l.name)}</span><span>${lsPounds(l.minor)}</span></div>`).join('')}
      ${label ? `<div class="d"><span>${esc(label)}</span><span>${off ? `−${lsPounds(off)}` : ''}</span></div>` : ''}
      <div class="t"><span>Total</span><span>${lsPounds(base - off)}</span></div>
    </div>`;
}

function renderSchemeEditor() {
  const s = lsEdit;
  $('ls-steps').innerHTML = LS_STEPS.map((st, i) => `
    <button type="button" class="ls-step ${i === lsStep ? 'on' : i < lsStep ? 'done' : ''}" data-ls-step="${i}">
      <i>${i < lsStep ? '✓' : i + 1}</i>${esc(st.label)}</button>`).join('');
  $('ls-title').textContent = s.id ? `Edit scheme: ${s.name}` : 'New loyalty scheme';
  $('ls-body').innerHTML = lsStepBody(s);
  $('ls-back').disabled = lsStep === 0;
  $('ls-next').textContent = lsStep === LS_STEPS.length - 1 ? 'Save scheme' : `Next: ${LS_STEPS[lsStep + 1].label}`;
  lsRefreshSide();
}

function lsRefreshSide() {
  if (!lsEdit) return;
  $('ls-preview').innerHTML = lsPreview(lsEdit);
  $('ls-sentence').innerHTML = lsSentence(lsEdit);
}

async function lsSave() {
  const s = lsEdit;
  if (!String(s.name || '').trim()) {
    lsStep = 0;
    renderSchemeEditor();
    toast('Give the scheme a name.', 'error');
    return;
  }
  try {
    await api(s.id ? `/loyalty/schemes/${s.id}` : '/loyalty/schemes', {
      method: s.id ? 'PUT' : 'POST',
      body: JSON.stringify(s),
    });
    toast(`${s.name} saved. The tills have it now.`);
    await loadSchemes();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function bindSchemes() {
  if (lsBound) return;
  lsBound = true;
  const view = $('view-loyalty_schemes');

  view.addEventListener('click', async (e) => {
    const t = e.target.closest('button, a');
    if (!t) return;

    if (t.id === 'ls-new') { lsEdit = lsBlank(); lsStep = 0; return renderSchemes(); }
    if (t.dataset.lsEdit) {
      const found = lsList.find((s) => String(s.id) === t.dataset.lsEdit);
      if (found) { lsEdit = JSON.parse(JSON.stringify(found)); lsStep = 0; renderSchemes(); }
      return;
    }
    if (t.dataset.lsDel) {
      const found = lsList.find((s) => String(s.id) === t.dataset.lsDel);
      if (!found) return;
      const ok = await confirmDialog(
        `Delete ${found.name}? Its ${Number(found.members) || 0} customer(s) keep their points and leave the scheme.`,
        { title: 'Delete scheme', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      await api(`/loyalty/schemes/${found.id}`, { method: 'DELETE' });
      toast(`${found.name} deleted.`);
      return loadSchemes();
    }
    if (!lsEdit) return;
    const s = lsEdit;

    if (t.id === 'ls-cancel') { lsEdit = null; return renderSchemes(); }
    if (t.id === 'ls-save') return lsSave();
    if (t.id === 'ls-back') { lsStep = Math.max(0, lsStep - 1); return renderSchemeEditor(); }
    if (t.id === 'ls-next') {
      if (lsStep === LS_STEPS.length - 1) return lsSave();
      if (lsStep === 0 && !String(s.name || '').trim()) { toast('Give the scheme a name.', 'error'); return; }
      lsStep++;
      return renderSchemeEditor();
    }
    if (t.dataset.lsStep !== undefined) { lsStep = Number(t.dataset.lsStep); return renderSchemeEditor(); }
    if (t.dataset.lsColour) { s.colour = t.dataset.lsColour; return renderSchemeEditor(); }
    if (t.dataset.lsReward) {
      s.reward_type = t.dataset.lsReward;
      if (s.reward_type === 'price_level' && !s.price_level) s.price_level = 2;
      return renderSchemeEditor();
    }
    if (t.dataset.lsEarn) { s.earn_points = Number(t.dataset.lsEarn); return renderSchemeEditor(); }
    if (t.dataset.lsDay !== undefined) {
      const i = Number(t.dataset.lsDay);
      const days = s.days_of_week.split('');
      days[i] = days[i] === '1' ? '0' : '1';
      s.days_of_week = days.join('');
      return renderSchemeEditor();
    }
    if (t.dataset.lsDeptAll) { s[t.dataset.lsDeptAll] = []; return renderSchemeEditor(); }
    if (t.dataset.lsDept) {
      const key = t.dataset.lsDeptKey;
      const set = new Set(s[key] || []);
      if (set.has(t.dataset.lsDept)) set.delete(t.dataset.lsDept);
      else set.add(t.dataset.lsDept);
      // Every department ticked is the same as everything.
      s[key] = set.size === lsDepartments.length ? [] : [...set];
      return renderSchemeEditor();
    }
  });

  const onInput = (e) => {
    if (!lsEdit) return;
    const el = e.target;
    if (el.dataset.ls) {
      const key = el.dataset.ls;
      if (el.type === 'checkbox') lsEdit[key] = el.checked ? 1 : 0;
      else if (el.type === 'number' || key === 'price_level') lsEdit[key] = el.value === '' ? null : Number(el.value);
      else if (key === 'card_prefix') lsEdit[key] = el.value.replace(/\D/g, '').slice(0, 8);
      else lsEdit[key] = el.value;
    } else if (el.dataset.lsPounds) {
      lsEdit[el.dataset.lsPounds] = el.value === '' ? null : Math.round(Number(el.value) * 100);
    } else {
      return;
    }
    lsRefreshSide();
    // The card preview reads the prefix as it is typed.
    if (el.dataset.ls === 'card_prefix') {
      const pv = view.querySelector('.ls-cardpv b');
      if (pv) pv.innerHTML = `${esc(lsEdit.card_prefix || '9998')}<u>00012</u>`;
    }
  };
  view.addEventListener('input', onInput);
  view.addEventListener('change', onInput);
}
