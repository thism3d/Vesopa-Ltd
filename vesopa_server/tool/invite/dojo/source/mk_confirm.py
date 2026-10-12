s=open('build_fixes.py').read()
def rep(a,b,n=1):
    global s
    assert s.count(a)==n, (a, s.count(a)); s=s.replace(a,b)
rep('"Vesopa + Dojo: accreditation fixes done, final testing Monday 12 October, 10:30 UK time"','"Please confirm: Vesopa + Dojo final testing today, Monday 12 October, 10:30 UK time"')
rep('f"UID:{uuid.uuid4()}@vesopa.com"','"UID:5885c584-039e-4ee7-8225-16a22f4e8667@vesopa.com"')
rep('"SEQUENCE:0"','"SEQUENCE:1"')
rep('<p {P}>Thank you for the accreditation feedback on Vesopa EPOS 1.15.1. <strong>We have fixed every point on the sheet</strong>, and the fixes are live in <strong>Vesopa EPOS 1.16.0</strong> and <strong>Customer Display 1.6.20</strong> on the Microsoft Store.</p>\n      <p {P}>Here is what changed:</p>',
    '<p {P}>Following our email last night, could you please <strong>confirm that today\'s final testing at 10:30 UK time still works for you</strong>? A quick reply to this email, or accepting the attached calendar invite, is all we need.</p>\n      <p {P}>If today does not suit, just reply with a time that works better and we will fit around it. If you would prefer to use your own meeting link, please send it over and we will join from that.</p>\n      <p {P}>As a reminder, every point from the accreditation sheet is fixed in <strong>Vesopa EPOS 1.16.0</strong> and <strong>Customer Display 1.6.20</strong>:</p>')
rep('Thank you for the accreditation feedback on Vesopa EPOS 1.15.1. We have fixed every point on the sheet, and the fixes are live in Vesopa EPOS 1.16.0 and Customer Display 1.6.20 on the Microsoft Store.\n\nWhat changed:',
    "Following our email last night, could you please confirm that today's final testing at 10:30 UK time still works for you? A quick reply to this email, or accepting the attached calendar invite, is all we need.\n\nIf today does not suit, just reply with a time that works better and we will fit around it. If you would prefer to use your own meeting link, please send it over and we will join from that.\n\nAs a reminder, every point from the accreditation sheet is fixed in Vesopa EPOS 1.16.0 and Customer Display 1.6.20:")
rep('If Monday at 10:30 does not suit, just reply with a time that works better for you and we will fit around it. Once the testing is signed off, we are ready to move to live API access and launch.',
    'Once the testing is signed off, we are ready to move to live API access and launch.',2)
rep('Thank you again for your help with the accreditation.','Thank you, and we look forward to hearing from you.',2)
s=s.replace('Vesopa-Dojo-final-testing.eml','Vesopa-Dojo-confirm.eml').replace('Vesopa-Dojo-final-testing.ics','Vesopa-Dojo-confirm.ics').replace('email-final-testing.','email-confirm.')
open('build_confirm.py','w').write(s)
