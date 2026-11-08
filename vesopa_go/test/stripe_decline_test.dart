import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/payments/stripe_tap.dart';

/// A Stripe decline on Tap to Pay says why and what to do (2026-11-08: the
/// Kitchen's iPhone 12 read a card the bank refused and Go never said so).
void main() {
  test('a refused card says why, that nothing was taken, and what to do', () {
    final w = declineWords({'code': 'card_declined', 'decline_code': 'transaction_not_allowed', 'message': 'Your card does not support this type of purchase.'});
    expect(w, contains('does not support'));
    expect(w, contains('No money was taken'));
    expect(w, contains('another card'));
  });

  test('an unknown decline keeps the bank\'s own words', () {
    expect(declineWords({'code': 'card_declined', 'decline_code': 'something_new', 'message': 'Call your bank.'}), startsWith('Call your bank.'));
  });

  test('no funds and a wrong PIN read plainly', () {
    expect(declineWords({'decline_code': 'insufficient_funds'}), startsWith('Not enough money'));
    expect(declineWords({'decline_code': 'incorrect_pin'}), startsWith('The PIN was wrong'));
  });
}
