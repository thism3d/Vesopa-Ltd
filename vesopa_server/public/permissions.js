/**
 * Two permission screens, and the menu that obeys them.
 *
 * STAFF PERMISSIONS is the till's: a named group of switches — Staff,
 * Supervisor, Manager — assigned to a member of staff, and checked at the
 * terminal with the broadband down.
 *
 * BACK OFFICE USER ROLES is this application's: a named set of pages a login
 * may open. The customer's example was an accountant who sees the reporting and
 * nothing else.
 *
 * Loaded before app.js and using its `$`, `api` and `esc` — the same
 * arrangement screens.js has, and for the same reason: those are defined by the
 * time anything here is called, and duplicating them is how two copies drift.
 *
 * WHY THE MENU HIDING IS NOT THE SECURITY
 *
 * `applyAccess` removes nav buttons a role cannot use. That is a courtesy: a
 * menu full of pages that answer 403 is worse to hand somebody than a short
 * menu. The enforcement is on the server, on every route, and it would still be
 * there if this file were deleted.
 */

/* global $, api, esc */

/** What the signed-in user may do. Filled on sign-in, read by the nav. */
let ACCESS = { unrestricted: true, permissions: new Set() };

/** The catalogue of switches, as this build of the server defines them. */
let CATALOGUE = { till: [], backoffice: [] };

/** Which nav button belongs to which permission. Absent means always shown. */
const NAV_PERMISSION = {
  dashboard: 'dashboard.view',
  run_report: 'reports.financial_summary',
  report: 'reports.report',
  product_sales: 'reports.product_sales',
  discount_report: 'reports.discounts',
  loyalty_report: 'reports.loyalty_spending',
  voids_report: 'reports.voids',
  sales_explorer: 'reports.sales_explorer',
  till_report: 'reports.till_report',
  bill_report: 'reports.bill_report',
  timesheets: 'reports.timesheets',
  report_schedules: 'reports.schedules',
  products: 'catalogue.products',
  stock: 'catalogue.stock',
  screens: 'programming.screens',
  program_departments: 'programming.departments',
  program_groups: 'programming.groups',
  printer_categories: 'programming.printer_categories',
  import: 'programming.import',
  modifiers: 'programming.modifiers',
  mix_match: 'programming.mix_match',
  finalise_keys: 'programming.finalise_keys',
  error_reasons: 'programming.error_reasons',
  tax: 'programming.tax',
  idle: 'programming.till_printers',
  kitchen: 'programming.kitchen',
  devices: 'programming.devices',
  tables: 'floor.tables',
  users: 'people.users',
  user_roles: 'people.roles',
  staff: 'people.staff',
  permission_groups: 'people.permission_groups',
  customers: 'people.customers',
  vouchers: 'people.vouchers',
  receipt_designer: 'people.receipt_designer',
  promotions: 'commerce.promotions',
  gift_cards: 'commerce.gift_cards',
  deposits: 'commerce.deposits',
  loyalty: 'commerce.loyalty',
  cards: 'commerce.cards',
  wallet: 'commerce.wallet',
  tender: 'commerce.tender',
  rules: 'commerce.rules',
};

/** True when the signed-in user holds [key]. */
function may(key) {
  return ACCESS.unrestricted || ACCESS.permissions.has(key);
}

/**
 * Read this session's access, then hide what it cannot open.
 *
 * Called once after sign-in. A failure leaves the menu whole rather than
 * blanking it: an unreadable role must not be the thing that locks a manager
 * out of their own back office, and every route still refuses on its own.
 */
async function applyAccess() {
  try {
    const me = await api('/me/access');
    ACCESS = {
      unrestricted: !!me.unrestricted,
      role: me.role || '',
      permissions: new Set(me.permissions || []),
    };
  } catch {
    // An unreadable role must not be the thing that locks a manager out of
    // their own back office. The menu stays whole and every route still
    // refuses on its own — the hiding was never the enforcement.
    ACCESS = { unrestricted: true, role: '', permissions: new Set() };
  }

  document.querySelectorAll('.nav[data-view]').forEach((btn) => {
    const need = NAV_PERMISSION[btn.dataset.view];
    btn.hidden = !!need && !may(need);
  });

  // A group heading with nothing left under it is a heading for an empty
  // section, which reads as a fault rather than as a restriction.
  document.querySelectorAll('.nav-group').forEach((heading) => {
    let el = heading.nextElementSibling;
    let anyVisible = false;
    while (el && !el.classList.contains('nav-group')) {
      if (el.classList.contains('nav') && !el.hidden) anyVisible = true;
      el = el.nextElementSibling;
    }
    heading.hidden = !anyVisible;
  });

  const badge = $('role-badge');
  if (badge) {
    // Named on screen, because "why can I not see Products?" is a question a
    // manager should be able to answer without ringing anybody.
    badge.hidden = ACCESS.unrestricted || !ACCESS.role;
    badge.textContent = ACCESS.role ? `Role: ${ACCESS.role}` : '';
  }
}

