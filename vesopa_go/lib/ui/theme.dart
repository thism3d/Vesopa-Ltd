/// Vesopa Go's look.
///
/// The till's own palette (vesopa_epos/lib/ui/theme.dart, design A "Till
/// exact", chosen by the owner 2026-10-27): lime #A5C715 on chrome #111111,
/// surfaces #1A1A18, lines #33332F, so a clerk moving from the till to an iPad
/// sees the same screen. It was made for a tool held in
/// one hand while walking. It follows the phone: ink in the dark (a pub at
/// nine at night), paper in the light (a garden at noon). Lime is kept for the
/// one thing to press next: Send, Pay, Tap.
///
/// Every target is at least 56 points tall, money is set in tabular figures
/// so a column of prices lines up, and table states have one colour each that
/// means the same on every screen.
library;

import 'package:flutter/material.dart';

import '../data/models.dart';

class Tp {
  static const lime = Color(0xFFA5C715);
  static const limeDeep = Color(0xFF6E8A0E);
  static const ink = Color(0xFF111111);
  static const onLime = Color(0xFF10130A);
  static const inkCard = Color(0xFF1A1A18);
  static const inkRaised = Color(0xFF232320);
  static const inkLine = Color(0xFF33332F);
  static const inkDeep = Color(0xFF0C0C0C);
  static const green = Color(0xFF2E9E5B);
  static const muted = Color(0xFF9A9B93);
  static const paper = Color(0xFFF6F7F0);
  static const paperLine = Color(0xFFE2E5D6);
  static const danger = Color(0xFFE5484D);
  static const amber = Color(0xFFF5B301);
  static const blue = Color(0xFF3E8CF0);

  static const radius = 14.0;
  static const target = 56.0;

  static const tabular = [FontFeature.tabularFigures()];

  static Color stateColour(TableState s) => switch (s) {
        TableState.free => const Color(0xFF7D8570),
        TableState.seated => blue,
        TableState.ordered => amber,
        TableState.mains => lime,
        TableState.bill => const Color(0xFFBB6BD9),
        TableState.paid => const Color(0xFF2BB673),
      };

  static String stateName(TableState s) => switch (s) {
        TableState.free => 'Free',
        TableState.seated => 'Seated',
        TableState.ordered => 'Ordered',
        TableState.mains => 'Mains away',
        TableState.bill => 'Bill asked',
        TableState.paid => 'Paid',
      };

  /// [font]: the venue's lettering (venue_font.dart), else the device's own.
  static ThemeData theme(Brightness b, {String? font}) {
    final dark = b == Brightness.dark;
    final scheme = ColorScheme.fromSeed(
      seedColor: lime,
      brightness: b,
      primary: lime,
      onPrimary: onLime,
      surface: dark ? ink : paper,
      onSurface: dark ? Colors.white : ink,
      surfaceContainer: dark ? inkCard : Colors.white,
      outlineVariant: dark ? inkLine : paperLine,
      error: danger,
    );
    final base = ThemeData(useMaterial3: true, colorScheme: scheme, brightness: b, scaffoldBackgroundColor: scheme.surface, fontFamily: font);
    return base.copyWith(
      textTheme: base.textTheme.apply(bodyColor: scheme.onSurface, displayColor: scheme.onSurface).copyWith(
            headlineMedium: base.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.5),
            titleLarge: base.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
          ),
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: base.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800, color: scheme.onSurface),
      ),
      cardTheme: CardThemeData(
        color: scheme.surfaceContainer,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radius), side: BorderSide(color: scheme.outlineVariant)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(64, target),
          backgroundColor: lime,
          foregroundColor: onLime,
          textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(64, target),
          foregroundColor: scheme.onSurface,
          side: BorderSide(color: scheme.outlineVariant, width: 1.5),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: scheme.surfaceContainer,
        indicatorColor: lime.withValues(alpha: 0.25),
        height: 68,
        labelTextStyle: const WidgetStatePropertyAll(TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainer,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide(color: scheme.outlineVariant)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide(color: scheme.outlineVariant)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: lime, width: 2)),
      ),
      snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
    );
  }
}

/// Go's surface colours for the current appearance (light, dark or the
/// device's own): cards, raised keys, hairlines, the deepest ground, and the
/// quiet text. The brand colours (lime, amber, the table states) are the same
/// in both.
///
/// The values are the till's own (vesopa_epos lib/ui/theme.dart, PosColors
/// and the payment board's PayPalette), so Night and Day read the same on
/// the counter and on Go.
extension GoColours on BuildContext {
  bool get goDark => Theme.of(this).brightness == Brightness.dark;
  Color get goCard => goDark ? Tp.inkCard : Colors.white;
  Color get goRaised => goDark ? Tp.inkRaised : const Color(0xFFEDEEE8);
  Color get goLine => goDark ? Tp.inkLine : const Color(0xFFD8D9D3);
  Color get goDeep => goDark ? Tp.inkDeep : const Color(0xFFF8F9F4);
  Color get goMuted => goDark ? Tp.muted : const Color(0xFF6B6B6A);
  Color get goText => goDark ? Colors.white : Tp.onLime;

  /// Lime as text or an icon: raw lime on a light ground is 1.9:1, so Day
  /// takes the deep lime (4.6:1), as the till does.
  Color get goLimeInk => goDark ? Tp.lime : Tp.limeDeep;

  /// A key that cannot be pressed yet (Pay with nothing on the sale): a quiet
  /// grey, never a faded colour (faded lime reads as mud in Night).
  Color get goDisabledFill => goDark ? const Color(0xFF1E1E1C) : const Color(0xFFE4E5DF);
  Color get goDisabledInk => goDark ? const Color(0x73FFFFFF) : const Color(0xFFA3A49E);
}

/// Whether looping, decorative motion (a breathing status light, rolling
/// waves) should run: not when the device asks for less motion, and not under
/// a widget test, where a loop that never ends never lets a test settle.
bool ambientMotion(BuildContext context) =>
    !MediaQuery.disableAnimationsOf(context) && !WidgetsBinding.instance.runtimeType.toString().contains('Test');

/// The Vesopa Go mark: a lime disc with the contactless waves.
class TapMark extends StatelessWidget {
  const TapMark({super.key, this.size = 72});
  final double size;

  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: Tp.lime, borderRadius: BorderRadius.circular(size * 0.28)),
        child: Icon(Icons.contactless_rounded, size: size * 0.62, color: Tp.onLime),
      );
}

/// Money, in tabular figures.
class Money extends StatelessWidget {
  const Money(this.minor, {super.key, this.style});
  final int minor;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => Text(
        money(minor),
        style: (style ?? Theme.of(context).textTheme.titleMedium)?.copyWith(fontFeatures: Tp.tabular),
      );
}
