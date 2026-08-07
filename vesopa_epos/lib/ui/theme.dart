import 'package:flutter/material.dart';

/// The Vesopa palette, taken from the 2026 brand mark: a black "vesopa"
/// wordmark with a lime tail on the V.
abstract class Pos {
  /// Brand lime. Straight off the logo (`#A5C715`).
  static const brand = Color(0xFFA5C715);

  /// Ink for anything sitting **on** the lime.
  ///
  /// This is the trap in the new identity: lime is a *light* colour — white on
  /// it lands around 1.9:1, far under the 4.5:1 a clerk needs on a glare-lit
  /// counter. Every brand-coloured surface pairs with this, never with white.
  static const onBrand = Color(0xFF10130A);

  /// A pale wash of the brand, for selected rows and quiet highlights.
  static const brandSoft = Color(0xFFEFF6D8);

  /// A deepened lime, for pressed states and for text that must read as brand
  /// on a light surface — the lime itself is too pale to be legible as type.
  static const brandDeep = Color(0xFF6E8A0E);

  /// Title bar, drawer header and splash. The mark is drawn on black, so the
  /// chrome is a true neutral rather than the tinted near-black it used to be.
  static const chrome = Color(0xFF111111);

  /// The brand's secondary neutral (`#6B6B6A`), for muted chrome text.
  static const graphite = Color(0xFF6B6B6A);

  static const red = Color(0xFFE8412C);
  static const blue = Color(0xFF4BA3F5);
  static const teal = Color(0xFF1E9184);
  static const amber = Color(0xFFF5B301);
  static const orange = Color(0xFFF4633A);
  static const purple = Color(0xFFA435B0);
  static const cyan = Color(0xFF3FBBD6);
  static const indigo = Color(0xFF2E3A8C);

  /// Success. Deliberately a bluer green than the brand lime: a status colour
  /// that reads as "brand chrome" tells the clerk nothing.
  static const green = Color(0xFF2E9E5B);

  /// A per-button colour from the back office, e.g. "#4BA3F5". Returns null for
  /// anything unset or malformed, so a bad value falls back to the department
  /// colour rather than crashing the till.
  static Color? parseColor(String? hex) {
    if (hex == null || hex.isEmpty) return null;
    var value = hex.replaceFirst('#', '').trim();
    if (value.length == 6) value = 'FF$value';
    final parsed = int.tryParse(value, radix: 16);
    return parsed == null ? null : Color(parsed);
  }

  /// The WCAG contrast ratio between two colours, 1:1 to 21:1.
  ///
  /// Used rather than a luminance threshold because a threshold answers the
  /// wrong question. "Is this colour bright?" is not "can a clerk read this at
  /// arm's length under a downlight?" — and the two disagree exactly where the
  /// brand lives, since #A5C715 is bright enough to look like a dark-text
  /// colour but saturated enough that people keep putting white on it.
  static double contrast(Color a, Color b) {
    final la = a.computeLuminance();
    final lb = b.computeLuminance();
    final hi = la > lb ? la : lb;
    final lo = la > lb ? lb : la;
    return (hi + 0.05) / (lo + 0.05);
  }

  /// Dark or light ink, whichever is actually readable on [background].
  ///
  /// Category and product buttons take arbitrary colours from the back office,
  /// so no label can assume either. This picks the higher-contrast of the two
  /// rather than guessing from brightness.
  ///
  /// The previous rule — luminance above 0.45 means dark ink — got lime and
  /// amber right but chose white for every mid-tone in the palette, where it
  /// is the weaker of the two options: cyan 2.3:1, blue 2.7:1, orange 3.1:1,
  /// green 3.4:1, teal 3.9:1, all under the 4.5:1 a clerk needs on a lit
  /// counter. Dark ink puts every one of them between 4.6:1 and 8.3:1.
  static Color inkOn(Color background) =>
      contrast(background, onBrand) >= contrast(background, Colors.white)
      ? onBrand
      : Colors.white;

  /// Secondary text on a coloured tile — a price under a name, a seat count.
  ///
  /// Fading the ink with an alpha would fade it towards the tile colour, which
  /// is what destroys the contrast [inkOn] just established. This keeps the
  /// chosen ink and softens it only as far as still-readable.
  static Color mutedInkOn(Color background) {
    final ink = inkOn(background);
    return ink == Colors.white
        ? const Color(0xFFE4E7DE)
        : const Color(0xFF3A3F2C);
  }

  /// Each category keeps its own colour, so a clerk learns the screen by colour
  /// rather than by reading every label.
  static Color categoryColor(String name) {
    switch (name.toLowerCase()) {
      case 'tea':
        return teal;
      case 'wines':
        return purple;
      case 'spirits':
        return indigo;
      case 'cocktails':
        return orange;
      case 'coffee':
        return const Color(0xFF8D5524);
      case 'bottles':
        return const Color(0xFF2E9E5B);
      case 'food':
        return const Color(0xFFD8452F);
      case 'drinks':
        return cyan;
      case 'beers':
        return amber;
      case 'desserts':
        return const Color(0xFFC2569B);
      default:
        return blue;
    }
  }
}

