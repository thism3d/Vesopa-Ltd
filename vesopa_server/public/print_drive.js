/**
 * Devices › Printer drives (2026-11-06).
 *
 * Each printer's place online: what goes in prints on that printer, through the
 * till it is attached to (src/print_drive.js).
 *
 * Loaded before app.js like the other page scripts; uses its `$`, `api`, `esc`,
 * `toast` and `confirmDialog` only from inside a call.
 */

/* global $, api, esc, toast, confirmDialog, token */

const printDrives = { drives: [], connectors: [], open: null };

const printDriveUrl = (link) => `${location.origin}${link}`;

async function loadPrintDrives() {
  const box = $('print-drives-list');
  if (!box) return;
  try {
    const data = await api('/print-drives');
    printDrives.drives = data.drives || [];
    printDrives.connectors = data.connectors || [];
  } catch (e) {
    box.innerHTML = '<p class="muted small">Printer drives are not available on this server yet.</p>';
    return;
  }
  renderPrintDrives();
}

function printDrivePrinters() {
  const id = Number(($('print-drive-till') || {}).value);
  const till = printDrives.connectors.find((c) => c.id === id);
  return till ? till.printers : [];
}

function renderPrintDrives() {
  const box = $('print-drives-list');
  const usable = printDrives.connectors.filter((c) => c.printers.length);
  box.innerHTML = `
    ${`<div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
      <input id="print-drive-name" placeholder="Name, such as Office" maxlength="80" aria-label="Drive name">
      <select id="print-drive-till" aria-label="Till"><option value="0">Online only, no paper</option>${usable.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>
      <select id="print-drive-printer" aria-label="Printer"></select>
      <button class="btn primary" data-pd-add>Add drive</button>
    </div>`}
    ${printDrives.drives.length ? `<div class="table-wrap"><table class="table"><thead><tr>
      <th>Drive</th><th>Till</th><th>Printer</th><th>Phones</th><th>Waiting</th><th></th></tr></thead><tbody>
      ${printDrives.drives.map((d) => `<tr>
        <td><b>${esc(d.name)}</b></td>
        <td>${d.online_only ? '<span class="small muted">Online only</span>' : `${esc(d.terminal || '—')} ${d.online ? '<span class="pill on">on now</span>' : '<span class="pill">off</span>'}`}</td>
        <td class="small">${esc(d.printer_name || d.printer_id || '—')}</td>
        <td><label class="small"><input type="checkbox" data-pd-phones="${esc(d.id)}"${d.phones ? ' checked' : ''}${d.online_only ? ' disabled' : ''}> On the venue's Wi-Fi</label></td>
        <td>${esc(d.waiting)}</td>
        <td class="right" style="white-space:nowrap">
          <label class="btn small">Add files<input type="file" hidden multiple accept="application/pdf,image/png,image/jpeg" data-pd-upload="${esc(d.id)}"></label>
          <button class="btn small" data-pd-test="${esc(d.id)}">Test page</button>
          <button class="btn small" data-pd-link="${esc(d.link)}">Copy link</button>
          <button class="btn small" data-pd-jobs="${esc(d.id)}">History</button>
          <button class="btn small danger-ghost" data-pd-delete="${esc(d.id)}">Remove</button>
        </td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div id="print-drive-jobs"></div>`;
  const pick = $('print-drive-printer');
  if (pick) {
    const fill = () => {
      pick.innerHTML = printDrivePrinters().map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    };
    fill();
    $('print-drive-till').onchange = fill;
  }
  if (printDrives.open) showPrintJobs(printDrives.open).catch(() => {});
}

async function showPrintJobs(id) {
  printDrives.open = id;
  const { jobs } = await api(`/print-drives/${id}/jobs`);
  const again = (j) => ['failed', 'printed', 'cancelled'].includes(j.status);
  $('print-drive-jobs').innerHTML = jobs.length ? `<h4>History</h4><div class="table-wrap"><table class="table"><thead><tr>
    <th>Document</th><th>From</th><th>Status</th><th>When</th><th></th></tr></thead><tbody>
    ${jobs.map((j) => `<tr>
      <td>${esc(j.filename)}</td>
      <td class="small muted">${esc(j.sent_by || '—')}</td>
      <td>${esc(j.status)}${j.error ? `<div class="small muted">${esc(j.error)}</div>` : ''}</td>
      <td class="small muted">${esc(new Date(j.created_at).toLocaleString('en-GB'))}</td>
      <td class="right">${j.sent_by === 'Phone on the network' ? '' : `<button class="btn small" data-pd-open="${esc(j.id)}">Open</button>`}
        ${j.status === 'waiting' ? `<button class="btn small" data-pd-cancel="${esc(j.id)}">Cancel</button>` : ''}
        ${again(j) && j.sent_by !== 'Phone on the network' ? `<button class="btn small" data-pd-again="${esc(j.id)}">Print again</button>` : ''}</td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="muted small">Nothing has been sent to this drive yet.</p>';
}

function bindPrintDrives() {
  const box = $('print-drives-list');
  if (!box || box.dataset.bound) return;
  box.dataset.bound = '1';

  box.addEventListener('change', async (e) => {
    const phones = e.target.getAttribute && e.target.getAttribute('data-pd-phones');
    if (phones) {
      try {
        await api(`/print-drives/${phones}`, { method: 'PUT', body: JSON.stringify({ phones: e.target.checked }) });
        toast(e.target.checked
          ? 'Phones on this venue\'s Wi-Fi can now find this printer. Anybody on that Wi-Fi can print to it.'
          : 'Phones can no longer find this printer.');
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    const id = e.target.getAttribute && e.target.getAttribute('data-pd-upload');
    if (!id) return;
    try {
      const form = new FormData();
      for (const f of e.target.files) form.append('files', f);
      // Not through api(): it says JSON, and a browser has to set a form's own type.
      const res = await fetch(`/api/print-drives/${id}/jobs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Those files could not be sent.');
      toast('Sent to the printer.');
      await loadPrintDrives();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  box.addEventListener('click', async (e) => {
    const on = (name) => e.target.closest(`[data-${name}]`);
    const value = (el, name) => el.getAttribute(`data-${name}`);
    try {
      let el;
      if (on('pd-add')) {
        await api('/print-drives', {
          method: 'POST',
          body: JSON.stringify({
            name: $('print-drive-name').value,
            terminal_id: Number($('print-drive-till').value),
            printer_id: $('print-drive-printer').value,
          }),
        });
        await loadPrintDrives();
      } else if ((el = on('pd-test'))) {
        await api(`/print-drives/${value(el, 'pd-test')}/test`, { method: 'POST' });
        toast('Test page sent.');
        await loadPrintDrives();
      } else if ((el = on('pd-link'))) {
        await navigator.clipboard.writeText(printDriveUrl(value(el, 'pd-link')));
        toast('Link copied. Anybody with it can print here.');
      } else if ((el = on('pd-jobs'))) {
        await showPrintJobs(value(el, 'pd-jobs'));
      } else if ((el = on('pd-open'))) {
        const res = await fetch(`/api/print-drives/jobs/${value(el, 'pd-open')}/file`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error('That document has gone.');
        window.open(URL.createObjectURL(await res.blob()), '_blank');
      } else if ((el = on('pd-cancel'))) {
        await api(`/print-drives/jobs/${value(el, 'pd-cancel')}/cancel`, { method: 'POST' });
        await loadPrintDrives();
      } else if ((el = on('pd-again'))) {
        await api(`/print-drives/jobs/${value(el, 'pd-again')}/again`, { method: 'POST' });
        await loadPrintDrives();
      } else if ((el = on('pd-delete'))) {
        const yes = await confirmDialog('Its link stops working. Anything still waiting will not print.', {
          title: 'Remove this drive?', confirmLabel: 'Remove', danger: true,
        });
        if (yes) {
          await api(`/print-drives/${value(el, 'pd-delete')}`, { method: 'DELETE' });
          printDrives.open = null;
          await loadPrintDrives();
        }
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
