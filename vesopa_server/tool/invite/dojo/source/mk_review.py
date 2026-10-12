s = open('build_correction.py').read()
def rep(a, b, n=1):
    global s
    assert s.count(a) == n, (a[:60], s.count(a)); s = s.replace(a, b)
def cut(start, end, new):
    global s
    i = s.index(start); j = s.index(end, i)
    s = s[:i] + new + s[j:]

rep('"Updated: Vesopa + Dojo kick-off call today, 1:30pm UK time, new Google Meet link"',
    '"Vesopa + Dojo accreditation review tonight, 21:00 UK time: UAT round 2 fixes in EPOS 1.16.3"')
rep('"20261009T123000Z", "20261009T131500Z"  # 13:30-14:15 BST', '"20261012T200000Z", "20261012T204500Z"  # 21:00-21:45 BST')
rep('"20261009T133000", "20261009T141500"', '"20261012T210000", "20261012T214500"')
rep('"https://meet.google.com/yib-pneg-xri"', '"https://meet.google.com/bpa-fqef-rpz"')
rep('PHONE, PIN = "+44 20 3910 5875", "955 030 598#"', 'PHONE, PIN = "+1 401-830-3638", "899656638"\nMORE_PHONES = "https://tel.meet/bpa-fqef-rpz?pin=6859843447630"')
rep('''      ("Fintan Bridger", "fintan.bridger@paymentsense.com"),
      ("Oliver England", "oliver.england@paymentsense.com")]''', '''      ("Fintan Bridger", "fintan.bridger@paymentsense.com")]''')
cut('AGENDA = [', 'DESC_TXT', '''AGENDA = [
    "A quick walk through the UAT round 2 fixes in Vesopa EPOS 1.16.3",
    "Retest the signature flow: accepted, rejected, and Dojo's 80-second auto-accept",
    "Retest matched and unlinked refunds, including expired results",
    "Sign-off, live API access and the go-live date",
]
''')
rep('"Kick-off call between Vesopa and Dojo.\\\\n\\\\nJoin with Google Meet: " + MEET + "\\\\n\\\\nAgenda:\\\\n"',
    '"Vesopa Dojo accreditation review of Vesopa EPOS 1.16.3.\\\\n\\\\nJoin with Google Meet: " + MEET + "\\\\nOr dial: " + PHONE + " PIN: " + PIN + "\\\\nMore phone numbers: " + MORE_PHONES + "\\\\n\\\\nAgenda:\\\\n"')
rep('"Vesopa + Dojo kick-off call"', '"Vesopa Dojo Accreditation Review"', 2)
rep('"2026-10-09T12:30:00Z"', '"2026-10-12T20:00:00Z"'); rep('"2026-10-09T13:15:00Z"', '"2026-10-12T20:45:00Z"')
cut('cards = "".join([', 'html = f', '''cards = "".join([
    ready_card("FIXED", "Signature", "The till keeps checking the machine during the signature. If Dojo accepts it after 80 seconds, the real result shows."),
    ready_card("FIXED", "Paid means paid", "If the card was charged, the sale is recorded as paid whatever button was pressed. Rejected only shows when Dojo declines."),
    ready_card("FIXED", "Refunds", "Matched and unlinked refunds now run like payments: signature prompt, Cancel and the full result screen."),
])
cards2 = "".join([
    ready_card("FIXED", "Expired results", "Shows Check status, Record and Try again, and keeps asking Dojo every 5 seconds for 5 minutes."),
    ready_card("NEW", "Failed payments", "Failed card payments get their own tab on the till and in the back office, with Dojo's reference and reason."),
    ready_card("UPDATED", "Customer display", "Display 1.6.22 shows card refunds too, as well as the payment status full screen."),
])

''')
rep('alt="Vesopa EPOS and Dojo: updated meeting link, Friday 9 October 2026 at 1:30pm UK time, on Google Meet."',
    'alt="Vesopa EPOS and Dojo: UAT round 2 fixed in EPOS 1.16.3, accreditation review on Monday 12 October 2026 at 21:00 UK time."')
