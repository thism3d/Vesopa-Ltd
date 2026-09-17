/**
 * Adding a domain, as a job the customer can watch — or walk away from.
 *
 * THE PROBLEM. Adding a domain is ten to twenty seconds of real work on the
 * node: the delegation is looked up at the registry, the zone is written, the
 * website is created, mail is set up and a certificate is requested from
 * Let's Encrypt. All of it used to happen INSIDE the form post. The customer
 * pressed Add, the button spun, and nothing on the screen changed for twenty
 * seconds — which reads as "broken" long before it reads as "working", and is
 * exactly when people press Back, press Add again, or close the tab.
 *
 * THE SHAPE. The form post now does only the fast part — record the domain —
 * and starts one of these. It redirects straight to the domain's page, which
 * shows a card with every step this run will take, greyed, and lights them up
 * one at a time as they happen. Each step has a line under it saying what is
 * going on and, once it is done, what happened. If the customer leaves, the
 * run carries on: the Domains list shows "Setting up…" with the current step
 * (over the live channel), and a notification arrives with the outcome.
 *
 * Same tables and same statuses as the post-payment build (setup_steps), so a
 * person who has seen one has seen both.
 *
 * The steps are PLANNED UP FRONT, all of them, before any work starts — a list
 * that grows as it goes tells the customer nothing about how long is left. The
 * ones that do not apply (mail on a domain that opted out; the build on a
 * domain that is not pointed at us yet) are marked skipped with a sentence
 * saying why, rather than vanishing.
 *
 * One process runs the job, in this process, straight after the response is
 * sent. There is no queue: the panel is one pm2 process and the work is a
 * handful of Hestia calls. A restart mid-run leaves the run 'running' for
 * ever; `sweepStale` finishes it as failed with an honest sentence, and the
 * next domain sweep does the actual work anyway, because everything here is
 * the same idempotent verify() the sweep calls.
 */

const db = require('./db');
const linking = require('./domain-linking');
const notifications = require('./notifications');

/* The runs this process is executing right now, by domain id. Read by the
   Domains list and the live channel to say "Setting up…" — synchronously,
   because domain-state.describe() is. */
const running = new Map();

const STALE_AFTER_MINUTES = 10;

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/**
 * What a run will do, in order, in words. Everything is planned even when it
 * may be skipped, so the customer sees the whole shape at once.
 */
function plan({ domain, subdomain, wantDns, wantMail, parent }) {
  if (subdomain) {
    return [
      ['web', `Create the website for ${domain}`, 'A virtual host on the node, on the same hosting as its main domain'],
      ['record', `Add an A record in ${parent}'s zone`, 'So the name resolves here without you touching DNS'],
      ['ssl', 'Request the certificate', 'From Let’s Encrypt — the slow step'],
      ['check', 'Check it answers', 'Whether the name resolves to this server yet'],
    ];
  }
  const steps = [
    ['delegation', `Look up who runs ${domain}`, 'At its registry, and on the public internet'],
    ['address', 'Check it points at this server', 'By nameservers, or by an A record'],
    ['mx', 'Check where its email goes', 'An MX pointed at us is enough for email on its own'],
  ];
  if (wantDns) steps.push(['zone', 'Write the DNS zone', 'A zone with the usual records, served by our nameservers']);
  steps.push(['web', 'Create the website on the server', 'A virtual host on the node, with a holding page until you upload']);
  if (wantMail) steps.push(['mail', 'Set up email', 'A mail domain with DKIM, ready for mailboxes']);
  steps.push(['ssl', 'Request the certificate', 'From Let’s Encrypt, once the name reaches us']);
  return steps;
}

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

/**
 * Begin a run for a domain that has just been recorded. Returns the run id at
 * once; the work happens after the caller has answered the browser.
 *
 * One run per domain at a time: a second Add while the first is still going
 * (a double-click, a reload that re-posts) attaches to the run under way.
 */
