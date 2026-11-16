'use strict';

/**
 * Vesopa Go as a card terminal (2026-11-16).
 *
 * The owner: "I want another different system in Go to use as only Terminal,
 * can be connected from other till, like in iPad another Android can be that
 * terminal." A phone running Go in Card terminal mode does one thing: it waits
 * for a till in its venue to send an amount, takes the card with its own Tap
 * to Pay, and says how it went. The till that asked is a Windows till or
 * another Go device; both use these routes.
 *
 *   The terminal (the phone)
 *     POST /api/go/terminal/hello                 "I am here", every few
 *                                                 seconds; answers with the
 *                                                 payment waiting for it
 *     POST /api/go/terminal/requests/:id/update   where the payment has got to,
 *                                                 and how it ended
 *
 *   The till that asks
 *     GET  /api/go/terminals                      the terminals awake now
 *     POST /api/go/terminal/pay                   send one an amount
 *     GET  /api/go/terminal/requests/:id          follow it to its verdict
 *     POST /api/go/terminal/requests/:id/cancel   ask it to stop
 *
 * Every route takes a terminal token and works only inside that token's venue.
 *
 * Nothing here moves money or records a sale. The phone's own payment goes
 * through the venue's gateway exactly as a tap on that phone always has, and
 * the till that asked records the tender exactly as it does for a card
 * machine. This is only the wire between the two.
 *
 * Kept in memory: a request lives for a minute or two, and a restart in the
 * middle of one leaves the till on "no answer, check before taking it again",
 * which is the right thing to tell a clerk who cannot know either.
 */

const crypto = require('crypto');
const express = require('express');
const { requireTerminal } = require('./auth');

