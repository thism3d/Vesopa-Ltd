/// The pound sign, on paper.
///
/// The till has always encoded "£" correctly and always selected a code page
/// that draws it. That works on most hardware and not on all of it: plenty of
/// cheap thermal printers ignore `ESC t` outright and draw whatever their DIP
/// switches say, and on the factory default (CP437) the byte behind "£" is
/// "ú". A Z report that reads "ú1,204.40" is not a cosmetic fault — it is a
/// document a manager hands to an accountant.
///
/// So the code page is a per-printer setting now, with a last resort for the
/// printer that will not be told: the UK international character set, where the
/// printer draws the ASCII byte 0x23 as "£". These checks are what that promise
/// rests on.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/printing/printer_transport.dart';
import 'package:vesopa_epos/printing/receipt_builder.dart';

/// ESC t — select character code table.
const _escSelectCodeTable = [0x1B, 0x74];

/// ESC R — select international character set. 3 is the United Kingdom.
const _escUkCharacterSet = [0x1B, 0x52, 3];

bool _contains(List<int> haystack, List<int> needle) {
  for (var i = 0; i + needle.length <= haystack.length; i++) {
    var hit = true;
    for (var j = 0; j < needle.length; j++) {
      if (haystack[i + j] != needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

PrinterConfig _printer({String codePage = 'CP1252'}) => PrinterConfig(
  id: 'p1',
  name: 'Counter',
  kind: PrinterKind.network,
  host: '10.0.0.9',
  codePage: codePage,
);

void main() {
  // CapabilityProfile.load() reads its JSON out of the asset bundle, which does
  // not exist until the binding does.
  TestWidgetsFlutterBinding.ensureInitialized();

  group('a printer carries its own character set', () {
    test('and CP1252 is what one set up before this existed gets', () {
      final legacy = PrinterConfig.fromJson(const {
        'id': 'p1',
        'name': 'Counter',
        'kind': 'network',
        'host': '10.0.0.9',
      });
      expect(legacy.codePage, 'CP1252');
    });

    test('and it survives the round trip through settings', () {
      final saved = PrinterConfig.fromJson(
        _printer(codePage: escPosGbp).toJson(),
      );
      expect(saved.codePage, escPosGbp);
    });

    test('every page on offer is one a venue could actually choose', () {
      expect(escPosCodePages.keys, contains('CP1252'));
      expect(escPosCodePages.keys, contains(escPosGbp));
      for (final label in escPosCodePages.values) {
        expect(label.trim(), isNotEmpty);
      }
    });
  });

  group('the ordinary path', () {
    late ReceiptBuilder builder;

    setUp(() async {
      builder = await ReceiptBuilder.forPrinter(_printer());
    });

    test('selects a code table on the wire', () async {
      final bytes = builder.testSlip(_printer());
      expect(_contains(bytes, _escSelectCodeTable), isTrue);
      expect(
        _contains(bytes, _escUkCharacterSet),
        isFalse,
        reason: 'the international set is the last resort, not the default',
      );
    });

    test('and sends the pound as 0xA3', () async {
      final bytes = builder.testSlip(_printer());
      expect(bytes, contains(0xA3));
    });

    test('a "#" typed by a venue prints as a "#"', () {
      expect(escPosSafe('Table #4'), 'Table #4');
    });
  });

  group('the last resort', () {
    late ReceiptBuilder builder;

    setUp(() async {
      builder = await ReceiptBuilder.forPrinter(
        _printer(codePage: escPosGbp),
      );
    });

    test('selects the UK international set instead of a code table', () {
      final bytes = builder.testSlip(_printer(codePage: escPosGbp));
      expect(_contains(bytes, _escUkCharacterSet), isTrue);
    });

    // The whole point: on this path the printer draws 0x23 as "£", so the
    // pound goes out as "#" and 0xA3 must not appear at all -- it is the byte
    // that was coming out wrong.
    test('sends the pound as the byte that printer draws as a pound', () {
      expect(escPosSafe('£12.00', ukAscii: true), '#12.00');
      final bytes = builder.testSlip(_printer(codePage: escPosGbp));
      expect(bytes, isNot(contains(0xA3)));
      expect(bytes, contains(0x23));
    });

    // And the cost of it, stated rather than discovered: a real "#" cannot be
    // printed on this path, so it is spelled out instead of coming out as a
    // pound sign in the middle of a table number.
    test('and spells a real "#" out rather than lying about it', () {
      expect(escPosSafe('Table #4', ukAscii: true), 'Table No.4');
    });
  });

  group('a report goes to its own printer', () {
    test('so a 58mm report printer gets a 58mm layout', () async {
      final narrow = await ReceiptBuilder.forPrinter(
        PrinterConfig(
          id: 'p2',
          name: 'Office',
          kind: PrinterKind.network,
          host: '10.0.0.8',
          paperWidthMm: 58,
        ),
      );
      expect(narrow.columns, 32);

      final wide = await ReceiptBuilder.forPrinter(_printer());
      expect(wide.columns, 48);
    });
  });
}