async function start({ domainRow, customer, subdomain = false, parent = '', wantDns = true, wantMail = false }) {
  const already = running.get(domainRow.id);
  if (already) return already.runId;

  const result = await db.query(
    'INSERT INTO domain_setup_runs (domain_id, customer_id) VALUES (?, ?)',
    [domainRow.id, customer.id],
  );
  const runId = result.insertId;

  const steps = plan({ domain: domainRow.domain, subdomain, wantDns, wantMail, parent });
  for (const [i, [key, label, detail]] of steps.entries()) {
    await db.query(
      'INSERT INTO domain_setup_steps (run_id, step_key, label, detail, sort_order) VALUES (?, ?, ?, ?, ?)',
      [runId, key, label, detail, i],
    );
  }

  running.set(domainRow.id, { runId, domain: domainRow.domain, label: steps[0][1], customerId: customer.id });

  setImmediate(() => {
    execute({ runId, domainRow, customer, subdomain, parent, wantDns, wantMail, steps }).catch(async (err) => {
      console.error(`[domain-setup] run ${runId} for ${domainRow.domain} crashed:`, err.message);
      await finish(runId, domainRow, customer, {
        status: 'failed',
        kind: 'error',
        headline: `Something went wrong setting up ${domainRow.domain}`,
        message: 'The domain is on your account and nothing is lost. We have been told, and the next automatic check will pick up where this left off.',
      }).catch(() => {});
    });
  });

  return runId;
}

// ---------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------

async function execute({ runId, domainRow, customer, subdomain, parent, wantDns, wantMail, steps }) {
  const seen = new Set();
  // Progress writes are queued IN ORDER and never awaited by the work: they
  // must not slow it down or fail it, and "running" landing after "ok" (two
  // pool connections racing) would leave a finished step spinning for ever.
  let writes = Promise.resolve();
  const onStep = (key, status, detail = '') => {
    // Only the steps this run planned. A hook may fire for a step that was
    // not planned (mail on a run that opted out) and must not invent a row.
    if (!steps.some(([k]) => k === key)) return;
    seen.add(key);
    const entry = running.get(domainRow.id);
    if (entry && status === 'running') {
      entry.label = steps.find(([k]) => k === key)[1];
      publish(customer.id, domainRow.id);
    }
    writes = writes.then(() => writeStep(runId, key, status, detail)).catch(() => {});
  };

  let outcome;
  if (subdomain) {
    const parentRow = await db.one('SELECT * FROM domains WHERE domain = ? AND customer_id = ? LIMIT 1', [parent, customer.id]);
    const built = await linking.buildSubdomain({
      row: domainRow, parent: parentRow, customer, wantDns, wantMail, onStep,
    });
    onStep('check', 'running', 'Asking the public DNS');
    const live = await linking.verify(domainRow, { customer });
    onStep('check', live.matched ? 'ok' : 'skipped',
      live.matched ? 'It resolves here' : `Not yet — add an A record for it at whoever runs DNS for ${parent}`);
    outcome = describeSubdomain(domainRow, parent, built.built, live);
  } else {
    const verdict = await linking.verify(domainRow, { customer, onStep });
    outcome = describeExternal(domainRow, verdict);
  }

  await writes;

  // Anything planned that no hook reached did not apply to this run.
  for (const [key] of steps) {
    if (!seen.has(key)) {
      const why = outcome.kind === 'ok' && !outcome.headline.includes('for email') ? ''
        : outcome.headline.includes('email') ? 'Not needed — the website is elsewhere, and that is fine'
          : 'Once it points at us — we check every few minutes';
      await writeStep(runId, key, 'skipped', why).catch(() => {});
    }
  }

  await finish(runId, domainRow, customer, outcome);
}

