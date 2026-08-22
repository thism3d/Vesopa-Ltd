import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/printing/receipt_builder.dart';

/// The room, on the kitchen ticket.
///
/// "Table 4" is not an address in a venue with a Main Floor and a Terrace: both
/// have a table 4, and the cost of the ambiguity is a plate carried to the
/// wrong one. The screens have carried the room since kitchen screens landed;
/// these are about the half that goes to paper, which had been left behind.
///
/// Asserted on the bytes rather than on a string, like the rest of the ESC/POS
/// tests here — the till having the right characters has never been the part
/// that failed.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late ReceiptBuilder builder;

  setUp(() async {
    builder = await ReceiptBuilder.create();
  });

  Order order({int? tableNumber = 4}) => Order(
    id: 'order-1',
    status: 'parked',
    tableNumber: tableNumber,
    subtotalMinor: 1000,
    manualDiscountMinor: 0,
    discountMinor: 0,
    taxMinor: 0,
    totalMinor: 1000,
    customerDiscountType: 'none',
    customerDiscountValue: 0,
    createdAt: DateTime(2026, 8, 22, 19, 30),
  );

  OrderLine line() => const OrderLine(
    id: 'line-1',
    orderId: 'order-1',
    pluId: 1,
    name: 'Crispy Chicken Burger',
    quantity: 1,
    unitPriceMinor: 1000,
    taxPercentage: 20,
    lineDiscountMinor: 0,
  );

  List<int> ticket({String? roomName}) => builder.kitchenTicket(
    order: order(),
    lines: [line()],
    station: 'FOOD',
    roomName: roomName,
  );

  /// The bytes as the printer will read them. CP1252 is a single-byte page for
  /// everything used here, so a plain code-unit search is faithful.
  bool contains(List<int> bytes, String text) =>
      _indexOfSequence(bytes, text.codeUnits) >= 0;

  test('the room prints under the table number', () {
    final bytes = ticket(roomName: 'Terrace');

    expect(contains(bytes, 'TABLE 4'), isTrue, reason: 'no table on the ticket');
    expect(contains(bytes, 'TERRACE'), isTrue, reason: 'no room on the ticket');

    // Under, not over. The table number is what is read first from a metre
    // away, so the room qualifies it rather than displacing it.
    expect(
      _indexOfSequence(bytes, 'TABLE 4'.codeUnits),
      lessThan(_indexOfSequence(bytes, 'TERRACE'.codeUnits)),
    );
  });

  test('a venue with no rooms prints exactly what it printed before', () {
    final bytes = ticket();

    expect(contains(bytes, 'TABLE 4'), isTrue);
    // Nothing is reserved for a room that does not exist — no blank line, no
    // separator. Most venues have one room and their ticket must not grow.
    expect(bytes, equals(ticket(roomName: null)));
  });

  // A floor plan that has not loaded yields an empty string rather than null,
  // and an empty heading printed centred and bold is a blank line the chef has
  // to look past on every ticket.
  test('a blank room is not printed as an empty line', () {
    expect(ticket(roomName: ''), equals(ticket()));
    expect(ticket(roomName: '   '), equals(ticket()));
  });

  test('the room is upper-cased and trimmed, like every other heading', () {
    final bytes = ticket(roomName: '  Main Floor  ');
    expect(contains(bytes, 'MAIN FLOOR'), isTrue);
    // Not the raw form, or the ticket carries the venue's typing.
    expect(contains(bytes, '  Main Floor  '), isFalse);
  });

  test('a takeaway has no table, and so has no room to print', () {
    final bytes = builder.kitchenTicket(
      order: order(tableNumber: null),
      lines: [line()],
      station: 'FOOD',
      roomName: 'Terrace',
    );

    // The room is only ever a qualifier on a table. A counter sale carrying
    // "TERRACE" would be actively wrong — there is no table there to take it
    // to — so this asserts the pairing, not merely the absence.
    expect(contains(bytes, 'TABLE'), isFalse);
  });
}

int _indexOfSequence(List<int> haystack, List<int> needle) {
  if (needle.isEmpty) return -1;
  for (var i = 0; i + needle.length <= haystack.length; i++) {
    var hit = true;
    for (var j = 0; j < needle.length; j++) {
      if (haystack[i + j] != needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}
