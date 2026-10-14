"""Write content/instagram-notes.md: every screenshot, its crop, and what the site did with it.

    python PontardaweRFC/website/tool/make_instagram_notes.py

Reads content/images/instagram/crops.json (tool/crop_instagram.py) and
content/updates.json. A crop no update uses is listed with the reason in
SKIPPED below, so nothing in the folder is unaccounted for.
"""
import json
import pathlib

SITE = pathlib.Path(__file__).resolve().parents[1]

# What each crop shows, as read from the post (newest first, as on the phone).
SEEN = {
    "post-001.jpg": "Weekly Lotto 19-7-26: 5, 11, 17; no winner; £150 jackpot, £185 next week; next draw 26-7-26 (the owner's own crop)",
    "post-002.jpg": "Facebook copy of the Little Daffs match report at Resolven (Daff of the match Addie-Mai)",
    "post-003.jpg": "Facebook copy of the Penlan home game poster; caption: back at The Rec this Saturday, another big league clash",
    "post-004.jpg": "Home game v Penlan RFC, Sat 17/10/2026, 2:30pm, The Rec (posted 2 hours before the screenshot, 14 Oct)",
    "post-005.jpg": "Match report: Resolven v Pontardawe Little Daffs (girls' touch rugby), away; Daff of the match Addie-Mai (13 Oct)",
    "post-006.jpg": "Fireworks Night, Thu 5 Nov: gates 6pm, fireworks 7:30pm; £5 adult, £3 child (under 16), £15 family of 4 (9 Oct)",
    "post-007.jpg": "Kids Halloween Party & Disco, fancy dress, Fri 30 Oct 6-8pm, £2 entry on the door (5 Oct)",
    "post-008.jpg": "Oktoberfest Sat 3 Oct line-up: 4pm Jono, 5:30-6:30pm John Jones, 7pm Double or Nothing, 9pm Helix and the Hounds (3 Oct)",
    "post-009.jpg": "Oktoberfest: 1 day to go; £3 entry, music until 11pm, £50 bar tab for best dress (2 Oct)",
    "post-010.jpg": "Oktoberfest line-up again: 'this Saturday' (30 Sep)",
    "post-011.jpg": "Little Goat Brewery will be at Oktoberfest, from 4pm (30 Sep)",
    "post-012.jpg": "Match report: Little Daffs v Resolven (Hillbetties Teens) at home at the Rec; Daff of the match Rosie (30 Sep)",
    "post-013.jpg": "Cup game: home v Banwen RFC, Sat 03/10/2026, 2pm, The Rec (29 Sep)",
    "post-014.jpg": "Wok Stix and Nellie May's Fish & Chip Co at Oktoberfest (29 Sep)",
    "post-015.jpg": "Weekly Lotto 27-9-26: 3, 7, 11; no winner; £150 jackpot, £285 next week; next draw 4-10-26 (28 Sep)",
    "post-016.jpg": "Oktoberfest: one week to go (26 Sep)",
    "post-017.jpg": "Team announcement: starting XV and replacements v Briton Ferry, Sat 26/09/2026, 2:30pm, The Rec (26 Sep)",
    "post-018.jpg": "Medium Night Mon 5 Oct, 7pm, £5 cash; medium Rodney Frost; the year's first-Monday dates (25 Sep)",
    "post-019.jpg": "Home game v Briton Ferry RFC, Sat 26/09/2026, 2:30pm (22 Sep)",
    "post-020.jpg": "Smokin Griddle pop-up, Fri 25 Sep, 5-9pm: burgers, loaded fries (21 Sep)",
    "post-021.jpg": "Away v Nantymoel, carousel: 'jam-packed weekend at Pontardawe RFC' (about 18 Sep)",
    "post-022.jpg": "Away day v Nantymoel RFC, Sat 19/09/2026, 2:30pm (17 Sep)",
    "post-023.jpg": "Wokstix Pizza pop-up, Sat 19 Sep, 5:30-8:30pm, wood-fired Neapolitan pizza (16 Sep)",
    "post-024.jpg": "Oktoberfest is coming: first poster with the line-up (16 Sep)",
    "post-025.jpg": "Signed: Milo Macklen, back row (10 Sep)",
    "post-026.jpg": "First up at home v Cwmgwrach RFC, Sat 12/09/2026, 14:30 (10 Sep)",
    "post-027.jpg": "Signed: Dominic Davies, wing (10 Sep)",
    "post-028.jpg": "Medium Night 'tonight' Mon 7 Sep with Jackie Rickard and Helen Jones (7 Sep)",
    "post-029.jpg": "Wok Stix pop-up, Fri 4 Sep 2026, 5:30-8:30pm: noodle bowls and family munch boxes (29 Aug)",
    "post-030.jpg": "Medium Night Mon 7 Sep announcement (26 Aug)",
    "post-031.jpg": "Oktoberfest announced (25 Aug)",
    "post-032.jpg": "Pre-season fixture away at Pantyffynnon, Sat 29 Aug, 2:30 (24 Aug)",
    "post-033.jpg": "Juniors sponsors wanted: juniors growing, new kit needed, contact via Facebook Messenger (19 Aug)",
    "post-035.jpg": "Polar Berries are back, 9pm (16 Aug)",
    "post-036.jpg": "Music Festival Sunday 16 Aug line-up: Lisa J Lewis, This River, The Stray Pursuit, Everything's Electric, headliner Polar Berries (16 Aug)",
    "post-037.jpg": "Music Festival Saturday 15 Aug line-up: Woolfey, Jonesy, Rodeo & the Juliets, Zac and the New Men, headliner Smooth Operator (15 Aug)",
    "post-038.jpg": "Music Festival Friday 14 Aug: 7pm Jono, 9pm Double or Nothing (14 Aug)",
    "post-039.jpg": "Music Festival Thursday 13 Aug: 12pm Mad Jay, 6pm Dick Daztardly (13 Aug)",
    "post-040.jpg": "Old Boys touch rugby round robin, Fri 14 Aug, tap-off 6:30pm at Alltwen Rugby Field (12 Aug)",
    "post-041.jpg": "Ponty Fest message for families: children home by Fri 9pm, Sat and Sun 6pm; Thursday is for children and families (12 Aug)",
    "post-042.jpg": "Ponty Fest food vendors: nachos, BBQ, Aroy Dee Thai food, The Chunky Chip Co; free entry (11 Aug)",
    "post-043.jpg": "Pontardawe Music Festival 13-16 Aug 2026 at the club, SA8 4EG: all four days, Kidsfest Thu 1-5pm (10 Aug)",
    "post-044.jpg": "Food vendor spot available after a cancellation, for the festival weekend (8 Aug)",
    "post-045.jpg": "Weekly Lotto 3-8-26: 4, 7, 11; no winner; £205 next week; next draw 9-8-26 (5 Aug)",
    "post-046.jpg": "Thank you: Medium Night on Mon 3 Aug raised £334, £167 to the Daffs (Touched by Cancer fundraiser) and £167 to LATCH; next Mon 7 Sep (4 Aug)",
    "post-047.jpg": "Music Festival countdown: the four-day poster (4 Aug)",
    "post-048.jpg": "Kidsfest, Thu 13 Aug 2026 from midday (4 Aug, second slide)",
    "post-049.jpg": "Music Festival countdown, first slide again (4 Aug)",
    "post-050.jpg": "Kidsfest, second slide again (4 Aug)",
    "post-051.jpg": "Medium Night Mon 3 Aug, 7pm, £5 cash; medium Pat Howells (3 Aug)",
    "post-052.jpg": "Cwmtawe Seven's vets' touch rugby, Sat 1 Aug 2026: women's competition 8 teams, men's 24; sponsor Clearsafe Knotweed & Bamboo (31 Jul)",
    "post-053.jpg": "Ponty Old Boys squad for Cwmtawe Seven's 2026, team manager Zak Beynon (about 30 Jul)",
    "post-054.jpg": "Cherry & Whites squad for Cwmtawe Seven's 2026, team manager Tony Trumper (about 30 Jul)",
    "post-055.jpg": "Medium Night Mon 3 Aug announcement (30 Jul)",
    "post-056.jpg": "Weekly Lotto 26-7-26: 2, 7, 8; no winner; £195 next week (27 Jul)",
    "post-057.jpg": "Car park closed tomorrow due to a private event; no cars overnight (25 Jul)",
    "post-058.jpg": "Kidsfest at the Music Festival, Thu 13 Aug 2026 from midday (24 Jul)",
    "post-059.jpg": "Cwmtawe Seven's: the countdown is on (22 Jul)",
    "post-060.jpg": "Photo: the Ponty Old Boys touch rugby squad, 'what a weekend for Pontardawe touch rugby' (about 21 Jul)",
    "post-061.jpg": "Photo: Pontardawe's women's touch rugby team, second slide of the same post (about 21 Jul)",
    "post-062.jpg": "Weekly Lotto 19-7-26 (20 Jul): the same post as the owner's crop",
}

