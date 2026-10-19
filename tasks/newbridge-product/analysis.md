# Newbridge "Create Product": what the recording shows

Source: `RPReplay_Final1790856557.mp4` (88.6 s, 1440x1920 portrait, iPad
Safari, recorded 1 Oct 2026, Pontardawe RFC on console.newbridgesoftware.co.uk).
Frames every 2 s are in `frames/` (`f_001.jpg` = 0 s, `f_N.jpg` = (N-1)x2 s).

Written from the frames, not by Gemini: there is no `GEMINI_API_KEY` on the
owner's PC (`.env.claude-tools` does not exist there). The video also has an
audio track that has not been transcribed; re-run
`.claude/skills/vesopa-ops/scripts/gemini_video.py` with a key to add it.

## The flow at a glance

Product Management list -> **New** -> "Create Product" with a row of tabs:

    Product Details | Stock Control | Modifiers | Printing | Child Products | Information

(Child Products appears once the product type allows it; the first frames show
five tabs, later ones six.) Every tab has the same three buttons top right of
the card: **Back** (blue, from tab 2), **Save** (green, with a disk icon) and
**Continue >** (blue). Information has Back and Save only. The tabs can also
be clicked directly. There is no progress bar beyond the tab row, and no
validation message appeared in the recording.

Each tab is one or two titled cards (blue header bar, white body). On the iPad
in portrait the first tab still scrolls; the later tabs fit on one screen.

## Tab by tab

### 1. Product Details (0:00 to about 0:40)

Card **Basic Product Information**:

| Field | Control | Default / options seen |
|---|---|---|
| Name | text | empty |
| Short Description | text | empty |
| Department | searchable single-select dropdown | Food, Drink, Tobacco, Misc, Membership, Rugby Tickets, Deposit, All Sports Catering (Misc picked) |
| Sub Department | searchable dropdown | Snacks, Tobacco, Misc, Hot Drinks, Double Spirits, Posh Gin, Membership, International Rugby Tickets, Sunday Lunch, Breakfast, Lunch, Kids, Modifiers, Sides, Buffet, Sweet, Deposit, Needs Sorting... (Beers & Ciders picked) |
| Barcode | text | |
| Supplier Code | text | |
| Product Type | searchable dropdown | Product (default), Modifier |
| Image Path | text (a URL, no upload) | |
| EAN 13 Barcode | checkbox "Yes" | off |
| Weighted Product? | checkbox "Yes" | off (ticked later in the demo) |
| Manual Weight Entry? | checkbox "Yes" | off (ticked later in the demo) |

Two cards side by side underneath:

- **Pricing**: Selling Price (GBP, 0.00), Cost Price (GBP, 0.00), Tax Rate
  (dropdown: 20% Standard Rate default, Zero Rate, Child Food).
- **Additional Pricing (optional)**: Selling Price 2, 3, 4, 5 (GBP, empty).
  These are their price levels.

### 2. Stock Control (about 0:42 to 0:58)

Card **Stock Control Method**: "Will this product be monitored for stock
control?", a four-way segmented button: **Non Stock | Stock Unit | Recipe |
Parent Product**. A one-line explanation under it changes with the choice.
Changing the choice after filling it in shows a browser confirm ("If you change
this option, your current selection will be lost", OK / Cancel).

- **Stock Unit** adds card **Stock Keeping Unit**: Stock Unit (searchable
  dropdown: Each, Pack of 6, 12, 18, 24, 48, 11g Keg, 9g Keg, 70cl Bottle, 1L
  Bottle, 1.5L Bottle, Pack of 15...), Supplier (dropdown, e.g. Neath Port
  Talbot County Council), Min Stock (0.00), Max Stock (0.00).
- **Recipe** adds card **Recipes**: Recipe (dropdown, None), Recipe Qty.
- **Parent Product** adds card **Parent Product Assignment**: Parent Stock
  Record (dropdown, e.g. Strongbow), Stock Consumed (number).

### 3. Modifiers (about 1:00 to 1:08)

Card **Modifier Groups**: Select Modifiers (searchable dropdown: Doubles, Dash,
CHALLENGE 25, Loaded Fries, Pancakes...) and a green **Add Modifier** button.
Added groups appear below under **Order Selected Modifiers** as yellow chips
with an x to remove (Dash, Pancakes), in the order they print/prompt.

### 4. Printing (about 1:08 to 1:16)

Card **Printer Options**:
- Receipt Print? checkbox "Print to Receipt" (ticked by default).
- Kitchen Print? a two-column grid of checkboxes: kp1 to kp6, Kitchen Printer
  7 to 10.
- KP Category: dropdown (Please Select One..., BREAKFAST).

### 5. Child Products (about 1:16 to 1:22)

Card **Child/Stock Products**: Automatic Product List? checkbox "Yes" ("If
active the till will automatically show the below products as options when
selling this product"). Then repeating rows of Product Name, Price, Barcode,
Stock Quantity, Priority and a red delete button, with **+ Add Child**.

### 6. Information (about 1:24 to end)

Card **Additional Product Information**: one rich-text editor (bold, italic,
underline, clear, strike, super/subscript, font size, highlight colour,
bullet and numbered lists, alignment, line height, table, link, image, video,
fullscreen). Buttons: **Back** (orange at the bottom) and **Save**. No
Continue.

## What the owner wants from it (1 Oct 2026)

- The same stepped flow for creating a product, fitting on one screen.
- **Allergens as a step before Information** (Newbridge has none).
- More advanced and modern than Newbridge, responsive, in the Vesopa brand,
  in the back office and on the till's product editor.

## What Vesopa does better already, or can

- Allergens and dietary flags as a proper step (14 UK allergens, "may
  contain", vegetarian/vegan), feeding the menu, kiosk and receipts.
- Image upload with crop, not an Image Path URL.
- Stock control with live "can make" counts, recipes with measures, and
  case/unit wastage (all built in September).
- A real progress indicator, required-field checks with messages, a summary
  before saving, and a draft that survives leaving the page.