/** Fetch the catalogue once. Both editors draw from it. */
async function loadCatalogue() {
  if (CATALOGUE.till.length) return CATALOGUE;
  CATALOGUE = await api('/permissions/catalogue');
  return CATALOGUE;
}

// ---------------------------------------------------------------------------
// A modal that is a grid of switches
// ---------------------------------------------------------------------------

/**
 * Open a wide modal. The shared `modal()` in app.js builds a field list; these
 * two screens are a grid of dozens of checkboxes, which is a different shape,
 * so the markup is written here and only the chrome is shared.
 */
function switchModal({ title, subtitle, body, onSave }) {
  const root = $('modal-root');
  root.innerHTML = `
    <div class="modal-back">
      <form class="modal perm-modal" id="perm-form">
        <h3>${esc(title)}</h3>
        ${subtitle ? `<p class="muted small">${esc(subtitle)}</p>` : ''}
        ${body}
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="perm-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    </div>`;

  const close = () => (root.innerHTML = '');
  $('perm-cancel').addEventListener('click', close);
  root.querySelector('.modal-back').addEventListener('click', (e) => {
    if (e.target === root.querySelector('.modal-back')) close();
  });

  // "Toggle all" per category, which is how the system they showed us works and
  // the only thing that makes fifty switches bearable.
  root.querySelectorAll('[data-toggle-all]').forEach((master) => {
    const group = master.dataset.toggleAll;
    const boxes = () =>
      [...root.querySelectorAll(`input[data-group="${CSS.escape(group)}"]`)];

    master.addEventListener('change', () => {
      boxes().forEach((b) => (b.checked = master.checked));
    });
    // And the other direction: a category whose switches are all on shows its
    // master on, so the two never disagree about what is true.
    const sync = () => {
      const all = boxes();
      master.checked = all.length > 0 && all.every((b) => b.checked);
      master.indeterminate = !master.checked && all.some((b) => b.checked);
    };
    boxes().forEach((b) => b.addEventListener('change', sync));
    sync();
  });

  $('perm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await onSave(form);
      close();
    } catch (err) {
      alert(err.message || 'Could not save.');
    }
  });
}

// ---------------------------------------------------------------------------
// Staff permissions (the till)
// ---------------------------------------------------------------------------

async function loadPermissionGroups() {
  const [groups] = await Promise.all([api('/permission-groups'), loadCatalogue()]);
  const body = $('permission-groups');

  if (!groups.length) {
    body.innerHTML = `
      <tr><td colspan="4">
        <div class="empty-cta">
          <p class="muted">No permission groups yet. Everybody signs on with every key.</p>
          <button class="btn primary" id="seed-groups">Add Staff, Supervisor and Manager</button>
        </div>
      </td></tr>`;
    $('seed-groups')?.addEventListener('click', async () => {
      await api('/permission-groups/standard', { method: 'POST' });
      loadPermissionGroups();
    });
    return;
  }

  body.innerHTML = groups
    .map((g) => {
      const held = CATALOGUE.till.filter((p) => g[p.column]);
      return `
        <tr>
          <td><strong>${esc(g.name)}</strong></td>
          <td>${g.is_manager ? '<span class="pill">Manager</span>' : ''}</td>
          <td class="muted small">${
            held.length
              ? esc(held.filter((p) => p.column !== 'is_manager').map((p) => p.label).join(', ')) ||
                '—'
              : 'Nothing — this group can ring up sales and no more.'
          }</td>
          <td>
            <button class="btn small" data-edit-group="${g.id}">Edit</button>
            <button class="btn small danger" data-del-group="${g.id}">Delete</button>
          </td>
        </tr>`;
    })
    .join('');
}

function tillSwitchGrid(group = {}) {
  return `
    <label>Name<input name="name" value="${esc(group.name || '')}" required maxlength="64" /></label>
    <div class="perm-category">
      <div class="perm-category-head">
        <strong>What this group may do at the till</strong>
        <label class="check">
          <input type="checkbox" data-toggle-all="till" /> Toggle all
        </label>
      </div>
      <div class="perm-grid">
        ${CATALOGUE.till
          .map(
            (p) => `
          <label class="check perm-item" title="${esc(p.hint)}">
            <input type="checkbox" name="${p.column}" data-group="till"
                   ${group[p.column] ? 'checked' : ''} />
            <span>
              <span class="perm-label">${esc(p.label)}</span>
              <span class="perm-hint">${esc(p.hint)}</span>
            </span>
          </label>`
          )
          .join('')}
      </div>
    </div>`;
}

function groupPayload(form) {
  const data = new FormData(form);
  const out = { name: (data.get('name') || '').toString().trim() };
  for (const p of CATALOGUE.till) out[p.column] = form.elements[p.column]?.checked || false;
  return out;
}

