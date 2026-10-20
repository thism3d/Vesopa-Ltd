// admin.vesopa.com: the few things a page needs a script for.
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle]');
  if (t) document.getElementById(t.dataset.toggle).classList.toggle('open');
  const c = e.target.closest('[data-confirm]');
  if (c && !window.confirm(c.dataset.confirm)) e.preventDefault();
});
document.addEventListener('change', (e) => {
  const all = e.target.closest('[data-all]');
  if (all) for (const box of document.querySelectorAll(`input[name="${all.dataset.all}"]`)) box.checked = all.checked;
  // "Every app" and single apps are either-or.
  if (e.target.name === 'apps') {
    const set = e.target.closest('fieldset');
    if (!set) return;
    if (e.target.value === '*' && e.target.checked) for (const b of set.querySelectorAll('input[name="apps"]:not([value="*"])')) b.checked = false;
    if (e.target.value !== '*' && e.target.checked) { const every = set.querySelector('input[value="*"]'); if (every) every.checked = false; }
  }
});

// Versions: the date and time box only for "Install at a time" (2026-10-20).
document.querySelectorAll('[data-when]').forEach((s) => {
  const at = s.parentElement.querySelector('input[name=when_at]');
  if (!at) return;
  const force = s.closest('form') && s.closest('form').querySelector('[data-force]');
  const sync = () => {
    at.hidden = s.value !== 'at';
    at.required = s.value === 'at';
    if (force) force.hidden = s.value === 'ask';
  };
  s.addEventListener('change', sync);
  sync();
});
