import 'package:flutter/material.dart';

/// The kitchen screen's palette.
///
/// Shares the Vesopa brand colours with the till — same lime, same ink — but
/// spends them differently, because the two screens are read differently. A
/// clerk reads a till at arm's length with their hand on it. A chef reads this
/// from two metres away, at an angle, through steam, while carrying something
/// hot. So the board is high-contrast, big, and almost monochrome: the only
/// colour on it is doing a job.
///
/// The three jobs colour does here, and nothing else:
///
///   * A card header says how old the ticket is.
///   * A modifier is red, because it is the thing about this plate that is not
///     the recipe.
///   * The selected tab is indigo, because something has to be.
abstract class Kds {
  /// Brand lime, off the logo. Chrome only — never a status.
  static const brand = Color(0xFFA5C715);

  /// Ink for anything sitting on the lime. Lime is a *light* colour: white on
  /// it lands around 1.9:1, nowhere near readable under a kitchen downlight.
  static const onBrand = Color(0xFF10130A);

  /// The board's ground. Not white: a wall-mounted panel at full brightness
  /// showing pure white is a light fitting, and the cards have to sit *on*
  /// something for their edges to mean anything.
  static const canvas = Color(0xFFEEF0F4);

  /// A card body.
  static const card = Color(0xFFFFFFFF);

  /// Body text on a card.
  static const ink = Color(0xFF14171C);

  /// Secondary text — the room, the time, the staff name.
  static const inkMuted = Color(0xFF5C6470);

  /// The card footer, and the segmented control's track.
  static const surface = Color(0xFFE4E7EC);

  /// A fresh ticket's header. Slate, and deliberately quiet: the board should
  /// be calm when the kitchen is calm, or the colours mean nothing when it is
  /// not.
  static const fresh = Color(0xFF44506B);

  /// Past the warn threshold.
  static const warn = Color(0xFFCE7A0A);

  /// Past the late threshold. Also pulses — see [TicketCard].
  static const late = Color(0xFFD03227);

  /// Completed. The reference board's green, which is the one colour convention
  /// every kitchen screen on the market shares and so the one worth copying
  /// exactly.
  static const done = Color(0xFF21A73E);

  /// Rushed by the kitchen: front of the board regardless of age.
  static const rush = Color(0xFF4B4FCE);

  /// A modifier or a kitchen note. The only red in the body of a card, so it
  /// keeps meaning "read this bit".
  static const modifier = Color(0xFFD32F2F);

  /// The selected segment in the header.
  static const selected = Color(0xFF4B57E8);
  static const selectedTrack = Color(0xFFDDE0FB);

  /// The offline bar.
  static const offline = Color(0xFF3A3F4A);

  /// The drawer's header. The same near-black the till uses for its chrome, so
  /// the two applications read as one product when they are seen side by side —
  /// which, in a venue that has both, they are.
  static const chromeHeader = Color(0xFF111111);

  /// Ink that is actually readable on [background].
  ///
  /// Picks the higher-contrast of dark and white rather than guessing from
  /// brightness — the same rule the till uses, and for the same reason: amber
  /// and lime are bright enough to look like dark-text colours and saturated
  /// enough that people keep putting white on them.
  static Color inkOn(Color background) =>
      _contrast(background, onBrand) >= _contrast(background, Colors.white)
      ? onBrand
      : Colors.white;

  /// Secondary text on a coloured header. Fading with an alpha would fade it
  /// towards the header colour, destroying the contrast [inkOn] just
  /// established; this keeps the chosen ink and softens it only as far as
  /// still-readable.
  static Color mutedInkOn(Color background) {
    final chosen = inkOn(background);
    return chosen == Colors.white
        ? const Color(0xFFE8EBF2)
        : const Color(0xFF31363F);
  }

  static double _contrast(Color a, Color b) {
    final la = a.computeLuminance();
    final lb = b.computeLuminance();
    final hi = la > lb ? la : lb;
    final lo = la > lb ? lb : la;
    return (hi + 0.05) / (lo + 0.05);
  }

  /// The app's one theme.
  ///
  /// Light only, and on purpose. A kitchen is a bright room and the screen is
  /// usually under a downlight; a dark board loses its contrast to the glare
  /// rather than gaining any. There is no toggle because there is no second
  /// answer worth offering.
  static ThemeData theme() {
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      fontFamily: 'OpenSans',
      colorScheme: ColorScheme.fromSeed(
        seedColor: selected,
        primary: selected,
        surface: canvas,
      ),
      scaffoldBackgroundColor: canvas,
    );

    return base.copyWith(
      textTheme: base.textTheme.apply(
        bodyColor: ink,
        displayColor: ink,
      ),
      dividerTheme: const DividerThemeData(
        color: Color(0x14000000),
        space: 1,
        thickness: 1,
      ),
      // Everything on this screen is pressed with a finger, often a gloved one.
      // 56 is the smallest target that survives that; the board's own buttons
      // are larger still.
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(0, 56),
          textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(minimumSize: const Size(0, 56)),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(minimumSize: const Size(0, 48)),
      ),
    );
  }
}
