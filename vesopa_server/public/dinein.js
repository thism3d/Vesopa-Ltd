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

/** The address a customer would type, as opposed to the one on the card.
 *
 * At the root of the menu host — `menu.vesopaepos.com/vesopakitchen` — because
 * that host serves nothing but menus and there is therefore nothing for a venue
 * name to collide with. `/m/<slug>` still answers, so any link already printed
 * or sent keeps working. */
function diVenueUrl() {
  if (!diVenue || !diVenue.slug) return '';
  return (diTables.base || location.origin) + '/' + diVenue.slug;
}

/**
 * A colour, shown as one.
 *
 * `input[type=color]` on its own is a small grey rectangle with a hairline of
 * the colour inside it — on the Windows build it is barely readable at a
 * glance, and the whole point of this panel is glancing at eight colours at
 * once and seeing whether they go together. So the swatch is the control: a
 * round well of the colour itself, the size of a button, with the native picker
 * lying invisibly on top of it so a tap still opens the operating system's own
 * colour wheel. The hex sits beside it for anybody who has a brand guide with
 * numbers in it.
 *
 * The swatch and the readout follow the input, so the panel says what it is set
 * to while the picker is still open — which is also what feeds the preview.
 */
function diSwatch(id, value) {
  const hex = String(value || '#000000').toUpperCase();
  return `
    <span class="di-swatch" data-swatch-for="${esc(id)}">
      <span class="di-swatch-well" style="background:${esc(hex)}">
        <input id="${esc(id)}" type="color" value="${esc(hex)}"
               aria-label="Pick a colour">
      </span>
      <code class="di-swatch-hex">${esc(hex)}</code>
    </span>`;
}

