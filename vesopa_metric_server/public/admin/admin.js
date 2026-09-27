/*
 * Metric Membership console. Plain script, no build: the page is small and
 * the content security policy allows only files from this origin.
 *
 * Everything shown is built with textContent / createElement, never innerHTML
 * with data in it: names, notes and plates are typed by members.
 */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  /** replaceChildren, skipping the nulls and falses conditional parts leave. */
  function put(node, ...kids) {
    node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  }

  async function api(path, opts = {}) {
    const res = await fetch(`/api/admin${path}`, {
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showSignIn(); throw new Error(data.error || 'Please sign in.'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  const when = (s) => (s ? new Date(s).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }) : '');
  const plate = (p) => el('span', { class: 'plate', text: p });
  const badge = (s) => el('span', { class: `badge ${s}`, text: s });

  const REASONS = {
    member: 'Member', member_fuzzy: 'Member (close read)', unknown_plate: 'Not a member', pending: 'Awaiting approval',
    suspended: 'Suspended', closed: 'Closed', expired: 'Expired', not_started: 'Not started yet', not_this_site: 'Not valid at this site',
    ambiguous_read: 'Unclear read', no_plate: 'No plate read',
  };

  function notice(text, kind = '') { return el('div', { class: `notice ${kind}`, text }); }

  function flash(container, text, kind) {
    const n = notice(text, kind);
    container.prepend(n);
    setTimeout(() => n.remove(), 6000);
  }

  // ---- sign in -------------------------------------------------------------
  function showSignIn() {
    $('#app').hidden = true;
    $('#signin').hidden = false;
    const q = new URLSearchParams(location.search).get('signin');
    const msg = {
      notstaff: 'That Vesopa account is not on Metric’s staff list. Ask Vesopa to add your email address.',
      failed: 'Vesopa could not sign you in. Please try again.',
      cancelled: 'Sign-in was cancelled.',
    }[q];
    put($('#signin-msg'), msg ? notice(msg, 'bad') : '');
  }

  async function boot() {
    try {
      const me = await api('/me');
      $('#who').textContent = me.email;
      $('#signin').hidden = true;
      $('#app').hidden = false;
      if (location.search) history.replaceState(null, '', '/admin/');
      show(location.hash.slice(1) || 'overview');
    } catch { /* showSignIn already ran */ }
  }

  $('#signout').addEventListener('click', async () => {
    await fetch('/admin/signout', { method: 'POST', credentials: 'same-origin' });
    location.href = '/admin/';
  });

  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('button[data-tab]');
    if (t) show(t.dataset.tab);
  });

  const VIEWS = {};
  function show(tab, arg) {
    const name = VIEWS[tab] ? tab : 'overview';
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
    if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
    const view = $('#view');
    put(view, el('p', { class: 'muted', text: 'Loading…' }));
    VIEWS[name](view, arg).catch((e) => put(view, notice(e.message, 'bad')));
  }

  // ---- overview ------------------------------------------------------------
  VIEWS.overview = async (view) => {
    const o = await api('/overview');
    const m = o.members;
    put(view, 
      el('h1', { text: 'Overview' }),
      el('div', { class: 'grid' },
        stat('Active members', m.active || 0),
        stat('Waiting for approval', m.pending || 0, () => show('members', { status: 'pending' })),
        stat('Cars registered', o.vehicles),
        stat('Barriers opened today', o.today.opened),
        stat('Refused today', o.today.denied)),
      el('h2', { text: 'Gates', style: 'margin-top:20px' }),
      o.gates.length
        ? el('div', { class: 'table-wrap' }, el('table', {},
          el('tr', {}, el('th', { text: 'Site' }), el('th', { text: 'Gate' }), el('th', { text: 'Make' }), el('th', { text: 'Last heard from' }), el('th', { text: 'Allow-list' })),
          o.gates.map((g) => el('tr', {},
            el('td', { text: g.site }), el('td', { text: `${g.name} (${g.direction})` }), el('td', { text: g.adapter }),
            el('td', { text: g.lastSeenAt ? when(g.lastSeenAt) : 'Never' }),
            el('td', {}, g.mode === 'decision' ? el('span', { class: 'muted', text: 'Asks the server' }) : g.lastSyncError ? el('span', { class: 'badge deny', text: g.lastSyncError }) : el('span', { text: g.lastSyncAt ? `Synced ${when(g.lastSyncAt)}` : 'Not yet' }))))))
        : el('p', { class: 'muted' }, 'No gates yet. ', el('a', { href: '#sites', onclick: () => show('sites') }, 'Add a site and its gates'), '.'),
    );
  };

  function stat(label, n, onclick) {
    return el('div', { class: 'stat', onclick, style: onclick ? 'cursor:pointer' : null }, el('b', { text: String(n) }), el('span', { class: 'muted', text: label }));
  }

  // ---- members -------------------------------------------------------------
  VIEWS.members = async (view, arg = {}) => {
    const q = el('input', { type: 'search', placeholder: 'Name, email, member no. or plate', value: arg.q || '' });
    const status = el('select', {}, ['', 'pending', 'active', 'suspended', 'closed'].map((s) => el('option', { value: s, text: s || 'Any status', selected: (arg.status || '') === s })));
    const list = el('div');
    async function load() {
      const p = new URLSearchParams({ q: q.value, status: status.value });
      const data = await api(`/members?${p}`);
      put(list, data.members.length ? el('div', { class: 'table-wrap' }, el('table', {},
        el('tr', {}, el('th', { text: 'Member' }), el('th', { text: 'Name' }), el('th', { text: 'Email' }), el('th', { text: 'Cars' }), el('th', { text: 'Status' })),
        data.members.map((m) => el('tr', { class: 'click', onclick: () => show('member', m.id) },
          el('td', { class: 'mono', text: m.memberNo }), el('td', { text: m.name || '—' }), el('td', { text: m.email }),
          el('td', {}, m.plates ? m.plates.split(', ').map((p) => [plate(p), ' ']) : el('span', { class: 'muted', text: 'none' })),
          el('td', {}, badge(m.status)))))) : el('p', { class: 'muted', text: 'No members match.' }));
    }
    const form = el('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); load(); } }, el('label', {}, 'Search', q), el('label', {}, 'Status', status), el('button', { class: 'primary', type: 'submit', text: 'Search' }));
    status.addEventListener('change', load);
    put(view, el('h1', { text: 'Members' }), form, list);
    await load();
  };

  VIEWS.member = async (view, id) => {
    if (!id) return show('members');
    const d = await api(`/members/${id}`);
    const m = d.member;
    const plans = (await api('/plans')).plans;
    const f = {
      status: el('select', {}, ['pending', 'active', 'suspended'].map((s) => el('option', { value: s, text: s, selected: m.status === s }))),
      plan: el('select', {}, plans.map((p) => el('option', { value: p.id, text: `${p.name} (${p.max_vehicles} cars)`, selected: m.planId === p.id }))),
      validFrom: el('input', { type: 'date', value: m.validFrom || '' }),
      validTo: el('input', { type: 'date', value: m.validTo || '' }),
      name: el('input', { value: m.name || '' }),
      company: el('input', { value: m.company || '' }),
      phone: el('input', { value: m.phone || '' }),
      notes: el('textarea', {}, m.notes || ''),
    };
    const box = el('div');
    const save = async (extra = {}) => {
      try {
        await api(`/members/${id}`, { method: 'PATCH', body: { status: f.status.value, planId: f.plan.value, validFrom: f.validFrom.value, validTo: f.validTo.value, name: f.name.value, company: f.company.value, phone: f.phone.value, notes: f.notes.value, ...extra } });
        show('member', id);
      } catch (e) { flash(box, e.message, 'bad'); }
    };
    const newPlate = el('input', { placeholder: 'AB12 CDE', maxlength: 12 });
    const cars = el('table', {},
      el('tr', {}, el('th', { text: 'Plate' }), el('th', { text: 'Car' }), el('th', { text: 'Added' }), el('th')),
      d.vehicles.map((v) => el('tr', {},
        el('td', {}, plate(v.display)), el('td', { text: [v.colour, v.make, v.nickname && `“${v.nickname}”`].filter(Boolean).join(' ') || '—' }),
        el('td', { text: v.removed ? `Removed ${when(v.removed)}` : when(v.added) }),
        el('td', {}, v.removed ? '' : el('button', { class: 'danger', type: 'button', text: 'Remove', onclick: async () => {
          if (!confirm(`Remove ${v.display} from this membership? The barriers stop opening for it.`)) return;
          try { await api(`/members/${id}/vehicles/${v.id}`, { method: 'DELETE' }); show('member', id); } catch (e) { flash(box, e.message, 'bad'); }
        } })))));
    put(view, 
      el('p', {}, el('a', { href: '#members', onclick: (e) => { e.preventDefault(); show('members'); } }, '← All members')),
      box,
      el('h1', {}, `${m.name || m.email} `, badge(m.status)),
      el('p', { class: 'muted' }, `${m.memberNo} · ${m.email} · joined ${when(m.since)}`),
      m.status === 'pending' ? el('div', { class: 'row' }, el('button', { class: 'go', type: 'button', text: 'Approve membership', onclick: () => save({ status: 'active' }) })) : null,
      el('div', { class: 'split' },
        el('div', {},
          el('h2', { text: 'Membership' }),
          el('div', { class: 'row' }, el('label', {}, 'Status', f.status), el('label', {}, 'Plan', f.plan)),
          el('div', { class: 'row' }, el('label', {}, 'Valid from', f.validFrom), el('label', {}, 'Valid to', f.validTo)),
          el('div', { class: 'row' }, el('label', {}, 'Name', f.name), el('label', {}, 'Company', f.company), el('label', {}, 'Phone', f.phone)),
          el('label', {}, 'Notes (staff only)', f.notes),
          el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'primary', type: 'button', text: 'Save', onclick: () => save() })),
          el('h2', { text: 'Cars', style: 'margin-top:20px' }),
          el('div', { class: 'table-wrap' }, cars),
          el('form', { class: 'row', style: 'margin-top:10px', onsubmit: async (e) => {
            e.preventDefault();
            try { await api(`/members/${id}/vehicles`, { method: 'POST', body: { plate: newPlate.value } }); show('member', id); } catch (err) { flash(box, err.message, 'bad'); }
          } }, el('label', {}, 'Add a car', newPlate), el('button', { type: 'submit', text: 'Add' }))),
        el('div', {},
          el('h2', { text: 'Barrier log' }),
          d.events.length ? el('div', { class: 'table-wrap' }, eventsTable(d.events)) : el('p', { class: 'muted', text: 'No visits yet.' }),
          el('h2', { text: 'What they did in the app', style: 'margin-top:20px' }),
          d.activity.length ? el('div', { class: 'table-wrap' }, activityTable(d.activity, false)) : el('p', { class: 'muted', text: 'Nothing yet.' }))),
    );
  };

  function eventsTable(rows, withMember) {
    return el('table', {},
      el('tr', {}, el('th', { text: 'When' }), el('th', { text: 'Plate' }), el('th', { text: 'Where' }), withMember ? el('th', { text: 'Member' }) : null, el('th', { text: 'Result' })),
      rows.map((e) => el('tr', {},
        el('td', { text: when(e.at) }), el('td', {}, plate(e.plate)), el('td', { text: `${e.site} · ${e.gate} · ${e.direction}` }),
        withMember ? el('td', { text: e.member_no ? `${e.member || ''} ${e.member_no}` : '—' }) : null,
        el('td', {}, badge(e.decision), ' ', el('span', { class: 'muted small', text: REASONS[e.reason] || e.reason })))));
  }

  function activityTable(rows, withWho = true) {
    return el('table', {},
      el('tr', {}, el('th', { text: 'When' }), withWho ? el('th', { text: 'Who' }) : null, el('th', { text: 'What' }), el('th', { text: 'Detail' })),
      rows.map((a) => el('tr', {},
        el('td', { class: 'small', text: when(a.at) }),
        withWho ? el('td', { class: 'small', text: `${a.actor_type}${a.actor_label ? ` · ${a.actor_label}` : ''}` }) : null,
        el('td', { class: 'mono', text: a.action }),
        el('td', {}, el('pre', { class: 'detail', text: a.detail ? JSON.stringify(a.detail, null, 1) : '' }), a.app ? el('span', { class: 'muted small', text: a.app }) : null))));
  }

  // ---- sites and gates -----------------------------------------------------
  VIEWS.sites = async (view) => {
    const d = await api('/sites');
    const box = el('div');
    const name = el('input', { placeholder: 'e.g. Swindon Business Park' });
    const address = el('input', { placeholder: 'Address' });
    put(view, 
      el('h1', { text: 'Sites and gates' }),
      el('p', { class: 'muted', text: 'A site is a car park. Each gate is one lane: an ANPR camera and its barrier. Members’ cars open every gate at the sites their plan covers.' }),
      box,
      ...d.sites.map((s) => siteCard(s, d.adapters, box)),
      el('h2', { text: 'Add a site', style: 'margin-top:20px' }),
      el('form', { class: 'row', onsubmit: async (e) => {
        e.preventDefault();
        try { await api('/sites', { method: 'POST', body: { name: name.value, address: address.value } }); show('sites'); } catch (err) { flash(box, err.message, 'bad'); }
      } }, el('label', {}, 'Name', name), el('label', {}, 'Address', address), el('button', { class: 'primary', type: 'submit', text: 'Add site' })),
    );
  };

  function gateForm(g, adapters, onSave) {
    const f = {
      name: el('input', { value: g.name || '', placeholder: 'North entrance' }),
      direction: el('select', {}, [['both', 'Entry and exit'], ['entry', 'Entry'], ['exit', 'Exit']].map(([v, t]) => el('option', { value: v, text: t, selected: (g.direction || 'both') === v }))),
      adapter: el('select', {}, adapters.map((a) => el('option', { value: a.key, text: a.label, selected: (g.adapter || 'generic') === a.key }))),
      mode: el('select', {}, [['decision', 'Camera asks this server on every car'], ['allowlist', 'Keep the list on the camera'], ['both', 'Both']].map(([v, t]) => el('option', { value: v, text: t, selected: (g.mode || 'decision') === v }))),
      deviceUrl: el('input', { value: g.deviceUrl || '', placeholder: 'http://camera-address (optional)' }),
      deviceUser: el('input', { value: g.deviceUser || '', placeholder: 'admin', autocomplete: 'off' }),
      devicePass: el('input', { type: 'password', placeholder: g.hasPassword ? 'Set (leave blank to keep)' : 'Camera password', autocomplete: 'new-password' }),
      deviceChannel: el('input', { type: 'number', min: 1, value: g.deviceChannel || 1, style: 'width:80px' }),
      fuzzyMatch: el('input', { type: 'checkbox', checked: g.fuzzyMatch !== false }),
    };
    return el('form', { onsubmit: (e) => { e.preventDefault(); onSave(Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.type === 'checkbox' ? i.checked : i.value]))); } },
      el('div', { class: 'row' }, el('label', {}, 'Gate name', f.name), el('label', {}, 'Direction', f.direction), el('label', {}, 'Camera make', f.adapter)),
      el('div', { class: 'row' }, el('label', {}, 'How it decides', f.mode)),
      el('div', { class: 'row' }, el('label', {}, 'Camera address (for the list, or to open it)', f.deviceUrl), el('label', {}, 'Camera user', f.deviceUser), el('label', {}, 'Camera password', f.devicePass), el('label', {}, 'Channel', f.deviceChannel)),
      el('div', { class: 'row' }, el('label', { style: 'flex-direction:row;align-items:center;gap:8px' }, f.fuzzyMatch, 'Allow close reads (0/O, 1/I, 8/B…)')),
      el('div', { class: 'row' }, el('button', { class: 'primary', type: 'submit', text: g.id ? 'Save gate' : 'Add gate' })));
  }

  function keyNotice(out) {
    return el('div', { class: 'notice good' },
      el('b', { text: 'Give these to the installer now. The key is not shown again.' }),
      el('p', {}, 'Camera event address (POST each plate read): ', el('code', { text: out.urls.event })),
      el('p', {}, 'Allow-list address (GET, JSON or ?format=csv): ', el('code', { text: out.urls.allowlist })),
      el('p', {}, 'Test address: ', el('code', { text: out.urls.ping })));
  }

  function siteCard(s, adapters, box) {
    const gates = el('div');
    const addBox = el('div', { hidden: true }, gateForm({}, adapters, async (body) => {
      try { const out = await api(`/sites/${s.id}/gates`, { method: 'POST', body }); show('sites'); setTimeout(() => $('#view').prepend(keyNotice(out)), 300); } catch (e) { flash(box, e.message, 'bad'); }
    }));
    for (const g of s.gates) {
      const edit = el('div', { hidden: true }, gateForm(g, adapters, async (body) => {
        try { await api(`/gates/${g.id}`, { method: 'PATCH', body }); show('sites'); } catch (e) { flash(box, e.message, 'bad'); }
      }));
      gates.append(el('div', { class: 'gate' },
        el('div', { class: 'head' },
          el('b', { text: g.name }), badge(g.direction), el('span', { class: 'muted small', text: `${g.adapter} · ${g.mode} · key …${g.keyHint}` }),
          g.active ? null : badge('closed'),
          el('span', { class: 'spacer' }),
          el('button', { type: 'button', text: 'Edit', onclick: () => { edit.hidden = !edit.hidden; } }),
          g.mode !== 'decision' ? el('button', { type: 'button', text: 'Sync list now', onclick: async () => {
            try { const r = await api(`/gates/${g.id}/sync`, { method: 'POST' }); flash(box, r.error ? `Sync failed: ${r.error}` : r.skipped ? `Nothing to push (${r.skipped}): the camera pulls its list.` : `Synced: ${r.added ?? r.total ?? 0} added, ${r.removed ?? 0} removed.`, r.error ? 'bad' : 'good'); } catch (e) { flash(box, e.message, 'bad'); }
          } }) : null,
          g.deviceUrl ? el('button', { type: 'button', text: 'Open barrier', onclick: async () => {
            if (!confirm(`Open the barrier at ${g.name} now?`)) return;
            try { await api(`/gates/${g.id}/open`, { method: 'POST' }); flash(box, 'Open command sent.', 'good'); } catch (e) { flash(box, e.message, 'bad'); }
          } }) : null,
          el('button', { type: 'button', text: 'New key', onclick: async () => {
            if (!confirm('Make a new key for this gate? The camera stops working until it is given the new address.')) return;
            try { const out = await api(`/gates/${g.id}/key`, { method: 'POST' }); box.prepend(keyNotice(out)); } catch (e) { flash(box, e.message, 'bad'); }
          } })),
        el('div', { class: 'small muted' }, `Last heard from: ${g.lastSeenAt ? when(g.lastSeenAt) : 'never'}`, g.lastSyncAt ? ` · list synced ${when(g.lastSyncAt)}` : ''),
        g.lastSyncError ? notice(`Last sync failed: ${g.lastSyncError}`, 'bad') : null,
        edit));
    }
    return el('div', { class: 'card', style: 'margin:12px 0' },
      el('div', { class: 'row', style: 'align-items:center;margin:0' }, el('h2', { text: s.name, style: 'margin:0' }), s.active ? null : badge('closed'), el('span', { class: 'spacer' }),
        el('button', { type: 'button', text: '+ Add gate', onclick: () => { addBox.hidden = !addBox.hidden; } })),
      el('p', { class: 'muted small', text: s.address || '' }),
      s.gates.length ? gates : el('p', { class: 'muted', text: 'No gates yet.' }),
      addBox);
  }

  // ---- logs ----------------------------------------------------------------
  VIEWS.events = async (view) => {
    const p = el('input', { type: 'search', placeholder: 'Plate' });
    const dec = el('select', {}, [['', 'Any result'], ['open', 'Opened'], ['deny', 'Refused']].map(([v, t]) => el('option', { value: v, text: t })));
    const list = el('div', { class: 'table-wrap' });
    const load = async () => {
      const d = await api(`/events?${new URLSearchParams({ plate: p.value, decision: dec.value })}`);
      put(list, d.events.length ? eventsTable(d.events, true) : el('p', { class: 'muted', text: 'No barrier activity yet.' }));
    };
    dec.addEventListener('change', load);
    put(view, el('h1', { text: 'Barrier log' }), el('p', { class: 'muted', text: 'Every plate the cameras read, and whether the barrier opened.' }),
      el('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); load(); } }, el('label', {}, 'Plate', p), el('label', {}, 'Result', dec), el('button', { class: 'primary', type: 'submit', text: 'Filter' })), list);
    await load();
  };

  VIEWS.activity = async (view) => {
    const actor = el('select', {}, [['', 'Everyone'], ['member', 'Members'], ['admin', 'Staff'], ['gate', 'Gates'], ['system', 'System']].map(([v, t]) => el('option', { value: v, text: t })));
    const who = el('input', { type: 'search', placeholder: 'Email or id' });
    const action = el('input', { type: 'search', placeholder: 'e.g. vehicle. or ui.' });
    const list = el('div', { class: 'table-wrap' });
    const load = async () => {
      const d = await api(`/activity?${new URLSearchParams({ actor: actor.value, who: who.value, action: action.value })}`);
      put(list, d.activity.length ? activityTable(d.activity) : el('p', { class: 'muted', text: 'Nothing logged yet.' }));
    };
    actor.addEventListener('change', load);
    put(view, el('h1', { text: 'Activity log' }),
      el('p', { class: 'muted', text: 'What every member, member of staff and camera pressed or changed. Also kept as daily files on the server (logs/metric-activity-*.jsonl).' }),
      el('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); load(); } }, el('label', {}, 'Who', actor), el('label', {}, 'Email or id', who), el('label', {}, 'Action starts with', action), el('button', { class: 'primary', type: 'submit', text: 'Filter' })), list);
    await load();
  };

  // ---- plans ---------------------------------------------------------------
  VIEWS.plans = async (view) => {
    const d = await api('/plans');
    const sites = (await api('/sites')).sites;
    const box = el('div');
    const row = (p) => {
      const f = { name: el('input', { value: p.name }), description: el('input', { value: p.description }), maxVehicles: el('input', { type: 'number', min: 1, max: 20, value: p.max_vehicles, style: 'width:80px' }), siteIds: el('input', { value: p.site_ids || '', placeholder: 'All sites' }) };
      return el('div', { class: 'gate' },
        el('div', { class: 'head' }, el('b', { text: p.name }), p.is_default ? badge('active') : null, p.is_default ? el('span', { class: 'muted small', text: 'new members get this plan' }) : null),
        el('div', { class: 'row' }, el('label', {}, 'Name', f.name), el('label', {}, 'Description', f.description), el('label', {}, 'Cars', f.maxVehicles), el('label', {}, 'Site ids (comma list)', f.siteIds)),
        el('div', { class: 'row' },
          el('button', { class: 'primary', type: 'button', text: 'Save', onclick: async () => { try { await api(`/plans/${p.id}`, { method: 'PATCH', body: { name: f.name.value, description: f.description.value, maxVehicles: f.maxVehicles.value, siteIds: f.siteIds.value } }); show('plans'); } catch (e) { flash(box, e.message, 'bad'); } } }),
          p.is_default ? null : el('button', { type: 'button', text: 'Make default', onclick: async () => { await api(`/plans/${p.id}`, { method: 'PATCH', body: { isDefault: true } }); show('plans'); } })));
    };
    const nf = { name: el('input', { placeholder: 'e.g. Staff' }), maxVehicles: el('input', { type: 'number', min: 1, max: 20, value: 2, style: 'width:80px' }) };
    put(view, el('h1', { text: 'Plans' }),
      el('p', { class: 'muted' }, 'A plan sets how many cars a member may register and which sites they may use. Sites: ', sites.map((s) => `${s.id} = ${s.name}`).join(', ') || 'none yet', '.'),
      box, ...d.plans.map(row),
      el('h2', { text: 'Add a plan', style: 'margin-top:20px' }),
      el('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); try { await api('/plans', { method: 'POST', body: { name: nf.name.value, maxVehicles: nf.maxVehicles.value } }); show('plans'); } catch (err) { flash(box, err.message, 'bad'); } } },
        el('label', {}, 'Name', nf.name), el('label', {}, 'Cars', nf.maxVehicles), el('button', { class: 'primary', type: 'submit', text: 'Add plan' })));
  };

  boot();
})();
