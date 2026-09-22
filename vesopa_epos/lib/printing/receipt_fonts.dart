import 'package:flutter/services.dart' show rootBundle;
import 'package:pdf/widgets.dart' as pw;

/// Fonts for printed documents.
///
/// The PDF package's built-in Helvetica is Latin-1 only: it cannot draw "£",
/// an em dash, or any non-Western name, and it fails *silently* — the glyph is
/// simply absent from the receipt. A till that prints "24.50" where "£24.50"
/// belongs is not acceptable, so a Unicode font is loaded when one is bundled.
///
/// Loading is from the asset bundle, never the network: a receipt prints while
/// a customer waits, and must not depend on the venue's internet.
///
/// To bundle one, drop the TTFs in `assets/fonts/` and declare them under
/// `flutter: assets:` in pubspec.yaml. Without them the till still prints —
/// see [safeText], which keeps unsupported characters legible rather than
/// letting them vanish.
class ReceiptFonts {
  ReceiptFonts._(this.theme, this.unicode);

  final pw.ThemeData? theme;

  /// Whether a full-Unicode font is available. When false, callers must run
  /// user-visible strings through [safeText].
  final bool unicode;

  static ReceiptFonts? _cached;

  /// The candidate bundled faces, in preference order.
  static const _candidates = <({String regular, String bold, String italic})>[
    (
      regular: 'assets/fonts/OpenSans-Regular.ttf',
      bold: 'assets/fonts/OpenSans-Bold.ttf',
      italic: 'assets/fonts/OpenSans-Italic.ttf',
    ),
    (
      regular: 'assets/fonts/DejaVuSans.ttf',
      bold: 'assets/fonts/DejaVuSans-Bold.ttf',
      italic: 'assets/fonts/DejaVuSans-Oblique.ttf',
    ),
  ];

  /// Resolved once per process — parsing a TTF on every receipt would show up
  /// as lag at the counter.
  static Future<ReceiptFonts> load() async {
    final cached = _cached;
    if (cached != null) return cached;

    for (final face in _candidates) {
      try {
        final regular = pw.Font.ttf(await rootBundle.load(face.regular));
        final bold = pw.Font.ttf(await rootBundle.load(face.bold));
        // Italic is a nicety; a missing one falls back to regular rather than
        // failing the whole load.
        pw.Font italic;
        try {
          italic = pw.Font.ttf(await rootBundle.load(face.italic));
        } catch (_) {
          italic = regular;
        }

        return _cached = ReceiptFonts._(
          pw.ThemeData.withFont(
            base: regular,
            bold: bold,
            italic: italic,
            boldItalic: bold,
          ),
          true,
        );
      } catch (_) {
        // Not bundled; try the next candidate.
      }
    }

    // Nothing bundled: fall back to the built-in fonts and degrade text.
    return _cached = ReceiptFonts._(null, false);
  }

  /// Test seams: pin a known state without touching the asset bundle, which is
  /// unavailable in a plain unit test.
  static void debugSet(ReceiptFonts fonts) => _cached = fonts;
  static void debugReset() => _cached = null;

  /// The built-in-Helvetica case: substitution active.
  static ReceiptFonts noUnicodeForTest() => ReceiptFonts._(null, false);

  /// The bundled-font case: text passes through untouched.
  static ReceiptFonts unicodeForTest() => ReceiptFonts._(null, true);

  /// Characters the built-in Helvetica cannot draw, mapped to what a receipt
  /// should show instead. Dropping them is not an option — a price without its
  /// currency symbol is a different claim about the money.
  static const _substitutions = {
    '£': 'GBP ',
    '€': 'EUR ',
    '—': '-',
    '–': '-',
    '’': "'",
    '‘': "'",
    '“': '"',
    '”': '"',
    '…': '...',
    '•': '*',
    '×': 'x',
    '≥': '>=',
    '≤': '<=',
  };

  /// Makes [text] printable on whichever font actually loaded.
  ///
  /// With a Unicode font this returns [text] untouched. Without one, known
  /// characters are substituted and anything else outside Latin-1 becomes "?"
  /// — visible evidence of a problem, rather than a blank where a customer's
  /// name should be.
  String safeText(String text) {
    if (unicode) return text;

    final out = StringBuffer();
    for (final rune in text.runes) {
      final ch = String.fromCharCode(rune);
      final swap = _substitutions[ch];
      if (swap != null) {
        out.write(swap);
      } else if (rune <= 0xFF) {
        out.write(ch);
      } else {
        out.write('?');
      }
    }
    return out.toString();
  }
}
