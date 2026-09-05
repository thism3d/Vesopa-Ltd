/**
 * Dine-in, in the back office.
 *
 * Four views, and the order they appear in the nav is the order a venue does
 * them in — which is deliberate, because every one of them is useless without
 * the one above it:
 *
 *   1. **Your menu page** — the web address, the name, the picture at the top,
 *      and the two switches that decide whether anybody can see it or order
 *      from it. Nothing else works until this is filled in.
 *   2. **Menu** — which products a customer is shown, in which sections, with
 *      the wording and pictures a phone deserves rather than the twelve
 *      characters that fit on a till key.
 *   3. **Table codes** — the address of every table and the card to print for
 *      it. This is the physical output of the whole feature.
 *   4. **Online orders** — what has come in, and where each one got to.
 *
 * Kept out of app.js, which is eight thousand lines, for the same reason
 * screens.js and permissions.js are: this is a self-contained feature with its
 * own state, and the only things it borrows are `api`, `$` and `esc`.
 */

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let diVenue = null;
let diMenu = [];
let diTables = { base: '', slug: null, tables: [] };
let diDesigns = [];
let diDesign = null;
let diCatalogue = null;

/** The address a customer would type, as opposed to the one on the card. */
function diVenueUrl() {
  if (!diVenue || !diVenue.slug) return '';
  return (diTables.base || location.origin) + '/m/' + diVenue.slug;
}

function diMoney(minor) {
  return '£' + (Number(minor || 0) / 100).toFixed(2);
}

/**
 * Report a failure where the person can see it, and never leave a half-drawn
 * panel behind. Every view here calls this from its catch.
 */
function diFail(id, e) {
  const box = $(id);
  if (box) {
    box.innerHTML =
      '<div class="empty">' + esc(e.message || 'That did not load.') + '</div>';
  }
}

// ---------------------------------------------------------------------------
// 1. Your menu page
// ---------------------------------------------------------------------------

async function loadDineIn() {
  try {
    diVenue = await api('/dinein/venue');
  } catch (e) {
    return diFail('dinein-body', e);
  }

  const v = diVenue;
  const name = v.display_name || v.fallback_name || '';
  const base = (diTables.base || location.origin);

  $('dinein-body').innerHTML = `
    <div class="card">
      <h3>Your web address</h3>
      <p class="hint">
        This is where a customer lands when they scan a code or follow a link.
        Choose it once and leave it alone — it is printed on things.
      </p>
      <div class="row" style="align-items:center;gap:8px">
        <span class="hint" style="white-space:nowrap">${esc(base)}/</span>
        <input id="di-slug" value="${esc(v.slug || '')}"
               placeholder="your-venue" style="max-width:280px">
        <button class="btn" id="di-slug-check" type="button">Check</button>
      </div>
      <div id="di-slug-note" class="hint" style="margin-top:6px"></div>
    </div>

    <div class="card">
      <h3>What a customer sees</h3>
      <div class="grid-2">
        <label>Name
          <input id="di-name" value="${esc(v.display_name || '')}"
                 placeholder="${esc(v.fallback_name || 'Your venue')}">
        </label>
        <label>Strapline
          <input id="di-tagline" value="${esc(v.tagline || '')}"
                 placeholder="Fresh, local, all day">
        </label>
        <label>Phone
          <input id="di-phone" value="${esc(v.phone || '')}">
        </label>
        <label>Postcode
          <input id="di-postcode" value="${esc(v.postcode || '')}">
        </label>
        <label style="grid-column:1/-1">Address
          <input id="di-address" value="${esc(v.address_line || '')}">
        </label>
        <label style="grid-column:1/-1">Map link
          <input id="di-map" value="${esc(v.map_url || '')}"
                 placeholder="https://maps.google.com/…">
          <span class="hint">The "Find us" button opens this. Any map will do.</span>
        </label>
        <label>Logo image URL
          <input id="di-logo" value="${esc(v.logo_url || '')}">
        </label>
        <label>Banner image URL
          <input id="di-banner" value="${esc(v.banner_url || '')}">
        </label>
        <label>Accent colour
          <input id="di-accent" type="color"
                 value="${esc(v.accent_colour || '#A5C715')}">
          <span class="hint">Buttons and highlights take this colour.</span>
        </label>
        <label style="grid-column:1/-1">Notice above the menu
          <input id="di-notice" value="${esc(v.notice || '')}"
                 placeholder="Kitchen closes at 9pm">
        </label>
      </div>
    </div>

    <div class="card">
      <h3>Open for business</h3>
      <p class="hint">
        These are separate on purpose. A venue often wants its menu readable
        weeks before it is ready to have tickets arriving at the till.
      </p>
      <label class="check">
        <input type="checkbox" id="di-published" ${v.is_published ? 'checked' : ''}>
        <span><b>Menu is live.</b> Anybody with the link or a code can read it.</span>
      </label>
      <label class="check">
        <input type="checkbox" id="di-ordering" ${v.ordering_open ? 'checked' : ''}>
        <span><b>Taking orders.</b> Customers can send an order to the till.</span>
      </label>
      <hr>
      <label class="check">
        <input type="checkbox" id="di-req-name" ${v.require_name ? 'checked' : ''}>
        <span>A name is required to order</span>
      </label>
      <label class="check">
        <input type="checkbox" id="di-req-phone" ${v.require_phone ? 'checked' : ''}>
        <span>A phone number is required to order</span>
      </label>
    </div>

    <div class="row" style="gap:10px;align-items:center">
      <button class="btn primary" id="di-save" type="button">Save</button>
      <a id="di-preview" class="btn" target="_blank" rel="noopener"
         href="${esc(diVenueUrl() || '#')}"
         ${v.slug ? '' : 'hidden'}>Open the menu page</a>
      <span id="di-saved" class="hint"></span>
    </div>
  `;

  $('di-slug-check').onclick = diCheckSlug;
  $('di-save').onclick = diSaveVenue;
  // Also on blur: the commonest way to find out the address is taken should not
  // be pressing Save.
  $('di-slug').onblur = diCheckSlug;
}

