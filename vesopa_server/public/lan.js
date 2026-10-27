/**
 * Devices › Local network (2026-10-27).
 *
 * What each till, kitchen screen and customer display can see on the venue's
 * own network, as they last reported it (src/lan.js). This is the check the
 * owner asked for before the local link was relied on: whether the network
 * lets the devices reach each other at all, which till is the main one, and
 * anything that lost when the link and the cloud met again.
 *
 * Loaded before app.js like the other page scripts; uses its `$`, `api`,
 * `esc` and `toast` only from inside a call.
 */

/* global $, api, esc, toast */

async function loadLan() {
  const box = $('lan-list');
  if (!box) return;
  let data;
  try {
    data = await api('/lan/reports');
  } catch (e) {
    box.innerHTML = '<p class="muted small">The local network check is not available on this server yet.</p>';
    return;
  }
  const devices = data.devices || [];
  if (!devices.length) {
    box.innerHTML = '<p class="muted small">No device has reported yet. Tills, kitchen screens and customer displays report once they are updated (EPOS 1.16.33, Kitchen 1.7.16, Display 1.7.6).</p>';
    return;
  }

  const fresh = (d) => d.age_s < 180;
  const tills = devices.filter((d) => d.role === 'till');
  const hub = devices.find((d) => fresh(d) && d.report && d.report.is_hub);
  const roleName = { till: 'Till', kitchen: 'Kitchen screen', display: 'Customer display' };

  // Can A see B? From A's own list of what it heard, both ways round.
  const sees = (a, b) => {
    const peers = (a.report && a.report.peers) || [];
    if (peers.some((p) => p.id === b.device)) return true;
    const clients = (a.report && a.report.clients) || [];
    return clients.some((c) => c.id === b.device);
  };

  const live = devices.filter(fresh);
  let summary;
  if (!live.length) {
    summary = 'No device has reported in the last three minutes.';
  } else if (hub) {
    const linked = live.filter((d) => d.report && (d.report.linked || d.report.is_hub)).length;
    summary = `Main till: <strong>${esc(hub.name || hub.device)}</strong>. ${linked} of ${live.length} devices are on the local link.`;
  } else if (tills.length) {
    summary = 'No main till yet: the tills cannot hear each other, or none has been updated.';
  } else {
    summary = 'No till has reported yet; only a till can be the main one.';
  }

  const rows = devices.map((d) => {
    const r = d.report || {};
    const state = !fresh(d)
      ? '<span class="pill">Not heard from</span>'
      : r.is_hub
        ? '<span class="pill on">Main till</span>'
        : r.linked
          ? '<span class="pill on">Linked</span>'
          : '<span class="pill amber">Not linked</span>';
    const seen = live.filter((o) => o.device !== d.device);
    const reach = seen.length
      ? seen.map((o) => {
        const ok = sees(d, o) || sees(o, d);
        return `<span class="pill ${ok ? 'on' : 'amber'}" title="${ok ? 'Can reach' : 'Cannot reach'}">${esc(o.name || o.device)}</span>`;
      }).join(' ')
      : '<span class="muted small">—</span>';
    const pin = d.role === 'till'
      ? `<button class="btn btn-small" data-lan-pin="${esc(d.device)}">${data.preferred_hub === d.device ? 'Unpin' : 'Make main till'}</button>`
      : '';
    return `<tr>
      <td><strong>${esc(d.name || d.device)}</strong><br><span class="muted small">${esc(roleName[d.role] || d.role)} · ${esc(d.version || '')}</span></td>
      <td>${state}${data.preferred_hub === d.device ? ' <span class="pill">Pinned</span>' : ''}</td>
      <td class="small">${esc((r.ips || []).join(', ') || '—')}</td>
      <td>${reach}</td>
      <td class="small muted">${fresh(d) ? 'Just now' : esc(ago(d.age_s))}</td>
      <td>${pin}</td>
    </tr>`;
  }).join('');

  const conflicts = (data.conflicts || []).map((c) => {
    let detail = c.detail;
    try {
      const j = JSON.parse(c.detail);
      if (c.kind === 'bill' && j.kept && j.lost) {
        detail = `Kept ${j.kept.terminal || 'the newer change'}'s version; ${j.lost.terminal || 'another till'}'s older change` +
          `${j.lost.table_number ? ` to table ${j.lost.table_number}` : ''} was not applied.`;
      } else if (j && j.error) {
        detail = j.error;
      }
    } catch { /* plain text */ }
    return `<tr><td class="small">${esc(new Date(c.created_at).toLocaleString())}</td><td>${esc(c.kind)}</td><td class="small">${esc(c.device || '')}</td><td class="small">${esc(detail || '')}</td></tr>`;
  }).join('');

  box.innerHTML = `
    <p>${summary}</p>
    <table class="table">
      <thead><tr><th>Device</th><th>Link</th><th>Address</th><th>Can reach</th><th>Reported</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${conflicts ? `<h4>Changes that lost when the link and the cloud met</h4>
      <table class="table"><thead><tr><th>When</th><th>What</th><th>Device</th><th>Detail</th></tr></thead><tbody>${conflicts}</tbody></table>` : ''}`;
}

function ago(seconds) {
  const s = Number(seconds) || 0;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

document.addEventListener('click', async (e) => {
  const pin = e.target.closest && e.target.closest('[data-lan-pin]');
  if (pin) {
    const id = pin.getAttribute('data-lan-pin');
    const unpin = pin.textContent.trim() === 'Unpin';
    try {
      await api('/lan/settings', { method: 'PUT', body: JSON.stringify({ preferred_hub: unpin ? null : id }) });
      toast(unpin ? 'No till is pinned; the longest running is the main one.' : 'Pinned. That till becomes the main one within a minute.');
      loadLan();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  if (e.target.id === 'lan-refresh') loadLan();
});
