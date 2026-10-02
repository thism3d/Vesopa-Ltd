# Newbridge Customers & Loyalty: what the recording shows

Source: `NewBridgeCustomerAndLoyalty.mp4` (124.5 s, 1440x1920 portrait, iPad
Safari, Pontardawe RFC on console.newbridgesoftware.co.uk, recorded 3 Oct
2026 local time on the device). One frame every 5 s is in
`docs/newbridge-loyalty-frames/` (`f_001.jpg` = 0 s, `f_N.jpg` = (N-1)x5 s).

Written from frames read every 2 s, not by Gemini: there is no
`GEMINI_API_KEY` on the owner's PC. The video has an audio track that has
not been transcribed, so any narration is missing here. Re-run
`.claude/skills/vesopa-ops/scripts/gemini_video.py` with a key to add it.

Menu path throughout: left sidebar **Customers & Loyalty**, which opens to
**Customers**, **Gift Cards** and **Loyalty Schemes**.

## 1. Customers list (0:00 to 0:06)

Page **Customer Management**, card "Create and Manage Customers" ("Click in
the table to instantly edit records shown, use the search boxes to filter").

- Buttons: **New**, **Edit**, **Delete**; "Show 50 entries".
- Columns, each with a search box under the header: ID, First Name, Last
  Name, Membership Number, Email Address, Group (dropdown filter "Show"),
  Type (dropdown filter), Expiry.
- Rows seen: membership numbers like 00000512 / 00000014; Groups such as Life
  Members, Committee, VIP, Sponsorship, President; Type "No Type Selected";
  Expiry dates (2026 to 2035).
- Cells are editable in place (inline editing).

## 2. Create a new Customer (0:06 to 0:34)

Page **Create a new Customer**, breadcrumb Dashboard > Customers > Create
Customer. One long scrolling form of stacked cards, **Save** (green) at the
bottom.

**Basic Customer Information**

| Field | Control | Default / placeholder |
|---|---|---|
| Prefix | dropdown | Mr |
| First Name | text | "Joe" |
| Last Name | text | "Bloggs" |
| Email Address | text | joe.bloggs@company.com |
| Telephone Number | text | 02920990610 |
| Marketing Emails | dropdown ("Would the customer like to receive marketing emails from your company?") | No |

**Customer Address** (collapsible, chevron): Address Line 1 ("e.g. 20 Castle
Court"), Address Line 2 ("e.g. Treforest Industrial Estate"), and more below.

**Customer Type & Loyalty**

| Field | Control | Notes |
|---|---|---|
| Loyalty Scheme | dropdown "Please select a group..." | the schemes: VIP, Member, Players VIP, Sponsorship, Life Members, Committee, President, Daffs, Old Boys |
| Customer Type | dropdown "Please select a type..." | |
| Membership Number | text | placeholder 123456 |
| Loyalty Points Balance | number | placeholder 10.00 |
| Expiry Date | date | 2027-10-02 (a year ahead) |

**Linked Customers**: dropdown "Please select a Customer..." listing every
customer ("Mr Terry Jones", "Mr Richard Kevin Mort"...), to link family or
company members.

**Customer Notes**: free text.

Note: in Newbridge the "Loyalty Scheme" doubles as the customer's group, which
is what the list's Group column shows.

## 3. Gift Cards (0:34 to 0:50)

Page **Gift Card Management**, card "Create and Manage Gift Cards".

- Buttons New / Edit / Delete at the top and bottom; Show 10 entries;
  paging "Showing 1 to 10 of 40 entries".
- Columns: ID, Gift Card Number (0501, 0500, 0549...), Balance (GBP 1.40,
  0.00, 25.00, 34.80), Purchase Date (date-time), Expiry Date. Search box per
  column.
- **New** opens a modal **New Gift Card** > Gift Card Details: Gift Card
  Number (text), Balance (number, "e.g. 30.00"); Close / Create.
- **Edit** with no row selected shows an error dialog "Please select a single
  row to edit" (OK).
- Balance can be edited inline in the table (on-screen keyboard shown).

## 4. Loyalty Schemes list (0:50 to 1:00)

Page **Loyalty Scheme Management** ("Loading data, please wait..." spinner
first), card "Create and Manage Loyalty Schemes".

- Columns: ID, Scheme Name, Scheme Type. New / Edit / Delete.
- Schemes: VIP (Loyalty Discount & Points), Member (None), Players VIP
  (Loyalty Discount & Points), Sponsorship (Loyalty Points), Life Members
  (Loyalty Discount & Points), Committee (Loyalty Points), President (Loyalty
  Points), Daffs (Loyalty Discount & Points), Old Boys (Loyalty Discount &
  Points). "Showing 1 to 9 of 9 entries".
- So a scheme's type is one of: **None**, **Loyalty Points**, **Loyalty
  Discount & Points** (and by implication Loyalty Discount).

## 5. Create Loyalty Scheme (1:00 to 2:04)

Page **Create Loyalty Scheme**, one tab "Scheme Details", **Create** (green)
at the bottom. Sections appear and disappear with the answers.

**Basic Scheme Information**

| Field | Control | Options |
|---|---|---|
| Scheme Name | text, "e.g. Gold Club" | |
| Scheme Type ("Select the type of reward") | searchable dropdown | **No Rewards** (default), **Discount** |
| Earn Points ("Would you like your customers to earn points?") | dropdown | **No** (default), **Yes** |

**Discount Information** (only when Scheme Type = Discount)

| Field | Control | Notes |
|---|---|---|
| Discount Type ("What type of discount should be applied to the promotion?") | searchable dropdown | Select One, **Percentage Off**, **Fixed Amount Off**, **Price Level** |
| Discount Value ("How much discount should be given or if using a set price, what is total amount for the items in this promotion?") | number | for Percentage / Fixed |
| Select a Price Level ("Select which price level to change to") | dropdown | Price Level 2, 3, 4, 5 (for Price Level) |
| Pontardawe RFC Discount Products ("Which products should be discounted?") | multi-select | "All selected (527)" |
| Start Time ("On each day what time will the promotion start?") | time | 00:00:00 |
| End Time | time | 23:59:59 |
| Available on Days ("Which days between the above dates is the promotion active?") | multi-select | Select all, Monday to Sunday; "All selected (7)" |

**Point Earning Information** (only when Earn Points = Yes)

| Field | Control | Help text |
|---|---|---|
| How many Points? | number | "How many points will be earned per GBP spent?" |
| Points Value | number | "How much is each point worth in pounds?" |
| Minimum Spend | number | "Minimum spend to earn points? (0 = unlimited)" |
| Initial Value | number | "Enter a number of points that will be given to the customer upon signup." |
| Minimum Balance for Discount | number | "Enter a number of points that are required to get any discount associated with this membership." |
| Pontardawe RFC Points Products ("Which products can earn points?") | multi-select by category | "All selected (527)", grouped (Beers & Ciders...) |

The demo switches between Percentage Off, Fixed Amount Off and Price Level
(2, 3) and back, then returns to the scheme list without saving.

## What is NOT in Newbridge (from what is shown)

- No tiers or automatic upgrade between schemes, no stamps / "buy 9 get the
  10th free", no birthday rewards, no points expiry rules, no redemption
  rules beyond "points value" and "minimum balance", no card number ranges
  or prefixes, no customer account / tab or credit limit, no per-scheme
  dates (only daily times and days of the week), no customer-facing app or
  wallet card, no history of points earned and spent.
- Everything is long scrolling forms; no summary, no preview of what the till
  or the customer will see.

These are where Vesopa can be more advanced: Vesopa Loyalty (app + Apple /
Google Wallet cards), stamps, tiers, birthday rewards, expiry, live points
history, customer accounts with credit limits, and a stepped editor like the
product wizard.