async function diCheckSlug() {
  const note = $('di-slug-note');
  const raw = $('di-slug').value.trim();
  if (!raw) { note.textContent = ''; return; }
  try {
    const res = await api('/dinein/slug-check?slug=' + encodeURIComponent(raw));
    if (res.slug && res.slug !== raw) $('di-slug').value = res.slug;
    note.textContent = res.ok
      ? 'That address is free.'
      : (res.reason || 'That address will not work.');
    note.style.color = res.ok ? 'var(--ok, #2E7D32)' : 'var(--bad, #B3261E)';
  } catch (e) {
    note.textContent = e.message;
  }
}

async function diSaveVenue() {
  const body = {
    slug: $('di-slug').value.trim(),
    display_name: $('di-name').value,
    tagline: $('di-tagline').value,
    phone: $('di-phone').value,
    address_line: $('di-address').value,
    postcode: $('di-postcode').value,
    map_url: $('di-map').value,
    logo_url: $('di-logo').value,
    banner_url: $('di-banner').value,
    accent_colour: $('di-accent').value,
    notice: $('di-notice').value,
    is_published: $('di-published').checked,
    ordering_open: $('di-ordering').checked,
    require_name: $('di-req-name').checked,
    require_phone: $('di-req-phone').checked,
  };
  // An empty address is not a change to the address, it is somebody who has
  // not chosen one yet. Sending it would fail validation and lose the rest.
  if (!body.slug) delete body.slug;

  try {
    const res = await api('/dinein/venue', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    diVenue = res.venue;
    $('di-saved').textContent = 'Saved.';
    setTimeout(() => { const s = $('di-saved'); if (s) s.textContent = ''; }, 2500);
    const link = $('di-preview');
    if (link && diVenue.slug) {
      link.hidden = false;
      link.href = diVenueUrl();
    }
  } catch (e) {
    alert(e.message);
  }
}

// ---------------------------------------------------------------------------
// 2. The menu
// ---------------------------------------------------------------------------

async function loadDineInMenu() {
  try {
    diMenu = await api('/dinein/menu');
  } catch (e) {
    return diFail('dinein_menu-body', e);
  }

  const body = $('dinein_menu-body');
  if (!diMenu.length) {
    body.innerHTML = `
      <div class="empty">
        <p>No sections yet. A section is a heading on the customer's phone —
           Starters, Mains, Drinks — and the tabs across the top are made from
           them.</p>
        <button class="btn primary" id="di-add-section" type="button">
          Add the first section
        </button>
      </div>`;
    $('di-add-section').onclick = diAddSection;
    return;
  }

  body.innerHTML =
    diMenu.map(diSectionCard).join('') +
    `<button class="btn" id="di-add-section" type="button">Add a section</button>`;

  $('di-add-section').onclick = diAddSection;
  body.querySelectorAll('[data-sec-save]').forEach((b) => {
    b.onclick = () => diSaveSection(Number(b.dataset.secSave));
  });
  body.querySelectorAll('[data-sec-del]').forEach((b) => {
    b.onclick = () => diDeleteSection(Number(b.dataset.secDel));
  });
  body.querySelectorAll('[data-sec-add]').forEach((b) => {
    b.onclick = () => diPickProducts(Number(b.dataset.secAdd));
  });
  body.querySelectorAll('[data-item-del]').forEach((b) => {
    b.onclick = () => diDeleteItem(Number(b.dataset.itemDel));
  });
  body.querySelectorAll('[data-item-save]').forEach((b) => {
    b.onclick = () => diSaveItem(Number(b.dataset.itemSave));
  });
  body.querySelectorAll('[data-item-avail]').forEach((c) => {
    c.onchange = () =>
      diSetAvailable(Number(c.dataset.itemAvail), c.checked);
  });
}

function diSectionCard(section) {
  return `
    <div class="card" data-section="${section.id}">
      <div class="row" style="gap:8px;align-items:flex-end">
        <label style="flex:1">Section
          <input data-f="name" data-sec="${section.id}"
                 value="${esc(section.name || '')}">
        </label>
        <label style="flex:2">Line underneath
          <input data-f="blurb" data-sec="${section.id}"
                 value="${esc(section.blurb || '')}"
                 placeholder="Served 12 til 3">
        </label>
        <button class="btn" data-sec-save="${section.id}" type="button">Save</button>
        <button class="btn danger" data-sec-del="${section.id}" type="button">Delete</button>
      </div>

      ${section.items.length
        ? `<table class="grid" style="margin-top:12px">
             <thead><tr>
               <th style="width:34%">Shown as</th>
               <th>Description</th>
               <th style="width:80px">On</th>
               <th style="width:150px"></th>
             </tr></thead>
             <tbody>${section.items.map(diItemRow).join('')}</tbody>
           </table>`
        : '<p class="hint" style="margin-top:10px">Nothing in this section yet.</p>'}

      <button class="btn" data-sec-add="${section.id}" type="button"
              style="margin-top:10px">Add products</button>
    </div>`;
}

function diItemRow(item) {
  return `
    <tr data-item="${item.id}">
      <td>
        <input data-f="name" data-item="${item.id}"
               value="${esc(item.name || '')}" placeholder="PLU ${item.plu_id}">
        <span class="hint">PLU ${item.plu_id}</span>
      </td>
      <td>
        <input data-f="description" data-item="${item.id}"
               value="${esc(item.description || '')}"
               placeholder="What is in it, and what it comes with">
      </td>
      <td style="text-align:center">
        <input type="checkbox" data-item-avail="${item.id}"
               ${item.available ? 'checked' : ''}
               title="Uncheck when the kitchen runs out">
      </td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn" data-item-save="${item.id}" type="button">Save</button>
        <button class="btn danger" data-item-del="${item.id}" type="button">Remove</button>
      </td>
    </tr>`;
}

function diField(kind, id, field) {
  const el = document.querySelector(`[data-f="${field}"][data-${kind}="${id}"]`);
  return el ? el.value : undefined;
}

async function diAddSection() {
  const name = prompt('What is this section called? (Starters, Mains, Drinks…)');
  if (!name) return;
  try {
    await api('/dinein/sections', {
      method: 'POST',
      body: JSON.stringify({ name, sort_order: diMenu.length + 1 }),
    });
    await loadDineInMenu();
  } catch (e) {
    alert(e.message);
  }
}

async function diSaveSection(id) {
  try {
    await api('/dinein/sections/' + id, {
      method: 'PUT',
      body: JSON.stringify({
        name: diField('sec', id, 'name'),
        blurb: diField('sec', id, 'blurb'),
      }),
    });
    await loadDineInMenu();
  } catch (e) {
    alert(e.message);
  }
}

async function diDeleteSection(id) {
  const section = diMenu.find((s) => s.id === id);
  const count = section ? section.items.length : 0;
  if (!confirm(
    count
      ? `Delete "${section.name}" and take its ${count} item${count === 1 ? '' : 's'} off the menu?`
      : 'Delete this section?'
  )) return;
  try {
    await api('/dinein/sections/' + id, { method: 'DELETE' });
    await loadDineInMenu();
  } catch (e) {
    alert(e.message);
  }
}

async function diSaveItem(id) {
  try {
    await api('/dinein/items/' + id, {
      method: 'PUT',
      body: JSON.stringify({
        name: diField('item', id, 'name'),
        description: diField('item', id, 'description'),
      }),
    });
    await loadDineInMenu();
  } catch (e) {
    alert(e.message);
  }
}

/**
 * Sold out, and back again.
 *
 * Saved on the spot rather than behind a Save button: this is the one thing on
 * the page that gets changed mid-service, by somebody the kitchen has just
 * shouted at, and it has to be one tap.
 */
async function diSetAvailable(id, available) {
  try {
    await api('/dinein/items/' + id, {
      method: 'PUT',
      body: JSON.stringify({ available }),
    });
  } catch (e) {
    alert(e.message);
    await loadDineInMenu();
  }
}

async function diDeleteItem(id) {
  try {
    await api('/dinein/items/' + id, { method: 'DELETE' });
    await loadDineInMenu();
  } catch (e) {
    alert(e.message);
  }
}

/**
 * Pick products off the catalogue, several at once.
 *
 * A searchable list of tick boxes rather than a dropdown per item: a venue puts
 * a whole section on the menu in one sitting, and doing that one dropdown at a
 * time is the difference between five minutes and half an hour.
 */
async function diPickProducts(sectionId) {
  if (!diCatalogue) {
    try {
      diCatalogue = await api('/products');
    } catch (e) {
      return alert(e.message);
    }
  }

  const already = new Set();
  diMenu.forEach((s) => s.items.forEach((i) => already.add(i.plu_id)));

  const rows = diCatalogue.map((p) => `
    <label class="check" data-name="${esc(
      (p.product_name + ' ' + (p.department_name || '')).toLowerCase()
    )}">
      <input type="checkbox" value="${p.pluid}"
             ${already.has(p.pluid) ? 'disabled' : ''}>
      <span>
        ${esc(p.product_name)}
        <span class="hint">${esc(p.department_name || '')} · £${Number(p.price || 0).toFixed(2)}${
          already.has(p.pluid) ? ' · already on the menu' : ''
        }</span>
      </span>
    </label>`).join('');

  showPanel('Add products to this section', `
    <input id="di-pick-search" placeholder="Search the catalogue"
           style="width:100%;margin-bottom:10px">
    <div id="di-pick-list"
         style="max-height:52vh;overflow:auto;border:1px solid var(--line);
                border-radius:8px;padding:8px">${rows}</div>
    <div class="row" style="margin-top:12px;gap:8px">
      <button class="btn primary" id="di-pick-add" type="button">Add ticked</button>
      <span id="di-pick-note" class="hint"></span>
    </div>
  `);

  $('di-pick-search').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    $('di-pick-list').querySelectorAll('[data-name]').forEach((row) => {
      row.hidden = q !== '' && !row.dataset.name.includes(q);
    });
  };

  $('di-pick-add').onclick = async () => {
    const picked = [...$('di-pick-list').querySelectorAll('input:checked')]
      .map((c) => Number(c.value));
    if (!picked.length) {
      $('di-pick-note').textContent = 'Nothing ticked.';
      return;
    }
    try {
      await api('/dinein/sections/' + sectionId + '/items', {
        method: 'POST',
        body: JSON.stringify({ plu_ids: picked }),
      });
      closePanel();
      await loadDineInMenu();
    } catch (e) {
      alert(e.message);
    }
  };
}