/** Keep every swatch showing what its picker is set to. */
function diWireSwatches(root) {
  (root || document).querySelectorAll('.di-swatch').forEach((sw) => {
    const input = sw.querySelector('input[type="color"]');
    if (!input || input.dataset.swatchWired) return;
    input.dataset.swatchWired = '1';
    const paint = () => {
      const hex = String(input.value || '').toUpperCase();
      sw.querySelector('.di-swatch-well').style.background = hex;
      sw.querySelector('.di-swatch-hex').textContent = hex;
    };
    input.addEventListener('input', paint);
    input.addEventListener('change', paint);
    paint();
  });
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
  // From the venue itself, not from whichever page was open last. `diTables` is
  // filled in by the Table codes page, so on a fresh visit here it was empty
  // and every address on this page fell back to the back office's own origin.
  if (v.base) diTables.base = v.base;
  const base = (v.base || diTables.base || location.origin);
  // Always a full palette: the server fills in whatever the venue has not set,
  // so the editor never has to think about a half-configured theme.
  const theme = v.theme || {};

  // Two columns where there is room for two: the settings on the left, and the
  // menu as it will look on the right, watching every change. Below 1100px
  // there is not room for a phone beside a form, so the preview folds up to the
  // top where it can still be opened and looked at.
  $('dinein-body').innerHTML = `
    <div class="di-layout">
    <div class="di-secs">
    <details class="card di-sec">
      <summary><h3>Your web address</h3></summary>
      <p class="hint">
        This is where a customer lands when they scan a code or follow a link.
        Choose it once and leave it alone — it is printed on things.
      </p>
      <div class="row" style="align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-start">
        <span class="muted small" style="white-space:nowrap">${esc(base)}/</span>
        <input id="di-slug" value="${esc(v.slug || '')}"
               placeholder="your-venue" style="flex:0 1 260px">
        <button class="btn" id="di-slug-check" type="button"
                style="flex:0 0 auto">Check</button>
      </div>
      <div id="di-slug-note" class="muted small" style="margin-top:6px;display:block"></div>
    </details>

    <details class="card di-sec" open>
      <summary><h3>What a customer sees</h3></summary>
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
          <span class="muted small">The "Find us" button opens this. Any map will do.</span>
        </label>

        <!-- How the menu reads when somebody pastes the link somewhere.
             All three were already being produced, from the venue name, the
             strapline and the banner. These override that; leave one blank and
             it goes back to deriving it. -->
        <label style="grid-column:1/-1">Link title
          <input id="di-meta-title" value="${esc(v.meta_title || '')}"
                 maxlength="255"
                 placeholder="${esc(v.display_name || 'Your venue')}">
          <span class="muted small">The heading in a search result or a
            WhatsApp preview. Blank uses the venue name.</span>
        </label>
        <label style="grid-column:1/-1">Link description
          <input id="di-meta-desc" value="${esc(v.meta_description || '')}"
                 maxlength="500"
                 placeholder="${esc(v.tagline || 'Fresh, local, all day')}">
          <span class="muted small">The sentence under it. Blank uses the
            strapline. Around 150 characters is what most sites show.</span>
        </label>
        <label style="grid-column:1/-1">Link image
          <input id="di-meta-image" value="${esc(v.meta_image_url || '')}"
                 placeholder="Blank uses your banner, then your logo">
          <span class="muted small">The picture in the preview. Wide images
            read better than square ones here.</span>
        </label>
        <label>Your logo
          ${imagePicker('di-logo', v.logo_url, { crop: 'square', label: 'Choose a logo' })}
          <span class="muted small">Drawn on the banner, at the top of the menu.</span>
        </label>
        <label>Banner photograph
          ${imagePicker('di-banner', v.banner_url, { crop: 'landscape', label: 'Choose a photograph' })}
          <span class="muted small">The room, across the top of the page.</span>
        </label>
        <label style="grid-column:1/-1">Accent colour
          ${diSwatch('di-accent', v.accent_colour || '#A5C715')}
          <span class="muted small">Buttons and highlights take this colour.</span>
        </label>
        <label style="grid-column:1/-1">Notice above the menu
          <input id="di-notice" value="${esc(v.notice || '')}"
                 placeholder="Kitchen closes at 9pm">
        </label>
      </div>
    </details>

    <details class="card di-sec" open>
      <summary><h3>Open for business</h3></summary>
      <p class="muted small">
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
      <label class="check">
        <input type="checkbox" id="di-auto-accept" ${v.auto_accept_orders ? 'checked' : ''}>
        <span><b>Accept orders automatically.</b> An order goes straight onto the
        table's bill and prints to the kitchen without anybody pressing Accept.</span>
      </label>
      <p class="muted small" style="margin:2px 0 0 28px">
        What you give up is the chance to refuse. With this on there is no
        moment between the order arriving and the food being started, so a
        mistake has to be dealt with as a void or a refund afterwards. It also
        needs a till switched on and signed in &mdash; accepting is what puts the
        order on a bill, and nothing else can do that.
      </p>
      <hr>
      <label class="check">
        <input type="checkbox" id="di-image-product" ${v.image_source === 'product' ? 'checked' : ''}>
        <span><b>Use the pictures from Products.</b> A dish shows the picture set
        against its product in Products, the same one the back office and the
        till show.</span>
      </label>
      <p class="muted small" style="margin:2px 0 0 28px">
        Off, a dish shows the picture set on the menu item here &mdash; useful when
        you have photographed the plate as it is served rather than the product.
        Either way, a dish with only one of the two pictures now shows that one
        instead of nothing, on the QR menu and on Vesopa Express alike.
      </p>
      <hr>
      <label class="check">
        <input type="checkbox" id="di-req-name" ${v.require_name ? 'checked' : ''}>
        <span>A name is required to order</span>
      </label>
      <label class="check">
        <input type="checkbox" id="di-req-phone" ${v.require_phone ? 'checked' : ''}>
        <span>A phone number is required to order</span>
      </label>
    </details>

    <details class="card di-sec">
      <summary><h3>Popular and Featured</h3></summary>
      <p class="muted small">
        Two grids above your menu, and they answer two different questions.
        <b>Popular</b> is what people order here. <b>Featured</b> is what you
        would like them to try — the new dish, the special that is on this week.
        Tick dishes for either on the <b>Menu</b> page.
      </p>
      <label class="check">
        <input type="checkbox" id="di-show-popular" ${v.show_popular ? 'checked' : ''}>
        <span>Show the Popular grid</span>
      </label>
      <label class="check">
        <input type="checkbox" id="di-show-featured" ${v.show_featured ? 'checked' : ''}>
        <span>Show the Featured grid</span>
      </label>
      <div class="grid-2" style="margin-top:12px">
        <label>Call the first one
          <input id="di-popular-title" value="${esc(v.popular_title || '')}"
                 placeholder="Popular">
        </label>
        <label>Call the second one
          <input id="di-featured-title" value="${esc(v.featured_title || '')}"
                 placeholder="Featured">
        </label>
      </div>
    </details>

    <details class="card di-sec">
      <summary><h3>Your offer</h3></summary>
      <p class="muted small">
        One offer, taken off the whole order once it reaches your minimum.
        Every dish shows its new price against its old one, and the basket
        bar tells a customer how far off it they are.
      </p>
      <label class="check">
        <input type="checkbox" id="di-offer-on" ${v.offer_active ? 'checked' : ''}>
        <span><b>Run an offer</b> on the menu</span>
      </label>
      <div class="grid-2" style="margin-top:12px">
        <label>Percentage off
          <input id="di-offer-pct" type="number" min="0" max="90"
                 value="${Number(v.offer_percent) || 0}">
        </label>
        <label>Minimum spend
          <input id="di-offer-min" type="number" min="0" step="0.01"
                 value="${((Number(v.offer_min_spend_minor) || 0) / 100).toFixed(2)}">
        </label>
        <label style="grid-column:1/-1">What to call it (optional)
          <input id="di-offer-label" value="${esc(v.offer_label || '')}"
                 placeholder="Leave blank and we write it for you">
        </label>
      </div>
    </details>

    <details class="card di-sec">
      <summary><h3>Promotions</h3></summary>
      <p class="muted small">
        Not a discount — something you want to say. A quiz night, a new
        supplier, a roast that needs booking. Up to six, shown as cards a
        customer can swipe through above the menu.
      </p>
      <div id="di-promos"></div>
      <button class="btn" id="di-promo-add" type="button" style="margin-top:10px">
        Add a promotion
      </button>
    </details>

    <details class="card di-sec">
      <summary><h3>Your colours</h3></summary>
      <p class="muted small">
        The menu takes these, not Vesopa's. Changes show in the preview as you
        make them and reach customers only when you press Save.
      </p>
      <div class="di-brand">
        <div class="di-brand-fields">
          <div class="grid-2">
            <label>Buttons and highlights
              ${diSwatch('di-t-accent', theme.accent)}
            </label>
            <label>Text on those buttons
              ${diSwatch('di-t-onaccent', theme.onAccent)}
            </label>
            <label>Page background
              ${diSwatch('di-t-page', theme.page)}
            </label>
            <label>Cards and panels
              ${diSwatch('di-t-card', theme.card)}
            </label>
            <label>Text
              ${diSwatch('di-t-ink', theme.ink)}
            </label>
            <label>Quieter text
              ${diSwatch('di-t-inksoft', theme.inkSoft)}
            </label>
            <label>Corners
              <input id="di-t-radius" type="range" min="0" max="28"
                     value="${Number(theme.radius)}">
            </label>
            <label>Lettering
              <select id="di-t-font">
                ${['system', 'serif', 'rounded', 'mono'].map((f) => `
                  <option value="${f}"${theme.font === f ? ' selected' : ''}>
                    ${f === 'system' ? 'Standard' : f[0].toUpperCase() + f.slice(1)}
                  </option>`).join('')}
              </select>
            </label>
          </div>
          <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
            <button class="btn" id="di-t-reset" type="button">Back to Vesopa's colours</button>
            <button class="btn" id="di-draft-save" type="button">Save as a draft</button>
            <span id="di-draft-note" class="muted small"></span>
          </div>
        </div>
      </div>
    </details>

    <details class="card di-sec">
      <summary><h3>Your own web address</h3></summary>
      <p class="muted small">
        Point a domain you own at this server and your menu answers on it, and
        your printed cards carry it instead of ours. Leave it blank to stay on
        ${esc((diTables.base || 'menu.vesopaepos.com').replace(/^https?:\/\//, ''))}.
      </p>
      <div class="row" style="align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-start">
        <input id="di-domain" value="${esc(v.custom_domain || '')}"
               placeholder="menu.yourpub.co.uk" style="flex:1 1 260px">
        <span id="di-domain-state" class="muted small" style="flex:0 0 auto">
          ${v.custom_domain
            ? (v.domain_verified
                ? '<b style="color:var(--green)">Answering</b>'
                : 'Not answering yet')
            : ''}
        </span>
      </div>
      <p class="muted small" style="margin-top:10px">
        Point a CNAME at <code>menu.vesopaepos.com</code>. The certificate is
        issued once the name reaches us, which is usually within the hour.
      </p>
    </details>

    <details class="card di-sec">
      <summary><h3>When you are open</h3></summary>
      <p class="muted small">
        Outside these hours the menu still reads, and the Add buttons are still
        there — a customer who presses one is told when you open rather than
        finding a button that does nothing. Nothing reaches the till.
      </p>
      <label class="check">
        <input type="checkbox" id="di-sched-on" ${v.schedule_enabled ? 'checked' : ''}>
        <span><b>Use these hours.</b> Turn this off to take orders whenever the
          menu is live.</span>
      </label>
      <div id="di-hours" class="di-hours">${diHoursRows(v.opening_hours)}</div>
      <div class="grid-2" style="margin-top:14px">
        <label>What to say when you are closed
          <input id="di-closed-msg" value="${esc(v.closed_message || '')}"
                 placeholder="The kitchen is closed. We open at 11.">
        </label>
        <label>Usual wait once an order is accepted
          <span class="row" style="align-items:center;gap:8px">
            <input id="di-eta" type="number" min="0" max="240"
                   value="${Number(v.eta_minutes) || 25}" style="flex:0 1 110px">
            <span class="muted small" style="flex:0 0 auto">minutes</span>
          </span>
        </label>
      </div>
    </details>

    <datalist id="di-diets">
      <option value="Vegetarian"><option value="Vegan"><option value="Gluten free">
      <option value="Spicy"><option value="Halal"><option value="Contains nuts">
    </datalist>

    <div class="row" style="gap:10px;align-items:center">
      <button class="btn primary" id="di-save" type="button">Save</button>
      <a id="di-preview" class="btn" target="_blank" rel="noopener"
         href="${esc(diVenueUrl() || '#')}"
         ${v.slug ? '' : 'hidden'}>Open the menu page</a>
      <span id="di-saved" class="muted small"></span>
    </div>
    </div>
    <aside class="di-side">
      <details class="card di-sec di-preview" id="di-preview-box">
        <summary><h3>Preview</h3></summary>
        <div class="di-phone"><iframe id="di-preview-frame" title="Menu preview"></iframe></div>
        <p class="muted small di-side-note">
          What a customer sees, updating as you type. Nothing here reaches them
          until you press Save.
        </p>
      </details>
    </aside>
    </div>
  `;

  $('di-slug-check').onclick = diCheckSlug;
  $('di-save').onclick = diSaveVenue;
  diWireHours();
  // The logo, the banner and every colour on the page. Both are drawn straight
  // into the HTML above, so nothing listens to them until this runs.
  wireImagePickers($('dinein-body'));
  diWireSwatches($('dinein-body'));
  diFitPhone();
  diPreviewFold();

  // A draft, if one was left, is what the editor opens on — otherwise a venue
  // comes back tomorrow to find yesterday's work gone.
  diPromos = (v.draft && Array.isArray(v.draft.promotions))
    ? v.draft.promotions
    : (v.promotions || []);
  diPaintPromos();
  $('di-promos').addEventListener('click', (e) => {
    const del = e.target.closest('[data-promo-del]');
    if (!del) return;
    diPromos = diReadPromos();
    diPromos.splice(Number(del.dataset.promoDel), 1);
    diPaintPromos();
  });
  $('di-promo-add').onclick = () => {
    diPromos = diReadPromos();
    if (diPromos.length >= 6) return;
    diPromos.push({ title: '', body: '', image_url: '', until: '' });
    diPaintPromos();
  };

  if (v.draft && v.draft.theme) {
    // Show the draft's colours, and say so, rather than silently applying them.
    Object.entries({
      'di-t-accent': v.draft.theme.accent, 'di-t-onaccent': v.draft.theme.onAccent,
      'di-t-page': v.draft.theme.page, 'di-t-card': v.draft.theme.card,
      'di-t-ink': v.draft.theme.ink, 'di-t-inksoft': v.draft.theme.inkSoft,
      'di-t-radius': v.draft.theme.radius, 'di-t-font': v.draft.theme.font,
    }).forEach(([id, value]) => { const el = $(id); if (el && value != null) el.value = value; });
    const note = $('di-draft-note');
    if (note) note.textContent = 'Showing your unsaved draft.';
  }

  diWireBranding();
  $('di-draft-save').onclick = diSaveDraft;
  // Also on blur: the commonest way to find out the address is taken should not
  // be pressing Save.
  $('di-slug').onblur = diCheckSlug;
}