rep('Please use this time and link: today, 1:30pm to 2:15pm UK time, with a new Google Meet link. Ignore any 8:30am time you were sent.',
    'Every UAT round 2 point is fixed in Vesopa EPOS 1.16.3, now live on the Microsoft Store. Accreditation review tonight, 21:00 UK time.')
cut('      <p {P}>Hi Finn, Alex and Oliver,</p>', '    </td></tr>', '''      <p {P}>Hi Alex and Finn,</p>
      <p {P}>Thank you for the UAT round 2 feedback. <strong>We have fixed the signature flow and the expired results on matched and unlinked refunds</strong>, and added a few more improvements along the way. Everything is in <strong>Vesopa EPOS 1.16.3</strong> and <strong>Customer Display 1.6.22</strong>.</p>
      <p {P}>Here is what changed:</p>
''')
rep('''      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>{cards}
      </tr></table>
    </td></tr>''', '''      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>{cards}
      </tr><tr>{cards2}
      </tr></table>
    </td></tr>
    <tr><td style="padding:8px 24px 6px;">
      <h2 {H2}>Live on the Microsoft Store</h2>
      <p {P}>All of our Windows apps have been updated and are published on the Microsoft Store today:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e3ea;border-radius:14px;">{versions}
      </table>
      <p style="margin:12px 0 22px;{F}font-size:14px;line-height:1.6;color:#5f5a68;">This release also reads member cards and QR codes at the till, closes the apps straight away on Exit, and makes secure connections more reliable on new PCs.</p>
    </td></tr>''')
rep('<h2 {H2}>The right time and link</h2>', '<h2 {H2}>Accreditation review</h2>')
rep('color:#0b1a6b;">9</td></tr>', 'color:#0b1a6b;">12</td></tr>')
rep('color:#5f5a68;">FRIDAY</td>', 'color:#5f5a68;">MONDAY</td>')
rep('<div style="{F}font-size:17px;font-weight:800;color:#0b1a6b;">Vesopa + Dojo kick-off call</div>', '<div style="{F}font-size:17px;font-weight:800;color:#0b1a6b;">Vesopa Dojo Accreditation Review</div>')
rep('<strong>Friday 9 October 2026</strong><br>1:30pm to 2:15pm UK time (BST)<br>Google Meet: <a href="{MEET}" style="color:#0b1a6b;font-weight:700;">meet.google.com/yib-pneg-xri</a>',
    '<strong>Monday 12 October 2026</strong><br>21:00 to 21:45 UK time (BST)<br>Google Meet: <a href="{MEET}" style="color:#0b1a6b;font-weight:700;">meet.google.com/bpa-fqef-rpz</a><br>Or dial: {PHONE}, PIN {PIN}<br><a href="{MORE_PHONES}" style="color:#0b1a6b;">More phone numbers</a>')
rep('<br><span style="color:#2f8f00;font-weight:800;">&#10003; Today, 1:30pm UK time (not 8:30am)</span>', '')
rep('The updated calendar invite is attached and replaces the earlier ones. Accept it straight from your inbox.', 'The calendar invite is attached as well, so you can accept it straight from your inbox.')
rep('<h2 {H2}>What we would like to cover</h2>', '<h2 {H2}>What we would like to do</h2>')
rep('<p {P}>If anything changes, just reply to this email.</p>\n      <p {P}>Sorry again for the mix-up. We are looking forward to speaking with you this afternoon.</p>',
    '<p {P}>If the time does not suit, just reply with one that works better and we will fit around it. Once the review is signed off, we are ready to move to live API access and launch.</p>\n      <p {P}>Thank you again for your help with the accreditation. We look forward to speaking with you tonight.</p>')
