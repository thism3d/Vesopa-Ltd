import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/printing/receipt_builder.dart';
// printer_transport re-exports print_targets.dart, where PrintTarget lives.
import 'package:vesopa_epos/printing/printer_transport.dart';

/// What actually reaches the printer.
///
/// These assert on bytes rather than on strings, because every bug they guard
/// was invisible in the string: the till had the right characters all along and
/// the printer drew something else, or the encoder threw on the way out.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late ReceiptBuilder builder;

  setUp(() async {
    builder = await ReceiptBuilder.create();
  });

  PrinterConfig printer({int widthMm = 80, String name = 'Counter'}) =>
      PrinterConfig(
        id: 'a',
        name: name,
        kind: PrinterKind.network,
        host: '10.0.0.5',
        paperWidthMm: widthMm,
      );

  group('code page', () {
    // ESC t n. Without it the printer stays on its power-on page, which is
    // CP437 on essentially every thermal printer sold — and CP437 draws 0xA3
    // as "ú". This is the whole of the missing-pound-sign bug.
    test('every document selects CP1252 before printing anything', () {
      final bytes = builder.testSlip(printer());
      final selector = [0x1b, 0x74, 16]; // ESC t 16 == CP1252

      final index = _indexOfSequence(bytes, selector);
      expect(index, isNonNegative, reason: 'no ESC t 16 in the stream');

      // Before any text, or the first lines print in the wrong page.
      final pound = bytes.indexOf(0xa3);
      expect(pound, isNonNegative, reason: 'no £ byte in the stream');
      expect(index, lessThan(pound));
    });

    test('the pound sign goes out as 0xA3, not as a substitution', () {
      final bytes = builder.testSlip(printer());
      expect(bytes, contains(0xa3));
      // "GBP" would mean something had swapped the symbol out for letters.
      expect(_indexOfSequence(bytes, 'GBP'.codeUnits), -1);
    });
  });

  group('escPosSafe', () {
    test('leaves a pound sign alone', () {
      expect(escPosSafe('£12.00'), '£12.00');
    });

    test('folds typography the printer cannot draw', () {
      expect(escPosSafe('BILL — NOT A RECEIPT'), 'BILL - NOT A RECEIPT');
      expect(escPosSafe('Thank you — see you soon.'),
          'Thank you - see you soon.');
      expect(escPosSafe('Rosie’s'), "Rosie's");
      expect(escPosSafe('“Special”'), '"Special"');
      expect(escPosSafe('2 × Latte'), '2 x Latte');
      expect(escPosSafe('More…'), 'More...');
    });

    test('spells out a euro sign, which has no Latin-1 byte at all', () {
      expect(escPosSafe('€5'), 'EUR 5');
    });

    test('keeps accented names, which CP1252 can draw', () {
      expect(escPosSafe('Café Crème'), 'Café Crème');
      expect(escPosSafe('Piña Colada'), 'Piña Colada');
    });

    test('replaces the unrenderable with ? rather than dropping it', () {
      expect(escPosSafe('Sushi 寿司'), 'Sushi ??');
      expect(escPosSafe('nice 😀'), 'nice ?');
    });

    test('flattens control characters that would derail the column layout', () {
      expect(escPosSafe('Large\rCoffee'), 'Large Coffee');
      expect(escPosSafe('Tab\there'), 'Tab here');
    });
  });

  group('the encoder never throws on real-world text', () {
    // The reported failure: an em dash in a heading did not print a wrong
    // character, it threw `Invalid argument (string): Contains invalid
    // characters.` out of latin1.encode and no receipt came out.
    const nasty = [
      'BILL — NOT A RECEIPT',
      'Thank you — see you soon.',
      'Rosie’s Café — “the best”…',
      '€5 off • today only',
      '寿司 🍣',
    ];

    test('a document carrying any of it still produces bytes', () {
      for (final text in nasty) {
        expect(
          () => builder.testSlip(printer(name: text)),
          returnsNormally,
          reason: text,
        );
      }
    });
  });

  group('roll width', () {
    test('a 58mm builder lays out to 32 columns', () async {
      final narrow = await ReceiptBuilder.create(paperWidthMm: 58);
      expect(narrow.columns, 32);
    });

    test('an 80mm builder lays out to 48 columns', () {
      expect(builder.columns, 48);
    });

    test('the test slip ruler is exactly one line for the roll', () async {
      final narrow = await ReceiptBuilder.create(paperWidthMm: 58);
      final bytes = narrow.testSlip(printer(widthMm: 58));
      expect(_indexOfSequence(bytes, '12345678901234567890123456789012'.codeUnits),
          isNonNegative);
      // The 80mm ruler must not appear on a 58mm slip.
      expect(_indexOfSequence(bytes, ('1234567890' * 4).codeUnits), -1);
    });
  });
}

/// Where [needle] starts in [haystack], or -1.
int _indexOfSequence(List<int> haystack, List<int> needle) {
  if (needle.isEmpty) return -1;
  for (var i = 0; i + needle.length <= haystack.length; i++) {
    var match = true;
    for (var j = 0; j < needle.length; j++) {
      if (haystack[i + j] != needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}
