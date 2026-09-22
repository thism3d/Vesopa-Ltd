// Proves the bundled TTFs actually parse and can draw the characters a UK
// receipt needs. The other font tests use debugSet to pin a known state, so
// they would pass even with no fonts bundled at all — this one deliberately
// goes through the real asset bundle instead.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

void main() {
  group('bundled receipt fonts', () {
    // Reads from disk rather than rootBundle: a plain unit test has no asset
    // bundle, and what matters here is that the shipped bytes are a valid TTF.
    pw.Font load(String name) {
      final file = File('assets/fonts/$name');
      expect(file.existsSync(), isTrue, reason: '$name is not bundled');
      return pw.Font.ttf(file.readAsBytesSync().buffer.asByteData());
    }

    test('the three declared faces parse', () {
      for (final name in const [
        'OpenSans-Regular.ttf',
        'OpenSans-Bold.ttf',
        'OpenSans-Italic.ttf',
      ]) {
        expect(load(name).fontName, isNotEmpty, reason: name);
      }
    });

    test('regular face draws every character a receipt needs', () {
      // isRuneSupported lives on the low-level PdfFont, which needs a document
      // to attach to; pw.Font is only a lazy wrapper around it.
      final doc = PdfDocument();
      final font = load('OpenSans-Regular.ttf').getFont(
        pw.Context(document: doc),
      );

      // The pound sign is the one that silently vanished with built-in
      // Helvetica and prompted bundling a font in the first place.
      for (final ch in const ['£', '€', '—', '’', '…', '•', '×', 'é', 'ł']) {
        expect(font.isRuneSupported(ch.runes.first), isTrue,
            reason: 'no glyph for "$ch" — it would print blank');
      }

      // The control: a character Open Sans genuinely lacks must report false,
      // otherwise this test proves nothing about the ones above.
      expect(font.isRuneSupported('漢'.runes.first), isFalse);
    });

    test('the licence ships alongside the fonts', () {
      // Open Font License clause 2: the licence text travels with the font.
      // The repo is public, so this is not merely a formality.
      expect(File('assets/fonts/OFL.txt').existsSync(), isTrue);
    });

    test('pubspec declares exactly the fonts that exist', () {
      final pubspec = File('pubspec.yaml').readAsStringSync();
      final declared = RegExp(r'- (assets/fonts/[\w.-]+)')
          .allMatches(pubspec)
          .map((m) => m.group(1)!)
          .toSet();
      final present = Directory('assets/fonts')
          .listSync()
          .whereType<File>()
          .map((f) => f.uri.pathSegments.last)
          // macOS drops .DS_Store into any directory it displays. It is
          // gitignored and never ships, so failing on it would be noise.
          .where((n) => !n.startsWith('.'))
          .map((n) => 'assets/fonts/$n')
          .toSet();
      // Both directions matter: an undeclared font is missing at runtime, and
      // a declared-but-absent one fails the build.
      expect(declared, equals(present));
    });
  });
}