// ---------------------------------------------------------------------------
// 3. Table codes, and the card to print
// ---------------------------------------------------------------------------

async function loadDineInQr() {
  try {
    [diTables, diDesigns] = await Promise.all([
      api('/dinein/tables'),
      api('/dinein/designs'),
    ]);
  } catch (e) {
    return diFail('dinein_qr-body', e);
  }

  if (!diDesigns.length) {
    try {
      const made = await api('/dinein/designs', {
        method: 'POST',
        body: JSON.stringify({ name: 'Table card', is_default: true }),
      });
      diDesigns = await api('/dinein/designs');
      diDesign = diDesigns.find((d) => d.id === made.id) || diDesigns[0];
    } catch (e) {
      return diFail('dinein_qr-body', e);
    }
  }
  diDesign = diDesign
    ? diDesigns.find((d) => d.id === diDesign.id) || diDesigns[0]
    : diDesigns[0];

  const withCodes = diTables.tables.filter((t) => t.public_id);

  $('dinein_qr-body').innerHTML = `
    <div class="card">
      <h3>Every table has its own address</h3>
      <p class="hint">
        A table's code never changes, even when you rename or renumber it — so a
        card you print today keeps working. Untick a table to stop phones
        ordering from it without taking the card away.
      </p>
      ${withCodes.length
        ? `<table class="grid">
             <thead><tr>
               <th>Table</th><th>Room</th><th>Link</th>
               <th style="width:90px">Ordering</th><th style="width:110px"></th>
             </tr></thead>
             <tbody>${withCodes.map((t) => `
               <tr>
                 <td><b>${esc(t.display_name)}</b></td>
                 <td>${esc(t.room_name || '')}</td>
                 <td><a href="${esc(t.url)}" target="_blank" rel="noopener"
                        class="hint" style="word-break:break-all">${esc(t.url)}</a></td>
                 <td style="text-align:center">
                   <input type="checkbox" data-qr-on="${t.id}"
                          ${t.qr_enabled ? 'checked' : ''}>
                 </td>
                 <td style="text-align:right">
                   <button class="btn" data-qr-print="${t.id}" type="button">Print</button>
                 </td>
               </tr>`).join('')}
             </tbody>
           </table>
           <div class="row" style="margin-top:12px;gap:8px">
             <button class="btn primary" id="di-print-all" type="button">
               Print a card for every table
             </button>
           </div>`
        : `<div class="empty">No tables yet. Draw your floor in
             <b>Table Designer</b> first — every table you add gets a code
             automatically.</div>`}
    </div>

    <div class="card">
      <h3>The card</h3>
      <div class="row" style="gap:14px;align-items:flex-start;flex-wrap:wrap">
        <div style="flex:0 0 300px">
          <label>Paper
            <select id="di-page">
              ${[
                ['a4', 'A4 sheet (210 × 297mm)'],
                ['a5', 'A5 card (148 × 210mm)'],
                ['a6', 'A6 card (105 × 148mm)'],
                ['sticker80', 'Square sticker (80 × 80mm)'],
                ['sticker60', 'Square sticker (60 × 60mm)'],
                ['custom', 'Custom size'],
              ].map(([v, label]) =>
                `<option value="${v}" ${diDesign.page_size === v ? 'selected' : ''}>${label}</option>`
              ).join('')}
            </select>
          </label>
          <div id="di-custom" class="row" style="gap:8px"
               ${diDesign.page_size === 'custom' ? '' : 'hidden'}>
            <label>Width mm<input id="di-pw" type="number" value="${diDesign.page_w_mm}"></label>
            <label>Height mm<input id="di-ph" type="number" value="${diDesign.page_h_mm}"></label>
          </div>
          <label>Background
            <input id="di-bg" type="color" value="${esc(diDesign.background || '#FFFFFF')}">
          </label>

          <h4 style="margin:16px 0 6px">What is on it</h4>
          <div id="di-elements"></div>
          <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
            <button class="btn" data-add-el="text" type="button">+ Text</button>
            <button class="btn" data-add-el="image" type="button">+ Image</button>
            <button class="btn" data-add-el="link" type="button">+ Web address</button>
          </div>
          <button class="btn primary" id="di-design-save" type="button"
                  style="margin-top:14px">Save the card</button>
          <span id="di-design-saved" class="hint"></span>
        </div>

        <div style="flex:1 1 320px">
          <p class="hint">Preview, with the first table's details filled in.</p>
          <div id="di-preview-card"></div>
        </div>
      </div>
    </div>
  `;

  $('di-page').onchange = () => {
    diDesign.page_size = $('di-page').value;
    $('di-custom').hidden = diDesign.page_size !== 'custom';
    diDrawPreview();
  };
  $('di-bg').oninput = () => { diDesign.background = $('di-bg').value; diDrawPreview(); };
  const pw = $('di-pw'); const ph = $('di-ph');
  if (pw) pw.oninput = () => { diDesign.page_w_mm = Number(pw.value) || 148; diDrawPreview(); };
  if (ph) ph.oninput = () => { diDesign.page_h_mm = Number(ph.value) || 210; diDrawPreview(); };

  document.querySelectorAll('[data-add-el]').forEach((b) => {
    b.onclick = () => {
      diDesign.elements.push(
        b.dataset.addEl === 'image'
          ? { kind: 'image', x: 30, y: 4, w: 40, h: 14, url: '' }
          : b.dataset.addEl === 'link'
            ? { kind: 'link', x: 10, y: 88, w: 80, h: 6, size: 11, align: 'center' }
            : { kind: 'text', x: 10, y: 88, w: 80, h: 7, size: 13,
                align: 'center', text: 'Ask us about allergens' }
      );
      diDrawElements();
      diDrawPreview();
    };
  });
  $('di-design-save').onclick = diSaveDesign;

  document.querySelectorAll('[data-qr-on]').forEach((c) => {
    c.onchange = async () => {
      try {
        await api('/floor/tables/' + c.dataset.qrOn, {
          method: 'PUT',
          body: JSON.stringify({ qr_enabled: c.checked }),
        });
      } catch (e) {
        alert(e.message);
        c.checked = !c.checked;
      }
    };
  });
  document.querySelectorAll('[data-qr-print]').forEach((b) => {
    b.onclick = () => diPrint([Number(b.dataset.qrPrint)]);
  });
  const all = $('di-print-all');
  if (all) all.onclick = () => diPrint(withCodes.map((t) => t.id));

  diDrawElements();
  diDrawPreview();
}

