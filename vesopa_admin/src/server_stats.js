/**
 * The server this admin runs on: its address, how hard it is working, and what
 * is running on it (2026-11-05).
 *
 * Read from the machine itself, every thirty seconds, into a day of samples kept
 * in memory. A restart of admin loses the history and nothing else, which is
 * the right price for a page that adds no table and nothing to back up. The
 * only stored thing is the alert levels a person chose (`adm_settings`).
 *
 * Linux only for the disk, network and process rows; on a PC they read as
 * empty rather than failing, so the page can be worked on anywhere.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

const db = require('./db');

const EVERY_MS = 30 * 1000;
const KEEP = 2880;
const DEFAULT_ALERTS = { cpu: 85, memory: 90, disk: 90 };

const samples = [];
let lastCpu = null;
let lastNet = null;
let externalIp = null;
let timer = null;

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [name, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (name === 'idle') idle += ms;
    }
  }
  return { idle, total };
}

/** Busy share between two readings, 0 to 100. */
function cpuPercent(before, after) {
  if (!before) return 0;
  const total = after.total - before.total;
  if (total <= 0) return 0;
  return Math.round((1 - (after.idle - before.idle) / total) * 1000) / 10;
}

/** Bytes in and out across every real interface, from /proc/net/dev's text. */
function parseNetDev(text) {
  let rx = 0;
  let tx = 0;
  for (const line of String(text).split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest || name.trim() === 'lo') continue;
    const cols = rest.trim().split(/\s+/).map(Number);
    rx += cols[0] || 0;
    tx += cols[8] || 0;
  }
  return { rx, tx };
}

function netBytes() {
  try {
    return parseNetDev(fs.readFileSync('/proc/net/dev', 'utf8'));
  } catch {
    return null;
  }
}

async function disk() {
  try {
    const s = await fs.promises.statfs('/');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, percent: total ? Math.round((1 - free / total) * 1000) / 10 : 0 };
  } catch {
    return null;
  }
}

async function sample() {
  const cpu = cpuTimes();
  const net = netBytes();
  const drive = await disk();
  const free = os.freemem();
  const total = os.totalmem();
  const now = Date.now();
  const seconds = lastNet ? (now - lastNet.at) / 1000 : 0;
  const row = {
    at: now,
    cpu: cpuPercent(lastCpu, cpu),
    memory: Math.round((1 - free / total) * 1000) / 10,
    disk: drive ? drive.percent : null,
    load: os.loadavg()[0],
    rx: net && seconds ? Math.max(0, (net.rx - lastNet.rx) / seconds) : 0,
    tx: net && seconds ? Math.max(0, (net.tx - lastNet.tx) / seconds) : 0,
  };
  lastCpu = cpu;
  if (net) lastNet = { ...net, at: now };
  samples.push(row);
  if (samples.length > KEEP) samples.shift();
  return row;
}

/** Google's own record of this box's public address, where there is one. */
async function fetchExternalIp() {
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) }
    );
    if (res.ok) externalIp = (await res.text()).trim();
  } catch {
    // Not on Google Cloud, or it did not answer: the internal addresses still show.
  }
}

function start() {
  if (timer) return;
  sample().catch(() => {});
  fetchExternalIp();
  timer = setInterval(() => sample().catch(() => {}), EVERY_MS);
  timer.unref();
}

/** What pm2 is running. Empty, not an error, where pm2 is not to hand. */
function processes() {
  return new Promise((resolve) => {
    execFile('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([]);
      try {
        resolve(JSON.parse(stdout).map((p) => ({
          name: p.name,
          status: p.pm2_env && p.pm2_env.status,
          restarts: p.pm2_env ? p.pm2_env.restart_time : 0,
          since: p.pm2_env ? p.pm2_env.pm_uptime : null,
          cpu: p.monit ? p.monit.cpu : 0,
          memory: p.monit ? p.monit.memory : 0,
        })));
      } catch {
        resolve([]);
      }
    });
  });
}

function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (!a.internal && a.family === 'IPv4') out.push({ name, address: a.address });
    }
  }
  return out;
}

/** The samples of the last [minutes], thinned to about 240 points for a chart. */
function history(minutes) {
  const since = Date.now() - minutes * 60 * 1000;
  const rows = samples.filter((s) => s.at >= since);
  const step = Math.max(1, Math.ceil(rows.length / 240));
  return rows.filter((_, i) => i % step === 0);
}

/** Which levels are over what a person set. */
function alertsFor(latest, levels) {
  const out = [];
  if (!latest) return out;
  for (const [key, label] of [['cpu', 'CPU'], ['memory', 'Memory'], ['disk', 'Disk']]) {
    if (latest[key] != null && latest[key] >= levels[key]) {
      out.push(`${label} is at ${latest[key]}%, over your ${levels[key]}% level`);
    }
  }
  return out;
}

async function ensureSettings() {
  await db.run(`CREATE TABLE IF NOT EXISTS adm_settings (
    name VARCHAR(64) NOT NULL PRIMARY KEY,
    value TEXT NOT NULL
  )`);
}

async function alertLevels() {
  try {
    await ensureSettings();
    const rows = await db.all("SELECT value FROM adm_settings WHERE name = 'server_alerts'");
    return { ...DEFAULT_ALERTS, ...(rows[0] ? JSON.parse(rows[0].value) : {}) };
  } catch {
    return { ...DEFAULT_ALERTS };
  }
}

async function setAlertLevels(body) {
  const levels = {};
  for (const key of Object.keys(DEFAULT_ALERTS)) {
    const n = Number(body[key]);
    levels[key] = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : DEFAULT_ALERTS[key];
  }
  await ensureSettings();
  await db.run(
    `INSERT INTO adm_settings (name, value) VALUES ('server_alerts', ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [JSON.stringify(levels)]
  );
  return levels;
}

/** Everything the page shows. */
async function snapshot(minutes = 60) {
  const levels = await alertLevels();
  const [drive, running] = await Promise.all([disk(), processes()]);
  const points = history(minutes);
  const latest = samples[samples.length - 1] || null;
  return {
    host: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    cores: os.cpus().length,
    cpuModel: (os.cpus()[0] || {}).model || '',
    uptime: os.uptime(),
    externalIp,
    addresses: addresses(),
    memory: { total: os.totalmem(), free: os.freemem() },
    disk: drive,
    latest,
    points,
    processes: running,
    levels,
    alerts: alertsFor(latest, levels),
  };
}

module.exports = {
  start, snapshot, setAlertLevels, cpuPercent, parseNetDev, alertsFor, history, DEFAULT_ALERTS,
};