/** Monday first, because a week of trading starts on a Monday. */
const DI_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday'];

function diHoursRows(hours) {
  const list = Array.isArray(hours) ? hours : [];
  return DI_DAYS.map((day, i) => {
    const h = list[i] || { closed: false, open: '11:00', close: '23:00' };
    return `
      <div class="di-hour-row" data-day="${i}">
        <span class="di-day">${day}</span>
        <label class="check di-shut">
          <input type="checkbox" data-hclosed="${i}" ${h.closed ? 'checked' : ''}>
          <span>Closed</span>
        </label>
        <input type="time" data-hopen="${i}" value="${esc(h.open || '11:00')}"
               ${h.closed ? 'disabled' : ''}>
        <span class="muted small di-to">to</span>
        <input type="time" data-hclose="${i}" value="${esc(h.close || '23:00')}"
               ${h.closed ? 'disabled' : ''}>
      </div>`;
  }).join('');
}

/** What the seven rows currently say. */
function diReadHours() {
  return DI_DAYS.map((_, i) => {
    const closed = !!(document.querySelector(`[data-hclosed="${i}"]`) || {}).checked;
    const open = ((document.querySelector(`[data-hopen="${i}"]`) || {}).value) || '11:00';
    const close = ((document.querySelector(`[data-hclose="${i}"]`) || {}).value) || '23:00';
    return { closed, open, close };
  });
}

