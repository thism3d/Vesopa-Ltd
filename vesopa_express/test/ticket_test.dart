import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_express/data/models.dart';
import 'package:vesopa_express/printing/ticket_builder.dart';
import 'package:vesopa_express/printing/ticket_printer.dart';

/// What a printer would be sent, as text, so it can be read.
String _read(List<int> bytes) => latin1.decode(bytes, allowInvalid: true);

const _face = ReceiptFace(
  mode: 'ask',
  venueName: 'The Vesopa Kitchen',
  address: ['1 High Street', 'London N1'],
  vatNumber: 'GB123456789',
  footer: 'Thank you — see you soon!',
);

const _paid = OrderView(
  publicId: 'p',
  number: 42,
  status: 'paid',
  stage: PayStage.paid,
  totalMinor: 2360,
  taxMinor: 393,
  orderType: 'take_away',
  customerName: 'Rhys',
  lines: [
    OrderLineView(name: 'Cheeseburger Meal', qty: 2, unitMinor: 1100, isModifier: false),
    OrderLineView(name: 'Meal Large Fries', qty: 2, unitMinor: 60, isModifier: true),
    OrderLineView(name: 'Meal Cola', qty: 2, unitMinor: 0, isModifier: true),
  ],
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the number is on the paper, big, with what was ordered and paid', () async {
    final b = await TicketBuilder.create();
    final text = _read(b.ticket(order: _paid, face: _face, venueName: 'X', kioskName: 'Kiosk by the door'));
    for (final expected in [
      'The Vesopa Kitchen', 'VAT No. GB123456789', 'YOUR ORDER NUMBER', '42', 'TAKE AWAY', 'For Rhys',
      '2 x Cheeseburger Meal', 'Meal Large Fries', 'Meal Cola', 'TOTAL', 'Paid by card', 'Kiosk by the door',
      'Vesopa Express',
    ]) {
      expect(text, contains(expected), reason: expected);
    }
    // The pound, on the path every printer draws: the UK set, where # is £.
    expect(text, contains('#23.60'));
    expect(text, isNot(contains('£')));
    // The footer's em dash could not be drawn, and would have thrown in the
    // generator: it is swapped, not the reason there is no ticket.
    expect(text, contains('Thank you - see you soon!'));
  });

  test('a pay-at-the-counter ticket says so across the top', () async {
    final b = await TicketBuilder.create();
    const counter = OrderView(
      publicId: 'p', number: 7, status: 'counter', stage: PayStage.counter, totalMinor: 650, orderType: 'eat_in',
      lines: [OrderLineView(name: 'Soup of the Day', qty: 1, unitMinor: 650, isModifier: false)],
    );
    final text = _read(b.ticket(order: counter, face: _face, venueName: 'X', kioskName: 'K'));
    expect(text, contains('PAY AT THE COUNTER'));
    expect(text, contains('To pay at the counter'));
    expect(text, contains('EAT IN'));
    expect(text, isNot(contains('Paid by card')));
  });

  test('a demo ticket says it is not a receipt', () async {
    final b = await TicketBuilder.create();
    const demo = OrderView(publicId: 'p', number: 1, status: 'demo', stage: PayStage.demo, totalMinor: 0);
    final text = _read(b.ticket(order: demo, face: const ReceiptFace(), venueName: 'Arms', kioskName: 'K'));
    expect(text, contains('DEMO ORDER - NOT A RECEIPT'));
    expect(text, contains('Arms'), reason: 'with no branding, the venue name still heads it');
  });

  test('a printer on a real code page gets the real pound byte', () async {
    final b = await TicketBuilder.create(codePage: 'CP1252');
    final bytes = b.ticket(order: _paid, face: _face, venueName: 'X', kioskName: 'K');
    expect(bytes, contains(0xA3));
    expect(_read(bytes), contains('£23.60'));
  });

  test('anything a printer cannot draw is swapped or marked, never thrown on', () {
    expect(escPosSafe('Café — “special” • 2×', ukAscii: false), 'Café - "special" * 2x');
    expect(escPosSafe('Soup 🍲'), 'Soup ?');
    expect(escPosSafe('No. #1 £5', ukAscii: true), 'No. No.1 #5');
  });

  test('the test slip names the printer and draws a pound to check', () async {
    final b = await TicketBuilder.create(paperWidthMm: 58);
    final text = _read(b.testSlip(face: _face, venueName: 'X', kioskName: 'K', printer: 'EPSON TM-T20'));
    expect(text, contains('TEST TICKET'));
    expect(text, contains('EPSON TM-T20'));
    expect(text, contains('58 mm'));
    expect(text, contains('#12.50'));
  });

  group('the chosen printer', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('is kept on the kiosk and read back as it was', () async {
      const store = TicketPrinterStore();
      expect(await store.load(), isNull);
      await store.save(const TicketPrinter(kind: TicketPrinterKind.network, host: '192.168.1.50', paperWidthMm: 58));
      final back = await store.load();
      expect(back?.kind, TicketPrinterKind.network);
      expect(back?.summary, '192.168.1.50:9100');
      expect(back?.columns, 32);
      await store.clear();
      expect(await store.load(), isNull);
    });

    test('one that cannot print is no printer at all', () async {
      SharedPreferences.setMockInitialValues({'express_ticket_printer': '{"kind":"usb"}'});
      expect(await const TicketPrinterStore().load(), isNull, reason: 'a USB printer with no device path');
      SharedPreferences.setMockInitialValues({'express_ticket_printer': 'not json'});
      expect(await const TicketPrinterStore().load(), isNull);
    });
  });
}
