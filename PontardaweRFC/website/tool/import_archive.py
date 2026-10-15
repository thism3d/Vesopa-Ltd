"""The club's old website (pontardawerfc.co.uk, 2012-13) as content/archive.json.

    python tool/import_archive.py <pages-dir>

The owner, 2026-10-15: "Copy everything from the website archives and update
the new websites properly." The pages come from the Wayback Machine
(web.archive.org/web/2013*/pontardawerfc.co.uk), saved as text, one file per
WordPress page id, by a fetch script; this reads the fixture tables out of
them and writes everything the /archive page shows. The squads, officials,
sponsors and news are the club's own words from those pages, tidied (typos,
spacing) but not rewritten.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "content" / "archive.json"
SOURCE = "https://web.archive.org/web/20130507193509/http://pontardawerfc.co.uk/"

# WordPress page id -> month, per team, in season order.
TEAMS = [
    ("Seniors", [492, 496, 498, 500, 502, 504, 506, 509, 511]),
    ("Under 15s", [184, 189, 191, 193, 195, 197, 199, 201]),
    ("Under 14s", [323]),
    ("Under 13s", [272, 274, 276, 278, 280, 282, 284, 286]),
    ("Under 11s", [343, 345, 347, 349, 351, 353, 355, 357]),
    ("Under 10s", [359, 361, 363, 365, 367, 369, 371, 373]),
    ("Under 8s", [383, 385, 387, 389, 391, 393, 395, 397]),
    ("Under 7s", [401, 403, 405, 407, 409, 411, 413, 415]),
]
DAY = re.compile(r"^(Mon|Tue|Tues|Wed|Thu|Thurs|Fri|Sat|Sun)\b")
SEASON = {"Aug": 2012, "Sep": 2012, "Oct": 2012, "Nov": 2012, "Dec": 2012,
          "Jan": 2013, "Feb": 2013, "Mar": 2013, "Apr": 2013}


def body(pages, pid):
    lines = (pages / f"page_id_{pid}.txt").read_text(encoding="utf-8").splitlines()
    title = lines[0][2:].split(" | ")[0].replace("′", "")
    stop = next((i for i, x in enumerate(lines) if x.startswith("Share this")), len(lines))
    start = max(i for i, x in enumerate(lines[:stop]) if x == "Result") if "Result" in lines[:stop] else stop
    return title, lines[start + 1:stop]


def tidy_date(s):
    s = re.sub(r"(\d+)\s+(st|nd|rd|th)\b", r"\1\2", s)
    s = re.sub(r"\b0(\d)(st|nd|rd|th)", r"\1\2", s)
    # the old pages' own slips: "22 th", "20 st", "21 st"
    s = re.sub(r"\b(\d+)(st|nd|rd|th)\b", lambda m: m.group(1) + ordinal(int(m.group(1))), s)
    return s.replace("Sept", "Sep")


def ordinal(n):
    return "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")


def tidy_result(s):
    s = s.strip().replace("–", "-")
    s = re.sub(r"\s*-\s*", "–", s)
    if s in ("P", "Postponed"):
        return "Postponed"
    if s == "Off":
        return "Off"
    m = re.match(r"^(\d+)–(\d+)\s*\((W|L|D)\)$", s)
    return f"{m.group(1)}–{m.group(2)} {m.group(3)}" if m else s


def games(lines):
    rows, cur = [], None
    for x in lines:
        x = x.strip()
        if not x:
            continue
        if DAY.match(x):
            cur = [x]
            rows.append(cur)
        elif cur is not None:
            cur.append(x)
    out = []
    for r in rows:
        date, rest = tidy_date(r[0]), r[1:]
        time = rest.pop(0) if rest and re.match(r"^(\d|TBC)", rest[0], re.I) else ""
        opp = rest.pop(0) if rest else ""
        where, result = "", ""
        if rest and re.match(r"^(Home|Away)", rest[0]):
            where = rest.pop(0)
        if rest:
            result = tidy_result(rest.pop(0))
        # The old tables were not consistent about which side's score came
        # first; the W or L says which one was Pontardawe's, so theirs leads.
        m = re.match(r"^(\d+)–(\d+) ([WLD])$", result)
        if m:
            x, y = sorted((int(m.group(1)), int(m.group(2))), reverse=m.group(3) != "L")
            result = f"{x}–{y} {m.group(3)}"
        time = re.sub(r"^0(\d)\.", lambda m: m.group(1) + ".", time.replace("AM", "am").replace("PM", "pm"))
        opp = re.sub(r"\s+", " ", opp.replace("′", "").replace("’", "").replace("Britton", "Briton"))
        out.append({"date": date, "time": time, "opponent": opp, "where": where, "result": result})
    return out


def fixtures(pages):
    teams = []
    for team, ids in TEAMS:
        months = []
        for pid in ids:
            title, lines = body(pages, pid)
            month = re.sub(r"^U\d+s\s+", "", title)
            # one page is headed January 2012 in a 2012-13 season
            m = month.split()
            if m and m[0][:3] in SEASON:
                month = f"{m[0]} {SEASON[m[0][:3]]}"
            g = games(lines)
            if g:
                months.append({"month": month, "games": g})
        teams.append({"team": team, "months": months})
    return teams


ARCHIVE = {
    "source": SOURCE,
    "site": "pontardawerfc.co.uk",
    "season": "2012-13",
    "nickname": "The Cherry and Whites",
    "welcome": "Welcome to Pontardawe RFC, home of the Cherry and Whites. Founded in 1881.",
    "officials": [
        ["Chairman", "Gethin Davies"],
        ["Vice Chairman", "Graham Williams"],
        ["Secretary", "Colin Rees"],
        ["Treasurer", "Clive Giles"],
        ["Child Welfare Officer", "Michaela Rees"],
        ["First XV Manager", "Darren Rees"],
    ],
    "first_xv": [
        ["Darren Rees", "Second row, team manager"], ["Jordan Byrne", "Back row, player coach"],
        ["Dai Hawkins", "Centre, player coach"], ["Rhodri Griffiths", "Back row"],
        ["Steffan Griffiths", "Back row, second row"], ["Dai Morris", "Prop"],
        ["Nigel Williams", "Back row, second row"], ["Daniel Weston", "Front row"],
        ["Geraint Davies", "Second row"], ["Nicky Williams", "Outside half, scrum half"],
        ["Drew Williams", "Second row"], ["Shaun Williams", "Back row"],
        ["Kevin Williams", "Full back, wing"], ["Dylan Davies", "Second row"],
        ["Aaron Burt", "Wing"], ["Chris Davies", "Back row"], ["Craig Jones", "No. 8, prop"],
        ["Julian Power", "Hooker"], ["Jason Richards", "Scrum half"], ["Shaun Lewis", "Scrum half"],
        ["Geraint Williams", "Front row"], ["Daniel Williams", "Front row"], ["Michael Slack", "Wing, full back"],
    ],
    "coaches": [
        ["Youth", ["Bleddyn Howells (coach)", "Phil Beynon (coach)", "Mark Jarret (team manager)"]],
        ["Under 15s", ["Kevin Mort", "Brynmor Steel"]],
        ["Under 14s", ["Phil Beynon", "Adrian Byrne"]],
        ["Under 13s", ["Stuart Evans", "Kevin Thomas"]],
        ["Under 11s", ["Ian Gibson"]],
        ["Under 10s", ["Ceri Walker", "Jonathan Rogers"]],
        ["Under 8s", ["Ainsley Davies", "Craig Jones"]],
        ["Under 7s", ["Martin Collum"]],
    ],
    "training": "Senior training: Tuesdays and Thursdays, 6.30 to 8pm, at the Recreation Ground.",
    "news": [
        ["Jul 2013", "Cwmtawe 7s", "The Under 14s took on Morriston, Tata and Neath Athletic at the Cwmtawe Sevens on 3 August, after the previous year's exhibition match grew into a tournament with invited teams from the area."],
        ["Jul 2013", "Afan Nedd Tawe skills days", "Afan Nedd ran August skills sessions at Cwrt Herbert, Neath, for District Schools Under 14s, open to Year 8 and 9 pupils at any Afan Nedd comprehensive."],
        ["Jul 2013", "Seren 7s, Birchgrove", "The boys reached the final, with the Ystalyfera Chunky 7s the weekend after."],
        ["Jul 2013", "Proms in the Park", "Saturday 27 July: an outdoor proms night with a Pimm's and wine bar. Gates at 5pm, music from 6.30pm. Bring a deckchair and a picnic."],
        ["Jul 2013", "League fixtures", "The WRU released the 2013-14 fixtures for Division 4 South West."],
        ["Jul 2013", "Lions third Test", "Shown live at the clubhouse on Saturday 6 July 2013 from 11am."],
        ["Jul 2013", "Gentlemen's evening", "Rick O'Shea was guest speaker on Friday 5 July 2013: £20 with a three-course meal and a drink."],
        ["Mar 2013", "Club reunion", "A reunion for everyone who has played for, supported or served on the committee of Pontardawe RFC, on 15 March, the eve of Wales v England in the Six Nations."],
        ["Jan 2013", "Back for 2013", "Happy New Year: senior training restarted, Tuesdays and Thursdays, 6.30 to 8pm, at the Recreation Ground."],
        ["Nov 2012", "Social Saturday", "Saturday 24 November: cawl during the game, then Irish bingo, karaoke and games."],
        ["Nov 2012", "Fireworks night", "Ponty fireworks night, Saturday 3 November 2012, from 4.30pm."],
        ["Oct 2012", "Ospreys skills days", "The Ospreys' half-term skill identification day for Neath Port Talbot: Wednesday 31 October, Under 14s in the morning, Under 12s and 13s in the afternoon."],
        ["Oct 2012", "Racing night", "Saturday 20 October: doors at 7pm, first race 7.30pm, a raffle, and free entry."],
        ["Oct 2012", "Quiz night", "On the last Thursday of every month, teams in by 8pm, with the First XV and youth sending a team of backs against a team of forwards."],
        ["Sep 2012", "Ospreys development day", "Pontardawe hosted the Ospreys development coaches on 23 September, 12 to 3pm, for boys and girls aged 7 to 11, and recruited for the Under 13s."],
        ["Aug 2012", "5-a-side football day", "Saturday 25 August 2012. Winners: Team Big Nose."],
        ["Monthly", "Car boot sale", "On the last Sunday of the month at the club: sellers in by 9am, £5 a car."],
    ],
    "function_room": "The Lounge is available for all functions, from birthdays to wedding nights. It holds a large number of people and has a stage for bands and DJs.",
    "darts": {
        "Monday league": ["Nigel Williams", "Rob Fuge", "Alan Weston", "Ann Farr", "Nigel Farr", "Wayne Brown", "Stuart Evans"],
        "Thursday league": ["Kevin Williams", "Barry Tipping", "Gethin John", "Kyla Rees", "Garry McKerron", "Brian Williams", "Rob Fuge", "Ade Williams", "Alan Weston", "Stuart Evans"],
    },
    "sponsors": [
        ["Seniors", [
            ["Amman and District Motor Club", ""],
            ["Artizan Windows and Doors", "Church Street, Pontardawe"],
            ["Regalia Printing & Embroidery", "Herbert Street, Pontardawe"],
            ["Williams Properties", "Local family-run construction and property rental"],
        ]],
        ["Juniors", [
            ["Pennant Homes", "Three years' sponsorship, from the Parc y Dderwen development on the old Cwmtawe school site"],
            ["Howdens Joinery", "Plasmarl Industrial Estate, Swansea"],
            ["Tamarind Indian", "Herbert Street, Pontardawe"],
            ["Hurley & Davies", "Chartered building surveyors, Riverside Business Park, Swansea"],
            ["Viv Date Carpets", "Carpets in South Wales for a quarter of a century"],
            ["Lliw Building Supplies", "Building materials, timber and roofing"],
            ["Morgan Marine", "GRP enclosures and buildings"],
            ["Oaktree Construction", "Local family-run builder"],
            ["Second Life Products Wales", "Recycled outdoor furniture"],
            ["DNA Cleaning Services", ""],
            ["Flames Pizza Shop", "High Street, Pontardawe"],
            ["Charlo's Fish and Chip Shop", ""],
            ["Brian Thomas", "With best wishes to the juniors"],
        ]],
    ],
}


def main():
    pages = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if not pages or not pages.is_dir():
        raise SystemExit(__doc__)
    data = dict(ARCHIVE, fixtures=fixtures(pages))
    OUT.write_bytes((json.dumps(data, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))
    n = sum(len(m["games"]) for t in data["fixtures"] for m in t["months"])
    print(f"wrote {OUT.relative_to(ROOT)}: {n} fixtures, {len(data['news'])} news items")


if __name__ == "__main__":
    main()
