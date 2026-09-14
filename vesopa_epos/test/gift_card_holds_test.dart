/// Gift cards at the till: held at tender, spent when the sale is recorded,
/// given back on Undo, put back on a refund -- and every call carrying the
/// till's own token.
///
/// The server side of each call is tested in vesopa_server/test/gift-shop.test.js
/// against a real database. These check the till's half: what it sends, and
/// what it makes of the answers, including a back office too old to hold.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/data/commerce.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/data/tender_engine.dart';

const _office = 'venue@example.com';
const _token = 'signed.till.token';

CommerceRepository _repo(MockClient client, {String? token = _token}) =>
    CommerceRepository(
      apiBase: 'https://backoffice.example',
      office: _office,
      terminalToken: token,
      client: client,
    );

void main() {
  group('the till says who it is', () {
    test('every call carries the terminal token', () async {
      final seen = <String, String?>{};
      final repo = _repo(MockClient((r) async {
        seen[r.url.path] = r.headers['Authorization'];
        return switch (r.url.path) {
          '/api/gift-cards/lookup' => http.Response(jsonEncode({'id': 'c1', 'code': 'AAAA', 'balance_minor': 100}), 200),
          '/api/gift-cards/hold' => http.Response(jsonEncode({'hold_id': 'h1', 'amount_minor': 100, 'card': {'code': 'AAAA'}}), 200),
          '/api/gift-cards/capture' => http.Response(jsonEncode({'captured': true}), 200),
          '/api/gift-cards/release' => http.Response(jsonEncode({'released': true}), 200),
          '/api/tender-settings/public' => http.Response(jsonEncode({}), 200),
          _ => http.Response('{}', 200),
        };
      }));
      await repo.giftCard('AAAA');
      await repo.holdGiftCard(code: 'AAAA', amountMinor: 100, orderId: 'o1');
      await repo.captureGiftCard(holdId: 'h1', orderId: 'o1');
      await repo.releaseGiftCard('h1');
      await repo.loadTenderSettings();
      expect(seen.values.toSet(), {'Bearer $_token'});
      expect(seen.length, 5);
    });

    test('a till with no token still works, and sends no empty header', () async {
      String? auth = 'unset';
      final repo = _repo(
        MockClient((r) async {
          auth = r.headers['Authorization'];
          return http.Response(jsonEncode({'id': 'c1', 'code': 'AAAA', 'balance_minor': 100}), 200);
        }),
        token: null,
      );
      await repo.giftCard('AAAA');
      expect(auth, isNull);
    });
  });

  group('holding a card', () {
    test('a hold sends the bill, and answers with what was reserved', () async {
      late Map<String, dynamic> body;
      final repo = _repo(MockClient((r) async {
        body = jsonDecode(r.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({
            'hold_id': 'h-1',
            'amount_minor': 1200,
            'card': {'code': 'K7QM-2HXP-94TD', 'label': 'Sunday lunch for two', 'available_minor': 3600},
          }),
          200,
        );
      }));
      final hold = await repo.holdGiftCard(
        code: 'K7QM-2HXP-94TD',
        amountMinor: 1200,
        orderId: 'order-9',
        clerkName: 'Sam',
      );
      expect(body, containsPair('order_id', 'order-9'));
      expect(body, containsPair('amount_minor', 1200));
      expect(body, containsPair('office', _office));
      expect(hold.holdId, 'h-1');
      expect(hold.amountMinor, 1200);
      expect(hold.label, 'Sunday lunch for two');
      expect(hold.availableAfterMinor, 3600);
    });

    test('a back office from before holds is recognised, so the till can spend the old way', () async {
      final repo = _repo(MockClient((_) async => http.Response(
            '<!DOCTYPE html><pre>Cannot POST /api/gift-cards/hold</pre>',
            404,
          )));
      expect(
        () => repo.holdGiftCard(code: 'AAAA', amountMinor: 100, orderId: 'o'),
        throwsA(isA<HoldsUnsupported>()),
      );
    });

    test('a refused card says why, in the server\'s words -- not "unsupported"', () async {
      final repo = _repo(MockClient((_) async => http.Response(
            jsonEncode({'error': 'No such gift card'}),
            404,
          )));
      expect(
        () => repo.holdGiftCard(code: 'NOPE', amountMinor: 100, orderId: 'o'),
        throwsA(isA<CommerceException>().having((e) => e.message, 'message', 'No such gift card')),
      );
    });

    test('money another bill holds is refused with the server\'s reason', () async {
      final repo = _repo(MockClient((_) async => http.Response(
            jsonEncode({'error': 'Not enough left on this card', 'available_minor': 200}),
            409,
          )));
      expect(
        () => repo.holdGiftCard(code: 'AAAA', amountMinor: 900, orderId: 'o'),
        throwsA(isA<CommerceException>().having((e) => e.message, 'message', 'Not enough left on this card')),
      );
    });
  });

  group('spending, giving back, putting back', () {
    test('a capture that did not capture is an error', () async {
      final repo = _repo(MockClient((_) async => http.Response(
            jsonEncode({'error': 'That hold was already given back'}),
            409,
          )));
      expect(
        () => repo.captureGiftCard(holdId: 'h', orderId: 'o'),
        throwsA(isA<CommerceException>()),
      );
    });

    test('release says whether anything was still held', () async {
      var released = true;
      final repo = _repo(MockClient((_) async => http.Response(jsonEncode({'released': released}), 200)));
      expect(await repo.releaseGiftCard('h'), isTrue);
      released = false;
      expect(await repo.releaseGiftCard('h'), isFalse, reason: 'already spent, or already given back');
    });

    test('a refund puts money back by the sale alone, and says onto which cards', () async {
      late Map<String, dynamic> body;
      final repo = _repo(MockClient((r) async {
        body = jsonDecode(r.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({
            'reversed_minor': 700,
            'cards': [
              {'code': 'AAAA-BBBB-CCCC', 'reversed_minor': 700, 'balance_minor': 4500},
            ],
          }),
          200,
        );
      }));
      final back = await repo.reverseGiftCards(orderId: 'sale-1', amountMinor: 700, note: 'Refund off receipt');
      expect(body.containsKey('code'), isFalse, reason: 'the receipt does not know which card');
      expect(body, containsPair('order_id', 'sale-1'));
      expect(back.reversedMinor, 700);
      expect(back.codes, ['AAAA-BBBB-CCCC']);
    });
  });

  group('what the till shows about a card', () {
    test('it offers what is free, not the whole balance, and names what it is for', () {
      final card = GiftCard.fromJson({
        'id': 'c',
        'code': 'AAAA',
        'balance_minor': 5000,
        'available_minor': 2000,
        'label': 'Sunday lunch for two',
        'redeemable': true,
      });
      expect(card.spendableMinor, 2000);
      expect(card.label, 'Sunday lunch for two');
      expect(card.redeemable, isTrue);
    });

    test('the server\'s verdict wins: a voucher for next week is not spendable today', () {
      final card = GiftCard.fromJson({
        'id': 'c',
        'code': 'AAAA',
        'balance_minor': 5000,
        'status': 'active',
        'not_yet': true,
        'reason': 'This voucher can be spent from Saturday 24 October',
        'redeemable': false,
      });
      expect(card.redeemable, isFalse);
      expect(card.notYet, isTrue);
      expect(card.reason, contains('24 October'));
    });

    test('an old back office that sends no availability still works on the balance', () {
      final card = GiftCard.fromJson({'id': 'c', 'code': 'AAAA', 'balance_minor': 900, 'status': 'active'});
      expect(card.spendableMinor, 900);
      expect(card.redeemable, isTrue);
      expect(card.label, isNull);
    });
  });

  group('taking a payment off the middle of a bill', () {
    const cash = TenderEntry(kind: TenderKind.cash, amountMinor: 1000);
    const gift = TenderEntry(kind: TenderKind.giftCard, amountMinor: 1500, holdId: 'h', reference: 'AAAA');
    const card = TenderEntry(kind: TenderKind.card, amountMinor: 500);

    TenderState bill() => const TenderState(totals: BasketTotals.empty).addTender(cash).addTender(gift).addTender(card);

    test('on an ordinary bill, any payment can come off', () {
      final after = bill().removeTenderAt(1);
      expect(after.tenders.map((t) => t.kind), [TenderKind.cash, TenderKind.card]);
      expect(after.paidMinor, 1500);
    });

    test('the last one comes off as Undo would take it', () {
      expect(bill().removeTenderAt(2).tenders.length, 2);
    });

    test('out of range changes nothing', () {
      final b = bill();
      expect(identical(b.removeTenderAt(7), b), isTrue);
    });
  });
}
