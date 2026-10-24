# Plan — 2026-10-24: cashback, EPOS subscriptions on Dojo, hardware shop, Dojo live certification

Owner's request (WhatsApp with Meirion + chat, 2026-10-24). Tick items off as they land.

## Decisions from the owner (interactive questions)
- Cashback: "not sure, check logs". Investigate and fix whatever is failing.
- Software sold as **monthly tiers**: "check the current prices on vesopaepos.com and choose the best options".
- Subscription admin lives in **admin.vesopa.com** (Vesopa administration).
- Hardware on the website: **retail prices + photos**, branded Vesopa (supplier brand covered, per Meirion).
- Terms: **14-day free trial** (card saved), **annual = 2 months free**, **grace on failed payment**
  (retry 3x over 7 days, email each time, then suspend licences), **one-off setup fee**.
- Hardware retail (ex VAT), the suggested set: POS-1566/1562 till £599, KDS-181 £449, KDS-151 £379,
  OCPP-80A receipt printer £129, OCPP-80D kitchen printer £149, OCBS-T2182D scanner £69, kiosk £1,499.
  Supplier cost prices (proforma PI2606112) are NEVER shown publicly.

## Facts found
- Pontardawe tills pay through Paymentsense **Connect** (PAC REST): cashback sent as `amountCashback`
  (vesopa_epos/lib/payments/connect_pac.dart startTransaction). Cloud/terminal path sends
  `cashbackAmount` on the payment intent (payment_provider.dart createIntent).
- `epos_tender_settings.allow_cashback = 1` for info@vesopa.com. 6 payments with cashback recorded
  16–22 Oct, none since. So it worked; something since 22 Oct (or a particular case) fails.
- vesopaepos.com = `vesopa_web/` (Stripe + PayPal checkout today). Live prices: Starter £85/mo (monthly),
  Quarterly £75/mo (£225 / 3 mo), Business £70/mo (£840 / yr), Enterprise £60/mo (£1,440 / 2 yrs);
  every plan = 1 till + 1 customer display + back office + support; add-ons: extra display £15/mo,
  Vesopa Kitchen £15/mo per venue. Site says 30-day trial.
- vesopasoftware.com = `vesopasoftware/` (site + server with its own subscriptions/invoices admin).
- Licences / device limits: vesopa_server/src/licences.js + entitlements.js (auth.vesopa.com holds subs).
- Socials (owner, 2026-10-24): instagram.com/vesopasoftware, x.com/VesopaSoftware,
  reddit.com/u/Vesopasoftware, quora.com/profile/Vesopa-Software, facebook.com/vesopasoftware.
- Brochure: Vesopa-EPOS-Hardware-Brochure.pdf (11 pages; POS-1562, POS-1566, KDS-181, KDS-151, kiosk,
  OCPP-80A, OCPP-80D, card payments). KDS-181 spec PDF from OCOM.
- Supplier: OCOM Technologies (ocominc.com). Product pages on site for POS-1566, OCPP-80A, K01 kiosk;
  others from spec PDF / brochure. Images on cdn.cloudbf.com.
- Dojo contacts: alex.radzio@dojo.tech, partnertech@dojo.tech, integrations@dojo.tech. Meirion cc.

## Work
1. [x] Cashback at Pontardawe: root cause "Terminal is busy" (cashback went over REST while the socket held the reader). Fixed in 1.16.29 (a0484f3d): cashback over the socket.
       force-update Pontardawe (backup first).