/// Surfaces that differ between light and dark. Reading these from the theme
/// rather than hardcoding white keeps the till legible in a dim bar as well as
/// a bright cafe.
extension PosColors on ThemeData {
  bool get isDark => brightness == Brightness.dark;

  /// The panel behind the basket and the category rail.
  Color get posSurface => isDark ? const Color(0xFF1A1A18) : Colors.white;

  /// The totals strip.
  Color get posTotals =>
      isDark ? const Color(0xFF232320) : const Color(0xFFEDEEE8);

  /// Hairlines between panels.
  Color get posLine =>
      isDark ? const Color(0xFF33332F) : const Color(0xFFD8D9D3);

  /// The action bar along the bottom.
  Color get posActionBar =>
      isDark ? const Color(0xFF0C0C0C) : const Color(0xFF151515);

  /// The navigation rail.
  Color get posRail =>
      isDark ? const Color(0xFF161614) : const Color(0xFFF8F9F4);

  /// An idle table on the floor plan.
  Color get posIdle =>
      isDark ? const Color(0xFF2A2A26) : const Color(0xFFEAEBE5);

  /// The title bar and app bar.
  ///
  /// This used to be [Pos.chrome] in both themes, on the argument that the till
  /// chrome is "always the dark brand bar". That argument does not survive
  /// contact with the product: pick Day, and every surface on the screen turns
  /// white except a black strip across the top, which reads as a bar that
  /// failed to repaint rather than as a deliberate accent. The brand mark is a
  /// black wordmark on white as often as the reverse, so a light bar is no less
  /// on-brand than a dark one.
  Color get posChrome => isDark ? Pos.chrome : const Color(0xFFF7F8F2);

  /// Text and icons on [posChrome]. Near-black on the light bar, white on the
  /// dark one — 16.5:1 and 17.4:1 respectively.
  Color get posOnChrome => isDark ? Colors.white : Pos.onBrand;

  /// The lime, adjusted to stay legible on [posChrome].
  ///
  /// Raw #A5C715 on the light bar is 1.9:1 — the section icon beside the title
  /// all but disappears. brandDeep is the same hue at 4.6:1.
  Color get posBrandOnChrome => isDark ? Pos.brand : Pos.brandDeep;
}

/// The payment screen's own surfaces — the "Ledger" board.
///
/// The tender screen was rebuilt in v1.3.3.0 to an accepted design that is not
/// expressible in the Material scheme the rest of the till runs on. It is a
/// *board*, not a page: a near-black canvas with the check, the money and the
/// keypad each sitting on it as a separate raised panel, one lime accent for
/// what is owed and one deep teal for cash. Pulling those values out of
/// `ColorScheme` would mean fighting Material's surface tinting for every one
/// of them and still landing somewhere else, so they are named here instead.
///
/// Both brightnesses are given, and Night is the accepted design value for
/// value. Day is not a second design — it is the same board with the same
/// relationships inverted (panels lighter than the canvas rather than darker),
/// because a venue that runs its till in Day must not be the one venue that
/// gets a black slab where everyone else gets the design. The two brand
/// colours are shared: lime and the teal are legible on both.
///
/// The one thing Day may not share is lime *as type*. #A5C715 on white is
/// 1.9:1 — the "left to pay" figure, which is the largest and most-read number
/// on the till, would be the least legible thing on the screen. Day uses
/// [Pos.brandDeep] for ink and keeps the raw lime for fills.
class PayPalette {
  const PayPalette({
    required this.canvas,
    required this.panel,
    required this.panelLine,
    required this.chip,
    required this.keyFill,
    required this.keyLine,
    required this.softFill,
    required this.softLine,
    required this.ink,
    required this.inkSoft,
    required this.inkMuted,
    required this.inkDim,
    required this.rowAlt,
    required this.accent,
    required this.accentFill,
    required this.accentLine,
    required this.cash,
    required this.onCash,
    required this.card,
    required this.onCard,
    required this.dangerFill,
    required this.dangerInk,
    required this.changeFill,
    required this.changeLabel,
    required this.changeInk,
  });

  /// Behind everything. The board itself.
  final Color canvas;

  /// A panel resting on the canvas: the check, the balance, the amount box.
  final Color panel;

  /// The hairline around a panel. It is what separates panel from canvas in
  /// Night, where the two are only a few values apart.
  final Color panelLine;

  /// Small pill surfaces in the header — the back key and the table chips.
  final Color chip;

  /// A keypad digit, and its edge.
  final Color keyFill;
  final Color keyLine;

  /// The quieter keys: manual card, split, and the eight function keys.
  final Color softFill;
  final Color softLine;

  /// Type, in three weights of emphasis, plus a fourth for absent values
  /// ("Nothing taken yet") that must read as a placeholder rather than a fact.
  final Color ink;
  final Color inkSoft;
  final Color inkMuted;
  final Color inkDim;

  /// Every other row of the check, so a long bill can be read across.
  final Color rowAlt;

  /// The brand, as type. See the class note: not the same value in Day.
  final Color accent;