const DI_ELEMENT_NAMES = {
  qr: 'The code',
  venue_name: 'Your venue name',
  table_name: 'The table name',
  text: 'Text',
  image: 'Picture',
  link: 'Your web address',
};

function diDrawElements() {
  $('di-elements').innerHTML = diDesign.elements.map((el, i) => `
    <div class="card" style="padding:8px;margin:6px 0">
      <div class="row" style="justify-content:space-between;align-items:center">
        <b style="font-size:13px">${esc(DI_ELEMENT_NAMES[el.kind] || el.kind)}</b>
        <button class="btn danger" data-el-del="${i}" type="button"
                style="padding:2px 8px">×</button>
      </div>
      ${el.kind === 'text'
        ? `<input data-el="${i}" data-k="text" value="${esc(el.text || '')}"
                  placeholder="What it should say">` : ''}
      ${el.kind === 'image'
        ? `<input data-el="${i}" data-k="url" value="${esc(el.url || '')}"
                  placeholder="Image URL">` : ''}
      <div class="row" style="gap:6px;margin-top:6px">
        <label style="flex:1">Left %<input type="number" data-el="${i}" data-k="x" value="${el.x}"></label>
        <label style="flex:1">Top %<input type="number" data-el="${i}" data-k="y" value="${el.y}"></label>
        <label style="flex:1">Width %<input type="number" data-el="${i}" data-k="w" value="${el.w}"></label>
        <label style="flex:1">Height %<input type="number" data-el="${i}" data-k="h" value="${el.h}"></label>
      </div>
    </div>`).join('');

  $('di-elements').querySelectorAll('[data-el-del]').forEach((b) => {
    b.onclick = () => {
      diDesign.elements.splice(Number(b.dataset.elDel), 1);
      diDrawElements();
      diDrawPreview();
    };
  });
  $('di-elements').querySelectorAll('[data-el][data-k]').forEach((input) => {
    input.oninput = () => {
      const el = diDesign.elements[Number(input.dataset.el)];
      const key = input.dataset.k;
      el[key] = input.type === 'number' ? Number(input.value) : input.value;
      diDrawPreview();
    };
  });
}