/** Grey out the times on a day that is marked closed. */
function diWireHours() {
  const host = $('di-hours');
  if (!host) return;
  host.addEventListener('change', (e) => {
    const box = e.target.closest('[data-hclosed]');
    if (!box) return;
    const i = box.getAttribute('data-hclosed');
    [`[data-hopen="${i}"]`, `[data-hclose="${i}"]`].forEach((sel) => {
      const el = host.querySelector(sel);
      if (el) el.disabled = box.checked;
    });
  });
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

let diPromos = [];

function diPromoRow(p, i) {
  return `
    <div class="di-promo" data-promo="${i}">
      <div class="grid-2">
        <label>Title
          <input data-p="title" data-promo="${i}" value="${esc(p.title || '')}"
                 placeholder="Quiz night, every Thursday">
        </label>
        <label>Runs until (optional)
          <input data-p="until" data-promo="${i}" type="date" value="${esc(p.until || '')}">
        </label>
        <label style="grid-column:1/-1">What it says
          <input data-p="body" data-promo="${i}" value="${esc(p.body || '')}"
                 placeholder="Teams of up to six. Starts at eight.">
        </label>
        <label style="grid-column:1/-1">Picture (optional)
          ${imagePicker(`di-promo-img-${i}`, p.image_url, {
            crop: 'landscape', label: 'Choose a picture',
          })}
        </label>
      </div>
      ${iconBtn('del', 'Remove this promotion', `data-promo-del="${i}"`, 'danger')}
    </div>`;
}

function diPaintPromos() {
  const host = $('di-promos');
  if (!host) return;
  host.innerHTML = diPromos.length
    ? diPromos.map(diPromoRow).join('')
    : '<p class="muted small">Nothing on at the moment.</p>';
  // Every repaint draws new file inputs, and an input nothing listens to is a
  // button that does nothing when pressed.
  wireImagePickers(host);
  const add = $('di-promo-add');
  if (add) add.disabled = diPromos.length >= 6;
}

/** What the rows currently say, read back in order. */
function diReadPromos() {
  return diPromos.map((_, i) => {
    const get = (f) => {
      const el = document.querySelector(`[data-p="${f}"][data-promo="${i}"]`);
      return el ? el.value : '';
    };
    return {
      title: get('title'), body: get('body'),
      // The picture is a picker now, so it is read off its hidden field by id
      // rather than off a data-attribute — there is no text box to read.
      image_url: (document.getElementById(`di-promo-img-${i}`) || {}).value || '',
      until: get('until'),
    };
  }).filter((p) => p.title.trim());
}

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

const DI_THEME_DEFAULT = {
  accent: '#A5C715', onAccent: '#10130A', page: '#FFFFFF', card: '#FFFFFF',
  ink: '#14171C', inkSoft: '#5C6470', radius: 16, font: 'system',
};

function diReadTheme() {
  const val = (id, fallback) => {
    const el = $(id);
    return el ? el.value : fallback;
  };
  return {
    accent: val('di-t-accent', DI_THEME_DEFAULT.accent),
    onAccent: val('di-t-onaccent', DI_THEME_DEFAULT.onAccent),
    page: val('di-t-page', DI_THEME_DEFAULT.page),
    card: val('di-t-card', DI_THEME_DEFAULT.card),
    ink: val('di-t-ink', DI_THEME_DEFAULT.ink),
    inkSoft: val('di-t-inksoft', DI_THEME_DEFAULT.inkSoft),
    radius: Number(val('di-t-radius', DI_THEME_DEFAULT.radius)),
    font: val('di-t-font', DI_THEME_DEFAULT.font),
  };
}

/**
 * The preview, driven straight from the controls.
 *
 * The frame loads the real menu page, and the colours are pushed into it as
 * custom properties rather than by reloading it with different data. A reload
 * per keystroke on a colour picker is a request per keystroke, and the picker
 * fires continuously while a thumb is moving.
 *
 * Cross-origin would make this impossible; the preview is served from the same
 * origin as the back office for exactly that reason.
 */
function diPaintPreview() {
  const frame = $('di-preview-frame');
  if (!frame || !frame.contentDocument) return;
  const doc = frame.contentDocument;
  const t = diReadTheme();
  const root = doc.documentElement;
  if (!root || !root.style) return;
  root.style.setProperty('--accent', t.accent);
  root.style.setProperty('--on-accent', t.onAccent);
  root.style.setProperty('--page', t.page);
  root.style.setProperty('--card', t.card);
  root.style.setProperty('--ink', t.ink);
  root.style.setProperty('--ink-soft', t.inkSoft);
  root.style.setProperty('--radius', t.radius + 'px');
  const fonts = {
    system: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
    serif: 'Georgia,"Times New Roman",serif',
    rounded: 'ui-rounded,"SF Pro Rounded",system-ui,"Segoe UI",sans-serif',
    mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  };
  if (doc.body) doc.body.style.fontFamily = fonts[t.font] || fonts.system;
}

/**
 * Fit the phone to the column it is in.
 *
 * The preview frame is 390px wide because that is a phone, and the column it
 * sits in is whatever is left over. Scaling it is what makes the page inside
 * lay itself out as a phone rather than as a very narrow desktop — but the
 * scale has to be computed, because the column is 340px on a laptop, wider on
 * a large screen, and the full width of the page below 1100px.
 */
/**
 * Whether the preview starts open.
 *
 * Open beside the form where there is room for two columns, because a preview
 * you have to ask for is a preview nobody looks at. Folded where there is not,
 * because there it is stacked *above* the settings — and measured on an iPad it
 * is a 708px block, so the page opened on a phone-shaped picture with every
 * control below the fold and the venue scrolling past its own menu to reach the
 * form.
 *
 * Driven from the same 1100px the stylesheet switches the layout at. A details
 * element cannot be opened by CSS, so the width is asked here.
 */
function diPreviewFold() {
  const box = $('di-preview-box');
  if (!box) return;
  const wide = window.matchMedia('(min-width: 1101px)');
  const apply = () => { box.open = wide.matches; };
  apply();
  // Rotating an iPad crosses this line, and a preview that stayed folded on a
  // screen with room for it would look like the feature had gone.
  wide.addEventListener('change', apply);
}

function diFitPhone() {
  const shell = document.querySelector('.di-phone');
  if (!shell) return;
  const fit = () => {
    const w = shell.clientWidth;
    if (!w) return;
    shell.style.setProperty('--di-phone-scale', (w / 390).toFixed(4));
  };
  fit();
  if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(shell);
  else window.addEventListener('resize', fit);
}

function diWireBranding() {
  const ids = ['di-t-accent', 'di-t-onaccent', 'di-t-page', 'di-t-card',
    'di-t-ink', 'di-t-inksoft', 'di-t-radius', 'di-t-font'];
  ids.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.oninput = diPaintPreview;
    el.onchange = diPaintPreview;
  });

  const reset = $('di-t-reset');
  if (reset) reset.onclick = () => {
    Object.entries({
      'di-t-accent': DI_THEME_DEFAULT.accent,
      'di-t-onaccent': DI_THEME_DEFAULT.onAccent,
      'di-t-page': DI_THEME_DEFAULT.page,
      'di-t-card': DI_THEME_DEFAULT.card,
      'di-t-ink': DI_THEME_DEFAULT.ink,
      'di-t-inksoft': DI_THEME_DEFAULT.inkSoft,
      'di-t-radius': DI_THEME_DEFAULT.radius,
      'di-t-font': DI_THEME_DEFAULT.font,
    }).forEach(([id, value]) => { const el = $(id); if (el) el.value = value; });
    // The wells are painted from the inputs, and setting `.value` fires no
    // event — so without this the colours would go back to Vesopa's in the
    // preview while the swatches went on showing the venue's own.
    document.querySelectorAll('.di-swatch input[type="color"]').forEach((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    diPaintPreview();
  };

  const frame = $('di-preview-frame');
  if (frame && diVenue && diVenue.slug) {
    frame.src = (diTables.base || location.origin) + '/' + diVenue.slug;
    frame.onload = diPaintPreview;
  }
}

/**
 * Keep what is on screen without publishing it.
 *
 * The live row is what somebody standing at a table is reading right now, so a
 * venue trying a new colour at four in the afternoon has somewhere to put it
 * that is not in front of a customer.
 */
async function diSaveDraft() {
  const note = $('di-draft-note');
  try {
    await api('/dinein/draft', {
      method: 'PUT',
      body: JSON.stringify({ theme: diReadTheme(), promotions: diReadPromos() }),
    });
    if (note) {
      note.textContent = 'Draft kept.';
      setTimeout(() => { if (note) note.textContent = ''; }, 2600);
    }
  } catch (e) {
    toast(e.message, 'error');
  }
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
    meta_title: $('di-meta-title').value,
    meta_description: $('di-meta-desc').value,
    meta_image_url: $('di-meta-image').value,
    logo_url: $('di-logo').value,
    banner_url: $('di-banner').value,
    accent_colour: $('di-accent').value,
    notice: $('di-notice').value,
    is_published: $('di-published').checked,
    ordering_open: $('di-ordering').checked,
    auto_accept_orders: $('di-auto-accept').checked,
    // A pair rather than a boolean: the server stores which source leads, and
    // a third one later is a new value here rather than a second checkbox.
    image_source: $('di-image-product').checked ? 'product' : 'menu',
    require_name: $('di-req-name').checked,
    require_phone: $('di-req-phone').checked,
    schedule_enabled: $('di-sched-on').checked,
    opening_hours: diReadHours(),
    closed_message: $('di-closed-msg').value,
    eta_minutes: $('di-eta').value,

    offer_active: $('di-offer-on').checked,
    offer_percent: $('di-offer-pct').value,
    // Entered in pounds, stored in pence, like every other price here.
    offer_min_spend_minor: Math.round((Number($('di-offer-min').value) || 0) * 100),
    offer_label: $('di-offer-label').value,
    promotions: diReadPromos(),

    show_popular: $('di-show-popular').checked,
    show_featured: $('di-show-featured').checked,
    popular_title: $('di-popular-title').value,
    featured_title: $('di-featured-title').value,

    theme: diReadTheme(),
    custom_domain: $('di-domain').value,
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
    toast(e.message, 'error');
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

  // The statutory fourteen, once. Falls back to empty rather than failing the
  // menu: a server that has not been redeployed shows the rows without the
  // allergen column instead of an unreachable page.
  if (!diAllergens.length) {
    diAllergens = await api('/allergens')
      .then((r) => r.allergens || [])
      .catch(() => []);
  }

  const body = $('dinein_menu-body');

  // Named where it is created rather than in a browser prompt(): a prompt is
  // an unstyled modal that cannot say what a section is for, and the back
  // office already treats it as something editors do not do.
  const adder = `
    <div class="card">
      <div class="row" style="gap:8px;align-items:flex-end">
        <label style="flex:1">New section
          <input id="di-new-section" placeholder="Starters, Mains, Drinks…"
                 autocomplete="off">
        </label>
        <button class="btn primary" id="di-add-section" type="button">Add</button>
      </div>
    </div>`;

  body.innerHTML = diMenu.length
    ? diMenu.map(diSectionCard).join('') + adder
    : `<div class="empty">
         <p>No sections yet. A section is a heading on the customer's phone —
            Starters, Mains, Drinks — and the tabs that scroll across the top
            are made from them.</p>
       </div>` + adder;

  $('di-add-section').onclick = diAddSection;
  // Enter adds it, because typing a name and reaching for the mouse is the
  // slow half of adding six sections in a row.
  $('di-new-section').onkeydown = (e) => {
    if (e.key === 'Enter') diAddSection();
  };
  if (diMenu.length === 0) $('di-new-section').focus();
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
  body.querySelectorAll('[data-item-allergens]').forEach((b) => {
    b.onclick = () => diEditAllergens(b.dataset.itemAllergens);
  });
  body.querySelectorAll('[data-item-save]').forEach((b) => {
    b.onclick = () => diSaveItem(Number(b.dataset.itemSave));
  });
  body.querySelectorAll('[data-item-copy]').forEach((b) => {
    b.onclick = () => diCopyItem(Number(b.dataset.itemCopy));
  });
  body.querySelectorAll('[data-item-avail]').forEach((c) => {
    c.onchange = () =>
      diSetAvailable(Number(c.dataset.itemAvail), c.checked);
  });
}

/**
 * One section of the menu.
 *
 * Folded, and folded to begin with: a venue with nine sections wants to see the
 * nine, not the first one's forty dishes. The summary is the section as a
 * customer meets it: its name, the line under it, and how many dishes are in
 * it. A venue with nine sections was
 * scrolling through nine open tables to reach the one it wanted, and the thing
 * it was looking for — which section is which — was the one thing not visible
 * without reading a form field.
 *
 * The two fields are stacked, in the order they appear on the phone: the name,
 * and then the line that goes underneath it. Side by side they read as two
 * unrelated boxes; stacked, the form is a small picture of the result.
 *
 * A plain label above a plain field. They were briefly labels that floated into
 * the box, which made every field half as tall again to hold both — a lot of
 * furniture for two words. The wording above the box was already right.
 */
function diSectionCard(section) {
  const count = section.items.length;
  return `
    <details class="card di-sec di-menu-sec" data-section="${section.id}">
      <summary>
        <h3>${esc(section.name || 'Untitled section')}</h3>
        <span class="muted small di-sec-count">
          ${count === 1 ? '1 dish' : `${count} dishes`}
        </span>
      </summary>

      <div class="di-sec-fields">
        <label>Section
          <input data-f="name" data-sec="${section.id}"
                 value="${esc(section.name || '')}">
        </label>
        <label>Line underneath
          <input data-f="blurb" data-sec="${section.id}"
                 value="${esc(section.blurb || '')}"
                 placeholder="Served 12 til 3">
        </label>
        <span class="di-sec-acts">
          ${iconBtn('save', 'Save this section', `data-sec-save="${section.id}"`, 'go')}
          ${iconBtn('del', 'Delete this section', `data-sec-del="${section.id}"`, 'danger')}
        </span>
      </div>

      ${count
        ? `<div class="di-scroll"><table class="grid di-items">
             <thead><tr>
               <th style="width:23%">Shown as</th>
               <th style="width:auto">Description</th>
               <th class="mid" style="width:52px">On</th>
               <!-- Wide enough for the word. At 58 and 62 these two clipped
                    their own headings, and the header row read
                    "POPULARFEATUREDDIET" as one string. -->
               <th class="mid" style="width:74px">Popular</th>
               <th class="mid" style="width:80px">Featured</th>
               <th style="width:88px">Diet</th>
               <!-- One button, not fourteen tick boxes. Nearly every item
                    inherits what its product declares, so the common case is a
                    word rather than a form, and the rare override opens a
                    chooser. -->
               <th style="width:120px">Allergens</th>
               <!-- Three 40px buttons and the gaps between them. At 116 the
                    third one — delete — was drawn 26px outside the cell and
                    clipped by the scroll box, which could not scroll because
                    the table itself fitted. It was on the page, and it could
                    not be reached by any means. -->
               <th style="width:150px"></th>
             </tr></thead>
             <tbody>${section.items.map(diItemRow).join('')}</tbody>
           </table></div>`
        : '<p class="muted small" style="margin-top:10px">Nothing in this section yet.</p>'}

      <button class="btn" data-sec-add="${section.id}" type="button"
              style="margin-top:10px">Add products</button>
    </details>`;
}

function diItemRow(item) {
  return `
    <tr data-item="${item.id}">
      <td>
        <input data-f="name" data-item="${item.id}"
               value="${esc(item.name || '')}"
               placeholder="${esc(item.catalogue_name || 'Name it for the menu')}">
      </td>
      <td>
        <input data-f="description" data-item="${item.id}"
               value="${esc(item.description || '')}"
               placeholder="What is in it, and what it comes with">
      </td>
      <td class="mid">
        <input type="checkbox" data-item-avail="${item.id}"
               ${item.available ? 'checked' : ''}
               title="Uncheck when the kitchen runs out">
      </td>
      <td class="mid">
        <input type="checkbox" data-f="is_popular" data-item="${item.id}"
               ${item.is_popular ? 'checked' : ''}
               title="Show this in the Popular grid at the top of the menu">
      </td>
      <td class="mid">
        <input type="checkbox" data-f="is_featured" data-item="${item.id}"
               ${item.is_featured ? 'checked' : ''}
               title="Show this in the Featured grid at the top of the menu">
      </td>
      <td>
        <input data-f="diet_tag" data-item="${item.id}" list="di-diets"
               value="${esc(item.diet_tag || '')}" placeholder="—"
               style="max-width:130px">
      </td>
      <td>${diAllergenCell(item)}</td>
      <td class="di-row-acts">
        ${iconBtn('save', 'Save', `data-item-save="${item.id}"`, 'go')}
        ${iconBtn('copy', 'Duplicate', `data-item-copy="${item.id}"`)}
        ${iconBtn('del', 'Take off the menu', `data-item-del="${item.id}"`, 'danger')}
      </td>
    </tr>`;
}

/** The fourteen, fetched once and shared by every row. */
let diAllergens = [];

/** The item behind a row, out of the loaded menu. */
function diFindItem(id) {
  for (const section of diMenu) {
    const found = (section.items || []).find((i) => String(i.id) === String(id));
    if (found) return found;
  }
  return null;
}

/**
 * A dialog holding arbitrary markup, answering with the chosen allergens.
 *
 * Built on the same backdrop the rest of the back office uses rather than a
 * new one, so Escape, the backdrop click and the animation all behave the way
 * they do everywhere else.
 *
 * Resolves undefined for Cancel, null for "inherit from the product", and an
 * array — possibly empty — for an answer this item gives itself.
 */
function diAllergenPrompt(title, bodyHtml) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back confirm-back';
    back.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="max-width:520px">
        <h3>${esc(title)}</h3>
        ${bodyHtml}
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-no>Cancel</button>
          <button type="button" class="btn primary" data-yes>Save</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    requestAnimationFrame(() => back.classList.add('in'));

    const list = back.querySelector('#di-al-list');
    const inherit = back.querySelector('#di-al-inherit');
    // Ticking Inherit greys the fourteen rather than hiding them: a box that
    // vanishes reads as a bug, and seeing what would be overridden is the
    // point of having them on screen at all.
    const sync = () => {
      list.style.opacity = inherit.checked ? '0.45' : '1';
      list.querySelectorAll('input').forEach((el) => {
        el.disabled = inherit.checked;
      });
    };
    inherit.onchange = sync;
    sync();

    const done = (answer) => {
      back.classList.remove('in');
      setTimeout(() => back.remove(), 220);
      document.removeEventListener('keydown', onKey);
      resolve(answer);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(undefined); };
    document.addEventListener('keydown', onKey);
    back.querySelector('[data-no]').onclick = () => done(undefined);
    back.querySelector('[data-yes]').onclick = () => done(
      inherit.checked
        ? null
        : [...list.querySelectorAll('input:checked')].map((el) => el.value)
    );
    back.onclick = (e) => { if (e.target === back) done(undefined); };
  });
}

