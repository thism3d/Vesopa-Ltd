// Vesopa Express kiosk orders, on the till.
//
// The server has announced paid kiosk orders and queued kitchen tickets for
// printer-only stations since the kiosk shipped; the till simply never read
// either, so a counter venue could not move a number up the collection board
// and a kitchen with only printers never saw a kiosk ticket. These pin the
// till's half: what it reads, what it claims, what it prints and what it
// reports back.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/data/express_orders.dart';
import 'package:vesopa_epos/data/printer_settings.dart';
import 'package:vesopa_epos/data/terminal_identity.dart';
import 'package:vesopa_epos/data/till_settings.dart';
import 'package:vesopa_epos/main.dart' show tillSettingsProvider;
import 'package:vesopa_epos/ui/dinein_toasts.dart';
import 'package:vesopa_epos/printing/printer_transport.dart';
import 'package:vesopa_epos/ui/printers_page.dart'
    show PrinterSettingsController, printerSettingsProvider;

Map<String, Object?> _order({String status = 'paid', int id = 7}) => {
  'id': id,
  'number': 42,
  'status': status,
  'order_type': 'eat_in',
  'customer_name': 'Sam',
  'total_minor': 1299,
  'kiosk': 'Kiosk 1',
  'paid_at': '2026-09-27T12:00:00.000Z',
  'ready_at': null,
  'lines': [
    {'name': 'Cheeseburger meal', 'qty': 1, 'unit_minor': 999},
    {'name': 'Large fries', 'qty': 1, 'unit_minor': 0, 'is_modifier': true},
    {'name': 'Brownie', 'qty': 2, 'unit_minor': 150},
  ],
};

Map<String, Object?> _claim({List<String> stations = const ['kp1']}) => {
  'claim_id': '0b5b7a3c-3f7e-4c55-9d1e-0c7a9b1d2e3f',
  'stations': stations,
  'ticket': {
    'order_id': 7,
    'number': 42,
    'order_type': 'take_away',
    'order_type_label': 'Take away',
    'customer_name': 'Sam',
    'kiosk': 'Kiosk 1',
    'placed_at': '2026-09-27T12:00:00.000Z',
    'stations': stations,
    'lines': [
      {
        'name': 'Cheeseburger',
        'qty': 1,
        'is_modifier': false,
        'note': 'No pickles',
        'stations': ['kp1'],
      },
      {
        'name': 'Extra cheese',
        'qty': 1,
        'is_modifier': true,
        'stations': ['kp1'],
      },
      {
        'name': 'Milkshake',
        'qty': 1,
        'is_modifier': false,
        'stations': ['kp2'],
      },
      {
        'name': 'Chips',
        'qty': 2,
        'is_modifier': false,
        'stations': ['kp1'],
      },
    ],
  },
};