/** The sentence at the end, for a domain in its own right. Mirrors what the old flash said. */
function describeExternal(row, verdict) {
  const name = row.domain;
  if (verdict.matched) {
    const pointed = verdict.pointed || {};
    if (pointed.pointed && pointed.ssl) {
      return { status: 'finished', kind: 'ok', headline: `${name} is live`, message: `It points at us, the website is on the server and https://${name} has its certificate. Upload your site whenever you are ready.` };
    }
    if (pointed.pointed) {
      return { status: 'finished', kind: 'ok', headline: `${name} is set up`, message: `The website is on the server. ${pointed.sslError || 'The certificate is requested automatically once the name resolves here.'}` };
    }
    return { status: 'finished', kind: 'warn', headline: `${name} is pointing at us`, message: `But the website could not be created on the server. ${pointed.reason || 'Open a ticket and we will sort it.'}` };
  }
  if (verdict.mailOnly) {
    const split = verdict.mx && verdict.mx.others && verdict.mx.others.length
      ? ` Its MX also names ${verdict.mx.others.join(', ')} — remove those, or mail will be split between them and us.` : '';
    if (verdict.mailBuilt && verdict.mailBuilt.ok) {
      return { status: 'finished', kind: 'ok', headline: `${name} is set up for email`, message: `Its MX points at us, so mail for ${name} is delivered here; the website stays where it is. Create mailboxes from the Email page, and add the SPF and DKIM records it shows so your mail is trusted.${split}` };
    }
    return { status: 'finished', kind: 'warn', headline: `${name}'s email points here — one thing in the way`, message: `${verdict.mailBuilt ? verdict.mailBuilt.reason : 'The mail domain could not be created.'}${split}` };
  }
  if (verdict.unregistered) {
    return { status: 'finished', kind: 'warn', headline: `${name} is on your account — but not registered`, message: 'Its registry says the name does not exist. Check the spelling, or register it here and we will set it up for you.' };
  }
  if (name.split('.').length > 2 && !verdict.nameservers.length) {
    return { status: 'finished', kind: 'warn', headline: `${name} is on your account`, message: 'We do not have its main domain here, so point it at us with an A record — the value is on this page. We check every few minutes and set it up the moment it lands.' };
  }
  return { status: 'finished', kind: 'warn', headline: `${name} is on your account — one thing left`, message: 'Point it at us using either method on this page. We check every few minutes and will email you when it is live.' };
}

/** The sentence at the end, for a subdomain. */
function describeSubdomain(row, parent, built, live) {
  const name = row.domain;
  if (!built || !built.pointed) {
    return { status: 'finished', kind: 'warn', headline: `${name} was added, but not built`, message: built && built.reason ? built.reason : 'The website could not be created on the server. Open a ticket and we will sort it.' };
  }
  if (live.matched) {
    return { status: 'finished', kind: 'ok', headline: `${name} is set up and serving`, message: built.ssl ? `https://${name} has its certificate.` : (built.sslError || 'The certificate follows on its own.') };
  }
  return { status: 'finished', kind: 'warn', headline: `${name} is set up`, message: `One thing left: add an A record for it at whoever runs DNS for ${parent} — this page shows exactly what.` };
}

// ---------------------------------------------------------------------------
// Writing progress
// ---------------------------------------------------------------------------

async function writeStep(runId, key, status, detail) {
  if (status === 'running') {
    await db.query(
      `UPDATE domain_setup_steps SET status = 'running', started_at = NOW(), detail = ?
        WHERE run_id = ? AND step_key = ?`,
      [String(detail || '').slice(0, 400), runId, key],
    );
  } else {
    await db.query(
      `UPDATE domain_setup_steps SET status = ?, detail = ?, finished_at = NOW(),
              started_at = COALESCE(started_at, NOW())
        WHERE run_id = ? AND step_key = ?`,
      [status, String(detail || '').slice(0, 400), runId, key],
    );
  }
}

async function finish(runId, domainRow, customer, outcome) {
  await db.query(
    `UPDATE domain_setup_runs SET status = ?, kind = ?, headline = ?, message = ?, finished_at = NOW()
      WHERE id = ?`,
    [outcome.status, outcome.kind, outcome.headline.slice(0, 190), outcome.message.slice(0, 600), runId],
  );
  running.delete(domainRow.id);
  publish(customer.id, domainRow.id);

  /*
   * Told wherever they are. The card on the domain page says this too, but
   * the whole point of a background job is that the person may have gone to
   * make a coffee; the inbox icon is what tells them when they come back.
   */
  await notifications.raise({
    customerId: customer.id,
    level: outcome.kind === 'ok' ? 'info' : 'warn',
    area: 'domain',
    title: outcome.headline,
    body: outcome.message,
    fixUrl: `/panel/domains/${domainRow.domain}`,
    fixLabel: 'Open the domain',
    dedupeKey: `domain-setup:${domainRow.id}`,
  }).catch(() => {});
}

