/// The pound sign, on paper.
///
/// The till has always encoded "£" correctly and always selected a code page
/// that draws it. That works on most hardware and not on all of it: plenty of
/// cheap thermal printers ignore `ESC t` outright and draw whatever their DIP
/// switches say, and on the factory default (CP437) the byte behind "£" is
/// "ú". A Z report that reads "ú1,204.40" is not a cosmetic fault — it is a
/// document a manager hands to an accountant.
///
/// So the pound no longer goes through a code page at all by default. It goes
/// through the UK *international character set* — `ESC R 3`, in which the
/// printer draws the ASCII byte 0x23 as "£" whatever code page it is on. That
/// became the default after a venue reported X and Z reports printing "r"
/// where the pound belonged: byte 0xA3 read out of CP866, which is what
/// `ESC t 16` selects on a clone whose table is shifted by one from the Epson
/// table this till's profile assumes.
///
/// A code page is still selected underneath, for the upper range — accented
/// names on a receipt — and is still selectable for a venue that needs a
/// literal "#" more than it needs a guaranteed "£". These checks are what those
/// promises rest on.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/session_repository.dart';
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

PrinterConfig _printer({String codePage = escPosGbp}) => PrinterConfig(
  id: 'p1',
  name: 'Counter',
  kind: PrinterKind.network,
  host: '10.0.0.9',
  codePage: codePage,
);

/// A day's trading, with enough money in it to need a pound sign.
///
/// The amounts are the point: every one of them reaches the paper through
/// `_money`, so a report built from this carries the byte the field complained
/// about wherever that byte is going to appear.
TillReport _zReport({bool isZ = true}) => TillReport(
  isZ: isZ,
  zNumber: isZ ? 12 : null,
  openedAt: DateTime(2026, 8, 30, 9),
  closedAt: DateTime(2026, 8, 30, 23, 30),
  orderCount: 215,
  grossMinor: 65149,
  discountMinor: 0,
  taxMinor: 10176,
  byMethod: const {
    'CASH': ReportTally(count: 31, amountMinor: 17806),
    'CARD': ReportTally(count: 58, amountMinor: 46592),
  },
  byDepartment: const {
    'Drink': ReportTally(count: 101, amountMinor: 38000),
    'Food': ReportTally(count: 114, amountMinor: 27149),
  },
  openingFloatMinor: 10000,
  covers: 84,
);