void main() {
  group('reading the feed', () {
    test('an order carries its number, how it is eaten and its dishes', () {
      final order = ExpressOrder.fromJson(_order())!;
      expect(order.number, 42);
      expect(order.isPaid, isTrue);
      expect(order.orderTypeLabel, 'Eat in');
      expect(order.customerName, 'Sam');
      // Two dishes; the fries are the meal's answer, not a third plate.
      expect(order.dishes.length, 2);
      expect(order.itemCount, 3);
    });

    test(
      'nothing is announced when the back office says not to tell tills',
      () {
        final quiet = ExpressFeed.fromJson({
          'enabled': true,
          'notify_till': false,
          'orders': [_order()],
        })!;
        expect(quiet.orders, hasLength(1));
        expect(quiet.announced, isEmpty);

        final off = ExpressFeed.fromJson({
          'enabled': false,
          'notify_till': true,
          'orders': [_order()],
        })!;
        expect(off.announced, isEmpty);

        final on = ExpressFeed.fromJson({
          'enabled': true,
          'notify_till': true,
          'orders': [_order(), _order(status: 'ready', id: 8)],
        })!;
        expect(on.announced.map((o) => o.status), ['paid', 'ready']);
      },
    );

    test(
      'a server with no kiosk at all is no kiosk orders, not an error',
      () async {
        final service = ExpressService(
          apiBase: 'https://example.test',
          terminalToken: 't',
          client: MockClient((_) async => http.Response('Not found', 404)),
        );
        final feed = await service.orders();
        expect(feed, isNotNull);
        expect(feed!.announced, isEmpty);
      },
    );

    test(
      'an unreachable server is "could not ask", so the cards stay put',
      () async {
        final service = ExpressService(
          apiBase: 'https://example.test',
          terminalToken: 't',
          client: MockClient((_) async => throw Exception('offline')),
        );
        expect(await service.orders(), isNull);
      },
    );
  });

  group('the kitchen ticket', () {
    final claim = ExpressPrintClaim.fromJson(_claim(stations: ['kp1', 'kp2']))!;

    test('carries only the lines for its station', () {
      final grill = claim.ticketFor('kp1');
      expect(grill.lines.map((l) => l.name), [
        'Cheeseburger',
        'Extra cheese',
        'Chips',
      ]);
      final bar = claim.ticketFor('kp2');
      expect(bar.lines.map((l) => l.name), ['Milkshake']);
    });

    test('hangs an add-on off the dish before it, and keeps the note', () {
      final lines = claim.ticketFor('kp1').lines;
      expect(lines[0].parentLineId, isNull);
      expect(lines[0].notes, 'No pickles');
      expect(lines[1].parentLineId, lines[0].id);
      expect(lines[2].parentLineId, isNull);
      expect(lines[2].quantity, 2);
    });

    test('says which kiosk number it is and how it is eaten', () {
      expect(claim.headline, 'Kiosk no. 42 - Take away');
      expect(claim.ticketFor('kp1').order.notes, 'Name: Sam');
    });

    test('a claim somebody else won is nothing to print', () {
      expect(
        ExpressPrintClaim.fromJson({'claim_id': null, 'stations': []}),
        isNull,
      );
    });
  });

  group('which stations a till prints for', () {
    const kp1 = PrinterConfig(
      id: 'kp1',
      name: 'Grill',
      kind: PrinterKind.network,
      host: '10.0.0.5',
    );
    const receipt = PrinterConfig(
      id: 'r',
      name: 'Counter',
      kind: PrinterKind.network,
      host: '10.0.0.6',
    );
    const printers = PrinterSettings(
      printers: [kp1, receipt],
      assignments: {'kp1': 'kp1', 'customer_receipt': 'r'},
    );

    test('the ones it has a printer at', () {
      expect(expressPrintStations(printers, const TillSettings()), {
        'kp1',
        'receipt',
      });
    });

    test('but not one the venue sends only to a screen', () {
      expect(
        expressPrintStations(
          printers,
          const TillSettings(kitchenDelivery: {'kp1': KitchenDelivery.screen}),
        ),
        {'receipt'},
      );
    });

    test('and none on a till with no printers', () {
      expect(
        expressPrintStations(const PrinterSettings(), const TillSettings()),
        isEmpty,
      );
    });
  });

  group('printing the queue', () {
    const kp1 = PrinterConfig(
      id: 'kp1',
      name: 'Grill',
      kind: PrinterKind.network,
      host: '10.0.0.5',
    );
    const printers = PrinterSettings(
      printers: [kp1],
      assignments: {'kp1': 'kp1'},
    );

    ProviderContainer container(http.Client client) => ProviderContainer(
      overrides: [
        expressServiceProvider.overrideWithValue(
          ExpressService(
            apiBase: 'https://example.test',
            terminalToken: 't',
            client: client,
          ),
        ),
        printerSettingsProvider.overrideWith(() => _FixedPrinters(printers)),
        tillSettingsProvider.overrideWithValue(const TillSettings()),
        terminalNameProvider.overrideWithValue('Bar till'),
      ],
    );

    final refProvider = Provider<Ref>((ref) => ref);

    TestWidgetsFlutterBinding.ensureInitialized();

    test('claims only its own stations, prints them and reports back', () async {
      final calls = <String>[];
      Map<String, Object?>? claimBody;
      Map<String, Object?>? resultBody;
      final client = MockClient((req) async {
        calls.add('${req.method} ${req.url.path}');
        if (req.url.path.endsWith('/print-queue')) {
          return http.Response(
            jsonEncode({
              'jobs': [
                {
                  'order_id': 7,
                  'stations': ['kp1', 'kp2'],
                },
                // Nothing here for this till: left for the till that has KP 3.
                {
                  'order_id': 8,
                  'stations': ['kp3'],
                },
              ],
            }),
            200,
          );
        }
        if (req.url.path.endsWith('/claim')) {
          claimBody = jsonDecode(req.body) as Map<String, Object?>;
          return http.Response(jsonEncode(_claim()), 200);
        }
        if (req.url.path.endsWith('/result')) {
          resultBody = jsonDecode(req.body) as Map<String, Object?>;
          return http.Response('{"ok":true}', 200);
        }
        return http.Response('', 404);
      });

      final c = container(client);
      addTearDown(c.dispose);
      final printer = ExpressKitchenPrinter(c.read(refProvider));
      final sent = <String, List<int>>{};
      printer.sendOverride = (p, bytes) async => sent[p.id] = bytes;

      await printer.run();

      expect(calls, [
        'GET /till/express/print-queue',
        'POST /till/express/print-queue/7/claim',
        'POST /till/express/print-queue/7/result',
      ]);
      expect(claimBody!['stations'], ['kp1']);
      expect(claimBody!['terminal'], 'Bar till');
      expect(sent.keys, ['kp1']);
      final text = latin1.decode(sent['kp1']!, allowInvalid: true);
      expect(text, contains('KIOSK NO. 42 - TAKE AWAY'));
      expect(text, contains('Cheeseburger'));
      expect(text, isNot(contains('Milkshake')));
      expect(resultBody!['claim_id'], _claim()['claim_id']);
      expect(resultBody!['results'], [
        {'station': 'kp1', 'ok': true},
      ]);
    });

    test(
      'a printer that fails is reported, so the job goes back on offer',
      () async {
        Map<String, Object?>? resultBody;
        final client = MockClient((req) async {
          if (req.url.path.endsWith('/print-queue')) {
            return http.Response(
              jsonEncode({
                'jobs': [
                  {
                    'order_id': 7,
                    'stations': ['kp1'],
                  },
                ],
              }),
              200,
            );
          }
          if (req.url.path.endsWith('/claim')) {
            return http.Response(jsonEncode(_claim()), 200);
          }
          resultBody = jsonDecode(req.body) as Map<String, Object?>;
          return http.Response('{"ok":true}', 200);
        });

        final c = container(client);
        addTearDown(c.dispose);
        final printer = ExpressKitchenPrinter(c.read(refProvider));
        printer.sendOverride = (_, _) async => throw Exception('out of paper');

        await printer.run();

        final results = resultBody!['results'] as List;
        expect(results.single, containsPair('ok', false));
        expect((results.single as Map)['error'], contains('out of paper'));
      },
    );

    test('a till with no kitchen printer never asks', () async {
      var asked = false;
      final client = MockClient((_) async {
        asked = true;
        return http.Response('{"jobs":[]}', 200);
      });
      final c = ProviderContainer(
        overrides: [
          expressServiceProvider.overrideWithValue(
            ExpressService(
              apiBase: 'https://example.test',
              terminalToken: 't',
              client: client,
            ),
          ),
          printerSettingsProvider.overrideWith(
            () => _FixedPrinters(const PrinterSettings()),
          ),
          tillSettingsProvider.overrideWithValue(const TillSettings()),
        ],
      );
      addTearDown(c.dispose);
      await ExpressKitchenPrinter(c.read(refProvider)).run();
      expect(asked, isFalse);
    });
  });

  group('the card', () {
    Future<List<String>> pump(WidgetTester tester, String status) async {
      final moves = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 400,
              child: ExpressToast(
                order: ExpressOrder.fromJson(_order(status: status))!,
                busy: false,
                onMove: moves.add,
                onSetAside: () {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return moves;
    }

    testWidgets('a paid order offers Ready, and Collected', (tester) async {
      final moves = await pump(tester, 'paid');
      expect(find.text('42'), findsOneWidget);
      expect(find.text('Kiosk order paid'), findsOneWidget);
      await tester.tap(find.text('Ready'));
      await tester.tap(find.text('Collected'));
      expect(moves, ['ready', 'collected']);
    });

    testWidgets('a ready order offers only Collected', (tester) async {
      final moves = await pump(tester, 'ready');
      expect(find.text('Ready'), findsNothing);
      await tester.tap(find.text('Collected'));
      expect(moves, ['collected']);
    });
  });
}

class _FixedPrinters extends PrinterSettingsController {
  _FixedPrinters(this.value);

  final PrinterSettings value;

  @override
  Future<PrinterSettings> build() async => value;
}
