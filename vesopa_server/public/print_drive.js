/**
 * Virtual Printers (2026-11-06).
 *
 * A printer a venue can have without owning one: anything sent to it from a
 * phone or a computer lands here, and prints on paper if a till's printer is
 * attached (src/print_drive.js calls each one a drive).
 *
 * The page: what is happening at a glance, a card for each printer, every
 * document in one list. Creating one goes straight on to putting it on a phone,
 * because a printer nobody can reach has not been set up.
 *
 * Loaded before app.js like the other page scripts; uses its `$`, `api`, `esc`,
 * `toast` and `confirmDialog` only from inside a call.
 */

/* global $, api, esc, toast, confirmDialog, token */

const vp = { drives: [], connectors: [], jobs: [], printer: '', status: '', find: '', timer: null };

const VP_STATUS = {
  saved: ['Saved', 'on'],
  waiting: ['Waiting for the till', 'amber'],
  printing: ['Printing', 'amber'],
  printed: ['Printed', 'on'],
  failed: ['Failed', 'bad'],
  cancelled: ['Cancelled', ''],
};

const vpUrl = (link) => `${location.origin}${link}`;
const vpUsable = () => vp.connectors.filter((c) => c.printers.length);
const vpDrive = (id) => vp.drives.find((d) => d.id === Number(id));

function vpSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function vpWhen(at) {
  if (!at) return 'Nothing yet';
  const when = new Date(at);
  const today = new Date().toDateString() === when.toDateString();
  return today
    ? `Today ${when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : when.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** What state a printer is in, in words a manager would use. */
function vpState(d) {
  if (!d.enabled) return ['Paused', ''];
  if (d.online_only || d.online) return ['Ready', 'on'];
  return ['Till is off, documents will wait', 'amber'];
}

async function loadPrintDrives() {
  const box = $('vp-printers');
  if (!box) return;
  try {
    const [list, activity] = await Promise.all([api('/print-drives'), api('/print-drives/activity')]);
    vp.drives = list.drives || [];
    vp.connectors = list.connectors || [];
    vp.jobs = activity.jobs || [];
  } catch (e) {
    box.innerHTML = `<p class="muted small">${esc(e.message)}</p>`;
    return;
  }
  renderVirtualPrinters();
}

/** While the page is open, so a document sent from a phone appears by itself. */
function vpKeepFresh() {
  clearInterval(vp.timer);
  vp.timer = setInterval(() => {
    const view = $('view-virtual_printers');
    if (!view || view.hidden) {
      clearInterval(vp.timer);
      return;
    }
    if (!document.hidden) loadPrintDrives().catch(() => {});
  }, 15000);
}

function renderVirtualPrinters() {
  const sum = (key) => vp.drives.reduce((n, d) => n + d[key], 0);
  const attention = sum('failed');
  $('vp-stats').innerHTML = [
    ['Printers', vp.drives.length, ''],
    ['Documents today', sum('today'), 'blue'],
    ['Saved', sum('saved'), ''],
    ['Waiting to print', sum('waiting'), sum('waiting') ? 'amber' : ''],
    ['Failed this week', attention, attention ? 'red' : ''],
    ['Space used', vpSize(sum('bytes')), ''],
  ].map(([label, value, tone]) => `<div class="card stat ${tone}"><span class="label">${esc(label)}</span>
    <span class="value">${esc(value)}</span><span class="accent"></span></div>`).join('');

  $('vp-printers').innerHTML = vp.drives.length ? vp.drives.map(vpCard).join('') : `
    <div class="card vp-empty">
      <h3>No virtual printers yet</h3>
      <p class="muted">Create one and it appears in the Print menu of your phones. Whatever you print to it is saved here, and no paper printer is needed.</p>
      <button class="btn primary" data-vp-new>New virtual printer</button>
    </div>`;

  const pick = $('vp-filter-printer');
  pick.innerHTML = `<option value="">All printers</option>${vp.drives.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}`;
  pick.value = vp.drives.some((d) => String(d.id) === vp.printer) ? vp.printer : '';
  $('vp-all-phones').hidden = vp.drives.filter((d) => d.enabled).length < 2;
  renderVpJobs();
}

function vpCard(d) {
  const [state, tone] = vpState(d);
  const where = d.online_only ? 'Online only, no paper' : `${d.printer_name || d.printer_id} on ${d.terminal || 'a till'}`;
  return `<article class="card vp-card${d.enabled ? '' : ' vp-paused'}" data-vp-drop="${esc(d.id)}">
    <div class="vp-card-head">
      <div><h3>${esc(d.name)}</h3><p class="muted small">${esc(where)}</p></div>
      <span class="pill ${tone}">${esc(state)}</span>
    </div>
    <dl class="vp-facts">
      <div><dt>Today</dt><dd>${esc(d.today)}</dd></div>
      <div><dt>Saved</dt><dd>${esc(d.saved)}</dd></div>
      <div><dt>Waiting</dt><dd>${esc(d.waiting)}</dd></div>
      <div><dt>Failed</dt><dd>${esc(d.failed)}</dd></div>
    </dl>
    <p class="muted small">Last document: ${esc(vpWhen(d.last_job_at))}</p>
    <div class="vp-actions">
      <button class="btn primary small" data-vp-setup="${esc(d.id)}">Add to a phone</button>
      <label class="btn small">Send files<input type="file" hidden multiple accept="application/pdf,image/png,image/jpeg" data-vp-upload="${esc(d.id)}"></label>
      <button class="btn small" data-vp-test="${esc(d.id)}">Send a test</button>
      <button class="btn small" data-vp-settings="${esc(d.id)}">Settings</button>
    </div>
  </article>`;
}

function renderVpJobs() {
  const box = $('vp-jobs');
  const find = vp.find.trim().toLowerCase();
  const rows = vp.jobs.filter((j) => (!vp.printer || String(j.drive_id) === vp.printer)
    && (!vp.status || j.status === vp.status)
    && (!find || `${j.filename} ${j.sent_by || ''}`.toLowerCase().includes(find)));
  if (!rows.length) {
    box.innerHTML = `<p class="muted small">${vp.jobs.length ? 'No documents match.' : 'Nothing has been sent yet. Use Send a test on a printer to see one arrive.'}</p>`;
    return;
  }
  box.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>
    <th>Document</th><th>Printer</th><th>From</th><th>Status</th><th>When</th><th>Size</th><th></th></tr></thead><tbody>
    ${rows.map((j) => {
      const [label, tone] = VP_STATUS[j.status] || [j.status, ''];
      const local = j.mime === 'local';
      const paper = !j.online_only && !local && ['saved', 'failed', 'printed', 'cancelled'].includes(j.status);
      return `<tr>
        <td><b>${esc(j.filename)}</b></td>
        <td class="small">${esc(j.drive_name)}</td>
        <td class="small muted">${esc(j.sent_by || '—')}</td>
        <td><span class="pill ${tone}">${esc(label)}</span>${j.error ? `<div class="small muted">${esc(j.error)}</div>` : ''}</td>
        <td class="small muted">${esc(vpWhen(j.created_at))}</td>
        <td class="small muted">${local ? '—' : esc(vpSize(j.size))}</td>
        <td class="right vp-row-actions">
          ${local ? '' : `<button class="btn small" data-vp-open="${esc(j.id)}">Open</button>
          <button class="btn small" data-vp-save="${esc(j.id)}" data-name="${esc(j.filename)}">Download</button>`}
          ${paper ? `<button class="btn small" data-vp-again="${esc(j.id)}">${j.status === 'saved' ? 'Print on paper' : 'Print again'}</button>` : ''}
          ${j.status === 'waiting' ? `<button class="btn small" data-vp-cancel="${esc(j.id)}">Cancel</button>` : ''}
          ${j.status === 'printing' ? '' : `<button class="btn small danger-ghost" data-vp-delete-job="${esc(j.id)}">Delete</button>`}
        </td></tr>`;
    }).join('')}</tbody></table></div>`;
}