  /// The brand as a surface — the quick-cash keys.
  final Color accentFill;
  final Color accentLine;

  /// Cash. A deep teal rather than a second lime, so the two largest keys on
  /// the screen can never be confused with one another at a glance.
  final Color cash;
  final Color onCash;

  /// Card, which is the brand key.
  final Color card;
  final Color onCard;

  /// Cancel sale, and the CL key.
  final Color dangerFill;
  final Color dangerInk;

  /// Change owed. Deliberately the cash teal: the clerk is being told to open
  /// the drawer, and the colour says which key that money came in on.
  final Color changeFill;
  final Color changeLabel;
  final Color changeInk;

  static const dark = PayPalette(
    canvas: Color(0xFF000000),
    panel: Color(0xFF0E1113),
    panelLine: Color(0x14FFFFFF),
    chip: Color(0xFF161A1C),
    keyFill: Color(0xFF14181B),
    keyLine: Color(0x1AFFFFFF),
    softFill: Color(0xFF12161A),
    softLine: Color(0x24FFFFFF),
    ink: Color(0xFFFFFFFF),
    inkSoft: Color(0xB8FFFFFF),
    inkMuted: Color(0x73FFFFFF),
    inkDim: Color(0x4DFFFFFF),
    rowAlt: Color(0x08FFFFFF),
    accent: Pos.brand,
    accentFill: Color(0x1AA5C715),
    accentLine: Color(0x66A5C715),
    cash: Color(0xFF00373A),
    onCash: Color(0xFFFFFFFF),
    card: Pos.brand,
    onCard: Pos.onBrand,
    dangerFill: Color(0xFF2A1213),
    dangerInk: Color(0xFFFF8B84),
    changeFill: Color(0xFF00373A),
    changeLabel: Color(0xFF8FD9CF),
    changeInk: Color(0xFFFFFFFF),
  );

  static const light = PayPalette(
    canvas: Color(0xFFEDEEE8),
    panel: Color(0xFFFFFFFF),
    panelLine: Color(0xFFD8D9D3),
    chip: Color(0xFFE7E9E1),
    keyFill: Color(0xFFFFFFFF),
    keyLine: Color(0xFFCFD1C8),
    softFill: Color(0xFFF7F8F2),
    softLine: Color(0xFFC6C8BE),
    ink: Pos.onBrand,
    inkSoft: Color(0xFF3E4038),
    inkMuted: Pos.graphite,
    inkDim: Color(0xFFA3A49E),
    rowAlt: Color(0x0A000000),
    accent: Pos.brandDeep,
    accentFill: Color(0x2EA5C715),
    accentLine: Color(0x8C6E8A0E),
    cash: Color(0xFF00373A),
    onCash: Color(0xFFFFFFFF),
    card: Pos.brand,
    onCard: Pos.onBrand,
    dangerFill: Color(0xFFFBE3DF),
    dangerInk: Color(0xFF9C2417),
    changeFill: Color(0xFFD7EDE8),
    changeLabel: Color(0xFF0B5F5A),
    changeInk: Color(0xFF00373A),
  );

  static PayPalette of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? dark : light;
}

ThemeData buildPosTheme(Brightness brightness) {
  final dark = brightness == Brightness.dark;

  // Seeded for the incidental roles, then the brand-carrying ones are pinned.
  // Left purely to the seed, Material darkens lime into an olive that is not
  // the logo colour — and the logo colour is the whole point.
  final scheme =
      ColorScheme.fromSeed(
        seedColor: Pos.brand,
        brightness: brightness,
      ).copyWith(
        primary: Pos.brand,
        onPrimary: Pos.onBrand,
        primaryContainer: dark ? Pos.brandDeep : Pos.brandSoft,
        onPrimaryContainer: dark ? Colors.white : Pos.onBrand,
        // Offers, savings and loyalty read in teal so a reduction is never
        // confused with the brand lime it sits next to.
        tertiary: dark ? const Color(0xFF4FC3B4) : Pos.teal,
        error: Pos.red,
      );

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: dark ? const Color(0xFF121211) : Colors.white,
    // Pinned rather than left to Material 3, which tints an untinted AppBar
    // towards the surface and produced white text on a near-white bar. Pinned
    // *per brightness* now, though: this was one hardcoded dark bar for both
    // themes, so choosing Day left a black strip across the top of an otherwise
    // white screen. See PosColors.posChrome.
    appBarTheme: AppBarTheme(
      backgroundColor: dark ? Pos.chrome : const Color(0xFFF7F8F2),
      foregroundColor: dark ? Colors.white : Pos.onBrand,
      elevation: 0,
      iconTheme: IconThemeData(color: dark ? Colors.white : Pos.onBrand),
      // The dark bar separates from the page by contrast; the light one does
      // not, so it needs a hairline or it floats.
      shape: dark
          ? null
          : const Border(
              bottom: BorderSide(color: Color(0xFFD8D9D3), width: 1),
            ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: dark ? const Color(0xFF1A1A18) : Colors.white,
    ),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
  );
}
