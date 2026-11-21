# Loughor RFC

The club's website (loughorrfc.site) and its own members' app, made the same
way as Pontardawe RFC's (`PontardaweRFC/`).

| | |
|---|---|
| `brand/crest.png` | the club's crest, exactly as the club supplied it (`crest-original.jpeg`). Everything below is drawn from it; it is never redrawn or recoloured |
| `venue.json` | slug `loughor-rfc`, names, `com.vesopaepos.loughorrfc`, colours (from the crest), version and build |
| `overlay/` | app icons, splash and Watch icon, by `vesopa_loyalty/tool/make_venue_art.py LoughorRFC` |
| `store/` | Play and App Store listings, icons and feature graphic (`listing.md`) |
| `website/` | loughorrfc.site: Node, from Pontardawe's site; `npm test` |

Colours, from the crest: royal blue `#1238A8`, deep `#071A52`, glow `#2F62E0`,
gold `#F5C518`, with the crest's green and white.

## Shipping

- Website, member.loughorrfc.site, info@ and contact@ forwarding (to
  info@vesopasoftware.com) and the club's venue in the back office:
  GitHub Actions > **Club site** > LoughorRFC (`check` first, then `site`).
- Apps: the venue app workflows with `venue: LoughorRFC`.

## Still needed from the owner, once

- Google Play Console: create the app `com.vesopaepos.loughorrfc` (Play's API cannot create an app).
- App Store Connect: create the app record for `com.vesopaepos.loughorrfc`.
- SMTP2GO: verify the domain loughorrfc.site so forwarded mail can leave From it.
- A reviewer member account for store review (see `store/listing.md`).