// ---- Dialogs ---------------------------------------------------------------

function vpDialog(html) {
  const back = document.createElement('div');
  back.className = 'modal-back confirm-back';
  back.innerHTML = `<div class="modal vp-modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(back);
  requestAnimationFrame(() => back.classList.add('in'));
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    back.classList.remove('in');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => back.remove(), 220);
  }
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.querySelectorAll('[data-vp-close]').forEach((b) => { b.onclick = close; });
  return { root: back, close };
}

/** Where a printer's documents go: the choice shared by New and Settings. */
function vpWhereFields(current) {
  const usable = vpUsable();
  const paper = current && !current.online_only;
  return `<fieldset class="vp-where">
    <legend>Where should documents go?</legend>
    <label class="vp-choice"><input type="radio" name="vp-where" value="online"${paper ? '' : ' checked'}>
      <span><b>Keep them online</b><small>Saved here to read or download. No paper printer needed.</small></span></label>
    <label class="vp-choice${usable.length ? '' : ' vp-off'}"><input type="radio" name="vp-where" value="paper"${paper ? ' checked' : ''}${usable.length ? '' : ' disabled'}>
      <span><b>Print on paper</b><small>${usable.length ? 'Through a printer attached to one of your tills.' : 'No till has reported a printer yet. You can add this later in Settings.'}</small></span></label>
    <div class="vp-paper" hidden>
      <label>Till<select id="vp-till">${usable.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
      <label>Printer<select id="vp-printer"></select></label>
    </div>
  </fieldset>`;
}

function vpWireWhere(root, current) {
  const paper = root.querySelector('.vp-paper');
  const till = root.querySelector('#vp-till');
  const printer = root.querySelector('#vp-printer');
  const fill = () => {
    const c = vp.connectors.find((x) => String(x.id) === till.value);
    printer.innerHTML = (c ? c.printers : []).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  };
  const show = () => { paper.hidden = root.querySelector('[name="vp-where"]:checked').value !== 'paper'; };
  root.querySelectorAll('[name="vp-where"]').forEach((r) => { r.onchange = show; });
  till.onchange = fill;
  if (current && !current.online_only && [...till.options].some((o) => o.value === String(current.terminal_id))) {
    till.value = String(current.terminal_id);
  }
  fill();
  if (current && [...printer.options].some((o) => o.value === current.printer_id)) printer.value = current.printer_id;
  show();
}

function vpWhereValue(root) {
  if (root.querySelector('[name="vp-where"]:checked').value !== 'paper') return { terminal_id: 0 };
  return { terminal_id: Number(root.querySelector('#vp-till').value), printer_id: root.querySelector('#vp-printer').value };
}

function vpNew() {
  const { root, close } = vpDialog(`
    <h3>New virtual printer</h3>
    <p class="muted small">Step 1 of 2. Name it the way it should appear in the Print menu.</p>
    <form id="vp-new-form">
      <label>Name<input id="vp-name" maxlength="80" required placeholder="Office, Invoices, Bar menus"></label>
      ${vpWhereFields(null)}
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-vp-close>Cancel</button>
        <button type="submit" class="btn primary">Create printer</button>
      </div>
    </form>`);
  vpWireWhere(root, null);
  root.querySelector('#vp-name').focus();
  root.querySelector('#vp-new-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { id } = await api('/print-drives', {
        method: 'POST',
        body: JSON.stringify({ name: root.querySelector('#vp-name').value, ...vpWhereValue(root) }),
      });
      await loadPrintDrives();
      close();
      vpSetup(id, { created: true });
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

const VP_TABS = {
  iphone: {
    label: 'iPhone or iPad',
    qr: (d) => vpUrl(d.link),
    hint: 'Point the camera at this code and open it in Safari. The page then takes you through it.',
    steps: ['Tap <b>Add to this device</b>, then <b>Allow</b>.',
      'Open <b>Settings</b>, tap <b>Profile Downloaded</b>, then <b>Install</b>.',
      'Print from any app and choose this printer. The page ticks when it connects.'],
  },
  android: {
    label: 'Android',
    qr: (d) => vpUrl(d.link),
    hint: 'Point the camera at this code and open it in Chrome.',
    steps: ['Tap <b>Add to this phone</b> and confirm.',
      'In any app, tap <b>Share</b> on a document and pick this printer.',
      'Android cannot show an online printer in its Print menu, so Share is the way in.'],
  },
  computer: {
    label: 'Computer',
    qr: null,
    steps: ['Open the link below on any computer.',
      'Choose a PDF or a picture, and it arrives here.',
      'You can also drag a file onto the printer\'s card on this page.'],
  },
  go: {
    label: 'Vesopa Go',
    qr: null,
    steps: ['Open Vesopa Go, version 1.2.46 or newer.',
      'Go to <b>More</b>, then <b>Add this venue\'s printers</b>.',
      'On an iPhone, finish in Settings as the app tells you. Every printer here is added at once.'],
  },
};

async function vpDrawQr(box, url) {
  box.innerHTML = '';
  const res = await fetch(`/api/qr.svg?size=200&text=${encodeURIComponent(url)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error('The code could not be drawn.');
  box.innerHTML = await res.text();
}

function vpSetup(id, { created } = {}) {
  const d = vpDrive(id);
  if (!d) return;
  const { root } = vpDialog(`
    <h3>${created ? `${esc(d.name)} is ready` : `Add ${esc(d.name)} to a phone`}</h3>
    <p class="muted small">${created ? 'Step 2 of 2. Put it on a device so you can print to it.' : 'Choose the device.'}</p>
    <div class="seg vp-tabs">${Object.entries(VP_TABS).map(([k, t], i) => `<button type="button" class="seg-btn${i ? '' : ' active'}" data-tab="${k}">${esc(t.label)}</button>`).join('')}</div>
    <div class="vp-setup">
      <div class="vp-qr" id="vp-qr"></div>
      <div><p class="small muted" id="vp-hint"></p><ol class="vp-steps" id="vp-steps"></ol></div>
    </div>
    <label class="small">Private link<span class="vp-link"><input readonly value="${esc(vpUrl(d.link))}" aria-label="Private link"><button type="button" class="btn small" data-vp-copy>Copy</button></span></label>
    <p class="small muted">Anybody with this link or code can send documents to this printer.</p>
    <div class="modal-actions"><button type="button" class="btn primary" data-vp-close>Done</button></div>`);
  const pick = async (key) => {
    const tab = VP_TABS[key];
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    root.querySelector('#vp-steps').innerHTML = tab.steps.map((s) => `<li>${s}</li>`).join('');
    root.querySelector('#vp-hint').textContent = tab.hint || '';
    const qr = root.querySelector('#vp-qr');
    qr.hidden = !tab.qr;
    if (tab.qr) await vpDrawQr(qr, tab.qr(d)).catch((e) => { qr.textContent = e.message; });
  };
  root.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => pick(b.dataset.tab); });
  root.querySelector('[data-vp-copy]').onclick = () => navigator.clipboard.writeText(vpUrl(d.link))
    .then(() => toast('Link copied.'), () => toast('Select the link and copy it.', 'error'));
  pick(/Android/.test(navigator.userAgent) ? 'android' : 'iphone');
}