2. [ ] Subscriptions on Dojo (sandbox = Vesopa Kitchen's shared sandbox key):
       - plans table (tiers, monthly/annual, setup fee, trial days, add-ons) editable in admin.vesopa.com
       - checkout: Dojo payment intent with card saved for merchant-initiated charges (or Dojo's
         recurring/subscription feature if the account has it), trial = £0 save-card then charge on day 14
       - billing sweep: renewals, retries (3 over 7 days), dunning emails, suspend licences after grace,
         restore on payment
       - admin pages: subscriptions list, customer detail, failed payments, retry now, cancel, refund,
         change plan, invoices
3. [ ] Pricing "best options": keep the live term structure, tidy tiers, annual = 10x monthly, setup fee,
       14-day trial; show on vesopaepos.com and vesopasoftware.com.
4. [ ] Hardware shop: every product with supplier photos/videos/specs, retail price, brochure download,
       on vesopaepos.com (+ vesopasoftware.com).
5. [ ] Socials on every site footer + schema.org sameAs.
6. [ ] Dojo certification email for Vesopa EPOS online payments / subscriptions (live API), branded,
       from muzahid@vesopa.com to Alex + Dojo partner, cc Meirion. Show draft to the owner before sending.
8. [ ] Website (vesopaepos.com, vesopasoftware.com) refresh, owner 2026-10-24:
       - "We are Dojo, Teya and Barclaycard accredited" badges/section
       - showcase menu.pontardawerfc.com: online ordering + payments incl. Apple Pay / Google Pay
       - feature sections: Cashback, Rewards/loyalty, white-label member apps (iOS/Android/Watch), Wallet
       - replace old/irrelevant screenshots with real current ones (till 1.16.x, kitchen, display, kiosk,
         back office, member app, menu)
       - motion graphics / short videos / animations and micro-interactions
7. [x] Pontardawe force update: till pinned to 1.16.29 with --force (2026-10-24 18:05). Store submission in certification.

## Progress 2026-10-24 evening
- Owner: KEEP the old vesopaepos.com (look + content), ADD features, never remove. "You choose the best", launching now.
- Claude Design canvas (private): https://claude.ai/artifact/MRJLHyigdaswdDaKVwXB59 , source in vesopa_web/design/project/
  - Main: NEW home sections only (accreditation band, product family, cashback demo, menu.pontardawerfc.com showcase,
    rewards + white-label apps, hardware teaser), in the live site's style: black, Orbitron uppercase, Roboto, #A5C715.
  - Hardware: new /hardware page with filter, specs, stock, setup basket. Pricing: existing plans UNCHANGED + trial checkout.
  - Admin: admin.vesopa.com Subscriptions (failed payments, retry, card link, change plan, refund, cancel).
- Pricing decision: keep the live plans (Starter 85, Quarterly 75, Business 70, Enterprise 60) + add-ons 15. Added: 14-day trial with
  card saved by Dojo, setup GBP149 waived on 12/24-month plans. (Earlier tier proposal dropped: owner wants nothing removed.)
- Real assets in vesopa_web/public/assets/v2/ (supplier logos painted out, Vesopa wordmark on bezels; menu screenshots live).
- NEXT: build into vesopa_web EJS (index sections, /hardware, footer socials, real screenshots replacing demo1-4),
  subscriptions backend (Dojo sandbox: setup intent + MIT renewals, retries 3/7d, dunning mail, licence suspend),
  admin pages, Dojo certification email draft for owner approval.

## Status 2026-10-24 19:10 (all committed, NOT live yet)
- Website additions c144462b: built + tested locally. LIVE DEPLOY BLOCKED by the auto-mode safety check.
  Owner runs: python tool/deploy_subscriptions.py   (schema, keys, admin + web files incl. the website; drift-guarded)
- Subscriptions f493c3e8: /trial with £1 card check refunded at once (owner), pay-link first charge + renewals,
  retries day 2/4/7, suspend -> admin pauses linked venue tills (48h grace), resumes when paid. admin.vesopa.com /subscriptions.
  Dojo sandbox API verified; sandbox checkout page itself was down ("upstream connect error") -> retest £1+refund after deploy.
- Dojo email 58f0ff7e: draft vesopa_server/tool/invite/dojo/Vesopa-Dojo-epos-live.eml, NOT SENT; waiting for owner OK.
  Send runs on the box: node tool/invite/dojo/send-dojo-invite.js --epos-live --send (uses Auth's SMTP).

## LIVE 2026-10-24 ~20:35
- Deployed: website additions + round 2 (747a9794): Try Vesopa EPOS -> /trial (3 interactive steps, £1 Dojo check,
  auto-activates via webhook + 5-min sweep), WebP photos + shimmer, zoom lightbox, carousel captions below with animation,
  testimonial motion. Subscriptions live in SANDBOX (tables + keys in place), admin.vesopa.com /subscriptions live.
- Dojo certification email SENT 24 Oct (250 OK) to alex.radzio@dojo.tech + partnertech@dojo.tech, cc Meirion.
- Test sign-up id 1 "TEST Vesopa QA (delete me)" pending_card: pay £1 on its sandbox checkout with Dojo test card
  5200 0000 0000 1005, 12/29, CVV 020, "Test Cardholder" -> should auto-start the trial and refund the £1.
  (Hidden browser pane could not type into Dojo's card iframe.) Cancel it in admin afterwards.
- Deploy next time: python tool/deploy_vesopaepos_site.py --base 747a9794