function openGroupEditor(group) {
  switchModal({
    title: group ? `Edit ${group.name}` : 'New permission group',
    subtitle:
      'Staff in this group get exactly these keys. Anyone not in a group keeps every key, which is how it worked before groups existed.',
    body: tillSwitchGrid(group || {}),
    onSave: async (form) => {
      const payload = groupPayload(form);
      if (group) {
        await api(`/permission-groups/${group.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await api('/permission-groups', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      loadPermissionGroups();
    },
  });
}

// ---------------------------------------------------------------------------
// Back office user roles
// ---------------------------------------------------------------------------

async function loadUserRoles() {
  const [roles] = await Promise.all([api('/user-roles'), loadCatalogue()]);
  const body = $('user-roles');

  if (!roles.length) {
    body.innerHTML = `
      <tr><td colspan="4">
        <div class="empty-cta">
          <p class="muted">No roles yet. Every back-office login sees everything.</p>
          <button class="btn primary" id="seed-roles">Add Owner, Manager, Accountant and Staff</button>
        </div>
      </td></tr>`;
    $('seed-roles')?.addEventListener('click', async () => {
      await api('/user-roles/standard', { method: 'POST' });
      loadUserRoles();
    });
    return;
  }

  const total = CATALOGUE.backoffice.reduce((n, g) => n + g.keys.length, 0);
  body.innerHTML = roles
    .map(
      (r) => `
      <tr>
        <td><strong>${esc(r.display_name)}</strong></td>
        <td class="muted small">${esc(r.description || '')}</td>
        <td class="muted small">${r.permissions.length} of ${total}</td>
        <td class="muted small">${r.users || 0}</td>
        <td>
          <button class="btn small" data-edit-role="${r.id}">Edit</button>
          <button class="btn small danger" data-del-role="${r.id}">Delete</button>
        </td>
      </tr>`
    )
    .join('');
}

function roleSwitchGrid(role = {}) {
  const held = new Set(role.permissions || []);
  return `
    <label>Name<input name="display_name" value="${esc(role.display_name || '')}" required maxlength="64" /></label>
    <label>Description<input name="description" value="${esc(role.description || '')}" maxlength="255" placeholder="What this role is for" /></label>
    ${CATALOGUE.backoffice
      .map(
        (g) => `
      <div class="perm-category">
        <div class="perm-category-head">
          <strong>${esc(g.group)}</strong>
          <label class="check">
            <input type="checkbox" data-toggle-all="${esc(g.group)}" /> Toggle all
          </label>
        </div>
        <div class="perm-grid">
          ${g.keys
            .map(
              (k) => `
            <label class="check perm-item">
              <input type="checkbox" value="${esc(k.key)}" name="perm"
                     data-group="${esc(g.group)}" ${held.has(k.key) ? 'checked' : ''} />
              <span class="perm-label">${esc(k.label)}</span>
            </label>`
            )
            .join('')}
        </div>
      </div>`
      )
      .join('')}`;
}

function rolePayload(form) {
  const data = new FormData(form);
  return {
    display_name: (data.get('display_name') || '').toString().trim(),
    description: (data.get('description') || '').toString().trim(),
    permissions: [...form.querySelectorAll('input[name="perm"]:checked')].map((i) => i.value),
  };
}

function openRoleEditor(role) {
  switchModal({
    title: role ? `Edit ${role.display_name}` : 'New role',
    subtitle:
      'Tick the pages this role may open. A login with no role sees everything, which is how it worked before roles existed.',
    body: roleSwitchGrid(role || {}),
    onSave: async (form) => {
      const payload = rolePayload(form);
      if (role) {
        await api(`/user-roles/${role.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/user-roles', { method: 'POST', body: JSON.stringify(payload) });
      }
      loadUserRoles();
    },
  });
}

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;

  try {
    if (t.id === 'add-permission-group') {
      await loadCatalogue();
      return openGroupEditor(null);
    }
    if (t.dataset.editGroup) {
      const groups = await api('/permission-groups');
      await loadCatalogue();
      return openGroupEditor(groups.find((g) => String(g.id) === t.dataset.editGroup));
    }
    if (t.dataset.delGroup) {
      if (!confirm('Delete this group? Staff in it go back to having every key.')) return;
      await api(`/permission-groups/${t.dataset.delGroup}`, { method: 'DELETE' });
      return loadPermissionGroups();
    }

    if (t.id === 'add-user-role') {
      await loadCatalogue();
      return openRoleEditor(null);
    }
    if (t.dataset.editRole) {
      const roles = await api('/user-roles');
      await loadCatalogue();
      return openRoleEditor(roles.find((r) => String(r.id) === t.dataset.editRole));
    }
    if (t.dataset.delRole) {
      if (!confirm('Delete this role? Anyone using it goes back to seeing everything.')) return;
      await api(`/user-roles/${t.dataset.delRole}`, { method: 'DELETE' });
      return loadUserRoles();
    }
  } catch (err) {
    alert(err.message || 'Something went wrong.');
  }
});
