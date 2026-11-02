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
  const roleName = { till: 'Till', kitchen: 'Kitchen screen', display: 'Customer display', go: 'Vesopa Go' };

  // Devices on different networks: 192.168.1.x cannot find 192.168.10.x by
  // itself, and only reaches it if the router lets the two talk.
  const subnet = (ip) => String(ip || '').split('.').slice(0, 3).join('.');
  const recent = devices.filter((d) => d.age_s < 7 * 86400);
  const tillNets = new Set(recent.filter((d) => d.role === 'till')
    .flatMap((d) => ((d.report && d.report.ips) || []).map(subnet)));
  const apart = recent.filter((d) => {
    const ips = (d.report && d.report.ips) || [];
    return d.role !== 'till' && tillNets.size && ips.length && !ips.some((ip) => tillNets.has(subnet(ip)));
  });
  const ports = data.ports || { tcp: 47821, udp: 47820 };
  const setup = `
    <h4>Network setup</h4>
    <p class="muted small">
      Devices on the same network need nothing set here: they find each other, and no port
      on the router has to be opened or forwarded. Keep the local link off the internet:
      do not forward these ports. To keep going in a power cut the router and any switch
      need a UPS as well as the tills, because they carry the traffic between devices.
    </p>
    <ul class="muted small">
      <li><strong>Ports:</strong> TCP ${esc(ports.tcp)} (the link) and UDP ${esc(ports.udp)} (finding each other), on the tills only. The till installer opens them in Windows Firewall.</li>
      <li><strong>Router:</strong> reserve each till's address (DHCP reservation), and turn off "client isolation" or "AP isolation" on the staff Wi-Fi, or devices cannot see each other.</li>
      <li><strong>Separate networks</strong> (for example tills on cable and tablets on Wi-Fi): let the router pass TCP ${esc(ports.tcp)} from the Wi-Fi network to the tills, and put the tills' addresses below.</li>
    </ul>
    ${apart.length ? `<p class="small"><span class="pill amber">Different network</span>
      ${apart.map((d) => esc(d.name || d.device)).join(', ')} ${apart.length === 1 ? 'is' : 'are'} not on the same network as the tills
      (${[...tillNets].map((n) => `${esc(n)}.x`).join(', ')}), so ${apart.length === 1 ? 'it goes' : 'they go'} through the internet, more slowly, and stop if it drops.</p>` : ''}
    <label class="small">Till addresses to try directly (only if devices do not find each other)
      <input id="lan-hosts" type="text" placeholder="192.168.1.190, 192.168.1.247" value="${esc((data.hosts || []).join(', '))}">
    </label>
    <div class="row gap" style="margin-top:8px"><button class="btn btn-small" id="lan-hosts-save">Save addresses</button></div>`;

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
    // Vesopa support's tools: through the main till, so only for a device on
    // the local link, and only when a main till is reporting.
    const tools = data.support && fresh(d) && (r.linked || r.is_hub)
      ? `<div class="row gap small" style="margin-top:6px;flex-wrap:wrap">
          ${[['ping', 'Test connection'], ['speed', 'Test speed'], ['identify', 'Identify'],
            ...(d.role === 'till' && !r.is_hub ? [['takeover', 'Make main till']] : []),
            ['restart', 'Restart app'], ['disconnect', 'Disconnect']]
            .map(([a, label]) => `<button class="btn btn-small" data-lan-cmd="${esc(a)}" data-lan-target="${esc(d.device)}" data-lan-name="${esc(d.name || d.device)}">${esc(label)}</button>`).join('')}
        </div><div class="small muted" id="lan-result-${esc(d.device)}"></div>`
      : '';
    return `<tr>
      <td><strong>${esc(d.name || d.device)}</strong><br><span class="muted small">${esc(roleName[d.role] || d.role)} · ${esc(d.version || '')}</span></td>
      <td>${state}${data.preferred_hub === d.device ? ' <span class="pill">Pinned</span>' : ''}</td>
      <td class="small">${esc((r.ips || []).join(', ') || '—')}</td>
      <td>${reach}</td>
      <td class="small muted">${fresh(d) ? 'Just now' : esc(ago(d.age_s))}</td>
      <td>${pin}${tools}</td>
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
      <table class="table"><thead><tr><th>When</th><th>What</th><th>Device</th><th>Detail</th></tr></thead><tbody>${conflicts}</tbody></table>` : ''}
    ${setup}
    ${data.support ? `<h4>Vesopa support</h4>
      <p class="small">Code that opens Connected devices on the till today (long-press Network setup in its Settings):
        <strong id="lan-support-code">…</strong></p>
      <div class="row gap"><button class="btn btn-small" data-lan-cmd="fullcheck" data-lan-target="*" data-lan-name="Everything">Full check of everything</button></div>
      <pre class="small" id="lan-result-*" style="white-space:pre-wrap"></pre>` : ''}
    ${data.platform_admin ? `<h4>Who has Vesopa support</h4>
      <p class="muted small">Opens these tools and the till's Connected devices page for the venue the login is in.
        Always: info@vesopa.com, support@vesopa.com, info@vesopasoftware.com, and every platform admin.</p>
      <div id="lan-support-users" class="small">…</div>
      <div class="row gap" style="margin-top:6px">
        <input id="lan-support-email" type="email" placeholder="name@example.com">
        <button class="btn btn-small" id="lan-support-add">Give access</button>
      </div>` : ''}`;
  if (data.support) {
    api('/lan/support-code').then((r) => { const el = $('lan-support-code'); if (el) el.textContent = r.code; }).catch(() => {});
  }
  if (data.platform_admin) loadSupportUsers();
}

async function loadSupportUsers() {
  const box = $('lan-support-users');
  if (!box) return;
  try {
    const r = await api('/lan/support-users');
    box.innerHTML = r.granted.length
      ? r.granted.map((u) => `${esc(u.email)} <span class="muted">${esc(u.office || '')}</span>
          <button class="btn btn-small" data-lan-support-off="${esc(u.email)}">Remove</button>`).join('<br>')
      : '<span class="muted">Nobody else yet.</span>';
  } catch (e) {
    box.textContent = e.message;
  }
}

/** Words for a command's answer, as the till's page says them. */
function lanSaid(action, r) {
  if (!r) return 'Done.';
  if (r.error) return r.error;
  const ms = (v) => (typeof v === 'number' ? `${v.toFixed(v < 10 ? 1 : 0)} ms` : '?');
  if (action === 'ping') {
    return r.ok ? `Reached: ${ms(r.avg_ms)} average, ${ms(r.min_ms)} best, ${ms(r.max_ms)} worst, ${r.lost} of ${r.sent} lost.` : `No answer (${r.sent} tried).`;
  }
  if (action === 'speed') {
    const low = Math.min(r.up_mbps || 0, r.down_mbps || 0);
    return `${low >= 5 ? 'Good' : low >= 1 ? 'Slow' : 'Poor'}: ${(r.up_mbps || 0).toFixed(1)} Mbit/s sending, ${(r.down_mbps || 0).toFixed(1)} receiving.`;
  }
  if (action === 'fullcheck') {
    const out = [r.internet_ms == null ? 'Internet: FAILED' : `Internet: OK, ${r.internet_ms} ms`];
    for (const d of r.devices || []) out.push(`${d.name}: ${lanSaid('ping', d.link)}${d.speed ? ' ' + lanSaid('speed', d.speed) : ''}`);
    for (const p of r.printers || []) out.push(`Printer ${p.name}: ${p.ok == null ? (p.note || '') : p.ok ? `OK, ${p.ms} ms` : 'NO ANSWER'} (${p.where})`);
    return out.join('\n');
  }
  return 'Done.';
}

async function runLanCommand(target, action, name) {
  const out = $(`lan-result-${target}`);
  const say = (t) => { if (out) out.textContent = t; };
  say('Sent to the main till…');
  try {
    const { id } = await api('/lan/commands', { method: 'POST', body: JSON.stringify({ target, action }) });
    const started = Date.now();
    while (Date.now() - started < 120000) {
      await new Promise((r) => setTimeout(r, 1500));
      const c = await api(`/lan/commands/${id}`);
      if (c.status === 'done' || c.status === 'failed') {
        say(`${name}: ${lanSaid(action, c.result)}`);
        return;
      }
      if (c.status === 'running') say('The main till is on it…');
    }
    say('No answer from the main till yet. It collects commands when it next reports, within a minute.');
  } catch (e) {
    say(e.message);
  }
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
  const cmd = e.target.closest && e.target.closest('[data-lan-cmd]');
  if (cmd) {
    const action = cmd.getAttribute('data-lan-cmd');
    const name = cmd.getAttribute('data-lan-name');
    const ask = { restart: `Restart the Vesopa app on ${name}? Refused during a sale.`,
      disconnect: `Take ${name} off the local link for a minute?`, takeover: `Make ${name} the main till?` }[action];
    if (ask && !window.confirm(ask)) return;
    runLanCommand(cmd.getAttribute('data-lan-target'), action, name);
    return;
  }
  if (e.target.id === 'lan-support-add') {
    try {
      await api('/lan/support-users', { method: 'PUT', body: JSON.stringify({ email: $('lan-support-email').value, on: true }) });
      toast('Vesopa support given.');
      $('lan-support-email').value = '';
      loadSupportUsers();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }
  const off = e.target.closest && e.target.closest('[data-lan-support-off]');
  if (off) {
    try {
      await api('/lan/support-users', { method: 'PUT', body: JSON.stringify({ email: off.getAttribute('data-lan-support-off'), on: false }) });
      loadSupportUsers();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }
  if (e.target.id === 'lan-hosts-save') {
    try {
      await api('/lan/settings', { method: 'PUT', body: JSON.stringify({ hosts: $('lan-hosts').value }) });
      toast('Saved. Devices pick the addresses up within 15 minutes, or when restarted.');
      loadLan();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  if (e.target.id === 'lan-refresh') loadLan();
});