const DI_PAGES = {
  a4: [210, 297], a5: [148, 210], a6: [105, 148],
  sticker80: [80, 80], sticker60: [60, 60],
};

function diPageSize(design) {
  if (design.page_size === 'custom') {
    return [design.page_w_mm || 148, design.page_h_mm || 210];
  }
  return DI_PAGES[design.page_size] || DI_PAGES.a5;
}

/**
 * One card, as HTML sized in millimetres.
 *
 * Millimetres rather than pixels because this is going to a printer and mm is
 * the one unit that means the same thing on screen and on paper. Element
 * positions are percentages of the page, so the same design prints correctly on
 * an A4 sheet and on a 60mm sticker.
 */
function diCardHtml(design, table, base) {
  const [w, h] = diPageSize(design);
  const url = base + '/t/' + table.public_id;

  const bits = design.elements.map((el) => {
    const box =
      `position:absolute;left:${el.x}%;top:${el.y}%;` +
      `width:${el.w}%;height:${el.h}%;`;
    const type =
      `font-size:${el.size || 14}pt;` +
      `text-align:${el.align || 'center'};` +
      `font-weight:${el.bold ? '800' : '400'};` +
      'display:flex;align-items:center;justify-content:center;' +
      'line-height:1.15;';

    switch (el.kind) {
      case 'qr':
        // The SVG markup itself, not an <img src>. /api/qr.svg is behind the
        // session — a plain src would 401 in this page and would have nothing
        // to authenticate with at all in the print window, which is a separate
        // document with no token. So the codes are fetched up front (see
        // diCodesFor) and inlined here, which also means the print window has
        // everything it needs the moment it opens.
        return `<div style="${box}display:flex;align-items:center;justify-content:center">
                  <div style="height:100%;aspect-ratio:1/1">${
                    diCodes[table.public_id] || ''
                  }</div>
                </div>`;
      case 'venue_name':
        return `<div style="${box}${type}">${esc(
          (diVenue && (diVenue.display_name || diVenue.fallback_name)) || ''
        )}</div>`;
      case 'table_name':
        return `<div style="${box}${type}">${esc(table.display_name)}</div>`;
      case 'link':
        return `<div style="${box}${type}">${esc(
          base.replace(/^https?:\/\//, '') + '/t/' + table.public_id.slice(0, 8) + '…'
        )}</div>`;
      case 'image':
        return el.url
          ? `<div style="${box}"><img src="${esc(el.url)}"
               style="width:100%;height:100%;object-fit:contain"></div>`
          : '';
      default:
        return `<div style="${box}${type}">${esc(el.text || '')}</div>`;
    }
  }).join('');

  return `<div class="di-card" style="
    position:relative;width:${w}mm;height:${h}mm;
    background:${esc(design.background || '#FFFFFF')};
    overflow:hidden;page-break-after:always;break-after:page;
  ">${bits}</div>`;
}