const ALIVE_MS = 20 * 1000;
const UNANSWERED_MS = 45 * 1000;
const RUNNING_MS = 5 * 60 * 1000;
const KEEP_MS = 60 * 60 * 1000;
const FINAL = new Set(['paid', 'declined', 'cancelled', 'failed', 'expired']);
const clamp = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function goTerminalRoutes({ secret, now = () => Date.now() }) {
  const router = express.Router();
  const terminal = requireTerminal(secret);
  const json = express.json();

  /** office -> device id -> { name, seen, gateway, ready, why } */
  const awake = new Map();
  /** id -> the request */
  const requests = new Map();

  const terminalsOf = (office) => {
    if (!awake.has(office)) awake.set(office, new Map());
    return awake.get(office);
  };

  function sweep() {
    const t = now();
    for (const [id, r] of requests) {
      if (FINAL.has(r.status)) {
        if (t - r.updated > KEEP_MS) requests.delete(id);
        continue;
      }
      // Sent, and the terminal never picked it up: it was asleep or out of
      // signal. Nothing was charged.
      if (r.status === 'waiting' && t - r.created > UNANSWERED_MS) {
        r.status = 'expired';
        r.message = 'The card terminal did not answer. Nothing was taken.';
        r.updated = t;
      }
      // Started, then silence. Whether the card was charged is not known.
      if (r.status !== 'waiting' && t - r.updated > RUNNING_MS) {
        r.status = 'failed';
        r.uncertain = true;
        r.message = 'The card terminal stopped answering. Check it before taking the payment again.';
        r.updated = t;
      }
    }
    for (const [office, devices] of awake) {
      for (const [id, d] of devices) if (t - d.seen > 10 * ALIVE_MS) devices.delete(id);
      if (!devices.size) awake.delete(office);
    }
  }

  const activeFor = (office, device) =>
    [...requests.values()].find((r) => r.office === office && r.device === device && !FINAL.has(r.status)) || null;

  const view = (r) => ({
    id: r.id,
    device_id: r.device,
    amount_minor: r.amount,
    reference: r.reference,
    from: r.from,
    clerk: r.clerk,
    status: r.status,
    step: r.step || null,
    cancel: r.cancel === true,
    payment_id: r.paymentId || null,
    gateway: r.gateway || null,
    message: r.message || null,
    uncertain: r.uncertain === true,
  });

  // ---- the terminal ------------------------------------------------------

  router.post('/api/go/terminal/hello', terminal, json, (req, res) => {
    sweep();
    const body = req.body || {};
    const device = clamp(body.device_id, 64);
    if (!device) return res.status(400).json({ error: 'device_id is required' });
    terminalsOf(req.office).set(device, {
      name: clamp(body.name, 80) || 'Card terminal',
      gateway: clamp(body.gateway, 24) || null,
      ready: body.ready !== false,
      why: clamp(body.why, 200) || null,
      seen: now(),
    });
    const waiting = activeFor(req.office, device);
    res.json({ request: waiting ? view(waiting) : null });
  });

  router.post('/api/go/terminal/requests/:id/update', terminal, json, (req, res) => {
    const r = requests.get(req.params.id);
    if (!r || r.office !== req.office) return res.status(404).json({ error: 'No such payment' });
    const body = req.body || {};
    if (clamp(body.device_id, 64) !== r.device) return res.status(403).json({ error: 'Not this terminal\'s payment' });
    // A verdict is never rewritten: the first one stands.
    if (FINAL.has(r.status)) return res.json(view(r));
    const status = clamp(body.status, 16);
    if (!['started', 'paid', 'declined', 'cancelled', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Not a status' });
    }
    r.status = status;
    r.step = clamp(body.step, 24) || r.step;
    r.message = clamp(body.message, 300) || null;
    r.uncertain = body.uncertain === true;
    if (body.payment_id) r.paymentId = clamp(body.payment_id, 120);
    if (body.gateway) r.gateway = clamp(body.gateway, 24);
    r.updated = now();
    res.json(view(r));
  });

  // ---- the till that asks ------------------------------------------------

  router.get('/api/go/terminals', terminal, (req, res) => {
    sweep();
    const t = now();
    const mine = clamp(req.query.device_id, 64);
    const list = [...terminalsOf(req.office)]
      .filter(([id, d]) => id !== mine && t - d.seen <= ALIVE_MS)
      .map(([id, d]) => ({
        device_id: id,
        name: d.name,
        gateway: d.gateway,
        ready: d.ready,
        why: d.why,
        busy: !!activeFor(req.office, id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ terminals: list });
  });

  router.post('/api/go/terminal/pay', terminal, json, (req, res) => {
    sweep();
    const body = req.body || {};
    const device = clamp(body.device_id, 64);
    const amount = Math.round(Number(body.amount_minor));
    if (!device) return res.status(400).json({ error: 'Which card terminal?' });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) {
      return res.status(400).json({ error: 'That is not an amount a card can pay.' });
    }
    const there = terminalsOf(req.office).get(device);
    if (!there || now() - there.seen > ALIVE_MS) {
      return res.status(409).json({ error: 'That card terminal is not awake. Open Vesopa Go on it and try again.', asleep: true });
    }
    if (there.ready === false) {
      return res.status(409).json({ error: there.why || 'That card terminal cannot take cards yet.' });
    }
    if (activeFor(req.office, device)) {
      return res.status(409).json({ error: `${there.name} is taking another payment.`, busy: true });
    }
    const t = now();
    const r = {
      id: crypto.randomUUID(),
      office: req.office,
      device,
      amount,
      reference: clamp(body.reference, 80) || null,
      from: clamp(body.from, 80) || 'A till',
      clerk: clamp(body.clerk, 80) || null,
      status: 'waiting',
      created: t,
      updated: t,
    };
    requests.set(r.id, r);
    res.status(201).json(view(r));
  });

  router.get('/api/go/terminal/requests/:id', terminal, (req, res) => {
    sweep();
    const r = requests.get(req.params.id);
    if (!r || r.office !== req.office) return res.status(404).json({ error: 'No such payment' });
    res.json(view(r));
  });

  router.post('/api/go/terminal/requests/:id/cancel', terminal, (req, res) => {
    const r = requests.get(req.params.id);
    if (!r || r.office !== req.office) return res.status(404).json({ error: 'No such payment' });
    if (!FINAL.has(r.status)) {
      if (r.status === 'waiting') {
        // Not picked up yet: it never will be.
        r.status = 'cancelled';
        r.message = 'Cancelled at the till.';
      } else {
        // Running on the phone: only the phone can say whether it stopped in time.
        r.cancel = true;
      }
      r.updated = now();
    }
    res.json(view(r));
  });

  return router;
}

module.exports = { goTerminalRoutes };