void main() {
  // CapabilityProfile.load() reads its JSON out of the asset bundle, which does
  // not exist until the binding does.
  TestWidgetsFlutterBinding.ensureInitialized();

  group('a printer carries its own character set', () {
    test('and one set up before this existed gets the safe pound', () {
      final legacy = PrinterConfig.fromJson(const {
        'id': 'p1',
        'name': 'Counter',
        'kind': 'network',
        'host': '10.0.0.9',
      });
      expect(legacy.codePage, escPosGbp);
    });

    test('and so does a brand new one', () {
      expect(_printer().codePage, escPosGbp);
    });

    test('and a venue that chose a code page keeps it', () {
      final saved = PrinterConfig.fromJson(
        _printer(codePage: 'CP1252').toJson(),
      );
      expect(saved.codePage, 'CP1252');
    });

    test('every page on offer is one a venue could actually choose', () {
      expect(escPosCodePages.keys, contains('CP1252'));
      expect(escPosCodePages.keys, contains(escPosGbp));
      for (final label in escPosCodePages.values) {
        expect(label.trim(), isNotEmpty);
      }
    });

    // ISO_8859-1 was on this list and is not in the default capability
    // profile, so choosing it threw inside the generator and the document did
    // not print at all. Offering a setting that cannot be honoured is worse
    // than the wrong glyph it was there to fix.
    test('and every page on offer resolves against the profile', () async {
      for (final page in escPosCodePages.keys) {
        if (page == escPosGbp) continue;
        final built = await ReceiptBuilder.create(codePage: page);
        expect(
          () => built.testSlip(_printer(codePage: page)),
          returnsNormally,
          reason: '$page is offered but cannot be selected',
        );
      }
    });

    test('and a page the profile has never heard of still prints', () async {
      // The repair path, exercised directly: a printer saved by an older build
      // carrying a page this one cannot resolve must fall back, not throw.
      final built = await ReceiptBuilder.create(codePage: 'ISO_8859-1');
      expect(
        () => built.testSlip(_printer(codePage: 'ISO_8859-1')),
        returnsNormally,
      );
    });
  });

  group('the default path', () {
    late ReceiptBuilder builder;

    setUp(() async {
      builder = await ReceiptBuilder.forPrinter(_printer());
    });

    test('selects the UK international set', () {
      final bytes = builder.tillReport(_zReport());
      expect(_contains(bytes, _escUkCharacterSet), isTrue);
    });

    // The upper range is still a code page's job: an accented name on a
    // receipt has nothing to do with the pound and must not regress because
    // the pound moved off ESC t.
    test('and still selects a code table underneath it', () {
      final bytes = builder.tillReport(_zReport());
      expect(_contains(bytes, _escSelectCodeTable), isTrue);
    });

    // The whole point: the printer draws 0x23 as "£", so the pound goes out as
    // "#" and 0xA3 — the byte that was coming out as "r" — must not appear in
    // the report at all.
    test('sends the pound as the byte every printer draws as a pound', () {
      expect(escPosSafe('£12.00', ukAscii: true), '#12.00');
      final bytes = builder.tillReport(_zReport());
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

  group('a venue that chose a code page instead', () {
    late ReceiptBuilder builder;

    setUp(() async {
      builder = await ReceiptBuilder.forPrinter(_printer(codePage: 'CP1252'));
    });

    test('selects a code table and not the international set', () {
      final bytes = builder.tillReport(_zReport());
      expect(_contains(bytes, _escSelectCodeTable), isTrue);
      expect(_contains(bytes, _escUkCharacterSet), isFalse);
    });

    test('and sends the pound as 0xA3', () {
      final bytes = builder.tillReport(_zReport());
      expect(bytes, contains(0xA3));
    });

    test('a "#" typed by a venue prints as a "#"', () {
      expect(escPosSafe('Table #4'), 'Table #4');
    });
  });

  // "X AND Z still printing r instead of £." The report is the document that
  // was reported wrong, so it is the document these assert on rather than the
  // test slip that happened to be convenient.
  group('the X and Z report', () {
    test('carries a pound the printer will draw, whatever page it is on',
        () async {
      final builder = await ReceiptBuilder.forPrinter(_printer());
      final bytes = builder.tillReport(_zReport());
      expect(_contains(bytes, _escUkCharacterSet), isTrue);
      expect(bytes, isNot(contains(0xA3)));
    });

    test('and an X report is on the same footing as a Z', () async {
      final builder = await ReceiptBuilder.forPrinter(_printer());
      final bytes = builder.tillReport(_zReport(isZ: false));
      expect(_contains(bytes, _escUkCharacterSet), isTrue);
      expect(bytes, isNot(contains(0xA3)));
    });
  });

  group('the test slip', () {
    test('shows the pound under every setting on offer', () async {
      final builder = await ReceiptBuilder.forPrinter(_printer());
      final bytes = builder.testSlip(_printer());

      // The sampler switches into each code page in turn, so every one of them
      // has to appear on the wire for the venue to be able to read the answer
      // off the paper.
      expect(_contains(bytes, _escSelectCodeTable), isTrue);
      expect(_contains(bytes, _escUkCharacterSet), isTrue);

      // ESC R 0 — the sampler puts the international set back after its own
      // line, so the rest of the slip is not silently drawn in it.
      expect(_contains(bytes, const [0x1B, 0x52, 0]), isTrue);
    });

    test('and does not throw on a printer carrying an unknown page', () async {
      final builder = await ReceiptBuilder.create(codePage: 'ISO_8859-1');
      expect(
        () => builder.testSlip(_printer(codePage: 'ISO_8859-1')),
        returnsNormally,
      );
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