/**
 * The QR images, by table id.
 *
 * Fetched once and kept, because a venue with forty tables printing a set of
 * cards would otherwise make forty requests while the print dialog is trying to
 * open — and the pages that had not arrived would print blank.
 */
const diCodes = Object.create(null);

/**
 * Make sure every one of these tables has its code in hand.
 *
 * Resolves only when they are all there. Everything that draws a card awaits
 * this first, so there is no state in which a card is rendered with a hole
 * where the code should be.
 */
async function diCodesFor(tables, base) {
  const missing = tables.filter((t) => t.public_id && !diCodes[t.public_id]);
  if (!missing.length) return;

  await Promise.all(missing.map(async (t) => {
    const url = base + '/t/' + t.public_id;
    try {
      const res = await fetch(
        '/api/qr.svg?size=420&text=' + encodeURIComponent(url),
        { headers: token ? { Authorization: 'Bearer ' + token } : {} }
      );
      if (!res.ok) throw new Error(String(res.status));
      const svg = await res.text();
      // Sized by its box rather than by the attributes the encoder wrote, so
      // one fetch serves a preview and an A4 sheet.
      diCodes[t.public_id] = svg.replace(
        /<svg([^>]*)>/,
        '<svg$1 style="width:100%;height:100%;display:block">'
      );
    } catch {
      // A code that will not load leaves a blank square rather than taking the
      // whole sheet down. The link under it still works.
      diCodes[t.public_id] = '';
    }
  }));
}

