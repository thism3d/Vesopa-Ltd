import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_display/data/basket_feed.dart';

void main() {
  test('a card payment in progress is read from the till file', () {
    final b = Basket.fromJson({
      'format': 1,
      'state': 'sale',
      'card': {
        'phase': 'progress',
        'title': 'Present card',
        'detail': 'Tap, insert or swipe your card',
        'amount_minor': 1250,
      },
    })!;
    expect(b.card!.isResult, isFalse);
    expect(b.card!.amountMinor, 1250);
  });

  test('a result says how it ended', () {
    final c = Basket.fromJson({
      'format': 1,
      'card': {'phase': 'result', 'title': 'Declined', 'outcome': 'declined'},
    })!.card!;
    expect(c.isResult, isTrue);
    expect(c.approved, isFalse);
  });

  test('an older till with no card leaves the screen alone', () {
    expect(Basket.fromJson({'format': 1})!.card, isNull);
    expect(Basket.fromJson({'format': 1, 'card': {'title': ''}})!.card, isNull);
  });
}
