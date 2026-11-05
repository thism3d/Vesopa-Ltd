/**
 * Devices › Terminals (2026-11-05).
 *
 * Each terminal of the venue: its number, site, version and last ping, the
 * access key that licenses it, and every setting it runs on (src/terminal_licences.js).
 * Laid out the way Newbridge's console is, because that is what Nicky works
 * from: a list of terminals, then searchable categories of settings, with Edit
 * and Copy to terminal on every row.
 *
 * Loaded before app.js like the other page scripts; uses its `$`, `api`, `esc`,
 * `toast` and `confirmDialog` only from inside a call.
 */

/* global $, api, esc, toast, confirmDialog */

const terminalPage = { rows: [], sites: [], kinds: [], venueCode: null, open: null, settings: [], search: '', category: '' };

const terminalKindName = (kind) => ({
  till: 'Till',
  go: 'Vesopa Go',
  kitchen: 'Kitchen screen',
  display: 'Customer display',
  express: 'Express kiosk',
}[kind] || kind);

function terminalWhen(value) {
  return value ? new Date(value).toLocaleString('en-GB') : '—';
}

function terminalSettingLabel(name) {
  const spaced = String(name).replace(/[_.#-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function terminalValueText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** What was typed, as the type the setting already holds. */
function terminalParseValue(text, previous) {
  if (typeof previous === 'boolean') return /^(true|yes|on|1)$/i.test(text.trim());
  if (typeof previous === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? n : previous;
  }
  if (previous && typeof previous === 'object') {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('That value has to stay in the same format.');
    }
  }
  return text;
}

async function loadTerminals() {
  const box = $('terminals-list');
  if (!box) return;
  let data;
  try {
    data = await api('/terminals');
  } catch (e) {
    box.innerHTML = '<p class="muted small">Terminals are not available on this server yet.</p>';
    return;
  }
  terminalPage.rows = data.terminals || [];
  terminalPage.kinds = data.kinds || [];
  terminalPage.venueCode = data.venue_code || null;
  try {
    const sites = await api('/till-sites');
    terminalPage.sites = Array.isArray(sites) ? sites : sites.sites || [];
  } catch (e) {
    terminalPage.sites = [];
  }
  renderTerminals();
}

function renderTerminals() {
  const box = $('terminals-list');
  const siteName = (id) => (terminalPage.sites.find((s) => s.id === id) || {}).name || '—';
  const rows = terminalPage.rows;
  box.innerHTML = `
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
      <span class="small muted">Venue code <b>${esc(terminalPage.venueCode || '—')}</b></span>
      <span style="flex:1"></span>
      <select id="terminal-new-kind" aria-label="Kind of terminal">
        ${terminalPage.kinds.map((k) => `<option value="${esc(k)}">${esc(terminalKindName(k))}</option>`).join('')}
      </select>
      <input id="terminal-new-name" placeholder="Name, such as Bar" maxlength="80" aria-label="Terminal name">
      <button class="btn primary" data-terminal-add>Add terminal</button>
    </div>
    <div id="terminal-key-shown"></div>
    ${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr>
        <th>No.</th><th>Name</th><th>Kind</th><th>Site</th><th>Licence</th><th>Version</th>
        <th>Last ping</th><th>Pending</th><th></th></tr></thead><tbody>
      ${rows.map((t) => `<tr${t.revoked_at ? ' class="muted"' : ''}>
        <td><b>${esc(t.number)}</b></td>
        <td>${esc(t.name || t.device_name || '—')}</td>
        <td>${esc(terminalKindName(t.kind))}</td>
        <td>${esc(siteName(t.site_id))}</td>
        <td class="small">${t.revoked_at ? '<span class="pill">withdrawn</span>'
          : t.key_prefix ? esc(t.key_prefix) + '…' : '<span class="muted">signed in</span>'}</td>
        <td class="small muted">${esc(t.version || '—')}</td>
        <td class="small muted">${esc(terminalWhen(t.last_ping_at))}</td>
        <td>${t.pending ? `<span class="pill">${esc(t.pending)} waiting</span>` : '<span class="small muted">none</span>'}</td>
        <td class="right" style="white-space:nowrap">
          <button class="btn small" data-terminal-settings="${esc(t.id)}">Settings</button>
          <button class="btn small" data-terminal-key="${esc(t.id)}">New key</button>
          ${t.bound ? `<button class="btn small" data-terminal-move="${esc(t.id)}">Move</button>` : ''}
          ${t.revoked_at ? '' : `<button class="btn small danger-ghost" data-terminal-revoke="${esc(t.id)}">Withdraw</button>`}
        </td></tr>`).join('')}
      </tbody></table></div>`
      : '<p class="muted small">No terminals yet. A till that is already signed in appears here by itself once it has been updated, or add one to get its access key.</p>'}
    <div id="terminal-settings"></div>`;
  if (terminalPage.open) renderTerminalSettings();
}

/** Shown once: the server keeps only a hash, so this cannot be looked up later. */
function showTerminalKey(row) {
  $('terminal-key-shown').innerHTML = `
    <div class="card" style="margin:12px 0">
      <b>Access key for ${esc(terminalKindName(row.kind))} ${esc(row.number)}</b>
      <p class="muted small">Write this down now. It will not be shown again.</p>
      <p>Venue code <b>${esc(terminalPage.venueCode || '—')}</b> &middot;
         Terminal number <b>${esc(row.number)}</b></p>
      <p><code style="font-size:1.1em;user-select:all">${esc(row.key)}</code></p>
    </div>`;
}

async function openTerminalSettings(id) {
  const data = await api(`/terminals/${id}/settings`);
  terminalPage.open = data.terminal;
  terminalPage.settings = data.settings || [];
  terminalPage.category = '';
  terminalPage.search = '';
  renderTerminalSettings();
}

function renderTerminalSettings() {
  const box = $('terminal-settings');
  const t = terminalPage.open;
  if (!box || !t) return;
  const all = terminalPage.settings;
  const categories = [...new Set(all.map((s) => s.category))].sort();
  const needle = terminalPage.search.toLowerCase();
  const shown = all.filter((s) => (!terminalPage.category || s.category === terminalPage.category)
    && (!needle || `${s.category} ${s.name} ${terminalValueText(s.value)}`.toLowerCase().includes(needle)));
  const others = terminalPage.rows.filter((o) => o.kind === t.kind && o.id !== t.id && !o.revoked_at);
  const copyTo = others.map((o) => `<option value="${esc(o.id)}">${esc(o.number)} ${esc(o.name || '')}</option>`).join('');

  box.innerHTML = `
    <h4>Settings for ${esc(terminalKindName(t.kind))} ${esc(t.number)} ${esc(t.name || '')}</h4>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <input id="terminal-search" placeholder="Search settings" value="${esc(terminalPage.search)}" aria-label="Search settings">
      <span style="flex:1"></span>
      ${others.length ? `<select id="terminal-copy-to" aria-label="Copy to terminal">${copyTo}</select>
        <button class="btn small" data-terminal-copy-all>Copy ${terminalPage.category ? 'this category' : 'everything'}</button>` : ''}
      <button class="btn small" data-terminal-close>Close</button>
    </div>
    <div class="row" style="gap:4px;flex-wrap:wrap;margin:8px 0">
      <button class="btn small${terminalPage.category ? '' : ' primary'}" data-terminal-category="">All</button>
      ${categories.map((c) => `<button class="btn small${terminalPage.category === c ? ' primary' : ''}" data-terminal-category="${esc(c)}">${esc(terminalSettingLabel(c))}</button>`).join('')}
    </div>
    ${shown.length ? `<div class="table-wrap"><table class="table"><thead><tr>
        <th>Category</th><th>Setting</th><th>Value</th><th></th></tr></thead><tbody>
      ${shown.map((s) => {
        const at = all.indexOf(s);
        return `<tr>
          <td class="small muted">${esc(terminalSettingLabel(s.category))}</td>
          <td>${esc(terminalSettingLabel(s.name))}${s.pending ? ' <span class="pill">waiting</span>' : ''}</td>
          <td class="small" style="word-break:break-word">${esc(terminalValueText(s.value))}</td>
          <td class="right" style="white-space:nowrap">
            <button class="btn small" data-terminal-edit="${at}">Edit</button>
            ${others.length ? `<button class="btn small" data-terminal-copy-row="${at}">Copy to terminal</button>` : ''}
          </td></tr>`;
      }).join('')}
      </tbody></table></div>`
      : '<p class="muted small">Nothing here yet. Settings appear once this terminal has reported them.</p>'}`;
}

async function copyTerminalSettings(body) {
  const to = Number($('terminal-copy-to').value);
  const done = await api(`/terminals/${terminalPage.open.id}/settings/copy`, {
    method: 'POST',
    body: JSON.stringify({ ...body, to: [to] }),
  });
  toast(`Copied ${done.rows} setting${done.rows === 1 ? '' : 's'}.`);
  await loadTerminals();
}

async function terminalAction(id, path, message) {
  const updated = await api(`/terminals/${id}/${path}`, { method: 'POST' });
  toast(message);
  await loadTerminals();
  return updated;
}

function bindTerminals() {
  const box = $('terminals-list');
  if (!box || box.dataset.bound) return;
  box.dataset.bound = '1';

  box.addEventListener('input', (e) => {
    if (e.target.id !== 'terminal-search') return;
    terminalPage.search = e.target.value;
    renderTerminalSettings();
    const input = $('terminal-search');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });

  box.addEventListener('click', async (e) => {
    const on = (name) => e.target.closest(`[data-${name}]`);
    const value = (el, name) => el.getAttribute(`data-${name}`);
    try {
      let el;
      if (on('terminal-add')) {
        const row = await api('/terminals', {
          method: 'POST',
          body: JSON.stringify({ kind: $('terminal-new-kind').value, name: $('terminal-new-name').value }),
        });
        await loadTerminals();
        showTerminalKey(row);
      } else if ((el = on('terminal-settings'))) {
        await openTerminalSettings(value(el, 'terminal-settings'));
      } else if ((el = on('terminal-key'))) {
        const yes = await confirmDialog(
          'The old key stops working straight away. The terminal keeps running, and this new key is what you would use to license it again.',
          { title: 'Issue a new key?', confirmLabel: 'New key' });
        if (!yes) return;
        const row = await terminalAction(value(el, 'terminal-key'), 'key', 'New key issued.');
        showTerminalKey(row);
      } else if ((el = on('terminal-move'))) {
        const yes = await confirmDialog(
          'This signs the terminal out of the machine it is on, so the key can be used on another. Its settings stay here and go with it.',
          { title: 'Move this licence?', confirmLabel: 'Move', danger: true });
        if (yes) await terminalAction(value(el, 'terminal-move'), 'unbind', 'The licence can now be used on another machine.');
      } else if ((el = on('terminal-revoke'))) {
        const yes = await confirmDialog(
          'The terminal stops on its next call to the server and the key no longer works. Its settings are kept.',
          { title: 'Withdraw this licence?', confirmLabel: 'Withdraw', danger: true });
        if (yes) await terminalAction(value(el, 'terminal-revoke'), 'revoke', 'Licence withdrawn.');
      } else if (on('terminal-close')) {
        terminalPage.open = null;
        $('terminal-settings').innerHTML = '';
      } else if ((el = e.target.closest('[data-terminal-category]'))) {
        terminalPage.category = el.getAttribute('data-terminal-category');
        renderTerminalSettings();
      } else if ((el = on('terminal-edit'))) {
        const row = terminalPage.settings[Number(value(el, 'terminal-edit'))];
        // eslint-disable-next-line no-alert
        const text = window.prompt(terminalSettingLabel(row.name), terminalValueText(row.value));
        if (text === null) return;
        await api(`/terminals/${terminalPage.open.id}/settings`, {
          method: 'PUT',
          body: JSON.stringify({
            values: [{ category: row.category, name: row.name, value: terminalParseValue(text, row.value) }],
          }),
        });
        toast('Saved. The terminal picks it up on its next check.');
        await openTerminalSettings(terminalPage.open.id);
      } else if ((el = on('terminal-copy-row'))) {
        const row = terminalPage.settings[Number(value(el, 'terminal-copy-row'))];
        await copyTerminalSettings({ category: row.category, name: row.name });
      } else if (on('terminal-copy-all')) {
        await copyTerminalSettings({ category: terminalPage.category });
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