async function diDrawPreview() {
  const table = diTables.tables.find((t) => t.public_id) || {
    public_id: '0'.repeat(32),
    display_name: 'Table 1',
  };
  await diCodesFor([table], diTables.base || location.origin);
  const [w] = diPageSize(diDesign);
  // Scaled to the panel rather than shown at print size: an A4 card at true
  // size does not fit beside its own controls on any screen.
  const scale = Math.min(1, 300 / (w * 3.78));
  $('di-preview-card').innerHTML = `
    <div style="transform:scale(${scale});transform-origin:top left;
                border:1px solid var(--line);display:inline-block;
                box-shadow:0 4px 18px rgba(0,0,0,.12)">
      ${diCardHtml(diDesign, table, diTables.base || location.origin)}
    </div>`;
}

async function diSaveDesign() {
  try {
    await api('/dinein/designs/' + diDesign.id, {
      method: 'PUT',
      body: JSON.stringify({
        page_size: diDesign.page_size,
        page_w_mm: diDesign.page_w_mm,
        page_h_mm: diDesign.page_h_mm,
        background: diDesign.background,
        elements: diDesign.elements,
      }),
    });
    $('di-design-saved').textContent = 'Saved.';
    setTimeout(() => {
      const s = $('di-design-saved');
      if (s) s.textContent = '';
    }, 2500);
  } catch (e) {
    alert(e.message);
  }
}

