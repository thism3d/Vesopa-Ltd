/**
 * The apps pages' browser half — install progress, live status, log tabs.
 *
 * Progressive, like panel.js: remove this file and every page still works. The
 * install page becomes one you refresh yourself, the Node list becomes a
 * snapshot, and the log tabs become two logs printed one after the other. What
 * this adds is that none of that is necessary.
 *
 * NOTHING HERE RENDERS NEW MARKUP. Every value it writes replaces text the
 * server already put on the page, which is why a failed poll leaves a correct
 * page rather than an empty one — and why a customer on hotel wifi sees a
 * status that is a minute old instead of a blank card.
 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  /* =======================================================================
     An install, while it runs
     ======================================================================= */
  const jobCard = $('[data-job]');
  if (jobCard) {
    const id = jobCard.getAttribute('data-job');
    const bar = $('[data-job-bar]', jobCard);
    const step = $('[data-job-step]', jobCard);
    const state = $('[data-job-state]', jobCard);
    const chip = $('[data-job-chip]', jobCard);
    const logEl = $('[data-job-log]', jobCard);

    /*
     * Two seconds while it is working. An install is minutes of downloading and
     * compiling, and the poll is one small file read on the node — the cost is
     * nothing and the difference between a bar that crawls and one that sits
     * still is the difference between waiting and refreshing.
     */
    let timer = null;
    let stopped = false;

    function paint(job) {
      if (bar) bar.style.width = Math.max(2, job.percent || 0) + '%';
      if (step && job.step) step.textContent = job.step;

      if (logEl && Array.isArray(job.log)) {
        // Only touch the DOM when the text has actually changed, so somebody
        // selecting a line to copy does not have it yanked out from under them
        // every two seconds.
        const text = job.log.join('\n');
        if (logEl.textContent !== text) {
          const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
          logEl.textContent = text;
          if (atBottom) logEl.scrollTop = logEl.scrollHeight;
        }
      }

      if (!job.finished) return;
      stopped = true;
      clearInterval(timer);
      if (state) state.textContent = job.state === 'done' ? 'Finished' : 'Stopped';
      if (chip) {
        chip.className = 'state state-' + (job.state === 'done' ? 'green' : 'red');
        chip.setAttribute('data-job-chip', '');
      }
      /*
       * One reload at the end rather than building the finished state here.
       * The success panel has an "Open your site" button, the next-step
       * sentence and a database card, and every one of them is already written
       * properly in the template. Reproducing them in JavaScript would be two
       * copies of the same page to keep in step.
       */
      setTimeout(() => window.location.reload(), 600);
    }

    function poll() {
      if (stopped) return;
      fetch('/panel/apps/jobs/' + encodeURIComponent(id) + '/status', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((job) => { if (job && job.ok !== false) paint(job); })
        .catch(() => { /* a dropped poll is not an error worth showing */ });
    }

    timer = setInterval(poll, 2000);
    poll();
    // A backgrounded tab should not keep polling; coming back should be fresh.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !stopped) poll();
    });
  }

  /* =======================================================================
     Node apps — the status, kept honest
     ======================================================================= */
  const nodeCards = $$('[data-node-app]');
  if (nodeCards.length) {
    const uptime = (ms) => {
      if (!ms) return '—';
      const d = Math.floor(ms / 86400000);
      if (d) return d + 'd';
      const h = Math.floor(ms / 3600000);
      if (h) return h + 'h';
      return Math.max(1, Math.floor(ms / 60000)) + 'm';
    };

    function apply(card, app) {
      const set = (sel, value) => {
        const el = $(sel, card);
        if (el && value !== undefined && value !== null) el.textContent = value;
      };
      const chip = $('[data-health-chip]', card);
      if (chip && app.health) chip.className = 'state state-' + app.health.tone;
      set('[data-health-label]', app.health && app.health.label);
      set('[data-health-why]', app.health && app.health.why);
      set('[data-stat-port]', app.port || '—');
      set('[data-stat-uptime]', uptime(app.uptime_ms));
      set('[data-stat-restarts]', app.restarts);
      set('[data-stat-memory]', app.memory_mb + ' MB');
      set('[data-stat-cpu]', app.cpu + '%');
    }

    /*
     * Ten seconds, not two. Each refresh makes a real HTTP request to every one
     * of the customer's apps — that is what makes "Working" mean working — so
     * the interval is the one place the honesty has a cost, and ten seconds
     * keeps it to nothing while still being faster than anybody would refresh.
     */
    function refresh() {
      if (document.hidden) return;
      fetch('/panel/apps/node/status', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data || !data.ok) return;
          data.apps.forEach((app) => {
            nodeCards
              .filter((c) => c.getAttribute('data-node-app') === app.name)
              .forEach((c) => apply(c, app));
          });
          const note = $('[data-node-refreshed]');
          if (note) {
            note.textContent = 'Checked just now. Each check is a real HTTP request to your '
              + 'app, not a guess from the process list.';
          }
        })
        .catch(() => { /* leave the last good answer on the page */ });
    }

    setInterval(refresh, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }

  /* =======================================================================
     Log tabs
     ======================================================================= */
  $$('[data-log-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const which = btn.getAttribute('data-log-tab');
      $$('[data-log-tab]').forEach((b) => b.classList.toggle('is-on', b === btn));
      $$('[data-log-pane]').forEach((p) => {
        p.hidden = p.getAttribute('data-log-pane') !== which;
      });
    });
  });
}());