/** The live channel, if it is up. Required lazily: panel-live reads this module. */
function publish(customerId, domainId) {
  try {
    require('./panel-live').publish(customerId, `domain:${domainId}`);
  } catch {
    /* the channel is optional */
  }
}

// ---------------------------------------------------------------------------
// Reading progress
// ---------------------------------------------------------------------------

/** Is this domain being set up right now, and what is it doing? Sync, for describe(). */
function runningFor(domainId) {
  return running.get(Number(domainId)) || null;
}

/**
 * The run a domain's page should show: the one under way, or the last one to
 * finish that the customer has not yet seen the end of. Null when there is
 * nothing to say.
 */
async function current(domainId) {
  const run = await db.one(
    `SELECT * FROM domain_setup_runs WHERE domain_id = ?
       AND (status = 'running' OR seen_at IS NULL)
      ORDER BY id DESC LIMIT 1`,
    [domainId],
  );
  if (!run) return null;
  /*
   * A run this process is not executing and that has not finished is one a
   * restart killed. Close it honestly rather than showing a spinner for ever.
   */
  if (run.status === 'running' && !running.has(Number(domainId))) {
    const age = (Date.now() - new Date(run.started_at).getTime()) / 60000;
    if (age > 1) {
      await db.query(
        `UPDATE domain_setup_runs SET status = 'failed', kind = 'warn', finished_at = NOW(),
                headline = ?, message = ? WHERE id = ? AND status = 'running'`,
        ['This setup was interrupted', 'The panel restarted while it was running. Nothing is lost: the domain is on your account and the next automatic check finishes the job.', run.id],
      );
      await db.query(
        "UPDATE domain_setup_steps SET status = 'skipped', detail = 'Interrupted' WHERE run_id = ? AND status IN ('pending','running')",
        [run.id],
      );
      return current(domainId);
    }
  }
  return run;
}

/** Everything the card needs, in one JSON shape the page polls. */
async function status(run) {
  const steps = await db.query(
    'SELECT step_key AS `key`, label, status, detail FROM domain_setup_steps WHERE run_id = ? ORDER BY sort_order, id',
    [run.id],
  );
  const done = steps.filter((s) => ['ok', 'failed', 'skipped'].includes(s.status)).length;
  const finished = run.status !== 'running';
  return {
    id: run.id,
    finished,
    failed: run.status === 'failed' || steps.some((s) => s.status === 'failed'),
    kind: run.kind,
    headline: run.headline,
    message: run.message,
    percent: finished ? 100 : Math.round((done / Math.max(steps.length, 1)) * 100),
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    steps,
  };
}

/** The customer has seen the outcome; the card can stand down. */
async function markSeen(runId, customerId) {
  await db.query(
    "UPDATE domain_setup_runs SET seen_at = NOW() WHERE id = ? AND customer_id = ? AND status <> 'running' AND seen_at IS NULL",
    [runId, customerId],
  );
}

/**
 * Runs left 'running' by a restart. Called once at boot: this process is not
 * executing any of them, by definition.
 */
async function sweepStale() {
  try {
    const stale = await db.query(
      `SELECT id FROM domain_setup_runs WHERE status = 'running'
          AND started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [STALE_AFTER_MINUTES],
    );
    for (const run of stale) {
      await db.query(
        `UPDATE domain_setup_runs SET status = 'failed', kind = 'warn', finished_at = NOW(),
                headline = 'This setup was interrupted',
                message = 'The panel restarted while it was running. Nothing is lost: the domain is on your account and the next automatic check finishes the job.'
          WHERE id = ?`,
        [run.id],
      );
      await db.query(
        "UPDATE domain_setup_steps SET status = 'skipped', detail = 'Interrupted' WHERE run_id = ? AND status IN ('pending','running')",
        [run.id],
      );
    }
    if (stale.length) console.log(`[domain-setup] closed ${stale.length} run(s) a restart left open`);
  } catch (err) {
    console.warn('[domain-setup] could not sweep stale runs:', err.message);
  }
}

module.exports = { start, current, status, markSeen, runningFor, sweepStale };
