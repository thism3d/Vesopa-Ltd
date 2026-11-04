## Recommended Connect integration

Vesopa Software Ltd, 2026-11-04. Stripe is a **third** payments provider beside Dojo and Teya, never a replacement (owner: "We have dojo and Teya, now add Stripe as well. Do not remove any others."). Each venue chooses, per way of paying, which provider it uses; with nothing chosen a venue stays exactly as it is today (Dojo).

### A. Account configuration
Accounts API: `/v2/core/accounts`
Legacy account `type`: not used
Dashboard: `express`
Fee collection: platform (`fees_collector: "application"`)
Negative balance liability: Stripe (`losses_collector: "stripe"`)

Venues are pubs, clubs and restaurants that want little to manage, so the Express dashboard with Vesopa's embedded components fits. Vesopa sets one rate per venue (Platform Pricing Tool), and Stripe holds negative-balance liability, so a venue's chargebacks do not land on Vesopa.

Each connected account needs merchant configuration (`configuration.merchant`, `card_payments` requested) for direct charges, and customer configuration (`configuration.customer`) so Vesopa can bill it for its software licence.

Public preview: Express + Stripe-held losses with direct charges is in public preview and needs the Connect preview API version (`Stripe-Version: 2026-10-28.preview` at the time of writing; confirm in the [preview changelog](https://docs.stripe.com/changelog.md?preview=true)). It applies to newly created connected accounts only, and the dashboard choice is permanent per account.

### B. Charge pattern: direct charges
Each venue is the merchant of record: its name is on the guest's statement and it owns refunds and disputes. Counter Tap to Pay, QR table ordering, online menus, event tickets and member subscriptions are all created on the venue's own account (`Stripe-Account` header).

### C. Venue onboarding flow
Onboarding method: embedded (`account_onboarding` in the Vesopa back office, Payments page).
The venue's manager opens Stripe in the back office; Vesopa creates the v2 account, shows embedded onboarding, Stripe verifies the business, Vesopa reads the capability statuses, and Stripe payments switch on only when `card_payments` and payouts are active. `notification_banner` keeps the venue current as requirements change.

### D. Payments dashboard access for venues
Venues use embedded components inside the Vesopa back office day to day, and can open the Stripe Express dashboard through login links Vesopa generates.

### E. Embedded components
- `account_onboarding`
- `notification_banner` (required; keeps venues aware of new requirements so they stay enabled)
- `account_management`
- `payments` (full detail with direct charges)
- `payouts`
- `balance_report`, `payout_reconciliation_report` (end-of-day reconciliation)

### F. Webhook integration
Use webhooks for reliable payment confirmation, and always verify webhook signatures ([webhook signature verification](https://stripe.com/docs/events/manage-webhook-endpoints#signature-errors)); event details are covered in the build.

### G. Onboarding status gating
Verify capability statuses with `stripe.v2.core.accounts.retrieve(id)` before enabling Stripe at a venue:
- `configuration.merchant.capabilities.card_payments.status === 'active'`
- `configuration.merchant.capabilities.stripe_balance.payouts.status === 'active'`

### H. Fee structure
- Platform fee model: a per-venue rate (percentage, optionally plus a fixed amount) set in the [Platform Pricing Tool](https://dashboard.stripe.com/settings/connect/platform_pricing).
- `application_fee_amount`: not set; the Platform Pricing Tool owns pricing and an explicit fee would override it.
- Guests pay the venue (direct charge). Vesopa pays Stripe's processing fee and keeps the venue's rate minus that fee. Configure the tool so the venue's rate includes Stripe's estimated processing fee plus Vesopa's margin, and watch the [margin report](https://docs.stripe.com/connect/margin-reports.md). Rates vary by card and region: [stripe.com/pricing](https://stripe.com/pricing).

```
Guest pays £20.00 (direct charge on the venue's account)
        │
        ▼
 ┌──────────────┐
 │    Venue     │ ── receives £20.00 minus its Vesopa rate (e.g. 1.6% = £0.32)
 └──────┬───────┘
        │ venue rate, per the Platform Pricing Tool
        ▼
 ┌──────────────┐
 │    Vesopa    │ ── keeps £0.32 minus Stripe's processing fee
 └──────────────┘
```

Warning: if a venue's rate is below what Stripe charges for a payment (premium or international cards), Vesopa loses money on it. Keep the estimated processing fee inside the venue's rate.

### I. SaaS monetization
- Transaction margin: Platform Pricing Tool (not `application_fee_amount`).
- Software licences: Billing subscriptions from Vesopa to each venue using the venue's `customer_account` (v2 customer configuration). No separate v1 Customer object.
- Venue memberships (e.g. Pontardawe RFC) are the venue's own Billing subscriptions on its account, to its members.

### J. Implementation plan
1. Account setup: platform profile, preview API version, Radar for Platforms, Platform Pricing Tool rules, webhook endpoint `https://backoffice.vesopaepos.com/api/stripe/webhook`.
2. Onboarding: `POST /api/stripe/account` (v2 account, merchant + customer configuration), `POST /api/stripe/account-session` (embedded components), capability gating, per-venue provider choice beside Dojo and Teya.
3. Payments: Terminal Tap to Pay in Vesopa Go (location + connection token + `card_present` PaymentIntent on the venue's account), Payment Element for QR ordering, menus and tickets, Billing for memberships and licences.
4. Webhooks and readiness: signature-verified webhook, capability re-check on account events.
5. Go-live: The Vesopa Kitchen end to end in a Stripe sandbox, then one live venue on request.

### K. Risk and liability
#### Negative balance liability
Stripe (`losses_collector: "stripe"`), which enables Stripe's Managed Risk: loss protection, monitoring, interventions and negative-balance recovery.

#### Risk management
Enable Radar for Platforms alongside Managed Risk; Managed Risk assumes Radar is catching transaction-level fraud.

### L. Why this fits your business
- Venues are independent businesses that own the guest relationship: direct charges.
- Pubs and clubs want little to run: Express dashboard with embedded components.
- Vesopa wants one rate per venue: platform-managed pricing via the Platform Pricing Tool.
- Chargebacks stay off Vesopa's balance: Stripe-held losses.

### M. Open questions
- Which ways of paying default to Stripe at a new venue (all stay on Dojo unless chosen).
- Identity (staff and member checks), Tax, Issuing and Invoicing are separate products, planned after Connect is live.
- Tap to Pay on iPhone still needs Apple's entitlement on `com.vesopa.go`.