/** Every printer on one iPhone in one go. */
async function vpSetupAll() {
  try {
    const { url } = await api('/print-drives/profile-link', { method: 'POST', body: '{}' });
    const { root } = vpDialog(`
      <h3>Add every printer to an iPhone</h3>
      <div class="vp-setup"><div class="vp-qr" id="vp-qr"></div>
      <ol class="vp-steps"><li>Point the camera at this code and open it in Safari.</li>
      <li>Tap <b>Allow</b>, then open <b>Settings</b> and install the profile.</li>
      <li>This code stops working after ten minutes.</li></ol></div>
      <div class="modal-actions"><button type="button" class="btn primary" data-vp-close>Done</button></div>`);
    await vpDrawQr(root.querySelector('#vp-qr'), url);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function vpSettings(id) {
  const d = vpDrive(id);
  if (!d) return;
  const { root, close } = vpDialog(`
    <h3>${esc(d.name)} settings</h3>
    <form id="vp-settings-form">
      <label>Name<input id="vp-name" maxlength="80" required value="${esc(d.name)}"></label>
      ${vpWhereFields(d)}
      <label class="vp-check"><input type="checkbox" id="vp-enabled"${d.enabled ? ' checked' : ''}><span><b>Accepting documents</b><small>Off pauses this printer: its link and phones stop working until you turn it back on.</small></span></label>
      <label class="vp-check"><input type="checkbox" id="vp-phones"${d.phones ? ' checked' : ''}${d.online_only ? ' disabled' : ''}><span><b>Show on the venue's Wi-Fi</b><small>${d.online_only ? 'Needs a paper printer. Online printers are added with Add to a phone.' : 'Anybody on that Wi-Fi can print to it, without adding it first.'}</small></span></label>
      <div class="modal-actions"><button type="button" class="btn ghost" data-vp-close>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>
    <div class="vp-danger">
      <div><b>New private link</b><p class="small muted">If the link got out. The old one stops, and every phone has to add this printer again.</p><button type="button" class="btn small" data-vp-relink>Change the link</button></div>
      <div><b>Remove this printer</b><p class="small muted">Its link stops at once. Documents still here are deleted after a week.</p><button type="button" class="btn small danger-ghost" data-vp-remove>Remove printer</button></div>
    </div>`);
  vpWireWhere(root, d);
  root.querySelector('#vp-settings-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const where = vpWhereValue(root);
      const body = { name: root.querySelector('#vp-name').value, enabled: root.querySelector('#vp-enabled').checked };
      const same = where.terminal_id === Number(d.terminal_id) && (!where.terminal_id || where.printer_id === d.printer_id);
      if (!same) Object.assign(body, where);
      if (where.terminal_id) body.phones = root.querySelector('#vp-phones').checked;
      await api(`/print-drives/${d.id}`, { method: 'PUT', body: JSON.stringify(body) });
      close();
      toast('Saved.');
      await loadPrintDrives();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  root.querySelector('[data-vp-relink]').onclick = async () => {
    const yes = await confirmDialog('The old link and QR code stop working now. Every phone that has this printer must add it again.', {
      title: 'Change the private link?', confirmLabel: 'Change the link', danger: true,
    });
    if (!yes) return;
    try {
      await api(`/print-drives/${d.id}/link`, { method: 'POST', body: '{}' });
      await loadPrintDrives();
      close();
      vpSetup(d.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  root.querySelector('[data-vp-remove]').onclick = async () => {
    const yes = await confirmDialog('Its link stops working, nothing waiting will print, and documents still here are deleted after a week.', {
      title: `Remove ${d.name}?`, confirmLabel: 'Remove', danger: true,
    });
    if (!yes) return;
    try {
      await api(`/print-drives/${d.id}`, { method: 'DELETE' });
      close();
      toast('Printer removed.');
      await loadPrintDrives();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

// ---- Documents -------------------------------------------------------------

async function vpFile(id, save) {
  const res = await fetch(`/api/print-drives/jobs/${id}/file${save ? '?save=1' : ''}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('That document has gone.');
  return URL.createObjectURL(await res.blob());
}

async function vpSend(id, files) {
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append('files', f);
  // Not through api(): it says JSON, and a browser has to set a form's own type.
  const res = await fetch(`/api/print-drives/${id}/jobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Those files could not be sent.');
  toast(files.length === 1 ? 'Sent.' : `${files.length} files sent.`);
  await loadPrintDrives();
}

function bindPrintDrives() {
  const view = $('view-virtual_printers');
  if (!view || view.dataset.bound) return;
  view.dataset.bound = '1';

  view.addEventListener('input', (e) => {
    if (e.target.id === 'vp-find') {
      vp.find = e.target.value;
      renderVpJobs();
    }
  });

  view.addEventListener('change', async (e) => {
    if (e.target.id === 'vp-filter-printer') vp.printer = e.target.value;
    if (e.target.id === 'vp-filter-status') vp.status = e.target.value;
    if (e.target.id === 'vp-filter-printer' || e.target.id === 'vp-filter-status') return renderVpJobs();
    const id = e.target.getAttribute('data-vp-upload');
    if (id) await vpSend(id, [...e.target.files]).catch((err) => toast(err.message, 'error'));
    return undefined;
  });

  // Drop a file on a printer's card.
  view.addEventListener('dragover', (e) => {
    const card = e.target.closest('[data-vp-drop]');
    if (!card) return;
    e.preventDefault();
    card.classList.add('vp-over');
  });
  view.addEventListener('dragleave', (e) => {
    const card = e.target.closest('[data-vp-drop]');
    if (card && !card.contains(e.relatedTarget)) card.classList.remove('vp-over');
  });
  view.addEventListener('drop', (e) => {
    const card = e.target.closest('[data-vp-drop]');
    if (!card) return;
    e.preventDefault();
    card.classList.remove('vp-over');
    vpSend(card.getAttribute('data-vp-drop'), [...e.dataTransfer.files]).catch((err) => toast(err.message, 'error'));
  });

  view.addEventListener('click', async (e) => {
    const on = (name) => e.target.closest(`[data-${name}]`);
    const value = (el, name) => el.getAttribute(`data-${name}`);
    let el;
    try {
      if (on('vp-new')) vpNew();
      else if (e.target.id === 'vp-all-phones') await vpSetupAll();
      else if (e.target.id === 'vp-refresh') await loadPrintDrives();
      else if ((el = on('vp-setup'))) vpSetup(value(el, 'vp-setup'));
      else if ((el = on('vp-settings'))) vpSettings(value(el, 'vp-settings'));
      else if ((el = on('vp-test'))) {
        await api(`/print-drives/${value(el, 'vp-test')}/test`, { method: 'POST' });
        toast('Test document sent.');
        await loadPrintDrives();
      } else if ((el = on('vp-open'))) {
        // Opened before the wait, or the browser takes it for a pop-up.
        const tab = window.open('', '_blank');
        try {
          tab.location = await vpFile(value(el, 'vp-open'));
        } catch (err) {
          tab.close();
          throw err;
        }
      } else if ((el = on('vp-save'))) {
        const a = document.createElement('a');
        a.href = await vpFile(value(el, 'vp-save'), true);
        a.download = value(el, 'name');
        a.click();
      } else if ((el = on('vp-cancel'))) {
        await api(`/print-drives/jobs/${value(el, 'vp-cancel')}/cancel`, { method: 'POST' });
        await loadPrintDrives();
      } else if ((el = on('vp-again'))) {
        await api(`/print-drives/jobs/${value(el, 'vp-again')}/again`, { method: 'POST' });
        toast('Sent to the printer.');
        await loadPrintDrives();
      } else if ((el = on('vp-delete-job'))) {
        const yes = await confirmDialog('The document is deleted for good.', { title: 'Delete this document?', confirmLabel: 'Delete', danger: true });
        if (yes) {
          await api(`/print-drives/jobs/${value(el, 'vp-delete-job')}`, { method: 'DELETE' });
          await loadPrintDrives();
        }
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function loadVirtualPrinters() {
  bindPrintDrives();
  vpKeepFresh();
  await loadPrintDrives();
}