# Crops the site does not show, and why (the owner: "ignore any images which is irrelevant").
SKIPPED = {
    "post-001.jpg": "the same post as post-062; its numbers are in the Weekly Lotto update",
    "post-002.jpg": "Facebook copy of post-005",
    "post-003.jpg": "Facebook copy of post-004 (its caption is used in the Penlan update)",
    "post-010.jpg": "the same poster as post-008",
    "post-016.jpg": "countdown, superseded by post-009 and post-008",
    "post-021.jpg": "same poster as post-022",
    "post-024.jpg": "same poster as post-009",
    "post-028.jpg": "September's medium named in the Medium Nights update",
    "post-030.jpg": "same as post-028",
    "post-031.jpg": "same poster as post-009",
    "post-035.jpg": "Polar Berries named as Sunday's headliner in Ponty Fest",
    "post-038.jpg": "Friday's line-up is in the Ponty Fest update",
    "post-039.jpg": "Thursday's line-up is in the Ponty Fest update",
    "post-041.jpg": "the families' message is summed up in the Ponty Fest update",
    "post-044.jpg": "a call for a food vendor that has long passed",
    "post-045.jpg": "its numbers are in the Weekly Lotto update",
    "post-047.jpg": "same poster as post-043",
    "post-048.jpg": "same poster as post-058",
    "post-049.jpg": "same poster as post-043",
    "post-050.jpg": "same poster as post-058",
    "post-051.jpg": "August's medium named in the Medium Nights update",
    "post-055.jpg": "same as post-051",
    "post-056.jpg": "its numbers are in the Weekly Lotto update",
    "post-057.jpg": "a one-day car park notice that has passed",
    "post-059.jpg": "same poster as post-052",
    "post-062.jpg": "an older lotto result; its numbers are in the Weekly Lotto update",
}


