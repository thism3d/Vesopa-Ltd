/**
 * The wallet's event log.
 *
 *     node test/wallet-log.test.js
 *
 * What matters about this module is not that it writes rows — it is that it
 * NEVER breaks the thing it is observing. Every call sits directly in the path
 * of a customer adding a card to their phone at a counter, so a log that can
 * throw is worse than no log at all. Most of what follows is about that.
 */

const assert = require('assert');

const walletLog = require('../src/wallet_log');

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, label);
  checks += 1;
  console.log('  ok ', label);
}

/** A pool that remembers what it was asked to do. */
function fakePool({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    execute(sql, params) {
      calls.push({ sql, params });
      return fail ? Promise.reject(new Error('the database is away')) : Promise.resolve([{ affectedRows: 1 }]);
    },
  };
}

/** A request, as far as this module is concerned. */
const fakeReq = (agent, ip = '203.0.113.9') => ({
  get: (header) => (header.toLowerCase() === 'user-agent' ? agent : undefined),
  ip,
});

async function main() {
  console.log('\nwallet event log\n');

  // ------------------------------------------------------------ the basics
  {
    const pool = fakePool();
    walletLog.record(pool, {
      office: 'venue@example.com',
      event: 'built',
      kind: 'loyalty',
      subjectId: '42',
      serial: 'abc-123',
      bytes: 285987,
      ms: 412,
    });
    ok('it writes one row', pool.calls.length === 1);
    ok('into epos_wallet_events', /INSERT INTO epos_wallet_events/.test(pool.calls[0].sql));

    const params = pool.calls[0].params;
    ok('with the office first, because every read is scoped by it', params[0] === 'venue@example.com');
    ok('the event', params[1] === 'built');
    ok('the kind', params[2] === 'loyalty');
    ok('the subject as a string', params[3] === '42');
    ok('the serial', params[4] === 'abc-123');
    ok('the size', params[7] === 285987);
    ok('how long it took', params[8] === 412);
    ok('and marked as having worked', params[9] === 1);
  }

  // ------------------------------------------------- the refusals that matter
  {
    const pool = fakePool();
    walletLog.record(pool, { event: 'built', kind: 'loyalty' });
    ok('a row with no office is DROPPED, not written', pool.calls.length === 0);
  }
  {
    const pool = fakePool();
    walletLog.record(pool, { office: 'venue@example.com' });
    ok('and so is one with no event', pool.calls.length === 0);
  }
  {
    // Nothing to assert but the absence of a throw. That is the whole point.
    walletLog.record(null, { office: 'venue@example.com', event: 'built' });
    ok('no pool at all is survivable', true);
  }

  // --------------------------------------------------- it must never throw
  {
    const pool = fakePool({ fail: true });
    let threw = false;
    try {
      walletLog.record(pool, { office: 'venue@example.com', event: 'built' });
    } catch {
      threw = true;
    }
    ok('a failing database does not throw at the caller', !threw);

    // The rejection is handled inside, so an unhandled rejection would take the
    // process down a tick later. Waiting one turn proves it was caught.
    await new Promise((resolve) => setImmediate(resolve));
    ok('and does not leave an unhandled rejection behind', true);
  }

  // ------------------------------------------------------------- truncation
  {
    const pool = fakePool();
    walletLog.record(pool, {
      office: 'v@example.com',
      event: 'device_log',
      detail: 'x'.repeat(900),
      req: fakeReq('y'.repeat(400)),
    });
    const params = pool.calls[0].params;
    ok('a long detail is cut to the column width', params[6].length === 500);
    ok('and so is a long user agent', params[10].length === 190);
    ok('the IP is kept', params[11] === '203.0.113.9');
  }
  {
    const pool = fakePool();
    walletLog.record(pool, { office: 'v@example.com', event: 'built' });
    const params = pool.calls[0].params;
    ok('a missing detail is null rather than the string "undefined"', params[6] === null);
    ok('a missing size is null rather than 0', params[7] === null);
    ok('and with no request there is no user agent', params[10] === null);
  }

  // ---------------------------------------------------------------- failures
  {
    const pool = fakePool();
    walletLog.record(pool, { office: 'v@example.com', event: 'push_failed', ok: false });
    ok('a failure is recorded as one', pool.calls[0].params[9] === 0);
  }

  // ------------------------------------------------------------------ bytes
  {
    const pool = fakePool();
    walletLog.record(pool, { office: 'v@example.com', event: 'built', bytes: -5, ms: 12.7 });
    ok('a negative size cannot reach an UNSIGNED column', pool.calls[0].params[7] === 0);
    ok('and a fractional duration is rounded', pool.calls[0].params[8] === 13);
  }

  // ------------------------------------------------------------------ prune
  {
    const pool = fakePool();
    const removed = await walletLog.prune(pool, 90);
    ok('pruning deletes by age', /DELETE FROM epos_wallet_events/.test(pool.calls[0].sql));
    ok('in bounded batches, so it cannot lock the table for a minute', /LIMIT 5000/.test(pool.calls[0].sql));
    ok('and says how many went', removed === 1);
  }
  {
    const pool = fakePool({ fail: true });
    const removed = await walletLog.prune(pool);
    ok('a failed prune returns 0 rather than throwing', removed === 0);
  }
  {
    const pool = fakePool();
    const timer = walletLog.startPruning(pool, 24);
    ok('the pruning timer exists', Boolean(timer));
    /*
     * `unref` is the load-bearing part. A timer that holds the event loop open
     * is a server that will not shut down — which presents as a deploy that
     * hangs, and nobody would look here for the reason.
     */
    ok('and does not hold the process open', timer.hasRef && timer.hasRef() === false);
    clearInterval(timer);
  }

  ok('ninety days is the retention', walletLog.RETAIN_DAYS === 90);

  console.log(`\n  ${checks} checks passed\n`);
}

main().catch((error) => {
  console.error('\nwallet log test failed:', error.message);
  process.exit(1);
});