rep('Copied to Meirion Davies', 'Copied to Meirion Davies')
cut('text = f"""', 'What we would like to cover:', '''text = f"""Hi Alex and Finn,

Thank you for the UAT round 2 feedback. We have fixed the signature flow and the expired results on matched and unlinked refunds, and added a few more improvements along the way. Everything is in Vesopa EPOS 1.16.3 and Customer Display 1.6.22.

What changed:
- Signature: the till keeps checking the machine during the signature. If Dojo accepts it after 80 seconds, the real result shows.
- Paid means paid: if the card was charged, the sale is recorded as paid whatever button was pressed. Rejected only shows when Dojo declines.
- Refunds: matched and unlinked refunds now run like payments: signature prompt, Cancel and the full result screen.
- Expired results: shows Check status, Record and Try again, and keeps asking Dojo every 5 seconds for 5 minutes.
- Failed payments: failed card payments get their own tab on the till and in the back office, with Dojo's reference and reason.
- Customer display: Display 1.6.22 shows card refunds too, as well as the payment status full screen.

LIVE ON THE MICROSOFT STORE
All of our Windows apps have been updated and are published on the Microsoft Store today:
""" + "\\n".join(f"- {n} {v}" for n, v, _ in VERSIONS) + f"""
This release also reads member cards and QR codes at the till, closes the apps straight away on Exit, and makes secure connections more reliable on new PCs.

ACCREDITATION REVIEW
Vesopa Dojo Accreditation Review
Monday 12 October 2026, 21:00 to 21:45 UK time (BST)
Join with Google Meet: {MEET}
Or dial: {PHONE} PIN: {PIN}
More phone numbers: {MORE_PHONES}
The calendar invite is attached, so you can accept it from your inbox.
Add to Google Calendar: {gcal}

''')
rep('What we would like to cover:', 'What we would like to do:')
rep('''If anything changes, just reply to this email.

Sorry again for the mix-up. We are looking forward to speaking with you this afternoon.''',
    '''If the time does not suit, just reply with one that works better and we will fit around it. Once the review is signed off, we are ready to move to live API access and launch.

Thank you again for your help with the accreditation. We look forward to speaking with you tonight.''')
# versions table, defined before html
rep('html = f\'\'\'<!doctype html>', '''VERSIONS = [
    ("Vesopa EPOS", "1.16.3", "Till, with all the Dojo fixes"),
    ("Vesopa Customer Display", "1.6.22", "Card status and refunds on the customer screen"),
    ("Vesopa Kitchen", "1.7.6", "Kitchen screen"),
    ("Vesopa Express", "1.0.13", "Self-service kiosk, also on Dojo"),
]
versions = "".join(f\'\'\'
        <tr><td style="padding:12px 16px;border-bottom:1px solid #eef0f7;{F}font-size:15px;color:#17141c;"><strong style="color:#0b1a6b;">{n}</strong> <span style="color:#2f8f00;font-weight:800;">{v}</span><br><span style="font-size:13px;color:#5f5a68;">{d}</span></td>
          <td align="right" valign="middle" style="padding:12px 16px;border-bottom:1px solid #eef0f7;{F}font-size:11px;font-weight:800;letter-spacing:1px;color:#2f8f00;">&#10003; LIVE</td></tr>\'\'\' for n, v, d in VERSIONS)

html = f\'\'\'<!doctype html>''')
rep('"UID:915819fe-1fb2-4622-ba16-2ea6e1dcbcbf@vesopa.com"', 'f"UID:{uuid.uuid4()}@vesopa.com"')
rep('"SEQUENCE:2"', '"SEQUENCE:0"')
rep('"hero-correction.jpg"', '"hero-review.jpg"')
s = s.replace('vesopa-dojo-correction.jpg', 'vesopa-dojo-review.jpg').replace('Vesopa-Dojo-kick-off-correction.', 'Vesopa-Dojo-review.').replace('email-correction.', 'email-review.')
s = s.replace('Vesopa + Dojo kick-off call', 'Vesopa Dojo Accreditation Review').replace('Builds the Dojo kick-off email', 'Builds the Dojo accreditation review email (12 Oct 21:00)')
assert 'kick-off' not in s.lower(), [l for l in s.splitlines() if 'kick-off' in l.lower()]
assert 'Oliver' not in s, [l for l in s.splitlines() if 'Oliver' in l]
open('build_review.py', 'w').write(s)
