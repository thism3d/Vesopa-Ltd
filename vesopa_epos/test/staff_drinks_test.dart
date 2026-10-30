import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/staff_drinks.dart';
import 'package:vesopa_epos/printing/receipt_builder.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('codes are SD and eight letters and numbers, none of them 0, O, 1 or I', () {
    final r = Random(7);
    for (var i = 0; i < 500; i++) {
      final c = newStaffDrinkCode(r);
      expect(isStaffDrinkCode(c), isTrue);
      expect(c.substring(2), isNot(matches(RegExp('[01OI]'))));
    }
  });

  test('a code typed with dashes, spaces or lower case is the same code', () {
    expect(isStaffDrinkCode('sd-k7q2-m9xa'), isTrue);
    expect(cleanStaffDrinkCode('sd k7q2 m9xa'), 'SDK7Q2M9XA');
    expect(formatStaffDrinkCode('SDK7Q2M9XA'), 'SD-K7Q2-M9XA');
    expect(isStaffDrinkCode('5012345678900'), isFalse, reason: 'a bottle');
    expect(isStaffDrinkCode('SDK7Q2'), isFalse);
  });

  test('the slip carries the drink, the code and a barcode', () async {
    final b = await ReceiptBuilder.create();
    final bytes = b.staffDrinkSlip(
      productName: 'Carling',
      code: 'SDK7Q2M9XA',
      printedCode: 'SD-K7Q2-M9XA',
      soldBy: 'Sam',
      number: 1,
      of: 2,
    );
    final text = latin1.decode(bytes, allowInvalid: true);
    expect(text, contains('STAFF DRINK'));
    expect(text, contains('Carling'));
    expect(text, contains('SD-K7Q2-M9XA'));
    expect(text, contains('1 of 2'));
    // GS k, Code 128, set B, then the code.
    expect(text, contains('{BSDK7Q2M9XA'));
  });

  group('sending and redeeming', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('codes wait on the till while the back office is away, then go up', () async {
      var online = false;
      final sent = <Map<String, dynamic>>[];
      final client = MockClient((req) async {
        if (!online) throw http.ClientException('offline');
        sent.add(jsonDecode(req.body) as Map<String, dynamic>);
        return http.Response('{"ok":true,"added":1}', 200);
      });
      final api = StaffDrinksApi(apiBase: 'https://x', terminalToken: 't', client: client);
      await api.issue(
        orderId: 'o-1',
        soldBy: 'Sam',
        drinks: const [StaffDrink(code: 'SDAAAABBBB', productName: 'Carling', priceMinor: 450)],
      );
      expect(await api.waiting(), 1);
      online = true;
      await api.flush();
      expect(await api.waiting(), 0);
      expect(sent.single['order_id'], 'o-1');
      expect((sent.single['drinks'] as List).single['code'], 'SDAAAABBBB');
    });

    test('a slip pours once, then says when it was used', () async {
      var used = false;
      final client = MockClient((req) async {
        final drink = {
          'code': 'SDAAAABBBB',
          'product_name': 'Carling',
          'redeemed_at': used ? '2026-10-30T20:00:00Z' : null,
          'redeemed_terminal': used ? 'Bar 1' : null,
        };
        if (used) return http.Response(jsonEncode({'error': 'used', 'already': true, 'drink': drink}), 409);
        used = true;
        return http.Response(jsonEncode({'ok': true, 'drink': drink}), 200);
      });
      final api = StaffDrinksApi(apiBase: 'https://x', terminalToken: 't', client: client);
      expect(await api.redeem('sd-aaaa-bbbb'), isA<StaffDrinkOk>());
      final again = await api.redeem('SDAAAABBBB');
      expect(again, isA<StaffDrinkUsed>());
      expect((again as StaffDrinkUsed).drink.redeemedTerminal, 'Bar 1');
    });

    test('no internet: refused, not poured', () async {
      final api = StaffDrinksApi(
        apiBase: 'https://x',
        client: MockClient((_) async => throw http.ClientException('offline')),
      );
      expect(await api.redeem('SDAAAABBBB'), isA<StaffDrinkRefused>());
      expect(await api.redeem('hello'), isA<StaffDrinkRefused>());
    });
  });
}
