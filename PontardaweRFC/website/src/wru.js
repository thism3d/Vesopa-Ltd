/**
 * Fixtures, results and the league table, live from the WRU.
 *
 * The WRU's own fixtures site (my.wru.wales) reads a public JSON API; this
 * reads the same, for the club's organisation (Pontardawe RFC is 165), so the
 * site always shows the real next match and the real score without anybody
 * typing them in. Read here on the server, every 20 minutes, and kept in
 * memory and in a small file (so a restart shows the last copy at once). The
 * pages are drawn from whatever was last read; if the WRU is down they keep
 * the last good copy, and with none at all they point to the WRU's page.
 *
 * Times come from the WRU as UK local time with no zone ("2026-10-17T14:30:00")
 * and are shown exactly as given: no conversion to get wrong around the
 * clocks going back.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const API = 'https://api.wru.wales/fixtures-results';
const ORG = Number(process.env.WRU_ORG_ID || 165);
const EVERY = 20 * 60 * 1000;
const FILE = path.join(process.env.LOG_DIR || os.tmpdir(), 'pontardawe-wru.json');

let data = { upcoming: [], results: [], table: null, updated: null };
try {
  data = { ...data, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {
  // Nothing saved yet.
}

async function get(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'pontardawerfc.com (fixtures)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${res.status} from the WRU`);
  return res.json();
}

/** One fixture, from the club's side. */
function shape(f) {
  const home = f.homeTeam && f.homeTeam.orgId === ORG;
  const us = home ? f.homeTeam : f.awayTeam;
  const them = home ? f.awayTeam : f.homeTeam;
  if (!us || !them) return null;
  const [day, time] = String(f.date || '').split('T');
  const played = f.status === 'PLAYED';
  return {
    id: f.fixtureId,
    day,
    kickoff: time && time !== '00:00:00' ? time.slice(0, 5) : null,
    home,
    team: us.childValue || '1st Team',
    opponent: them.organisationName,
    opponentLogo: them.organisationLogoUrl || null,
    competition: f.competitionName || null,
    status: f.status,
    us: played ? Number(us.score) : null,
    them: played ? Number(them.score) : null,
    result: played ? (us.score > them.score ? 'W' : us.score < them.score ? 'L' : 'D') : null,
  };
}

/** Played, but nothing reported: a friendly with no score, listed twice. Not a result anyone wants to read. */
function reported(f) {
  return !(f.status === 'PLAYED' && !f.competition && f.us === 0 && f.them === 0);
}

function unique(list) {
  const seen = new Set();
  return list.filter((f) => f && !seen.has(f.id) && seen.add(f.id));
}

async function refresh() {
  try {
    const [up1, up2, past, tables] = await Promise.all([
      get(`${API}/organisation-fixtures?upcoming=true&organisationId=${ORG}`),
      get(`${API}/organisation-fixtures?upcoming=true&organisationId=${ORG}&page=2`).catch(() => ({ fixtures: [] })),
      get(`${API}/organisation-fixtures?upcoming=false&organisationId=${ORG}`),
      get(`${API}/organisation-league-tables?organisationId=${ORG}`).catch(() => []),
    ]);
    const upcoming = unique([...(up1.fixtures || []), ...(up2.fixtures || [])].map(shape))
      .sort((a, b) => (a.day + (a.kickoff || '')).localeCompare(b.day + (b.kickoff || '')));
    const results = unique((past.fixtures || []).map(shape)).filter(reported);
    const league = Array.isArray(tables) ? tables.find((t) => t && t.leagueDetails && !t.leagueDetails.disableTable) : null;
    const table = league ? {
      name: `${league.leagueDetails.competitionName}, ${league.leagueDetails.competitionPoolName}`,
      season: league.leagueDetails.season,
      rows: (league.standings || []).map((r) => ({
        pos: r.position, team: r.teamName, p: r.played, w: r.wins, d: r.draws, l: r.losses,
        pd: r.pointsDifference, pts: r.totalPoints, us: /pontardawe/i.test(r.teamName),
      })),
    } : null;
    data = { upcoming, results, table, updated: new Date().toISOString() };
    fs.writeFile(FILE, JSON.stringify(data), () => {});
  } catch (e) {
    console.error('wru:', String(e.message || e).slice(0, 200));
  }
}

let timer = null;
function start() {
  if (timer || process.env.WRU_OFF) return;
  refresh();
  timer = setInterval(refresh, EVERY);
  timer.unref();
}

/** Today in the UK, as YYYY-MM-DD. */
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

/** What the pages show: matches from today on, and results newest first. */
function fixtures() {
  const now = today();
  return {
    upcoming: data.upcoming.filter((f) => f.day >= now && f.status !== 'PLAYED'),
    results: data.results.filter((f) => f.status === 'PLAYED'),
    postponed: data.results.filter((f) => f.status === 'POSTPONED'),
    table: data.table,
    updated: data.updated,
  };
}

/** For tests. */
function set(next) {
  data = { upcoming: [], results: [], table: null, updated: null, ...next };
}

module.exports = { start, refresh, fixtures, shape, set, ORG };
