# Notes from `VesopaKitchenDemo.MP4`

The brief points at a recording of a competitor's kitchen screen and asks for
something similar. The recording is a phone video of a wall-mounted screen — it
is not committed (see `.gitignore`), because eleven megabytes of shaky footage
in every clone is a poor way to carry a handful of design decisions. This is
what it actually shows.

## Chrome

A single bar across the top of the screen, and nothing else:

| Position | Contents |
| --- | --- |
| Left | Hamburger, opening a drawer |
| Centre | Segmented control: `0 Open` · `Counts` · `34 Completed` |
| Right | Printer · gear · speech bubble · sign-out |

The two counted tabs carry their number in the label rather than in a badge,
which is worth copying: `0 Open` reads as a sentence from across a kitchen,
where a badge on a word does not.

The selected segment is a saturated indigo with white text, sitting on a pale
lavender track. Everything else on screen is black-on-white.

## The board

Cards in a grid, roughly three columns on a 1080p screen, each one an order:

```
┌──────────────────────────────────────────┐
│ Table #4              Order 60292:4      │   ← header
│ Lounge                       sophie      │
│ 19:38                 Elapsed: 00:00     │
├──────────────────────────────────────────┤
│  1  The Front Row                        │   ← body
│     Extra Sausage                        │      (modifiers in red)
│     No Toast                             │
│  1  Jacket Potato                        │
├──────────────────────────────────────────┤
│            ≡↺            ✓               │   ← footer
└──────────────────────────────────────────┘
```

- **Header, left column** — order type and where it is going (`Table #4`), the
  room (`Lounge`), and the time it was placed (`19:38`).
- **Header, right column** — the order number as the till knows it
  (`Order 60292:4`), who rang it up (`sophie`), and a running `Elapsed` clock.
- **Body** — quantity, then item, in black. Modifiers and kitchen notes are
  indented under their line **in red**: `no tom no garlic`, `Extra Sausage`,
  `No Toast`. Red is the only colour in the body, and it is doing the one job
  that matters — the thing about this plate that is not the recipe.
- **Footer, open ticket** — two buttons, side by side. A list-with-undo-arrow
  glyph on the left, a tick on the right. Tapping the tick moves the order to
  Completed and the counters change (`1 Open`/`34 Completed` becomes
  `0 Open`/`35 Completed`).
- **Footer, completed ticket** — one full-width button, `↺ Recall Order`.

## Colour

Completed cards have a **solid green header** with white text. Open cards have
a **plain grey header** with black text.

The one open card in the recording is at `Elapsed: 00:00`, so the footage never
shows what an old ticket looks like — it may be that it never changes. We do
change it (see `architecture.md`, *Ageing*): a board where a two-minute ticket
and a twenty-minute ticket look identical makes the person at the pass do the
sorting, and they are the one person in the building with no spare attention.

## What the recording does not show

The drawer, the Counts tab, the settings screen, the printer button, the
speech-bubble button, and sign-in. Those are ours to design, and the brief
asks for an on-screen keyboard that the reference has no equivalent of.