def main():
    crops = json.loads((SITE / "content/images/instagram/crops.json").read_text(encoding="utf-8"))
    updates = json.loads((SITE / "content/updates.json").read_text(encoding="utf-8"))["updates"]
    used = {}
    for u in updates:
        for img in u.get("images", []):
            used[img["crop"]] = (u["slug"], img["name"])
    lines = [
        "# The club's posts, from the owner's screenshots",
        "",
        "From `PontardaweRFC/InstagramScreenshots` (61 Android screenshots of @pontardawerfc on Instagram and two of",
        "Pontardawe Rugby Club on Facebook, taken 15 October 2026, newest post first, plus the owner's own crop).",
        "`tool/crop_instagram.py` cut each post's picture out of its screenshot into `content/images/instagram/`;",
        "`content/updates.json` turns them into the site's updates, and `tool/make_update_images.py` publishes",
        "the pictures. This file is written by `tool/make_instagram_notes.py`.",
        "",
        "Dates in brackets are when the club posted (\"2 hours ago\" and \"6 days ago\" read from 15 October). Events",
        "show on What's On until their day; everything is also a news post with its own page.",
        "",
        "## Timeline: what the site says",
        "",
    ]
    for u in sorted(updates, key=lambda x: x["posted"], reverse=True):
        when = f" · {u['event']['start'].replace('T', ' ')}" if u.get("event") else ""
        lines.append(f"- **{u['posted']}** [{u['title']}](https://pontardawerfc.com/news/{u['slug']}) ({u['kind']}{when})")
    lines += ["", "## Every screenshot", "", "| Screenshot | Crop | What it shows | On the site |", "|---|---|---|---|"]
    reel = "Screenshot_2026-10-15-01-15-11-898_com.instagram.android.jpg"
    for c in crops:
        f = c["file"]
        where = f"[{used[f][0]}](https://pontardawerfc.com/news/{used[f][0]}) as `img/ig/{used[f][1]}`" if f in used else f"not shown: {SKIPPED.get(f, 'not used')}"
        lines.append(f"| `{c['source']}` | `{f}` | {SEEN.get(f, '')} | {where} |")
    lines.append(f"| `{reel}` | none | A reel (19 Aug): \"Ponty Fest 2026 brought the Swansea Valley community together for a weekend of live music, food and gratitude\"; no picture on screen | its words are in the Ponty Fest update |")
    lines += ["", "## Checks", "",
              "- The team sheet spells the captain \"Jospeh Mort\"; the site writes Joseph. The signing post spells \"Milo Macklen\" and the team sheet \"Milo Macklin\"; each is kept as the club wrote it.",
              "- The Medium Night poster lists \"Monday 1st December\", which is a Tuesday in 2026; the site gives only the next date, Monday 2 November.",
              "- The Briton Ferry, Cwmgwrach, Nantymoel, Banwen and Pantyffynnon results are on the WRU's fixtures page (/fixtures), not repeated here.",
              ""]
    (SITE / "content/instagram-notes.md").write_bytes("\n".join(lines).encode("utf-8"))
    print(len(crops), "crops noted,", len(used), "on the site")


if __name__ == "__main__":
    main()