/**
 * Send cards to the printer.
 *
 * A new window with its own @page rule rather than printing this one, because
 * the back office's stylesheet has a sidebar in it and a print stylesheet that
 * hid everything but one div would still be fighting it. The window owns
 * nothing but the cards.
 */
async function diPrint(tableIds) {
  const base = diTables.base || location.origin;
  const chosen = diTables.tables.filter(
    (t) => t.public_id && tableIds.includes(t.id)
  );
  if (!chosen.length) return;

  // Opened before the await, because a pop-up opened after one is a pop-up the
  // browser blocks: it is no longer attributable to the click.
  const win = window.open('', '_blank');
  if (!win) {
    return alert('Your browser blocked the print window. Allow pop-ups for this site.');
  }
  win.document.write('<!doctype html><title>Table cards</title>' +
    '<p style="font:15px system-ui;padding:24px">Drawing the codes…</p>');

  await diCodesFor(chosen, base);
  const [w, h] = diPageSize(diDesign);
  win.document.open();
  win.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>Table cards</title>
<style>
  @page { size: ${w}mm ${h}mm; margin: 0 }
  html,body { margin:0; padding:0; background:#fff }
  .di-card:last-child { page-break-after:auto; break-after:auto }
  img { display:block }
</style></head><body>
${chosen.map((t) => diCardHtml(diDesign, t, base)).join('')}
<script>
  // Wait for the codes to arrive before the dialog opens, or the first page
  // prints blank — which is exactly the page somebody is checking.
  window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 350); });
<\/script>
</body></html>`);
  win.document.close();
}

// ---------------------------------------------------------------------------
// 4. Online orders
// ---------------------------------------------------------------------------

const DI_STATUS = {
  placed: ['Waiting', 'warn'],
  accepted: ['In the kitchen', 'info'],
  ready: ['Ready', 'ok'],
  served: ['Served', 'muted'],
  rejected: ['Refused', 'bad'],
  cancelled: ['Cancelled', 'muted'],
};

async function loadDineInOrders() {
  let orders;
  try {
    orders = await api('/dinein/orders?limit=100');
  } catch (e) {
    return diFail('dinein_orders-body', e);
  }

  if (!orders.length) {
    $('dinein_orders-body').innerHTML = `
      <div class="empty">
        Nothing has come in from a phone in the last 24 hours.
      </div>`;
    return;
  }

  $('dinein_orders-body').innerHTML = `
    <table class="grid">
      <thead><tr>
        <th style="width:90px">Time</th>
        <th style="width:130px">Table</th>
        <th>What they ordered</th>
        <th style="width:130px">Customer</th>
        <th style="width:90px">Total</th>
        <th style="width:130px">Where it is</th>
      </tr></thead>
      <tbody>${orders.map((o) => {
        const [label, tone] = DI_STATUS[o.status] || [o.status, 'muted'];
        return `<tr>
          <td class="hint">${new Date(o.placed_at).toLocaleTimeString([], {
            hour: '2-digit', minute: '2-digit',
          })}</td>
          <td><b>${esc(o.table_label || '')}</b></td>
          <td>${o.lines.map((l) =>
            `${l.qty} × ${esc(l.name)}${l.note ? ` <span class="hint">(${esc(l.note)})</span>` : ''}`
          ).join('<br>')}
          ${o.note ? `<div class="hint">Note: ${esc(o.note)}</div>` : ''}</td>
          <td>${esc(o.customer_name || '—')}
            ${o.customer_phone ? `<div class="hint">${esc(o.customer_phone)}</div>` : ''}</td>
          <td>${diMoney(o.total_minor)}</td>
          <td><span class="pill ${tone}">${esc(label)}</span>
            ${o.status_note ? `<div class="hint">${esc(o.status_note)}</div>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}