/** Codes to labels, for the summary on a row. */
function diAllergenLabels(codes) {
  const by = new Map(diAllergens.map((a) => [a.code, a.label]));
  return codes.map((c) => by.get(c)).filter(Boolean);
}

/** Whatever a column holds, as an array. */
function diAllergenList(stored) {
  if (stored === null || stored === undefined || stored === '') return null;
  try {
    const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * What this item says about allergens, in a word.
 *
 * Three states, and the middle one is the reason this is not a tick box:
 *
 *   Inherits   the item says nothing, so the product answers. Nearly all of
 *              them, and the label names what is being inherited so nobody has
 *              to open the catalogue to find out.
 *   None       this menu entry has been asked and contains none of the
 *              fourteen. A real answer, not an absence of one.
 *   Milk +2    this entry answers for itself.
 */
function diAllergenCell(item) {
  const own = diAllergenList(item.allergens);
  const inherited = diAllergenList(item.product_allergens) || [];
  let label;
  let tone = 'ghost';
  if (own === null) {
    const names = diAllergenLabels(inherited);
    label = names.length ? 'Inherits ' + names.length : 'Inherits';
  } else if (!own.length) {
    label = 'None';
    tone = 'ghost';
  } else {
    const names = diAllergenLabels(own);
    label = names.length > 1 ? names[0] + ' +' + (names.length - 1) : names[0];
    tone = '';
  }
  const title = own === null
    ? 'Follows the product: ' + (diAllergenLabels(inherited).join(', ') || 'none set')
    : own.length
      ? 'This item: ' + diAllergenLabels(own).join(', ')
      : 'This item declares none of the fourteen';
  return `<button type="button" class="btn small ${tone}"
            data-item-allergens="${item.id}"
            title="${esc(title)}"
            style="max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</button>`;
}

/** The chooser. Saves straight away — it is not part of the row's Save. */
async function diEditAllergens(itemId) {
  const item = diFindItem(itemId);
  if (!item) return;
  const own = diAllergenList(item.allergens);
  const inherited = diAllergenLabels(diAllergenList(item.product_allergens) || []);

  const ticked = new Set(own || []);
  const body = `
    <p class="muted small" style="margin:0 0 10px">
      Leave this on <b>Inherit</b> and the item shows whatever its product
      declares${inherited.length ? ' — currently ' + esc(inherited.join(', ')) : ''}.
      Override it only where this menu entry genuinely differs.
    </p>
    <label class="check" style="margin-bottom:10px">
      <input type="checkbox" id="di-al-inherit" ${own === null ? 'checked' : ''}>
      <span>Inherit from the product</span>
    </label>
    <div class="allergen-field" id="di-al-list">
      ${diAllergens.map((a) => `<label class="check allergen-tick">
        <input type="checkbox" value="${esc(a.code)}" ${ticked.has(a.code) ? 'checked' : ''}>
        <span>${esc(a.label)}</span>
      </label>`).join('')}
    </div>
    <p class="muted small" style="margin:10px 0 0">
      Untick <b>Inherit</b> and leave every box clear to record that this
      contains none of the fourteen — which is a different answer from never
      having been asked.
    </p>`;

  const chosen = await diAllergenPrompt(
    'Allergens — ' + (item.name || item.catalogue_name || 'item'),
    body
  );
  // undefined is Cancel. null is "inherit". An array — possibly empty — is an
  // answer this item is giving for itself.
  if (chosen === undefined) return;

  await api('/dine-in/items/' + itemId, {
    method: 'PUT',
    body: JSON.stringify({ allergens: chosen }),
  });
  toast('Allergens saved');
  await loadDineInMenu();
}

function diField(kind, id, field) {
  const el = document.querySelector(`[data-f="${field}"][data-${kind}="${id}"]`);
  return el ? el.value : undefined;
}

async function diAddSection() {
  const field = $('di-new-section');
  const name = field ? field.value.trim() : '';
  if (!name) {
    if (field) field.focus();
    return;
  }
  try {
    await api('/dinein/sections', {
      method: 'POST',
      body: JSON.stringify({ name, sort_order: diMenu.length + 1 }),
    });
    await loadDineInMenu();
  } catch (e) {
    toast(e.message, 'error');
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
    toast(e.message, 'error');
  }
}

async function diDeleteSection(id) {
  const section = diMenu.find((s) => s.id === id);
  const count = section ? section.items.length : 0;
  if (!(await confirmDialog(
    count
      ? `"${section.name}" and its ${count} item${count === 1 ? '' : 's'} come off the menu. The products themselves are not touched.`
      : 'This section comes off the menu.',
    { title: 'Delete this section?', confirmLabel: 'Delete', danger: true }
  ))) return;
  try {
    await api('/dinein/sections/' + id, { method: 'DELETE' });
    await loadDineInMenu();
  } catch (e) {
    toast(e.message, 'error');
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
    toast(e.message, 'error');
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
    toast(e.message, 'error');
    await loadDineInMenu();
  }
}

/**
 * The same dish again, in the same section.
 *
 * For a venue with a Small and a Large of something, or the same product on
 * both a lunch and an evening menu. The copy carries the wording and the
 * picture, because retyping those is the work the button exists to avoid, and
 * it is not marked Popular or Featured — two identical cards in one grid is not
 * what anybody meant.
 */
async function diCopyItem(id) {
  let item = null;
  diMenu.forEach((sec) => (sec.items || []).forEach((it) => {
    if (it.id === id) item = it;
  }));
  if (!item) return;
  try {
    // The add route names a new row from the catalogue, which is right when a
    // product is being put on a menu for the first time and wrong here — the
    // wording is the work this button exists to avoid retyping. So it is
    // copied over afterwards, onto whichever row was just created.
    await api(`/dinein/sections/${item.section_id}/items`, {
      method: 'POST',
      body: JSON.stringify({ plu_ids: [item.plu_id] }),
    });
    const fresh = await api('/dinein/menu');
    const section = fresh.find((sec) => sec.id === item.section_id);
    const made = section
      ? (section.items || []).filter((it) => it.plu_id === item.plu_id)
          .sort((a, b) => b.id - a.id)[0]
      : null;
    if (made && made.id !== item.id) {
      await api(`/dinein/items/${made.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: item.name || '',
          description: item.description || '',
          image_url: item.image_url || '',
          diet_tag: item.diet_tag || '',
          // Not Popular and not Featured: two identical cards in one grid is
          // not what anybody meant by Duplicate.
          is_popular: false,
          is_featured: false,
        }),
      });
    }
    await loadDineInMenu();
    toast('Copied. Change whatever is different about it.');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function diDeleteItem(id) {
  try {
    await api('/dinein/items/' + id, { method: 'DELETE' });
    await loadDineInMenu();
  } catch (e) {
    toast(e.message, 'error');
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
      return toast(e.message, 'error');
    }
  }

  const already = new Set();
  // And by name, not only by PLU. A catalogue can carry two products called
  // the same thing — this venue's carries two Cheeseburgers — and adding both
  // puts the same dish on a customer's phone twice at the same price. They
  // pick one at random and the kitchen gets a ticket for whichever PLU
  // happened to be second.
  const alreadyNamed = new Set();
  diMenu.forEach((s) =>
    s.items.forEach((i) => {
      already.add(i.plu_id);
      alreadyNamed.add(String(i.name || '').trim().toLowerCase());
    })
  );

  const rows = diCatalogue.map((p) => {
    const onMenu = already.has(p.pluid);
    // A different PLU with a name already on the menu is not blocked — a venue
    // may genuinely sell two things called the same — but it is said out loud,
    // because the usual cause is a duplicate in the catalogue.
    const sameName =
      !onMenu && alreadyNamed.has(String(p.product_name || '').trim().toLowerCase());
    return `
    <label class="check" data-name="${esc(
      (p.product_name + ' ' + (p.department_name || '')).toLowerCase()
    )}">
      <input type="checkbox" value="${p.pluid}" ${onMenu ? 'disabled' : ''}>
      <span>
        ${esc(p.product_name)}
        <span class="muted small">${esc(p.department_name || '')} · £${Number(p.price || 0).toFixed(2)}${
          onMenu ? ' · already on the menu' : ''
        }${
          sameName
            ? ' · <b>another product with this name is already on the menu</b>'
            : ''
        }</span>
      </span>
    </label>`;
  }).join('');

  // A column that fits the window, with only the list scrolling inside it.
  // The list used to carry its own max-height as well as sitting in a panel
  // that scrolled, so the dialog had two scrollbars side by side — and the
  // outer one moved by the seventeen pixels the heading and footer overran.
  showPanel('Add products to this section', `
    <div class="di-pick-panel">
      <input id="di-pick-search" placeholder="Search the catalogue"
             style="width:100%;margin-bottom:10px">
      <div id="di-pick-list" class="di-pick-list"
           style="border:1px solid var(--line);border-radius:8px;padding:8px">${rows}</div>
      <div class="row" style="margin-top:12px;gap:8px">
        <button class="btn primary" id="di-pick-add" type="button">Add ticked</button>
        <span id="di-pick-note" class="muted small"></span>
      </div>
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
      toast(e.message, 'error');
    }
  };
}

// ---------------------------------------------------------------------------
// 3. Table codes, and the card to print
// ---------------------------------------------------------------------------

async function loadDineInQr() {
  try {
    [diTables, diDesigns, diVenue] = await Promise.all([
      api('/dinein/tables'),
      api('/dinein/designs'),
      api('/dinein/venue'),
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
    <details class="card di-sec">
      <summary><h3>Every table has its own address</h3></summary>
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
                        class="muted small" style="word-break:break-all">${esc(t.url)}</a></td>
                 <td style="text-align:center">
                   <input type="checkbox" data-qr-on="${t.id}"
                          ${t.qr_enabled ? 'checked' : ''}>
                 </td>
                 <td style="text-align:right">
                   ${iconBtn('print', 'Print this card', `data-qr-print="${t.id}"`)}
                   ${iconBtn('link', 'Open this menu', `data-qr-open="${t.id}"`)}
                 </td>
               </tr>`).join('')}
             </tbody>
           </table>
           ${iconKey([['print', 'Print this card'], ['link', 'Open this menu']])}
           <div class="row" style="margin-top:12px;gap:8px">
             <button class="btn primary" id="di-print-all" type="button">
               Print a card for every table
             </button>
           </div>`
        : `<div class="empty">No tables yet. Draw your floor in
             <b>Table Designer</b> first — every table you add gets a code
             automatically.</div>`}
    </details>

    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h3 style="margin:0">The card</h3>
        <div class="row" style="gap:8px">
          <button class="btn primary" id="di-design-save" type="button">Save the card</button>
          <span id="di-design-saved" class="muted small"></span>
        </div>
      </div>
      <p class="muted small">
        Drag things around, pull a corner to resize, and pick a starting point
        from the panel. The card prints at whatever paper size you choose, so a
        layout done once works on an A4 sheet and on a 60mm sticker.
      </p>
      <div id="di-card-editor"></div>
    </div>
  `;

  $('di-design-save').onclick = diSaveDesign;

  document.querySelectorAll('[data-qr-on]').forEach((c) => {
    c.onchange = async () => {
      try {
        await api('/floor/tables/' + c.dataset.qrOn, {
          method: 'PUT',
          body: JSON.stringify({ qr_enabled: c.checked }),
        });
      } catch (e) {
        toast(e.message, 'error');
        c.checked = !c.checked;
      }
    };
  });
  document.querySelectorAll('[data-qr-open]').forEach((b) => {
    b.onclick = () => {
      const t = (diTables.tables || []).find((x) => x.id === Number(b.dataset.qrOpen));
      if (t && t.url) window.open(t.url, '_blank', 'noopener');
    };
  });
  document.querySelectorAll('[data-qr-print]').forEach((b) => {
    b.onclick = () => diPrint([Number(b.dataset.qrPrint)]);
  });
  const all = $('di-print-all');
  if (all) all.onclick = () => diPrint(withCodes.map((t) => t.id));

  // The codes have to be in hand before the canvas draws, or the first paint
  // of the card has an empty square where the QR goes and the venue judges the
  // design on it.
  await diCodesFor(diTables.tables.slice(0, 1), diTables.base || location.origin);
  dcSelected = -1;
  dcRender();
}

/**
 * The paper this prints on.
 *
 * Read from the editor's own list (DC_PAGES in dinein_card.js) so the two can
 * never disagree. There used to be a second table here, and a size offered in
 * the editor but unknown to the printer would have silently printed on A5.
 */
function diPageSize(design) {
  if (design.page_size === 'custom') {
    return [design.page_w_mm || 148, design.page_h_mm || 210];
  }
  const page = DC_PAGES[design.page_size] || DC_PAGES.a5;
  return [page[0], page[1]];
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
    // Everything the canvas can set has to come out of the printer, or the
    // preview is a drawing of a different card. justify-content as well as
    // text-align, because the box is a flex container and text-align alone
    // does nothing to a single line inside one.
    const type =
      `font-size:${el.size || 14}pt;` +
      `text-align:${el.align || 'center'};` +
      `font-weight:${el.bold ? '800' : '400'};` +
      `font-family:${el.font || 'system-ui, sans-serif'};` +
      `color:${el.colour || '#14161A'};` +
      'display:flex;align-items:center;line-height:1.15;overflow:hidden;' +
      `justify-content:${
        el.align === 'left' ? 'flex-start'
          : el.align === 'right' ? 'flex-end' : 'center'
      };`;

    switch (el.kind) {
      // A flat panel behind everything else — a header band, or a white card
      // under the code so a dark design still scans.
      case 'box':
        return `<div style="${box}background:${esc(el.fill || '#EEEEEE')}"></div>`;
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
        // The venue's own address, not the table's. Somebody reading a printed
        // line off a card is going to type it, and nobody types 32 characters
        // of hex — they type menu.vesopaepos.com/the-bridge. The code beside it
        // is what carries the table.
        return `<div style="${box}${type}">${esc(
          base.replace(/^https?:\/\//, '') + '/' +
          ((diVenue && diVenue.slug) || '')
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
    toast(e.message, 'error');
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
    return toast('Your browser blocked the print window. Allow pop-ups for this site.', 'error');
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
          <td class="muted small">${new Date(o.placed_at).toLocaleTimeString([], {
            hour: '2-digit', minute: '2-digit',
          })}</td>
          <td><b>${esc(o.table_label || '')}</b></td>
          <td>${o.lines.map((l) =>
            `${l.qty} × ${esc(l.name)}${l.note ? ` <span class="muted small">(${esc(l.note)})</span>` : ''}`
          ).join('<br>')}
          ${o.note ? `<div class="muted small">Note: ${esc(o.note)}</div>` : ''}</td>
          <td>${esc(o.customer_name || '—')}
            ${o.customer_phone ? `<div class="muted small">${esc(o.customer_phone)}</div>` : ''}</td>
          <td>${diMoney(o.total_minor)}</td>
          <td><span class="pill ${tone}">${esc(label)}</span>
            ${o.status_note ? `<div class="muted small">${esc(o.status_note)}</div>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}
