/**
 * Barrier and camera adapters: how this server talks to one make of lane.
 *
 * HOW ANPR BARRIERS ARE NORMALLY WIRED, and so what an adapter has to do.
 * There are two ways a car park lets a registered car through, and real sites
 * use one or both:
 *
 *   1. ALLOW-LIST ON THE CAMERA. The camera keeps its own list of plates and
 *      closes the barrier relay itself on a match. Nothing has to be online at
 *      the moment the car arrives, which is why installers prefer it. This
 *      server's job is to keep that list equal to the members' cars:
 *      `pushPlates` / `removePlates`, reconciled by src/sync.js.
 *
 *   2. DECISION BY THE SERVER. The camera (or the site's own ANPR back office,
 *      such as Metric's AI-Gate) sends every read here, and the answer decides
 *      whether the barrier opens -- either in the response, or by this server
 *      telling the barrier to open (`open`). Needed for anything a camera
 *      cannot judge on its own: expiry dates, suspended memberships, one
 *      membership across many sites.
 *
 * Every adapter implements what its make can do. Anything a make cannot do is
 * simply absent, and callers check.
 *
 *   generic        any camera or controller that can call a web address with
 *                  the plate, and read {open:true}; also PULLS the list from
 *                  /anpr/v1/gates/<key>/allowlist. The default, and what Metric's
 *                  own integration (Mi-Xchange / AI-Gate) plugs into.
 *   metric_aigate  generic, named so the console says what is installed.
 *   hikvision      ISAPI: allow-list on the camera, barrier open command.
 *   dahua          CGI: TrafficRedList allow-list, openStrobe.
 */

const generic = require('./generic');
const hikvision = require('./hikvision');
const dahua = require('./dahua');

const ADAPTERS = {
  generic,
  metric_aigate: { ...generic, name: 'metric_aigate', label: 'Metric AI-Gate (via Mi-Office / Mi-Xchange)' },
  hikvision,
  dahua,
};

function adapterFor(gate) {
  return ADAPTERS[gate && gate.adapter] || generic;
}

function list() {
  return Object.entries(ADAPTERS).map(([key, a]) => ({
    key,
    label: a.label,
    canPush: typeof a.pushPlates === 'function' || typeof a.pushAll === 'function',
    canOpen: typeof a.open === 'function',
  }));
}

module.exports = { adapterFor, list, ADAPTERS };
