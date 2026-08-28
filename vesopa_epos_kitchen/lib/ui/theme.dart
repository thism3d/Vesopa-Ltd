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
  ///
  /// This and the five that follow it are the **Day** values. Each has a Night
  /// answer too, and a widget reads them through [KdsSkin] rather than from
  /// here -- see that class for what moves between the two themes and what
  /// deliberately does not. They stay as constants because [KdsSkin.day] is
  /// built out of them.
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

  /// The same red on an item that has been crossed off.
  ///
  /// Faded rather than greyed, so a struck "no bacon" still reads as the
  /// instruction it was — a chef checking back over a ticket needs to see that
  /// it was there, and a modifier that turns grey on completion looks like one
  /// that was never flagged.
  static const modifierMuted = Color(0x8CD32F2F);

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

  /// The grounds for whichever theme is showing.
  ///
  /// Read this rather than the constants above wherever a colour is a *ground*
  /// or *ink on a ground*.
  static KdsSkin of(BuildContext context) =>
      Theme.of(context).extension<KdsSkin>() ?? KdsSkin.day;

  /// The board, Day or Night.
  ///
  /// Day was the only answer for a long time, and the argument for it was a
  /// good one: a kitchen is a bright room, the screen is usually under a
  /// downlight, and a dark board loses contrast to the glare rather than
  /// gaining any.
  ///
  /// It turns out not to be the only room this gets mounted in. A pass in a dim
  /// service corridor, a late kitchen with the main lights off, and a screen a
  /// chef stands two feet from all want the other answer -- and a wall panel at
  /// full white in a dark room is a light fitting. So there are two, the venue
  /// chooses, and the choice survives a restart.
  ///
  /// **What does not move: every colour that means something.** Fresh, warn,
  /// late, done, rush and the modifier red are the board's whole vocabulary,
  /// each is saturated enough to carry either ground, and a chef who has
  /// learned that red means "read this bit" must not have to learn it twice.
  /// Only the grounds and the ink on them swap.
  static ThemeData theme({Brightness brightness = Brightness.light}) {
    final night = brightness == Brightness.dark;
    final skin = night ? KdsSkin.night : KdsSkin.day;

    final base = ThemeData(
      useMaterial3: true,
      brightness: brightness,
      fontFamily: 'OpenSans',
      colorScheme: ColorScheme.fromSeed(
        seedColor: selected,
        brightness: brightness,
        // Indigo at full strength disappears into a dark ground. Lifted rather
        // than changed: it is still the same hue doing the same job.
        primary: night ? const Color(0xFF8B95FF) : selected,
        surface: skin.canvas,
      ),
      scaffoldBackgroundColor: skin.canvas,
      extensions: [skin],
    );

    return base.copyWith(
      textTheme: base.textTheme.apply(
        bodyColor: skin.ink,
        displayColor: skin.ink,
      ),
      dividerTheme: DividerThemeData(
        color: skin.divider,
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

/// The grounds, and the ink that sits on them.
///
/// A ThemeExtension rather than a second set of constants, because every widget
/// that draws the board already has a BuildContext -- and because a global
/// "current brightness" read from static getters is the kind of thing that goes
/// wrong exactly once, in a golden test, six months later.
@immutable
class KdsSkin extends ThemeExtension<KdsSkin> {
  const KdsSkin({
    required this.canvas,
    required this.card,
    required this.ink,
    required this.inkMuted,
    required this.surface,
    required this.selectedTrack,
    required this.divider,
  });

  /// The board's ground.
  final Color canvas;

  /// A card body.
  final Color card;

  /// Body text on a card, and the secondary text beside it.
  final Color ink;
  final Color inkMuted;

  /// The card footer, and the segmented control's track.
  final Color surface;

  /// The ground behind the selected segment.
  final Color selectedTrack;

  final Color divider;

  /// The bright room. The board exactly as it has always been.
  static const day = KdsSkin(
    canvas: Kds.canvas,
    card: Kds.card,
    ink: Kds.ink,
    inkMuted: Kds.inkMuted,
    surface: Kds.surface,
    selectedTrack: Kds.selectedTrack,
    divider: Color(0x14000000),
  );

  /// The dim one.
  ///
  /// The relationships are inverted, not the colours. On Day a card is lighter
  /// than the board it sits on, so on Night it is lighter too -- a card that
  /// went darker than its ground would read as a hole, and the edge of a card
  /// is how a chef finds the ticket at two metres.
  static const night = KdsSkin(
    canvas: Color(0xFF0E1116),
    card: Color(0xFF1A1F27),
    ink: Color(0xFFECEFF3),
    inkMuted: Color(0xFF97A1AF),
    surface: Color(0xFF232A34),
    selectedTrack: Color(0xFF272C55),
    divider: Color(0x1FFFFFFF),
  );

  @override
  KdsSkin copyWith({
    Color? canvas,
    Color? card,
    Color? ink,
    Color? inkMuted,
    Color? surface,
    Color? selectedTrack,
    Color? divider,
  }) => KdsSkin(
    canvas: canvas ?? this.canvas,
    card: card ?? this.card,
    ink: ink ?? this.ink,
    inkMuted: inkMuted ?? this.inkMuted,
    surface: surface ?? this.surface,
    selectedTrack: selectedTrack ?? this.selectedTrack,
    divider: divider ?? this.divider,
  );

  /// Never actually interpolated -- the board switches outright rather than
  /// animating, because a kitchen screen crossfading its ground mid-service is
  /// motion nobody asked for. Implemented correctly all the same: "the base
  /// class requires it" is not a reason to return something wrong.
  @override
  KdsSkin lerp(ThemeExtension<KdsSkin>? other, double t) {
    if (other is! KdsSkin) return this;
    return KdsSkin(
      canvas: Color.lerp(canvas, other.canvas, t)!,
      card: Color.lerp(card, other.card, t)!,
      ink: Color.lerp(ink, other.ink, t)!,
      inkMuted: Color.lerp(inkMuted, other.inkMuted, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      selectedTrack: Color.lerp(selectedTrack, other.selectedTrack, t)!,
      divider: Color.lerp(divider, other.divider, t)!,
    );
  }
}
